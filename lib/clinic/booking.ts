// ============================================================================
// Máquina de estados del agendamiento — Clínica San Martín de Porres
// ----------------------------------------------------------------------------
// Flujo:
//   idle → choosing_specialty → choosing_doctor* → choosing_slot
//        → collecting_name → collecting_ci → collecting_reason
//        → choosing_payment → (qr) awaiting_proof | (cash) done
//
// * choosing_doctor se salta si la especialidad solo tiene un doctor activo.
//
// Navegación no lineal: el primer mensaje pasa por extractBookingPrefs, que
// guarda en draft.prefs lo que el paciente ya dijo (especialidad o síntoma,
// franja del día, si le da igual el médico). Con eso, enterSpecialty puede
// saltarse choosing_specialty y/o choosing_doctor:
//   - "quiero pediatría por la tarde" → salta especialidad y filtra médicos
//   - "me duele la barriga"           → orienta a la especialidad del catálogo
//   - "lo antes posible, con quien sea" → choosing_slot_any, horarios de todos
//     los médicos de la especialidad mezclados y ordenados por cercanía
// Todo salto se anuncia en el mensaje y deja salida; nunca se decide en silencio.
//
// Bloqueo de 30 min (OBLIGATORIO MVP):
//   Al confirmar slot → re-verificar disponibilidad → escribir hold en BD
//   → pasar a collecting_name. Si el slot fue tomado → re-ofrecer.
//
// QR: al llegar el comprobante se confirma de inmediato (modelo de confianza,
// ver handlePaymentProof); la secretaria solo cancela si detecta un pago inválido.
// Efectivo: se crea el evento en Google Calendar de inmediato.
//
// Reagendamiento (ver rescheduleActiveAppointment): si la cita original ya
// estaba `confirmed`, en choosing_slot se salta collecting_*/choosing_payment
// y se confirma directo con los datos y el método de pago ya guardados —
// no se le vuelve a cobrar ni a pedir sus datos.
// ============================================================================

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

import {
  getBusyIntervals,
  computeAvailableSlots,
  createAppointmentEvent,
  deleteAppointmentEvent,
  doctorWorksInTimeBand,
  BAND_LABELS,
} from "@/lib/clinic/googleCalendar";
import {
  getSpecialties,
  getDoctorsBySpecialty,
  getDoctorById,
  saveBookingSession,
  resetBookingSession,
  writeHold,
  getActiveHoldsForDoctor,
  getActiveAppointmentSlotsForDoctor,
  createAppointment,
  updateAppointment,
  findActiveAppointmentByPhone,
  claimAppointmentForEventCreation,
  releaseAppointmentEventClaim,
  getAppointmentStatus,
  getAppointmentById,
} from "@/lib/clinic/data";
import type {
  BookingSession,
  BookingDraft,
  BookingHold,
  BookingPrefs,
  TimeSlot,
  SlotWithDoctor,
  TimeBand,
  Doctor,
  Specialty,
  PaymentMethod,
} from "@/lib/clinic/types";
import { buildClinicSystemPrompt, type ClinicConfig } from "@/lib/clinic/config";

// ─── Tipos de resultado ──────────────────────────────────────────────────────

export type BookingAction = "send_qr" | "none";

export type BookingResult = {
  reply: string;
  action: BookingAction;
  session: BookingSession;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatSlotLocal(isoUtc: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoUtc));
}

function parseNumberChoice(text: string): number | null {
  const clean = text.trim();
  const n = parseInt(clean, 10);
  if (!isNaN(n) && String(n) === clean) return n;
  const words: Record<string, number> = {
    uno: 1, "1ro": 1, primero: 1,
    dos: 2, "2do": 2, segundo: 2,
    tres: 3, "3ro": 3, tercero: 3,
    cuatro: 4, "4to": 4, cuarto: 4,
    cinco: 5, "5to": 5, quinto: 5,
  };
  return words[clean.toLowerCase()] ?? null;
}

// Usa OpenAI para resolver lenguaje natural a un índice de lista cuando
// parseNumberChoice no pudo hacerlo.
async function resolveChoiceWithAI(userText: string, options: string[]): Promise<number | null> {
  if (!options.length) return null;
  const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: "El usuario está eligiendo una opción de una lista. Responde SOLO con el número de la opción que mejor coincide con lo que escribió. Si no coincide con ninguna, responde 0.",
      prompt: `Lista:\n${list}\n\nEl usuario escribió: "${userText}"\n\n¿Con qué número coincide?`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(8000),
    });
    const n = parseInt(text.trim(), 10);
    if (!isNaN(n) && n >= 1 && n <= options.length) return n;
    return null;
  } catch {
    return null;
  }
}

// Resuelve la elección de HORARIO desde lenguaje natural. A diferencia de
// resolveChoiceWithAI, entiende horas informales ("las 5", "a las cinco de la
// tarde", "el lunes tempranito") y, cuando la referencia es AMBIGUA (falta am/pm
// o la hora coincide en varios días), devuelve una pregunta de aclaración en vez
// de adivinar. Retorna { index } si hay coincidencia única, { clarify } si hay
// que preguntar, o ambos null si no se refiere a ningún horario.
async function resolveSlotChoiceWithAI(
  userText: string,
  slotLabels: string[],
): Promise<{ index: number | null; clarify: string | null }> {
  if (!slotLabels.length) return { index: null, clarify: null };
  const list = slotLabels.map((o, i) => `${i + 1}. ${o}`).join("\n");
  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: `El usuario elige un horario de una lista numerada de citas. Cada opción trae el día y la hora en formato 24h.
El usuario suele escribir de forma informal e incompleta ("las 5", "a las cinco de la tarde", "el lunes a la mañana").
Reglas:
- Si el mensaje identifica SIN ambigüedad UNA sola opción de la lista, responde: {"index": N, "clarify": null}.
- Si es AMBIGUO —por ejemplo dice "las 5" sin aclarar mañana/tarde (am/pm), o la hora que menciona existe en varios días distintos de la lista— responde: {"index": null, "clarify": "<pregunta breve y cálida, como recepcionista boliviana, pidiendo SOLO el dato que falta (mañana o tarde, y/o qué día)>"}.
- Si el mensaje no se refiere a ningún horario de la lista, responde: {"index": null, "clarify": null}.
Responde ÚNICAMENTE con el JSON.`,
      prompt: `Lista de horarios:\n${list}\n\nEl usuario escribió: "${userText}"`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(8000),
    });
    const parsed = JSON.parse(text.trim().replace(/^```json|```$/g, "").trim());
    const idx = Number(parsed.index);
    if (Number.isInteger(idx) && idx >= 1 && idx <= slotLabels.length) {
      return { index: idx, clarify: null };
    }
    const clarify =
      typeof parsed.clarify === "string" && parsed.clarify.trim() ? parsed.clarify.trim() : null;
    return { index: null, clarify };
  } catch {
    return { index: null, clarify: null };
  }
}

// Responde una pregunta del cliente dentro del flujo de reserva sin perder el paso actual.
//
// Usa el MISMO system prompt que el Q&A general del webhook. Antes armaba uno
// propio de cinco líneas, sin ningún dato del negocio: preguntarle "¿dónde
// están ubicados?" en mitad de una reserva devolvía "en el corazón de la
// ciudad" en vez de la dirección real. Con buildClinicSystemPrompt hay una
// sola fuente de verdad — si cambia la dirección en clinic_settings, cambia
// acá también.
async function replyInContext(
  userText: string,
  contextHint: string,
  followUp: string,
  session: BookingSession,
  clinic: ClinicConfig,
): Promise<BookingResult> {
  const system = [
    buildClinicSystemPrompt(clinic),
    "",
    `CONTEXTO: el paciente está agendando una cita y va por el paso "${contextHint}".`,
    "Responde su pregunta en pocas líneas y después invítalo con naturalidad a seguir con el agendamiento.",
    "La disponibilidad y los horarios de cada médico los resuelve el sistema, no vos: nunca los inventes ni los prometas.",
  ].join("\n");

  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system,
      prompt: userText,
      temperature: 0.5,
      abortSignal: AbortSignal.timeout(10000),
    });
    return { reply: `${text.trim()}\n\n${followUp}`, action: "none", session };
  } catch {
    return { reply: `${followUp}`, action: "none", session };
  }
}

function emptyHold(): BookingHold {
  return { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null };
}

function reply(text: string, action: BookingAction, session: BookingSession): BookingResult {
  return { reply: text, action, session };
}

async function saveAndReturn(
  conversationId: string,
  business: string,
  step: BookingSession["step"],
  draft: BookingDraft,
  hold: BookingHold,
): Promise<BookingSession> {
  await saveBookingSession({ conversationId, business, step, draft, hold });
  return { conversationId, step, draft, hold };
}

async function resetAndReturn(conversationId: string, business: string): Promise<BookingSession> {
  await resetBookingSession(conversationId, business);
  return { conversationId, step: "idle", draft: {}, hold: emptyHold() };
}

// Cierra la cita anterior de un reagendamiento: la cancela, borra su evento del
// calendario y recién ahí consume la reprogramación.
//
// Se llama SOLO una vez que la cita nueva ya existe. Antes esto se hacía al
// INICIAR el reagendamiento, y el paciente que abandonaba la conversación entre
// medio —no le gustó ningún horario, se quedó sin batería— terminaba sin la cita
// vieja y sin la nueva. Peor: rescheduleCount ya estaba gastado, así que al
// volver a escribir recibía "solo se permite una reprogramación" mientras
// findActiveAppointmentByPhone no le encontraba ninguna cita. Sin salida.
//
// Idempotente: si la cita ya está cancelada no vuelve a tocarla, así que da
// igual si se llama dos veces.
async function closePreviousAppointment(previousId: string): Promise<void> {
  const previous = await getAppointmentById(previousId);
  if (!previous || previous.status === "canceled") return;

  await updateAppointment(previousId, {
    status: "canceled",
    rescheduleCount: previous.rescheduleCount + 1,
    cancelReason: "Reagendada por el paciente",
  });

  if (previous.googleEventId && previous.doctorId) {
    const doctor = await getDoctorById(previous.doctorId);
    if (doctor?.googleCalendarId) {
      try {
        await deleteAppointmentEvent(doctor.googleCalendarId, previous.googleEventId);
        await updateAppointment(previousId, { googleEventId: null as unknown as string });
      } catch (err) {
        // El evento huérfano es molesto pero no bloquea: la cita nueva ya existe
        // y el trigger de confirmaciones vuelve a intentar el borrado.
        console.error("deleteAppointmentEvent (reschedule) failed", err);
      }
    }
  }
}

// Slots libres para un doctor, excluyendo holds y citas activas en BD.
async function getAvailableSlots(doctor: Doctor, conversationId: string): Promise<TimeSlot[]> {
  if (!doctor.googleCalendarId) return [];

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const [busy, holds, activeAppts] = await Promise.all([
    getBusyIntervals(doctor.googleCalendarId, timeMin, timeMax),
    getActiveHoldsForDoctor(doctor.id, conversationId),
    getActiveAppointmentSlotsForDoctor(doctor.id, timeMin, timeMax),
  ]);

  return computeAvailableSlots({
    doctor,
    busy,
    excludeSlots: [...holds, ...activeAppts],
    fromDate: now,
    daysAhead: 14,
    maxSlots: 15,
  });
}

// Slots libres del doctor para UN día puntual (usado tanto para el día por
// defecto como para un día que el paciente pidió explícitamente).
async function getSlotsForDate(doctor: Doctor, conversationId: string, targetDate: Date): Promise<TimeSlot[]> {
  if (!doctor.googleCalendarId) return [];

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const [busy, holds, activeAppts] = await Promise.all([
    getBusyIntervals(doctor.googleCalendarId, timeMin, timeMax),
    getActiveHoldsForDoctor(doctor.id, conversationId),
    getActiveAppointmentSlotsForDoctor(doctor.id, timeMin, timeMax),
  ]);

  return computeAvailableSlots({
    doctor,
    busy,
    excludeSlots: [...holds, ...activeAppts],
    fromDate: targetDate,
    daysAhead: 0,
    maxSlots: 30,
  });
}

// Slots del día por defecto: hoy, o el próximo día hábil si ya pasó el
// horario de atención de hoy (o hoy no es día laborable para el doctor).
async function getSlotsForDefaultDay(doctor: Doctor, conversationId: string, timeBand?: TimeBand | null): Promise<TimeSlot[]> {
  if (!doctor.googleCalendarId) return [];

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const [busy, holds, activeAppts] = await Promise.all([
    getBusyIntervals(doctor.googleCalendarId, timeMin, timeMax),
    getActiveHoldsForDoctor(doctor.id, conversationId),
    getActiveAppointmentSlotsForDoctor(doctor.id, timeMin, timeMax),
  ]);

  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const dayFrom = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const daySlots = computeAvailableSlots({
      doctor,
      busy,
      excludeSlots: [...holds, ...activeAppts],
      fromDate: dayFrom,
      daysAhead: 0,
      maxSlots: 30,
      now,
      timeBand,
    });
    if (daySlots.length) return daySlots;
  }

  return [];
}

// Detecta si el mensaje del paciente pide explícitamente OTRO día ("mañana",
// "el lunes", "para el 5 de agosto") en vez de elegir un horario de la lista
// actual. Devuelve la fecha (inicio del día, hora local de la clínica) o null.
async function resolveDateRequestWithAI(userText: string, timezone: string): Promise<Date | null> {
  const todayLabel = new Intl.DateTimeFormat("es-BO", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: `Hoy es ${todayLabel} (zona horaria ${timezone}). El usuario está eligiendo un horario de cita de una lista que ya se le mostró.
Si el mensaje pide EXPLÍCITAMENTE otro día distinto al que se le ofreció (ej: "mañana", "el lunes", "pasado mañana", "para el 5 de agosto", "el próximo martes"), responde SOLO con un JSON: {"date": "YYYY-MM-DD"}.
Si el mensaje NO pide otro día (por ejemplo, está eligiendo un horario de la lista, o preguntando algo distinto), responde: {"date": null}.`,
      prompt: userText,
      temperature: 0,
      abortSignal: AbortSignal.timeout(8000),
    });
    const parsed = JSON.parse(text.trim().replace(/^```json|```$/g, "").trim());
    if (typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
      const [y, m, d] = parsed.date.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d, 12)); // mediodía UTC: evita corrimientos de día por timezone
    }
    return null;
  } catch {
    return null;
  }
}

function slotsMessage(slots: TimeSlot[], tz: string): string {
  const lines = slots.map((s, i) => `  ${i + 1}. ${formatSlotLocal(s.start, tz)}`);
  return `Estos son los horarios disponibles:\n\n${lines.join("\n")}\n\n¿Cuál le viene bien?\n\n¿Prefiere otro día? Dígame la fecha (ej. "el lunes" o "para el 5 de agosto") 📅`;
}

// Como slotsMessage pero mostrando de qué médico es cada horario: acá el
// paciente elige por hora y el doctor sale de la opción que eligió.
function slotsWithDoctorMessage(slots: SlotWithDoctor[], tz: string): string {
  const lines = slots.map((s, i) => `  ${i + 1}. ${formatSlotLocal(s.start, tz)} — ${s.doctorName}`);
  return `Estos son los horarios más próximos:\n\n${lines.join("\n")}\n\n¿Cuál le viene bien?`;
}

// ─── Preferencias del paciente (navegación no lineal) ────────────────────────

// Extrae de un mensaje libre lo que el paciente ya nos dijo, para no volver a
// preguntárselo: qué especialidad necesita (mencionada, o inferida de un
// síntoma), en qué franja del día quiere y si le da igual el médico.
//
// El LLM se usa como EXTRACTOR, nunca como decisor: se le pasa la lista real de
// especialidades activas y solo puede devolver un índice de esa lista, así que
// no puede inventarse una que la clínica no tenga. Mismo patrón defensivo que
// resolveDateRequestWithAI: temperature 0, timeout corto y catch → sin
// preferencias (el flujo lineal de siempre).
export async function extractBookingPrefs(
  userText: string,
  specialties: Specialty[],
): Promise<BookingPrefs> {
  const none: BookingPrefs = {};
  if (!userText.trim() || !specialties.length) return none;

  const list = specialties.map((s, i) => `${i + 1}. ${s.name}`).join("\n");

  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: `Extraés preferencias de un paciente que quiere agendar una cita médica. Respondés ÚNICAMENTE con un JSON:
{"specialty": <número de la lista o null>, "timeBand": "morning"|"afternoon"|"evening"|null, "anyDoctor": true|false}

Reglas:
- "specialty": el número de la especialidad de la lista que el paciente necesita. Si la nombra, usá esa. Si solo describe un SÍNTOMA o malestar, elegí la especialidad más apropiada de la lista; si ninguna encaja con claridad, elegí Medicina General. Si el mensaje no da ninguna pista (ej. "quiero una cita"), devolvé null.
- Nunca afirmes la causa del síntoma ni diagnostiques: solo orientás a qué especialidad corresponde.
- Si el mensaje es una pregunta general sobre la clínica (dirección, precios, horarios, formas de pago) y no menciona especialidad ni síntoma, "specialty" es null.
- "timeBand": "morning" si pide mañana/temprano, "afternoon" si pide tarde, "evening" si pide noche. Si no menciona franja, null.
- "anyDoctor": true solo si le da igual el médico o pide lo más pronto posible ("con quien sea", "el primero que haya", "lo antes posible", "urgente"). Si no, false.
- Solo extraés lo que el mensaje dice de verdad. Ante la duda, null/false.`,
      prompt: `Especialidades disponibles:\n${list}\n\nEl paciente escribió: "${userText}"`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(8000),
    });

    const parsed = JSON.parse(text.trim().replace(/^```json|```$/g, "").trim());

    const n = Number(parsed.specialty);
    const specialtyId =
      Number.isInteger(n) && n >= 1 && n <= specialties.length ? specialties[n - 1].id : null;

    const band = parsed.timeBand;
    const timeBand: TimeBand | null =
      band === "morning" || band === "afternoon" || band === "evening" ? band : null;

    return { specialtyId, timeBand, anyDoctor: parsed.anyDoctor === true };
  } catch {
    return none;
  }
}

// Slots libres de TODA una especialidad, ordenados por cercanía y sabiendo de
// qué médico es cada uno. Para el paciente que dice "lo antes posible, con
// quien sea" y no quiere elegir doctor a ciegas.
//
// Coste: una llamada a Google Calendar POR MÉDICO (getAvailableSlots hace una
// sola porque mira un doctor). Por eso: en paralelo, con tope de médicos y
// mirando solo unos días —"lo antes posible" es cercano por definición—. Un
// calendario que falle se omite en vez de tumbar la respuesta entera.
const ANY_DOCTOR_MAX_DOCTORS = 6;
const ANY_DOCTOR_DAYS_AHEAD = 3;
const ANY_DOCTOR_MAX_SLOTS = 5;

async function getEarliestSlotsForSpecialty(params: {
  business: string;
  specialtyId: string;
  conversationId: string;
  timeBand?: TimeBand | null;
}): Promise<SlotWithDoctor[]> {
  const { business, specialtyId, conversationId, timeBand } = params;

  let doctors = await getDoctorsBySpecialty(business, specialtyId);
  if (timeBand) {
    const inBand = doctors.filter((d) => doctorWorksInTimeBand(d, timeBand));
    // Si nadie atiende en esa franja, mejor ofrecer los horarios que sí hay que
    // devolver una lista vacía y cortarle el flujo al paciente.
    if (inBand.length) doctors = inBand;
  }
  doctors = doctors.filter((d) => d.googleCalendarId).slice(0, ANY_DOCTOR_MAX_DOCTORS);
  if (!doctors.length) return [];

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + (ANY_DOCTOR_DAYS_AHEAD + 1) * 24 * 60 * 60 * 1000).toISOString();

  const perDoctor = await Promise.all(
    doctors.map(async (doctor): Promise<SlotWithDoctor[]> => {
      try {
        const [busy, holds, activeAppts] = await Promise.all([
          getBusyIntervals(doctor.googleCalendarId!, timeMin, timeMax),
          getActiveHoldsForDoctor(doctor.id, conversationId),
          getActiveAppointmentSlotsForDoctor(doctor.id, timeMin, timeMax),
        ]);
        return computeAvailableSlots({
          doctor,
          busy,
          excludeSlots: [...holds, ...activeAppts],
          fromDate: now,
          daysAhead: ANY_DOCTOR_DAYS_AHEAD,
          maxSlots: ANY_DOCTOR_MAX_SLOTS,
          now,
          timeBand,
        }).map((s) => ({ ...s, doctorId: doctor.id, doctorName: doctor.name }));
      } catch (err) {
        console.error(`getEarliestSlotsForSpecialty: doctor ${doctor.id} failed, skipping`, err);
        return [];
      }
    }),
  );

  return perDoctor
    .flat()
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, ANY_DOCTOR_MAX_SLOTS);
}

// Confirma el horario que el paciente eligió y lo bloquea 30 minutos.
//
// Es la parte más delicada del flujo —re-verifica contra Calendar/BD para no
// agendar dos pacientes en el mismo hueco— así que vive en UNA sola función:
// la comparten choosing_slot (ya sabíamos el médico) y choosing_slot_any (el
// médico sale del slot elegido). Duplicarla sería la forma más fácil de
// introducir un doble-booking.
//
// `draft` debe traer ya doctorId/specialtyId resueltos.
async function confirmSlotAndHold(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  chosen: TimeSlot;
  clinic: ClinicConfig;
  draft: BookingDraft;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone, chosen, clinic } = params;
  let draft = params.draft;

  if (!draft.doctorId) {
    return reply("Ocurrió un error al recuperar el médico. Comencemos de nuevo.", "none", await resetAndReturn(conversationId, business));
  }

  const doctor = await getDoctorById(draft.doctorId);
  if (!doctor || !doctor.googleCalendarId) {
    return reply("No pude verificar la disponibilidad. Intente de nuevo.", "none", await resetAndReturn(conversationId, business));
  }

  // Re-verificar disponibilidad con timeout de 5s para no exceder el límite de Vercel.
  const nowIso = new Date().toISOString();
  const chosenStart = new Date(chosen.start).getTime();
  const chosenEnd = new Date(chosen.end).getTime();

  function slotOverlaps(b: TimeSlot) {
    return new Date(b.start).getTime() < chosenEnd && new Date(b.end).getTime() > chosenStart;
  }

  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
    const verification = Promise.all([
      getBusyIntervals(doctor.googleCalendarId, nowIso, chosen.end),
      getActiveHoldsForDoctor(doctor.id, conversationId),
      getActiveAppointmentSlotsForDoctor(doctor.id, nowIso, chosen.end),
    ]);

    const result = await Promise.race([verification, timeout]);

    if (result !== null) {
      const [busyNow, holdsNow, activeAppts] = result;
      if (busyNow.some(slotOverlaps) || holdsNow.some(slotOverlaps) || activeAppts.some(slotOverlaps)) {
        const freshSlots = await getAvailableSlots(doctor, conversationId);
        if (!freshSlots.length) {
          const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
          return reply("Ese horario ya no está disponible y no quedan turnos libres. ¿Le puedo ayudar en otra cosa?", "none", newSession);
        }
        draft = { ...draft, offeredSlots: freshSlots, offeredSlotsAny: undefined };
        const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
        return reply(`Ese horario acaba de ser tomado 😔 Aquí los próximos disponibles:\n\n${slotsMessage(freshSlots, clinic.timezone)}`, "none", newSession);
      }
    }
    // Si timeout → continuar optimistamente (el slot fue validado al mostrarse).
  } catch (err) {
    console.error("slot re-verification failed, proceeding optimistically", err);
  }

  // Slot libre → escribir hold de 30 minutos.
  draft = { ...draft, slotStart: chosen.start, slotEnd: chosen.end, offeredSlots: undefined, offeredSlotsAny: undefined };
  const newHold: BookingHold = {
    heldDoctorId: doctor.id,
    heldSlotStart: chosen.start,
    holdExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  // Reagendamiento de una cita que ya estaba confirmada (pagada por QR con
  // comprobante validado, o efectivo ya dado por confirmado): no volvemos a
  // pedir datos ni pago, reutilizamos lo que ya teníamos y confirmamos directo.
  if (
    draft.reschedulingAppointmentId &&
    draft.rescheduleConfirmed &&
    draft.patientName &&
    draft.patientCi &&
    draft.paymentMethod
  ) {
    const friendlySlot = formatSlotLocal(chosen.start, clinic.timezone);
    const appointmentId = await createAppointment({
      business,
      conversationId,
      contactPhone,
      patientName: draft.patientName,
      patientCi: draft.patientCi,
      reason: draft.reason,
      specialtyId: draft.specialtyId,
      doctorId: draft.doctorId,
      scheduledStart: chosen.start,
      scheduledEnd: chosen.end,
      status: "confirmed",
      paymentMethod: draft.paymentMethod,
    });

    if (!appointmentId) {
      const freshSlots = await getAvailableSlots(doctor, conversationId);
      if (!freshSlots.length) {
        const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
        return reply("Lo sentimos, justo se ocupó ese horario y no quedan más turnos libres para este médico 😔 ¿Le puedo ayudar en otra cosa?", "none", newSession);
      }
      draft = { ...draft, offeredSlots: freshSlots };
      const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
      return reply(`Justo se ocupó ese horario 😔 Aquí los próximos disponibles:\n\n${slotsMessage(freshSlots, clinic.timezone)}`, "none", newSession);
    }

    if (draft.paymentProofUrl) {
      await updateAppointment(appointmentId, { paymentProofUrl: draft.paymentProofUrl });
    }

    // La cita nueva ya existe: recién ahora se cierra la vieja.
    await closePreviousAppointment(draft.reschedulingAppointmentId);

    const claimedReschedule = doctor.googleCalendarId
      ? await claimAppointmentForEventCreation(appointmentId)
      : false;

    if (doctor.googleCalendarId && claimedReschedule) {
      try {
        const eventId = await createAppointmentEvent({
          calendarId: doctor.googleCalendarId,
          timezone: doctor.timezone,
          startIso: chosen.start,
          endIso: chosen.end,
          summary: `Cita: ${draft.patientName} — ${doctor.name}`,
          description: [
            `Paciente: ${draft.patientName}`,
            `CI: ${draft.patientCi ?? "—"}`,
            `Tel: ${contactPhone}`,
            `Especialidad: ${draft.specialtyName ?? "—"}`,
            `Motivo: ${draft.reason ?? "—"}`,
            `Pago: ${draft.paymentMethod === "qr" ? "QR BNB" : "Efectivo"} (reagendado)`,
          ].join("\n"),
        });
        if (eventId) {
          const currentStatus = await getAppointmentStatus(appointmentId);
          if (currentStatus === "canceled") {
            // Se volvió a reagendar/cancelar mientras se creaba el evento: no
            // dejar un evento huérfano en Calendar.
            await deleteAppointmentEvent(doctor.googleCalendarId, eventId);
            await releaseAppointmentEventClaim(appointmentId);
          } else {
            await updateAppointment(appointmentId, { googleEventId: eventId });
          }
        } else {
          await releaseAppointmentEventClaim(appointmentId);
        }
      } catch (err) {
        console.error("createAppointmentEvent (reschedule confirmed) failed", err);
        await releaseAppointmentEventClaim(appointmentId);
        await updateAppointment(appointmentId, {
          notes: "⚠️ Cita confirmada pero falló crear el evento en Google Calendar. Verificar el calendario del doctor.",
        });
      }
    } else if (!doctor.googleCalendarId) {
      await updateAppointment(appointmentId, {
        notes: "⚠️ El doctor no tiene calendario configurado: la cita no aparece en ningún Google Calendar.",
      });
    }

    await resetBookingSession(conversationId, business);
    return reply(
      `✅ *¡Cita reprogramada!*\n\n📅 ${friendlySlot}\n👨‍⚕️ ${doctor.name}\n👤 ${draft.patientName}\n💊 ${draft.reason ?? "—"}\n\nNo necesita volver a pagar, su cita ya está confirmada. 😊`,
      "none",
      { conversationId, step: "done", draft: {}, hold: emptyHold() },
    );
  }

  await writeHold({
    conversationId,
    business,
    step: "collecting_name",
    draft,
    doctorId: doctor.id,
    slotStart: chosen.start,
  });

  const friendlySlot = formatSlotLocal(chosen.start, clinic.timezone);
  return reply(
    `¡Aparté su horario por 30 minutos! 🎉\n\n📅 *${friendlySlot}*\n👨‍⚕️ ${doctor.name}\n\nPara confirmar necesito algunos datos:\n\n👤 *Nombre completo*\n🪪 *Carnet de Identidad (CI)*\n💊 *Motivo de consulta*\n\nPuede respondernos todo en un mensaje o por separado 😊`,
    "none",
    { conversationId, step: "collecting_name", draft, hold: newHold },
  );
}
// "Me da igual el médico / lo antes posible": determinista y barato, sin LLM.
export const ANY_DOCTOR_PATTERN =
  /\b(cualquiera|cualquier m[eé]dic[oa]|el que sea|la que sea|quien sea|me da igual|da lo mismo|no importa|el primero|la primera|m[aá]s pronto|lo antes posible|m[aá]s temprano|urgente)\b/i;

// "¿Quién atiende en la mañana?" → la franja preguntada, o null.
// Ojo: "mañana" a secas es el DÍA de mañana, no la franja — por eso se exige
// "por la mañana" / "en la mañana" y nunca la palabra suelta.
export function detectBandQuestion(text: string): TimeBand | null {
  if (/\b(por la ma[ñn]ana|en la ma[ñn]ana|matutin[oa]|tempranito|temprano)\b/i.test(text)) return "morning";
  if (/\b(por la tarde|en la tarde|vespertin[oa])\b/i.test(text)) return "afternoon";
  if (/\b(por la noche|en la noche|nocturn[oa])\b/i.test(text)) return "evening";
  return null;
}

// Entra a una especialidad ya resuelta y decide el SIGUIENTE paso aplicando lo
// que el paciente ya pidió (draft.prefs): si le da igual el médico le ofrecemos
// directamente los horarios más próximos de toda la especialidad, y si pidió
// una franja filtramos a los médicos que atienden en ella.
//
// La comparten el paso idle (cuando el primer mensaje ya trae la especialidad o
// un síntoma) y choosing_specialty (cuando la eligió de la lista).
async function enterSpecialty(params: {
  conversationId: string;
  business: string;
  clinic: ClinicConfig;
  specialty: Specialty;
  draft: BookingDraft;
  intro?: string; // línea previa cuando saltamos un paso: nunca decidir en silencio
}): Promise<BookingResult> {
  const { conversationId, business, clinic, specialty, intro } = params;
  let draft: BookingDraft = { ...params.draft, specialtyId: specialty.id, specialtyName: specialty.name };
  const prefs = draft.prefs ?? {};
  const lead = intro ? `${intro}\n\n` : "";

  const allDoctors = await getDoctorsBySpecialty(business, specialty.id);
  if (!allDoctors.length) {
    const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
    return reply(`Lo sentimos, ${specialty.name} no tiene médicos disponibles. ¿Desea elegir otra especialidad?`, "none", newSession);
  }

  // "Con quien sea / lo antes posible": horarios de TODA la especialidad.
  if (prefs.anyDoctor) {
    const anySlots = await getEarliestSlotsForSpecialty({
      business,
      specialtyId: specialty.id,
      conversationId,
      timeBand: prefs.timeBand,
    });
    if (anySlots.length) {
      draft = { ...draft, offeredSlotsAny: anySlots, offeredSlots: undefined };
      const newSession = await saveAndReturn(conversationId, business, "choosing_slot_any", draft, emptyHold());
      return reply(`${lead}${slotsWithDoctorMessage(anySlots, clinic.timezone)}`, "none", newSession);
    }
    // Sin huecos cercanos: seguimos por el camino normal en vez de cortarle el flujo.
  }

  // Franja pedida: nos quedamos con los médicos que atienden en ella.
  let doctors = allDoctors;
  let header = `Médicos disponibles en ${specialty.name}`;
  if (prefs.timeBand) {
    const inBand = allDoctors.filter((d) => doctorWorksInTimeBand(d, prefs.timeBand!));
    if (inBand.length) {
      doctors = inBand;
      header = `Médicos de ${specialty.name} que atienden ${BAND_LABELS[prefs.timeBand]}`;
    } else {
      header = `No tenemos médicos de ${specialty.name} que atiendan ${BAND_LABELS[prefs.timeBand]} 😔 Estos son los que sí atienden`;
      // Se olvida la franja para que choosing_doctor arme la MISMA lista que
      // acabamos de mostrar: si no, los números no coincidirían.
      draft = { ...draft, prefs: { ...prefs, timeBand: null } };
    }
  }

  if (doctors.length === 1) {
    const doctor = doctors[0];
    draft = { ...draft, doctorId: doctor.id, doctorName: doctor.name };

    const slots = await getSlotsForDefaultDay(doctor, conversationId, draft.prefs?.timeBand);
    if (!slots.length) {
      const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
      return reply(`No hay horarios disponibles para ${doctor.name} en los próximos días. ¿Puedo ayudarle en algo más?`, "none", newSession);
    }

    draft = { ...draft, offeredSlots: slots };
    const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
    return reply(`${lead}Atenderá *${doctor.name}*.\n\n${slotsMessage(slots, clinic.timezone)}`, "none", newSession);
  }

  const lines = doctors.map((d, i) => `  ${i + 1}. ${d.name}${d.consultationPrice ? ` — ${d.consultationPrice} Bs` : ""}`).join("\n");
  const newSession = await saveAndReturn(conversationId, business, "choosing_doctor", draft, emptyHold());
  return reply(
    `${lead}${header}:\n\n${lines}\n\n¿Con quién prefiere? Si le da igual, dígame "cualquiera" y le busco el horario más próximo 😊`,
    "none",
    newSession,
  );
}


// ─── Avanzar la máquina de pasos ─────────────────────────────────────────────

export async function advanceBooking(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  incomingText: string;
  session: BookingSession;
  clinic: ClinicConfig;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone, incomingText, session, clinic } = params;
  const text = incomingText.trim();
  let { step, draft, hold } = session;
  // ── idle / start ──────────────────────────────────────────────────────────
  if (step === "idle") {
    const specialties = await getSpecialties(business);
    if (!specialties.length) {
      return reply(
        "Lo sentimos, en este momento no puedo mostrarle las especialidades 🙏 Ya estamos derivando su petición a un asesor de la clínica para que le atienda.",
        "none",
        { conversationId, step: "idle", draft: {}, hold: emptyHold() },
      );
    }

    // Lo que el paciente ya nos dijo en su mensaje ("pediatría el jueves por la
    // tarde", "me duele la barriga", "lo antes posible con quien sea") se
    // extrae UNA sola vez, acá, y los pasos siguientes lo consumen del draft.
    // No volvemos a preguntarle lo que acaba de decirnos.
    const prefs = await extractBookingPrefs(text, specialties);
    draft = { prefs };

    const preselected = prefs.specialtyId
      ? specialties.find((s) => s.id === prefs.specialtyId)
      : undefined;

    if (preselected) {
      return enterSpecialty({
        conversationId,
        business,
        clinic,
        specialty: preselected,
        draft,
        intro: `Le busco en *${preselected.name}* 😊 (si prefiere otra especialidad, dígamelo)`,
      });
    }

    const lines = specialties.map((s, i) => `  ${i + 1}. ${s.name}`).join("\n");
    const newSession = await saveAndReturn(conversationId, business, "choosing_specialty", draft, emptyHold());
    return reply(`Perfecto 😊 ¿Qué especialidad necesita?\n\n${lines}\n\n¿Cuál necesita?`, "none", newSession);
  }

  // ── choosing_specialty ────────────────────────────────────────────────────
  if (step === "choosing_specialty") {
    const specialties = await getSpecialties(business);
    const idx = parseNumberChoice(text) ?? await resolveChoiceWithAI(text, specialties.map(s => s.name));

    if (!idx || idx < 1 || idx > specialties.length) {
      // No eligió de la lista, pero quizá describió un síntoma ("me duele la
      // barriga") o una preferencia. Antes de repreguntar, intentamos orientarlo.
      const prefs = await extractBookingPrefs(text, specialties);
      const inferred = prefs.specialtyId
        ? specialties.find((s) => s.id === prefs.specialtyId)
        : undefined;

      if (inferred) {
        return enterSpecialty({
          conversationId,
          business,
          clinic,
          specialty: inferred,
          draft: { ...draft, prefs: { ...draft.prefs, ...prefs } },
          intro: `Por lo que me cuenta le corresponde *${inferred.name}* 😊 (si prefiere otra especialidad, dígamelo)`,
        });
      }

      const lines = specialties.map((s, i) => `  ${i + 1}. ${s.name}`).join("\n");
      return replyInContext(text, "eligiendo especialidad", `¿Cuál de estas especialidades necesita?\n\n${lines}`, session, clinic);
    }

    return enterSpecialty({ conversationId, business, clinic, specialty: specialties[idx - 1], draft });
  }

  // ── choosing_doctor ───────────────────────────────────────────────────────
  if (step === "choosing_doctor") {
    const allDoctors = draft.specialtyId ? await getDoctorsBySpecialty(business, draft.specialtyId) : [];
    const band = draft.prefs?.timeBand ?? null;

    // "Cualquiera" / "el que atienda antes": saltamos la elección de médico y
    // ofrecemos los horarios más próximos de toda la especialidad.
    if (draft.specialtyId && ANY_DOCTOR_PATTERN.test(text)) {
      const anySlots = await getEarliestSlotsForSpecialty({
        business,
        specialtyId: draft.specialtyId,
        conversationId,
        timeBand: band,
      });
      if (anySlots.length) {
        draft = { ...draft, offeredSlotsAny: anySlots, prefs: { ...draft.prefs, anyDoctor: true } };
        const newSession = await saveAndReturn(conversationId, business, "choosing_slot_any", draft, emptyHold());
        return reply(
          `Perfecto, le busco lo más próximo con cualquiera de nuestros médicos 😊\n\n${slotsWithDoctorMessage(anySlots, clinic.timezone)}`,
          "none",
          newSession,
        );
      }
    }

    // "¿Quién atiende en la mañana?": se responde leyendo el horario de cada
    // médico, sin consultar Google Calendar.
    const askedBand = detectBandQuestion(text);
    if (askedBand && allDoctors.length) {
      const matching = allDoctors.filter((d) => doctorWorksInTimeBand(d, askedBand));
      // La franja se guarda solo si alguien atiende en ella: así la lista que
      // ve el paciente y la que reconstruimos al responder son la misma.
      draft = { ...draft, prefs: { ...draft.prefs, timeBand: matching.length ? askedBand : null } };
      const newSession = await saveAndReturn(conversationId, business, "choosing_doctor", draft, emptyHold());

      if (!matching.length) {
        const lines = allDoctors.map((d, i) => `  ${i + 1}. ${d.name}`).join("\n");
        return reply(
          `Ninguno de nuestros médicos de esta especialidad atiende ${BAND_LABELS[askedBand]} 😔\n\nEstos son los que tenemos:\n\n${lines}\n\n¿Con quién prefiere?`,
          "none",
          newSession,
        );
      }

      const lines = matching.map((d, i) => `  ${i + 1}. ${d.name}${d.consultationPrice ? ` — ${d.consultationPrice} Bs` : ""}`).join("\n");
      return reply(
        `Atienden ${BAND_LABELS[askedBand]}:\n\n${lines}\n\n¿Con quién prefiere? Si le da igual, dígame "cualquiera" 😊`,
        "none",
        newSession,
      );
    }

    // La lista numerada debe ser la MISMA que se le mostró: si hay franja
    // guardada, el filtro se reaplica igual que en enterSpecialty.
    const inBand = band ? allDoctors.filter((d) => doctorWorksInTimeBand(d, band)) : [];
    const doctors = inBand.length ? inBand : allDoctors;

    const idx = parseNumberChoice(text) ?? await resolveChoiceWithAI(text, doctors.map(d => d.name));

    if (!idx || !doctors[idx - 1]) {
      const lines = doctors.map((d, i) => `  ${i + 1}. ${d.name}`).join("\n");
      return replyInContext(text, "eligiendo médico", `¿Con cuál de estos médicos prefiere?\n\n${lines}`, session, clinic);
    }

    const doctor = doctors[idx - 1];
    draft = { ...draft, doctorId: doctor.id, doctorName: doctor.name };

    const slots = await getSlotsForDefaultDay(doctor, conversationId, band);
    if (!slots.length) {
      const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
      return reply(`No hay horarios disponibles para ${doctor.name}. ¿Desea elegir otro médico?`, "none", newSession);
    }

    draft = { ...draft, offeredSlots: slots };
    const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
    return reply(slotsMessage(slots, clinic.timezone), "none", newSession);
  }

  // ── choosing_slot_any ─────────────────────────────────────────────────────
  // Horarios de VARIOS médicos de la especialidad: el paciente elige por hora y
  // el médico queda determinado por la opción que eligió.
  if (step === "choosing_slot_any") {
    const nowMs = Date.now() + 60 * 60 * 1000; // 1h de margen
    const slots = (draft.offeredSlotsAny ?? []).filter(s => new Date(s.start).getTime() > nowMs);

    if (!slots.length) {
      const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
      return reply("Esos horarios ya no están disponibles 😔 ¿Desea que busquemos nuevos turnos?", "none", newSession);
    }

    const labels = slots.map(s => `${formatSlotLocal(s.start, clinic.timezone)} (${s.doctorName})`);
    let idx = parseNumberChoice(text);

    if (!idx || !slots[idx - 1]) {
      const resolved = await resolveSlotChoiceWithAI(text, labels);
      if (resolved.clarify) {
        return reply(`${resolved.clarify}\n\n${slotsWithDoctorMessage(slots, clinic.timezone)}`, "none", session);
      }
      idx = resolved.index;
    }

    if (!idx || !slots[idx - 1]) {
      return replyInContext(text, "eligiendo horario", slotsWithDoctorMessage(slots, clinic.timezone), session, clinic);
    }

    const chosen = slots[idx - 1];
    draft = { ...draft, doctorId: chosen.doctorId, doctorName: chosen.doctorName };

    return confirmSlotAndHold({ conversationId, business, contactPhone, chosen, clinic, draft });
  }

  // ── choosing_slot ─────────────────────────────────────────────────────────
  if (step === "choosing_slot") {
    const nowMs = Date.now() + 60 * 60 * 1000; // 1h de margen
    let slots = (draft.offeredSlots ?? []).filter(s => new Date(s.start).getTime() > nowMs);

    // Si todos los slots guardados ya pasaron, regenerar desde el doctor actual.
    if (slots.length === 0 && draft.doctorId) {
      const freshDoctor = await getDoctorById(draft.doctorId);
      if (freshDoctor) {
        slots = await getSlotsForDefaultDay(freshDoctor, conversationId);
        if (!slots.length) {
          const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
          return reply("Los horarios que le habíamos mostrado ya no están disponibles y no hay nuevos turnos en los próximos días 😔 ¿Le puedo ayudar en algo más?", "none", newSession);
        }
        draft = { ...draft, offeredSlots: slots };
        const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
        return reply(`Los horarios anteriores ya pasaron 😊 Aquí los próximos disponibles:\n\n${slotsMessage(slots, clinic.timezone)}`, "none", newSession);
      }
    }

    // ¿El paciente pide explícitamente otro día en vez de elegir de la lista actual?
    if (draft.doctorId) {
      const requestedDate = await resolveDateRequestWithAI(text, clinic.timezone);
      if (requestedDate) {
        const dayDoctor = await getDoctorById(draft.doctorId);
        if (dayDoctor) {
          const daySlots = await getSlotsForDate(dayDoctor, conversationId, requestedDate);
          if (!daySlots.length) {
            return reply(
              `No hay horarios disponibles ese día 😔 Aquí los horarios que sí tenemos:\n\n${slotsMessage(slots, clinic.timezone)}`,
              "none",
              session,
            );
          }
          draft = { ...draft, offeredSlots: daySlots };
          const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
          return reply(slotsMessage(daySlots, clinic.timezone), "none", newSession);
        }
      }
    }

    const slotLabels = slots.map(s => formatSlotLocal(s.start, clinic.timezone));
    let idx = parseNumberChoice(text);

    if (!idx || !slots[idx - 1]) {
      const resolved = await resolveSlotChoiceWithAI(text, slotLabels);
      if (resolved.clarify) {
        // Hora informal/ambigua ("las 5" sin am/pm ni día): pedir el dato que
        // falta en vez de adivinar o cerrar el flujo. Seguimos en choosing_slot.
        return reply(`${resolved.clarify}\n\n${slotsMessage(slots, clinic.timezone)}`, "none", session);
      }
      idx = resolved.index;
    }

    if (!idx || !slots[idx - 1]) {
      return replyInContext(text, "eligiendo horario", slotsMessage(slots, clinic.timezone), session, clinic);
    }

    // El hold, la re-verificación anti doble-booking y el reagendamiento
    // confirmado viven en confirmSlotAndHold (compartido con choosing_slot_any).
    return confirmSlotAndHold({
      conversationId,
      business,
      contactPhone,
      chosen: slots[idx - 1],
      clinic,
      draft,
    });
  }

  // ── collecting_name / collecting_ci / collecting_reason ───────────────────
  // Los tres pasos se preguntan juntos. Si el cliente responde todo en un
  // mensaje, GPT extrae los tres campos. Si solo responde uno, avanzamos
  // acumulando lo que falte.
  if (step === "collecting_name" || step === "collecting_ci" || step === "collecting_reason") {
    // Intentar extraer campos faltantes con GPT.
    const missing = {
      name: !draft.patientName,
      ci: !draft.patientCi,
      reason: !draft.reason,
    };

    if (missing.name || missing.ci || missing.reason) {
      try {
        const fieldsNeeded = [
          missing.name && "nombre completo del paciente",
          missing.ci && "número de Carnet de Identidad (CI, solo dígitos)",
          missing.reason && "motivo de consulta",
        ].filter(Boolean).join(", ");

        const { text: extracted } = await generateText({
          model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
          system: `Extrae los siguientes campos del mensaje del usuario: ${fieldsNeeded}.
Responde ÚNICAMENTE con un JSON con las claves: "name", "ci", "reason".
Si un campo no está presente en el mensaje, usa null.
Ejemplos:
- "Me llamo Juan Pérez, CI 1234567, me duele la cabeza" → {"name":"Juan Pérez","ci":"1234567","reason":"dolor de cabeza"}
- "Juan Pérez" → {"name":"Juan Pérez","ci":null,"reason":null}
- "1234567" → {"name":null,"ci":"1234567","reason":null}`,
          prompt: text,
          temperature: 0,
          abortSignal: AbortSignal.timeout(8000),
        });

        const parsed = JSON.parse(extracted.trim().replace(/^```json|```$/g, "").trim());
        if (parsed.name && missing.name) draft = { ...draft, patientName: String(parsed.name) };
        if (parsed.ci && missing.ci) draft = { ...draft, patientCi: String(parsed.ci).replace(/\s+/g, "") };
        if (parsed.reason && missing.reason) draft = { ...draft, reason: String(parsed.reason) };
      } catch {
        // Si GPT falla, tratar el texto como el campo que falta primero.
        if (missing.name && text.length >= 3) draft = { ...draft, patientName: text };
        else if (missing.ci) draft = { ...draft, patientCi: text.replace(/\s+/g, "") };
        else if (missing.reason && text.length >= 3) draft = { ...draft, reason: text };
      }
    }

    // Ver qué falta aún y pedir solo eso.
    const stillMissingName = !draft.patientName;
    const stillMissingCi = !draft.patientCi;
    const stillMissingReason = !draft.reason;

    if (stillMissingName || stillMissingCi || stillMissingReason) {
      const pending = [
        stillMissingName && "👤 *Nombre completo*",
        stillMissingCi && "🪪 *Carnet de Identidad (CI)*",
        stillMissingReason && "💊 *Motivo de consulta*",
      ].filter(Boolean).join("\n");
      const currentStep = stillMissingName ? "collecting_name" : stillMissingCi ? "collecting_ci" : "collecting_reason";
      const newSession = await saveAndReturn(conversationId, business, currentStep, draft, hold);
      return reply(`Gracias 😊 Aún me falta:\n\n${pending}`, "none", newSession);
    }

    // Todos los datos completos → ir a elegir pago.
    const newSession = await saveAndReturn(conversationId, business, "choosing_payment", draft, hold);

    // El precio sale SIEMPRE del médico. Antes había un 150 Bs de respaldo — un
    // monto del seed viejo que hoy no existe en ningún tarifario (la clínica
    // cobra 60 y 80). Pedirle a un paciente una cifra inventada es peor que
    // pedirle que reintente, así que si no se puede recuperar, se corta.
    const doc = draft.doctorId ? await getDoctorById(draft.doctorId) : null;
    const price = doc?.consultationPrice ?? null;

    if (price === null) {
      console.error("no se pudo recuperar el precio de consulta", { doctorId: draft.doctorId });
      return reply(
        "Disculpe, tuve un problema al recuperar el precio de la consulta 😔 Escríbame de nuevo en un momento o llámenos al " +
          `${clinic.generalInfo.phone} y lo resolvemos.`,
        "none",
        await resetAndReturn(conversationId, business),
      );
    }

    return reply(
      `Perfecto 😊 ¿Cómo prefiere pagar la consulta? (*${price} Bs*)\n\n  1. QR BNB\n  2. Efectivo`,
      "none",
      newSession,
    );
  }

  // ── choosing_payment ──────────────────────────────────────────────────────
  if (step === "choosing_payment") {
    const choice = parseNumberChoice(text);
    const lc = text.toLowerCase();
    let paymentMethod: "qr" | "cash" | null = null;

    if (choice === 1 || lc.includes("qr") || lc.includes("código") || lc.includes("transferencia")) {
      paymentMethod = "qr";
    } else if (choice === 2 || lc.includes("efectivo") || lc.includes("cash") || lc.includes("contado")) {
      paymentMethod = "cash";
    }

    if (!paymentMethod) {
      return reply("No entendí 😊 Responda *1* para QR BNB o *2* para Efectivo.", "none", session);
    }

    draft = { ...draft, paymentMethod };

    if (!draft.doctorId || !draft.slotStart || !draft.slotEnd || !draft.patientName) {
      return reply("Hubo un error al recuperar sus datos. Comencemos de nuevo.", "none", await resetAndReturn(conversationId, business));
    }

    const doctor = await getDoctorById(draft.doctorId);
    if (!doctor) {
      return reply("No pude recuperar los datos del médico. Intente de nuevo.", "none", await resetAndReturn(conversationId, business));
    }

    if (paymentMethod === "cash") {
      const appointmentId = await createAppointment({
        business,
        conversationId,
        contactPhone,
        patientName: draft.patientName,
        patientCi: draft.patientCi,
        reason: draft.reason,
        specialtyId: draft.specialtyId,
        doctorId: draft.doctorId,
        scheduledStart: draft.slotStart,
        scheduledEnd: draft.slotEnd,
        status: "confirmed",
        paymentMethod: "cash",
      });

      // createAppointment devuelve null si el INSERT falló — lo más probable,
      // gracias al índice único de la BD, es que otro paciente tomó este mismo
      // horario con este doctor mientras completábamos los datos. No mentirle
      // "confirmada": ofrecer horarios frescos.
      if (!appointmentId) {
        const freshSlots = await getAvailableSlots(doctor, conversationId);
        if (!freshSlots.length) {
          const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
          return reply("Lo sentimos, justo se ocupó ese horario y no quedan más turnos libres para este médico 😔 ¿Le puedo ayudar en otra cosa?", "none", newSession);
        }
        draft = { ...draft, offeredSlots: freshSlots };
        const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
        return reply(`Justo se ocupó ese horario 😔 Aquí los próximos disponibles:\n\n${slotsMessage(freshSlots, clinic.timezone)}`, "none", newSession);
      }

      // Si esto venía de un reagendamiento de una cita aún no confirmada, la
      // anterior sigue viva hasta acá — cerrarla ahora evita dejar dos citas
      // activas para el mismo paciente.
      if (draft.reschedulingAppointmentId) {
        await closePreviousAppointment(draft.reschedulingAppointmentId);
      }

      // Claim atómico: si otro proceso (ej. el trigger de confirmaciones) ya está
      // creando el evento de esta cita, no duplicamos (ver P1.7 / migración
      // 20260717000000). Recién insertada, lo normal es ganar el claim siempre.
      const claimedCash = doctor.googleCalendarId
        ? await claimAppointmentForEventCreation(appointmentId)
        : false;

      if (doctor.googleCalendarId && claimedCash) {
        try {
          console.log("createAppointmentEvent starting", {
            calendarId: doctor.googleCalendarId,
            start: draft.slotStart,
            end: draft.slotEnd,
            patient: draft.patientName,
          });
          const eventId = await createAppointmentEvent({
            calendarId: doctor.googleCalendarId,
            timezone: doctor.timezone,
            startIso: draft.slotStart,
            endIso: draft.slotEnd,
            summary: `Cita: ${draft.patientName} — ${doctor.name}`,
            description: [
              `Paciente: ${draft.patientName}`,
              `CI: ${draft.patientCi ?? "—"}`,
              `Tel: ${contactPhone}`,
              `Especialidad: ${draft.specialtyName ?? "—"}`,
              `Motivo: ${draft.reason ?? "—"}`,
              `Pago: Efectivo`,
            ].join("\n"),
          });
          console.log("createAppointmentEvent result", { eventId });
          if (appointmentId && eventId) {
            const currentStatus = await getAppointmentStatus(appointmentId);
            if (currentStatus === "canceled") {
              // Se reagendó/canceló mientras se creaba el evento: no dejar un
              // evento huérfano en Calendar.
              await deleteAppointmentEvent(doctor.googleCalendarId, eventId);
              await releaseAppointmentEventClaim(appointmentId);
            } else {
              await updateAppointment(appointmentId, { googleEventId: eventId });
            }
          } else {
            await releaseAppointmentEventClaim(appointmentId);
          }
        } catch (err: any) {
          console.error("createAppointmentEvent (cash) failed", {
            message: err?.message,
            status: err?.status ?? err?.code,
            details: err?.errors ?? err?.response?.data,
          });
          await releaseAppointmentEventClaim(appointmentId);
          // La cita quedó confirmada pero SIN evento en el calendario. Dejar nota
          // para que la secretaria lo revise (panel filtro "⚠️ Revisar").
          if (appointmentId) {
            await updateAppointment(appointmentId, {
              notes: "⚠️ Cita confirmada pero falló crear el evento en Google Calendar. Verificar el calendario del doctor.",
            });
          }
        }
      } else if (!doctor.googleCalendarId) {
        console.warn("doctor has no googleCalendarId, skipping event creation", { doctorId: doctor.id });
        if (appointmentId) {
          await updateAppointment(appointmentId, {
            notes: "⚠️ El doctor no tiene calendario configurado: la cita no aparece en ningún Google Calendar.",
          });
        }
      }
      // else: no se ganó el claim porque otro proceso ya está creando el evento
      // para esta cita — no hay nada que hacer acá, ese proceso lo resuelve.

      await resetBookingSession(conversationId, business);
      const friendlySlot = formatSlotLocal(draft.slotStart, clinic.timezone);
      return reply(
        `✅ *¡Cita confirmada!*\n\n📅 ${friendlySlot}\n👨‍⚕️ ${doctor.name}\n👤 ${draft.patientName}\n💊 ${draft.reason ?? "—"}\n💵 Pago en efectivo al llegar.\n\n📍 ${clinic.generalInfo.address}\n🗺️ ${clinic.generalInfo.mapsUrl}\n\n¡Hasta pronto! 😊`,
        "none",
        { conversationId, step: "done", draft: {}, hold: emptyHold() },
      );
    }

    // QR → awaiting_payment.
    const appointmentId = await createAppointment({
      business,
      conversationId,
      contactPhone,
      patientName: draft.patientName,
      patientCi: draft.patientCi,
      reason: draft.reason,
      specialtyId: draft.specialtyId,
      doctorId: draft.doctorId,
      scheduledStart: draft.slotStart,
      scheduledEnd: draft.slotEnd,
      status: "awaiting_payment",
      paymentMethod: "qr",
    });

    // Igual que en efectivo: null significa que el horario se ocupó justo
    // antes de crear esta fila (protegido por el índice único de la BD).
    if (!appointmentId) {
      const freshSlots = await getAvailableSlots(doctor, conversationId);
      if (!freshSlots.length) {
        const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
        return reply("Lo sentimos, justo se ocupó ese horario y no quedan más turnos libres para este médico 😔 ¿Le puedo ayudar en otra cosa?", "none", newSession);
      }
      draft = { ...draft, offeredSlots: freshSlots };
      const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
      return reply(`Justo se ocupó ese horario 😔 Aquí los próximos disponibles:\n\n${slotsMessage(freshSlots, clinic.timezone)}`, "none", newSession);
    }

    // Mismo caso que en efectivo: reagendamiento de una cita no confirmada.
    if (draft.reschedulingAppointmentId) {
      await closePreviousAppointment(draft.reschedulingAppointmentId);
    }

    draft = { ...draft, appointmentId };
    const newSession = await saveAndReturn(conversationId, business, "awaiting_proof", draft, hold);
    const friendlySlot = formatSlotLocal(draft.slotStart, clinic.timezone);
    return reply(
      `Perfecto 😊 Le envío el QR para el pago.\n\n📅 *${friendlySlot}*\n👨‍⚕️ ${doctor.name}\n👤 ${draft.patientName}\n💊 ${draft.reason ?? "—"}\n\nUna vez realizado el pago, envíe el *comprobante* (foto o PDF) y lo validamos. ¡Gracias! 🙏`,
      "send_qr",
      newSession,
    );
  }

  // ── confirming_cancel ─────────────────────────────────────────────────────
  // Segundo paso de la cancelación: acá sí se destruye la cita. Ante cualquier
  // respuesta que no sea un sí claro se mantiene la cita, que es el lado seguro
  // del error.
  if (step === "confirming_cancel") {
    const lc = text.toLowerCase();
    const dice_si = /\b(si|sí|sip|claro|confirmo|dale|correcto|afirmativo|asi es|así es|por favor)\b/i.test(lc);
    const dice_no = /\b(no|nop|mejor no|olvidelo|olvídelo|dejalo|déjalo|mantener|mantenerla|cancele no)\b/i.test(lc);

    if (!dice_si || dice_no) {
      const newSession = await resetAndReturn(conversationId, business);
      return reply(
        dice_no
          ? "Perfecto, su cita sigue en pie 😊 ¿Puedo ayudarle en algo más?"
          : "No estoy seguro de haber entendido, así que dejo su cita como estaba 😊 Si desea cancelarla, escríbame *quiero cancelar mi cita*.",
        "none",
        newSession,
      );
    }

    const appointmentId = draft.cancelingAppointmentId;
    const appointment = appointmentId ? await getAppointmentById(appointmentId) : null;

    if (!appointment || appointment.status === "canceled") {
      const newSession = await resetAndReturn(conversationId, business);
      return reply(clinic.replies.noActiveAppointment, "none", newSession);
    }

    await updateAppointment(appointment.id, { status: "canceled", cancelReason: "Cancelada por el paciente" });

    if (appointment.googleEventId && appointment.doctorId) {
      const doc = await getDoctorById(appointment.doctorId);
      if (doc?.googleCalendarId) {
        try {
          await deleteAppointmentEvent(doc.googleCalendarId, appointment.googleEventId);
          await updateAppointment(appointment.id, { googleEventId: null as unknown as string });
        } catch (err) {
          console.error("deleteAppointmentEvent (cancel) failed", err);
        }
      }
    }

    const friendlySlot = appointment.scheduledStart
      ? formatSlotLocal(appointment.scheduledStart, clinic.timezone)
      : "su cita";
    const newSession = await resetAndReturn(conversationId, business);
    return reply(
      `Su cita del *${friendlySlot}* ha sido cancelada ✅. Si desea agendar una nueva, escríbame cuando quiera 😊`,
      "none",
      newSession,
    );
  }

  // ── awaiting_proof (texto sin imagen) ─────────────────────────────────────
  if (step === "awaiting_proof") {
    return reply("Estamos esperando el *comprobante de pago* (imagen o PDF). Por favor envíelo para confirmar su cita 😊", "none", session);
  }

  return reply("Su cita ya está registrada. ¿Puedo ayudarle en algo más? 😊", "none", session);
}

// ─── Comprobante recibido (media entrante) ────────────────────────────────────

// Modelo de confianza: la mayoría de los pacientes son clientes recurrentes que
// sí pagan, así que apenas llega el comprobante la cita queda CONFIRMADA de
// inmediato (crea el evento en Calendar y avisa al paciente), igual que el pago
// en efectivo. La secretaria ya NO aprueba cada comprobante uno por uno: la
// verificación con GPT-vision corre en paralelo solo para DEJAR UNA NOTA en la
// cita cuando el monto no cuadra o la imagen no parece un comprobante válido.
// Si al revisar esa nota la secretaria confirma que el pago era inválido,
// cancela la cita manualmente (status = 'canceled'), lo que dispara el borrado
// automático del evento en Calendar.
export async function handlePaymentProof(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  mediaUrl: string;
  session: BookingSession;
  clinic: ClinicConfig;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone, session, mediaUrl, clinic } = params;
  const { draft } = session;

  if (!draft.appointmentId) {
    const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
    return reply(clinic.replies.proofButNoBooking, "none", newSession);
  }

  // Escritura CRÍTICA: si esto no queda guardado, no hay que crear el evento de
  // Calendar ni decirle al cliente "confirmada" — se vería confirmada en
  // WhatsApp pero no en la BD, y los recordatorios/confirmaciones automáticas
  // (que filtran por status='confirmed') nunca la tomarían. Un reintento cubre
  // fallos transitorios; si vuelve a fallar, se deja para revisión manual.
  let confirmed = await updateAppointment(draft.appointmentId, {
    paymentProofUrl: mediaUrl,
    status: "confirmed",
  });
  if (!confirmed) {
    confirmed = await updateAppointment(draft.appointmentId, {
      paymentProofUrl: mediaUrl,
      status: "confirmed",
    });
  }

  if (!confirmed) {
    console.error("handlePaymentProof: no se pudo confirmar la cita tras reintento", {
      appointmentId: draft.appointmentId,
    });
    await updateAppointment(draft.appointmentId, {
      notes: "🚨 Error al confirmar automáticamente el pago (falló la escritura en BD). Revisar y confirmar o cancelar manualmente.",
    });
    const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
    return reply(
      "¡Gracias por su comprobante! 🙏 Estamos terminando de procesar su confirmación, en unos minutos le avisamos. Ya derivamos su petición a un asesor de la clínica, que le confirmará en un momento.",
      "none",
      newSession,
    );
  }

  const doctor = draft.doctorId ? await getDoctorById(draft.doctorId) : null;

  // Crear el evento en Calendar de inmediato (mismo patrón que el pago en
  // efectivo). El status ya se puso 'confirmed' arriba, lo que también puede
  // disparar el trigger de confirmaciones de Supabase — el claim atómico evita
  // que ambos caminos creen el evento dos veces (P1.7).
  const claimedQr =
    doctor?.googleCalendarId && draft.slotStart && draft.slotEnd
      ? await claimAppointmentForEventCreation(draft.appointmentId)
      : false;

  if (doctor?.googleCalendarId && draft.slotStart && draft.slotEnd && claimedQr) {
    try {
      const eventId = await createAppointmentEvent({
        calendarId: doctor.googleCalendarId,
        timezone: doctor.timezone,
        startIso: draft.slotStart,
        endIso: draft.slotEnd,
        summary: `Cita: ${draft.patientName ?? "Paciente"} — ${doctor.name}`,
        description: [
          `Paciente: ${draft.patientName ?? "—"}`,
          `CI: ${draft.patientCi ?? "—"}`,
          `Tel: ${contactPhone}`,
          `Especialidad: ${draft.specialtyName ?? "—"}`,
          `Motivo: ${draft.reason ?? "—"}`,
          `Pago: QR BNB`,
        ].join("\n"),
      });
      if (eventId) {
        const currentStatus = await getAppointmentStatus(draft.appointmentId);
        if (currentStatus === "canceled") {
          // Se reagendó/canceló mientras se creaba el evento: no dejar un
          // evento huérfano en Calendar.
          await deleteAppointmentEvent(doctor.googleCalendarId, eventId);
          await releaseAppointmentEventClaim(draft.appointmentId);
        } else {
          await updateAppointment(draft.appointmentId, { googleEventId: eventId });
        }
      } else {
        await releaseAppointmentEventClaim(draft.appointmentId);
      }
    } catch (err) {
      console.error("createAppointmentEvent (qr) failed", err);
      await releaseAppointmentEventClaim(draft.appointmentId);
      // Confirmada pero sin evento: dejar nota para revisión de la secretaria.
      await updateAppointment(draft.appointmentId, {
        notes: "⚠️ Cita confirmada pero falló crear el evento en Google Calendar. Verificar el calendario del doctor.",
      });
    }
  } else if (draft.doctorId && !doctor?.googleCalendarId) {
    await updateAppointment(draft.appointmentId, {
      notes: "⚠️ El doctor no tiene calendario configurado: la cita no aparece en ningún Google Calendar.",
    });
  }
  // Si había calendarId/horario pero no se ganó el claim, otro proceso (el
  // trigger de confirmaciones) ya está creando el evento — no hacemos nada más.

  // Verificación best-effort del monto: NO bloquea la confirmación, solo deja
  // una nota para revisión posterior de la secretaria si algo no cuadra.
  if (doctor?.consultationPrice != null) {
    try {
      const imgRes = await fetch(mediaUrl, {
        headers: process.env.KAPSO_API_KEY ? { "X-API-Key": process.env.KAPSO_API_KEY } : {},
        signal: AbortSignal.timeout(10000),
      });

      // Límite de tamaño: no cargar comprobantes gigantes a memoria (la cita ya
      // quedó confirmada; esta verificación es best-effort y puede saltarse).
      const contentLength = Number(imgRes.headers.get("content-length") ?? 0);
      const MAX_PROOF_BYTES = 8 * 1024 * 1024; // 8 MB
      if (imgRes.ok && contentLength <= MAX_PROOF_BYTES) {
        const imgBuffer = await imgRes.arrayBuffer();
        const imgUint8 = new Uint8Array(imgBuffer);

        const { text: rawAmount } = await generateText({
          model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
          messages: [
            {
              role: "user",
              content: [
                { type: "image", image: imgUint8 },
                {
                  type: "text",
                  text: `Este es un comprobante de transferencia/pago QR boliviano. Extrae ÚNICAMENTE el monto total pagado en bolivianos (Bs). Responde solo con el número (ej: "150" o "85.50"). Si no puedes leerlo o no es un comprobante de pago, responde "N/A".`,
                },
              ],
            },
          ],
          abortSignal: AbortSignal.timeout(15000),
        });

        const cleaned = rawAmount.trim().replace(/[^0-9.]/g, "");
        const amount = parseFloat(cleaned);
        const expectedPrice = doctor.consultationPrice;

        if (isNaN(amount)) {
          await updateAppointment(draft.appointmentId, {
            notes: `⚠️ Revisar comprobante: no se pudo leer un monto. Verificar manualmente antes de la consulta.`,
          });
        } else if (amount < expectedPrice) {
          await updateAppointment(draft.appointmentId, {
            notes: `⚠️ Revisar pago: monto detectado ${amount} Bs, precio de consulta ${expectedPrice} Bs.`,
          });
        }
      }
    } catch (err) {
      console.error("GPT vision payment check failed", err);
    }
  }

  const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
  const friendlySlot = draft.slotStart ? formatSlotLocal(draft.slotStart, clinic.timezone) : null;
  return reply(
    [
      `✅ ¡Recibimos su comprobante! Su cita quedó *confirmada* 😊`,
      ``,
      friendlySlot ? `📅 ${friendlySlot}` : null,
      doctor ? `👨‍⚕️ ${doctor.name}` : null,
      ``,
      `Le esperamos en la Clínica San Martín de Porres. Cualquier consulta, escríbanos por aquí. ¡Hasta pronto! 🙏`,
    ].filter((l) => l !== null).join("\n"),
    "none",
    newSession,
  );
}

// ─── Consultar cita activa ("¿cuándo es mi cita?") ───────────────────────────
// Solo informa, no cambia el estado de la sesión ni de la cita.

export async function checkActiveAppointment(params: {
  business: string;
  contactPhone: string;
  session: BookingSession;
  clinic: ClinicConfig;
}): Promise<BookingResult> {
  const { business, contactPhone, session, clinic } = params;

  const appointment = await findActiveAppointmentByPhone(business, contactPhone);
  if (!appointment) {
    return reply(clinic.replies.noActiveAppointment, "none", session);
  }

  const doctor = appointment.doctorId ? await getDoctorById(appointment.doctorId) : null;
  const friendlySlot = appointment.scheduledStart
    ? formatSlotLocal(appointment.scheduledStart, clinic.timezone)
    : null;

  const statusNote =
    appointment.status === "awaiting_payment"
      ? "\n\n_Su cita está reservada, pero aún esperamos su comprobante de pago para confirmarla._"
      : appointment.status === "payment_review"
        ? "\n\n_Estamos terminando de verificar su comprobante de pago._"
        : "";

  return reply(
    [
      friendlySlot ? `📅 Su cita es el *${friendlySlot}*` : `📅 Su cita está registrada, pero aún no tiene horario asignado.`,
      doctor ? `👨‍⚕️ ${doctor.name}` : null,
      appointment.reason ? `💊 ${appointment.reason}` : null,
      ``,
      `📍 ${clinic.generalInfo.address}`,
    ].filter((l) => l !== null).join("\n") + statusNote,
    "none",
    session,
  );
}

// ─── Cancelar cita activa ─────────────────────────────────────────────────────

export async function cancelActiveAppointment(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  session: BookingSession;
  clinic: ClinicConfig;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone, clinic } = params;

  const appointment = await findActiveAppointmentByPhone(business, contactPhone);
  if (!appointment) {
    await resetBookingSession(conversationId, business);
    return reply(clinic.replies.noActiveAppointment, "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  // NO se cancela todavía. Cancelar borra la cita y su evento de Calendar sin
  // vuelta atrás, y el patrón que dispara esto es tan amplio como /cancelar|anular/:
  // un "quería cancelar… mejor no" alcanzaba para destruirla. Se muestra la cita
  // y se espera un sí explícito; lo ejecuta el paso confirming_cancel.
  const doctor = appointment.doctorId ? await getDoctorById(appointment.doctorId) : null;
  const friendlySlot = appointment.scheduledStart
    ? formatSlotLocal(appointment.scheduledStart, clinic.timezone)
    : "su cita";

  const newSession = await saveAndReturn(
    conversationId,
    business,
    "confirming_cancel",
    { cancelingAppointmentId: appointment.id },
    emptyHold(),
  );

  return reply(
    [
      `¿Confirma que desea cancelar esta cita?`,
      ``,
      `📅 ${friendlySlot}`,
      doctor ? `👨‍⚕️ ${doctor.name}` : null,
      ``,
      `Responda *SÍ* para cancelarla o *NO* para mantenerla 😊`,
    ].filter((l) => l !== null).join("\n"),
    "none",
    newSession,
  );
}

// ─── Reprogramar cita activa ──────────────────────────────────────────────────

export async function rescheduleActiveAppointment(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  session: BookingSession;
  clinic: ClinicConfig;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone, clinic } = params;

  const appointment = await findActiveAppointmentByPhone(business, contactPhone);
  if (!appointment) {
    return reply(clinic.replies.noActiveAppointment, "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  if (appointment.rescheduleCount >= 1) {
    return reply(
      "Solo se permite una reprogramación por cita 😊 Si necesita cancelar y agendar una nueva, con gusto le ayudo.",
      "none",
      { conversationId, step: "idle", draft: {}, hold: emptyHold() },
    );
  }

  if (!appointment.doctorId) {
    return reply("No pude recuperar los datos de su cita. Contáctenos directamente.", "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  // La cita anterior se mantiene VIVA hasta que el paciente elija el horario
  // nuevo; la cierra closePreviousAppointment() una vez creada la nueva. Si acá
  // se cancelara por adelantado, abandonar la conversación en este punto dejaría
  // al paciente sin ninguna de las dos.
  const doctor = await getDoctorById(appointment.doctorId);
  if (!doctor) {
    await resetBookingSession(conversationId, business);
    return reply("No pude recuperar los datos del médico. Por favor inicie un nuevo agendamiento.", "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  const slots = await getSlotsForDefaultDay(doctor, conversationId);
  if (!slots.length) {
    await resetBookingSession(conversationId, business);
    return reply("No hay horarios disponibles para los próximos días. ¿Desea agendar con otra especialidad?", "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  const rescheduleConfirmed = appointment.status === "confirmed";
  const draft: BookingDraft = {
    specialtyId: appointment.specialtyId ?? undefined,
    doctorId: appointment.doctorId,
    doctorName: doctor.name,
    offeredSlots: slots,
    reschedulingAppointmentId: appointment.id,
    patientName: appointment.patientName ?? undefined,
    patientCi: appointment.patientCi ?? undefined,
    reason: appointment.reason ?? undefined,
    paymentMethod: (appointment.paymentMethod as PaymentMethod | undefined) ?? undefined,
    paymentProofUrl: appointment.paymentProofUrl ?? undefined,
    rescheduleConfirmed,
  };
  const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
  // El texto ya no dice "anulé su cita anterior": ahora sigue vigente hasta que
  // elija el horario nuevo, y sería mentirle si abandona acá.
  const intro = rescheduleConfirmed
    ? "Claro 😊 Elija el nuevo horario y muevo su cita (no necesita volver a pagar):"
    : "Claro 😊 Elija el nuevo horario y muevo su cita:";
  return reply(`${intro}\n\n${slotsMessage(slots, clinic.timezone)}`, "none", newSession);
}
