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
// Bloqueo de 30 min (OBLIGATORIO MVP):
//   Al confirmar slot → re-verificar disponibilidad → escribir hold en BD
//   → pasar a collecting_name. Si el slot fue tomado → re-ofrecer.
//
// QR: al llegar el comprobante se confirma de inmediato (modelo de confianza,
// ver handlePaymentProof); la secretaria solo cancela si detecta un pago inválido.
// Efectivo: se crea el evento en Google Calendar de inmediato.
// ============================================================================

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

import {
  getBusyIntervals,
  computeAvailableSlots,
  createAppointmentEvent,
  deleteAppointmentEvent,
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
} from "@/lib/clinic/data";
import type {
  BookingSession,
  BookingDraft,
  BookingHold,
  TimeSlot,
  Doctor,
} from "@/lib/clinic/types";
import { clinic } from "@/lib/clinic/config";

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
async function replyInContext(
  userText: string,
  contextHint: string,
  followUp: string,
  session: BookingSession,
): Promise<BookingResult> {
  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: `Eres la recepcionista virtual de la Clínica San Martín de Porres (Bolivia).
Estás ayudando a un paciente a agendar una cita y está en el paso: ${contextHint}.
Responde su pregunta de forma breve y cálida, como una recepcionista boliviana empática.
Al final de tu respuesta, invítalo suavemente a continuar con el agendamiento.
No inventes horarios, precios ni doctores. Si no sabes algo, dile que puede llamar al +591 75681881.`,
      prompt: userText,
      temperature: 0.7,
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

function slotsMessage(slots: TimeSlot[], tz: string): string {
  const lines = slots.map((s, i) => `  ${i + 1}. ${formatSlotLocal(s.start, tz)}`);
  return `Estos son los horarios disponibles:\n\n${lines.join("\n")}\n\n¿Cuál le viene bien?`;
}

// ─── Avanzar la máquina de pasos ─────────────────────────────────────────────

export async function advanceBooking(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  incomingText: string;
  session: BookingSession;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone, incomingText, session } = params;
  const text = incomingText.trim();
  let { step, draft, hold } = session;

  // ── idle / start ──────────────────────────────────────────────────────────
  if (step === "idle") {
    const specialties = await getSpecialties(business);
    if (!specialties.length) {
      return reply(
        "Lo sentimos, en este momento no hay especialidades disponibles. Contáctenos al +591 75681881.",
        "none",
        { conversationId, step: "idle", draft: {}, hold: emptyHold() },
      );
    }
    const lines = specialties.map((s, i) => `  ${i + 1}. ${s.name}`).join("\n");
    draft = {};
    const newSession = await saveAndReturn(conversationId, business, "choosing_specialty", draft, emptyHold());
    return reply(`Perfecto 😊 ¿Qué especialidad necesita?\n\n${lines}\n\n¿Cuál necesita?`, "none", newSession);
  }

  // ── choosing_specialty ────────────────────────────────────────────────────
  if (step === "choosing_specialty") {
    const specialties = await getSpecialties(business);
    const idx = parseNumberChoice(text) ?? await resolveChoiceWithAI(text, specialties.map(s => s.name));

    if (!idx || idx < 1 || idx > specialties.length) {
      const lines = specialties.map((s, i) => `  ${i + 1}. ${s.name}`).join("\n");
      return replyInContext(text, "eligiendo especialidad", `¿Cuál de estas especialidades necesita?\n\n${lines}`, session);
    }

    const specialty = specialties[idx - 1];
    draft = { ...draft, specialtyId: specialty.id, specialtyName: specialty.name };

    const doctors = await getDoctorsBySpecialty(business, specialty.id);
    if (!doctors.length) {
      const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
      return reply(`Lo sentimos, ${specialty.name} no tiene médicos disponibles. ¿Desea elegir otra especialidad?`, "none", newSession);
    }

    if (doctors.length === 1) {
      const doctor = doctors[0];
      draft = { ...draft, doctorId: doctor.id, doctorName: doctor.name };

      const slots = await getAvailableSlots(doctor, conversationId);
      if (!slots.length) {
        const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
        return reply(`No hay horarios disponibles para ${doctor.name} en los próximos días. ¿Puedo ayudarle en algo más?`, "none", newSession);
      }

      draft = { ...draft, offeredSlots: slots };
      const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
      return reply(`Atenderá *${doctor.name}*.\n\n${slotsMessage(slots, clinic.timezone)}`, "none", newSession);
    }

    const lines = doctors.map((d, i) => `  ${i + 1}. ${d.name}${d.consultationPrice ? ` — ${d.consultationPrice} Bs` : ""}`).join("\n");
    const newSession = await saveAndReturn(conversationId, business, "choosing_doctor", draft, emptyHold());
    return reply(`Médicos disponibles en ${specialty.name}:\n\n${lines}\n\n¿Con quién prefiere?`, "none", newSession);
  }

  // ── choosing_doctor ───────────────────────────────────────────────────────
  if (step === "choosing_doctor") {
    const doctors = draft.specialtyId ? await getDoctorsBySpecialty(business, draft.specialtyId) : [];
    const idx = parseNumberChoice(text) ?? await resolveChoiceWithAI(text, doctors.map(d => d.name));

    if (!idx || !doctors[idx - 1]) {
      const lines = doctors.map((d, i) => `  ${i + 1}. ${d.name}`).join("\n");
      return replyInContext(text, "eligiendo médico", `¿Con cuál de estos médicos prefiere?\n\n${lines}`, session);
    }

    const doctor = doctors[idx - 1];
    draft = { ...draft, doctorId: doctor.id, doctorName: doctor.name };

    const slots = await getAvailableSlots(doctor, conversationId);
    if (!slots.length) {
      const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
      return reply(`No hay horarios disponibles para ${doctor.name}. ¿Desea elegir otro médico?`, "none", newSession);
    }

    draft = { ...draft, offeredSlots: slots };
    const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
    return reply(slotsMessage(slots, clinic.timezone), "none", newSession);
  }

  // ── choosing_slot ─────────────────────────────────────────────────────────
  if (step === "choosing_slot") {
    const nowMs = Date.now() + 60 * 60 * 1000; // 1h de margen
    let slots = (draft.offeredSlots ?? []).filter(s => new Date(s.start).getTime() > nowMs);

    // Si todos los slots guardados ya pasaron, regenerar desde el doctor actual.
    if (slots.length === 0 && draft.doctorId) {
      const freshDoctor = await getDoctorById(draft.doctorId);
      if (freshDoctor) {
        slots = await getAvailableSlots(freshDoctor, conversationId);
        if (!slots.length) {
          const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
          return reply("Los horarios que le habíamos mostrado ya no están disponibles y no hay nuevos turnos en los próximos días 😔 ¿Le puedo ayudar en algo más?", "none", newSession);
        }
        draft = { ...draft, offeredSlots: slots };
        const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
        return reply(`Los horarios anteriores ya pasaron 😊 Aquí los próximos disponibles:\n\n${slotsMessage(slots, clinic.timezone)}`, "none", newSession);
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
      return replyInContext(text, "eligiendo horario", slotsMessage(slots, clinic.timezone), session);
    }

    const chosen = slots[idx - 1];

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
          draft = { ...draft, offeredSlots: freshSlots };
          const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
          return reply(`Ese horario acaba de ser tomado 😔 Aquí los próximos disponibles:\n\n${slotsMessage(freshSlots, clinic.timezone)}`, "none", newSession);
        }
      }
      // Si timeout → continuar optimistamente (el slot fue validado al mostrarse).
    } catch (err) {
      console.error("slot re-verification failed, proceeding optimistically", err);
    }

    // Slot libre → escribir hold de 30 minutos.
    draft = { ...draft, slotStart: chosen.start, slotEnd: chosen.end, offeredSlots: undefined };
    const newHold: BookingHold = {
      heldDoctorId: doctor.id,
      heldSlotStart: chosen.start,
      holdExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
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

    let price = 150;
    if (draft.doctorId) {
      const doc = await getDoctorById(draft.doctorId);
      price = doc?.consultationPrice ?? 150;
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

      if (doctor.googleCalendarId) {
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
            await updateAppointment(appointmentId, { googleEventId: eventId });
          }
        } catch (err: any) {
          console.error("createAppointmentEvent (cash) failed", {
            message: err?.message,
            status: err?.status ?? err?.code,
            details: err?.errors ?? err?.response?.data,
          });
        }
      } else {
        console.warn("doctor has no googleCalendarId, skipping event creation", { doctorId: doctor.id });
      }

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

    draft = { ...draft, appointmentId: appointmentId ?? undefined };
    const newSession = await saveAndReturn(conversationId, business, "awaiting_proof", draft, hold);
    const friendlySlot = formatSlotLocal(draft.slotStart, clinic.timezone);
    return reply(
      `Perfecto 😊 Le envío el QR para el pago.\n\n📅 *${friendlySlot}*\n👨‍⚕️ ${doctor.name}\n👤 ${draft.patientName}\n💊 ${draft.reason ?? "—"}\n\nUna vez realizado el pago, envíe el *comprobante* (foto o PDF) y lo validamos. ¡Gracias! 🙏`,
      "send_qr",
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
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone, session, mediaUrl } = params;
  const { draft } = session;

  if (!draft.appointmentId) {
    const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
    return reply(clinic.replies.proofButNoBooking, "none", newSession);
  }

  await updateAppointment(draft.appointmentId, { paymentProofUrl: mediaUrl, status: "confirmed" });

  const doctor = draft.doctorId ? await getDoctorById(draft.doctorId) : null;

  // Crear el evento en Calendar de inmediato (mismo patrón que el pago en
  // efectivo), sin depender del webhook de confirmaciones de Supabase.
  if (doctor?.googleCalendarId && draft.slotStart && draft.slotEnd) {
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
        await updateAppointment(draft.appointmentId, { googleEventId: eventId });
      }
    } catch (err) {
      console.error("createAppointmentEvent (qr) failed", err);
    }
  }

  // Verificación best-effort del monto: NO bloquea la confirmación, solo deja
  // una nota para revisión posterior de la secretaria si algo no cuadra.
  if (doctor?.consultationPrice != null) {
    try {
      const imgRes = await fetch(mediaUrl, {
        headers: process.env.KAPSO_API_KEY ? { "X-API-Key": process.env.KAPSO_API_KEY } : {},
      });

      if (imgRes.ok) {
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
      `Le esperamos en la Clínica San Martín de Porres. Cualquier consulta llámenos al +591 75681881. ¡Hasta pronto! 🙏`,
    ].filter((l) => l !== null).join("\n"),
    "none",
    newSession,
  );
}

// ─── Cancelar cita activa ─────────────────────────────────────────────────────

export async function cancelActiveAppointment(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  session: BookingSession;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone } = params;

  // Resetear sesión PRIMERO para que la máquina no quede colgada.
  await resetBookingSession(conversationId, business);

  const appointment = await findActiveAppointmentByPhone(business, contactPhone);
  if (!appointment) {
    return reply(clinic.replies.noActiveAppointment, "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  await updateAppointment(appointment.id, { status: "canceled" });

  if (appointment.googleEventId && appointment.doctorId) {
    const doctor = await getDoctorById(appointment.doctorId);
    if (doctor?.googleCalendarId) {
      try {
        await deleteAppointmentEvent(doctor.googleCalendarId, appointment.googleEventId);
        await updateAppointment(appointment.id, { googleEventId: null as unknown as string });
      } catch (err) {
        console.error("deleteAppointmentEvent (cancel) failed", err);
      }
    }
  }

  const friendlySlot = appointment.scheduledStart
    ? formatSlotLocal(appointment.scheduledStart, clinic.timezone)
    : "su cita";

  return reply(
    `Su cita del *${friendlySlot}* ha sido cancelada ✅. Si desea agendar una nueva, escríbame cuando quiera 😊`,
    "none",
    { conversationId, step: "idle", draft: {}, hold: emptyHold() },
  );
}

// ─── Reprogramar cita activa ──────────────────────────────────────────────────

export async function rescheduleActiveAppointment(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  session: BookingSession;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone } = params;

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

  // Cancelar la cita anterior.
  await updateAppointment(appointment.id, { status: "canceled", rescheduleCount: appointment.rescheduleCount + 1 });

  if (appointment.googleEventId && appointment.doctorId) {
    const doctor = await getDoctorById(appointment.doctorId);
    if (doctor?.googleCalendarId) {
      try {
        await deleteAppointmentEvent(doctor.googleCalendarId, appointment.googleEventId);
        await updateAppointment(appointment.id, { googleEventId: null as unknown as string });
      } catch (err) {
        console.error("deleteAppointmentEvent (reschedule) failed", err);
      }
    }
  }

  const doctor = await getDoctorById(appointment.doctorId);
  if (!doctor) {
    await resetBookingSession(conversationId, business);
    return reply("No pude recuperar los datos del médico. Por favor inicie un nuevo agendamiento.", "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  const slots = await getAvailableSlots(doctor, conversationId);
  if (!slots.length) {
    await resetBookingSession(conversationId, business);
    return reply("No hay horarios disponibles para los próximos días. ¿Desea agendar con otra especialidad?", "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  const draft: BookingDraft = {
    specialtyId: appointment.specialtyId ?? undefined,
    doctorId: appointment.doctorId,
    doctorName: doctor.name,
    offeredSlots: slots,
    reschedulingAppointmentId: appointment.id,
  };
  const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
  return reply(`Anulé su cita anterior 😊 Elija el nuevo horario:\n\n${slotsMessage(slots, clinic.timezone)}`, "none", newSession);
}
