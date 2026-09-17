// ============================================================================
// Solicitudes de ficha — el bot recopila, una persona confirma
// ----------------------------------------------------------------------------
// Desde 2026-09-15 el bot NO ofrece horarios ni médicos (el plantel no cumple
// los turnos cargados). Su trabajo es juntar lo que un asesor necesita para
// confirmar por WhatsApp, dejar la alarma en el panel y apagarse:
//
//   idle → collecting_lead → confirming_lead → pausa 12 h (asesor)
//
// Ficha (consulta): nombre del paciente (en pediatría, el del niño),
//   especialidad o médico de preferencia, día y hora cómodos, y consulta nueva
//   o reconsulta (esto último no se pregunta en especialidades sin reconsulta).
// Servicio (ecografía, procedimiento…): nombre y día y hora cómodos.
// No se pide motivo ni número de carnet: solo se recuerda traer el carnet.
//
// Con los datos completos se crea la fila en clinic_leads (hace sonar la alarma)
// y se manda el resumen con precio, reconsulta y carnet. Si el paciente corrige
// algo, se actualiza la misma fila y se reenvía el resumen. Cuando confirma, el
// webhook pausa el bot DESPUÉS de enviar la respuesta (pauseAfterReply).
//
// Cada mensaje pasa por analyzeTurn (una llamada a GPT, temperature 0) que
// extrae datos y detecta si pide una persona, si está frustrado o si desiste.
// Las derivaciones (registerEscalation) también dejan su alarma en el panel.
// ============================================================================

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

import { buildClinicSystemPrompt, type ClinicConfig } from "@/lib/clinic/config";
import {
  CONSULTATION_SPECIALTIES,
  findSpecialty,
  isHolidayToday,
  localDateISO,
  localNow,
  quoteConsultation,
} from "@/lib/clinic/pricing";
import { formatServicePrice, type ServiceItem } from "@/lib/clinic/services";
import {
  createLead,
  findRecentPendingLead,
  getActiveDoctorsWithSpecialty,
  saveBookingSession,
  updateLead,
  type LeadFields,
} from "@/lib/clinic/data";
import type { BookingDraft, BookingSession, BookingStep, LeadDraft, LeadKind, PaymentIntention, VisitType } from "@/lib/clinic/types";
import { getRecentConversationHistory } from "@/lib/engine/data";
import { getErrorMessage, logSystemEvent } from "@/lib/engine/logging";

const model = () => openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini");

// Si el mismo paciente vuelve a pedir lo mismo dentro de esta ventana, se
// actualiza la alarma que ya existe en vez de abrir otra.
const ESCALATION_DEDUPE_MS = 12 * 60 * 60 * 1000;

export const LEAD_REPLIES = {
  failedAttempts: "Disculpe las molestias 🙏 Le paso con una persona de la clínica, que le escribirá por aquí en un momento.",
  toAdvisor: "Le paso su pedido a un asesor de la clínica 🙏 En un momento le escribe por aquí.",
  payment: "Los datos de pago se los envía un asesor de la clínica cuando confirme su ficha o servicio 🙏 Ya le aviso para que le escriba por aquí.",
  technicalError: "Disculpe, tuve un problema para procesar su consulta 🙏 Ya le paso con un asesor de la clínica, que le atenderá en un momento.",
  receipt: "¡Gracias! 🙏 Recibimos su comprobante. Un asesor de la clínica lo revisará y le confirmará por aquí.",
  file: "¡Gracias! 🙏 Recibimos su archivo. Un asesor de la clínica lo revisará.",
  // El paciente pide algo que solo resuelve alguien de la clínica ("avísele a
  // la doctora", "ya llegué", "me confirma"). Antes esto caía en el Q&A, que
  // contestaba "Ok" sin que nadie se enterara.
  action: "Entendido 🙏 Eso se lo tiene que confirmar una persona de la clínica: ya le aviso para que le escriba por aquí en un momento.",
};

// Pidió por su nombre algo que la clínica no ofrece. Se lo decimos y lo pasamos
// a un asesor: nunca se sustituye en silencio por otra especialidad.
export function unavailableReply(request: string): string {
  return `Disculpe 🙏 No contamos con *${request}* en la clínica. Le paso con un asesor por si podemos ofrecerle alguna alternativa; en un momento le escribe por aquí.`;
}

export type LeadContext = {
  clinic: ClinicConfig;
  conversationId: string;
  contactPhone: string;
  contactName: string | null;
};

export type LeadTurnResult = { reply: string; pauseAfterReply: boolean };

export function isLeadStep(step: BookingStep): boolean {
  return step === "collecting_lead" || step === "confirming_lead";
}

// ─── Análisis del mensaje ────────────────────────────────────────────────────

export type TurnAnalysis = {
  patientName: string | null;
  specialtyKey: string | null;
  doctorName: string | null;
  preferredTime: string | null;
  preferredDate: string | null;
  preferredHour: string | null;
  visitType: VisitType | null;
  paymentIntention: PaymentIntention | null;
  unavailableRequest: string | null;
  needsHumanAction: boolean;
  wantsLead: boolean;
  wantsHuman: boolean;
  frustrated: boolean;
  confirms: boolean;
  wantsOut: boolean;
  isQuestion: boolean;
};

const ANALYSIS_SYSTEM = `Analizás mensajes de WhatsApp de pacientes de una clínica en Bolivia. Respondés ÚNICAMENTE con un JSON válido, sin texto extra:
{"patientName": string|null, "specialtyKey": string|null, "doctorName": string|null, "preferredTime": string|null, "preferredDate": "YYYY-MM-DD"|null, "preferredHour": "HH:MM"|null, "visitType": "nueva"|"reconsulta"|null, "paymentIntention": "qr"|"efectivo"|null, "unavailableRequest": string|null, "needsHumanAction": boolean, "wantsLead": boolean, "wantsHuman": boolean, "frustrated": boolean, "confirms": boolean, "wantsOut": boolean, "isQuestion": boolean}

Reglas:
- Solo extraés lo que el mensaje dice de verdad. Ante la duda, null o false. Nunca inventes.
- patientName: nombre del PACIENTE que se va a atender, tal como lo escribió. Si la ficha es para otra persona (un hijo, la mamá), es el nombre de esa persona. Nunca es el nombre de un médico.
- specialtyKey: la clave de la lista si nombra la especialidad o un sinónimo ("pediatra" → pediatria, "ginecólogo" → ginecologia, "médico general" → medicina-general). Si nombra a un médico de la lista, usá la especialidad de ese médico. Si SOLO describe un síntoma o malestar y no nombra ninguna especialidad, elegí la especialidad más apropiada de la lista y ante la duda medicina-general. Si no hay ninguna pista, null.
- unavailableRequest: si el paciente PIDE POR SU NOMBRE una especialidad, un servicio o una atención que NO está en la lista de especialidades ni en el tarifario (por ejemplo fisioterapia, odontología, oftalmología, psiquiatría, oncología, rehabilitación, kinesiología, nutrición), poné acá eso que pidió, tal como lo escribió. Si lo que pide SÍ está en la lista, null.
- REGLA DURA: cuando unavailableRequest tiene valor, specialtyKey es SIEMPRE null. Que el paciente nombre algo que no ofrecemos NUNCA se traduce a medicina-general ni a ninguna otra especialidad de la lista: el fallback a medicina-general vale solo para síntomas, jamás para una especialidad que el paciente nombró.
- paymentIntention: cómo dice que va a pagar. "qr" si menciona QR, transferencia o pago por banco; "efectivo" si dice que paga al llegar, en caja, en recepción o en efectivo. null si no dice nada de pago. Es solo un dato para el asesor: no cambia nada del resto.
- needsHumanAction: true si el mensaje pide una GESTIÓN o avisa de un HECHO FÍSICO que solo puede resolver una persona de la clínica: que se avise a alguien ("dígale a la doctora", "avise a la licenciada"), que se le confirme algo ("me confirma", "confírmeme"), que ya llegó o está por llegar ("ya llegué", "estoy en la puerta", "llego a las 5"), que ya pagó, o cualquier pedido de que alguien haga algo fuera de este chat. false si solo pide una ficha, un servicio o información, y también false si solo dice CÓMO va a pagar sin pedir nada más (eso ya va en paymentIntention).
- doctorName: el médico que pide el paciente, tal como lo escribió. null si no nombra a ninguno.
- preferredTime: el día y/o la hora que prefiere, en pocas palabras y como lo dijo ("mañana a las 10", "el sábado en la tarde", "lo antes posible"). null si no dijo nada de horario.
- preferredDate: la fecha de ese día en formato YYYY-MM-DD, calculada con la fecha actual ("hoy", "ahora", "mañana", "el lunes", "20 de septiembre"). null si no dijo un día claro.
- preferredHour: la hora en formato 24 h solo si es clara ("10 de la mañana" → 10:00, "7 de la noche" → 19:00, "15:30" → 15:30). Una hora de 1 a 6 sin mañana/tarde/noche es de la tarde (13:00 a 18:00). Una hora de 7 a 12 sin mañana/tarde/noche es ambigua → null. "ahora" o "lo antes posible" → la hora actual.
- visitType: "nueva" si es consulta nueva o primera vez; "reconsulta" si dice reconsulta, control, o que vuelve por lo mismo o a mostrar resultados. null si no lo dice.
- wantsLead: true si quiere pedir ficha, cita, turno o consulta, o atenderse con un médico o una especialidad.
- wantsHuman: true SOLO si pide hablar con una persona (doctora, doctor, enfermera, recepcionista, secretaria, asesor, alguien) o dice que no quiere seguir con el asistente. Pedir una ficha o consulta con un médico NO es wantsHuman.
- frustrated: true si expresa que no se le está ayudando, que no le entienden, que la respuesta no le sirve, o se queja de la atención por este chat.
- confirms: true si confirma que los datos están bien ("sí", "correcto", "así está bien", "ok, gracias") sin pedir ningún cambio.
- wantsOut: true si ya no quiere la ficha o el servicio, o pide dejarlo.
- isQuestion: true si hace una pregunta (precios, dirección, requisitos, etc.).`;

function cleanText(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.toLowerCase() === "null") return null;
  return text.slice(0, max);
}

function cleanHour(value: unknown): string | null {
  const match = typeof value === "string" ? value.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

function sanitizeAnalysis(raw: any): TurnAnalysis {
  const date = typeof raw?.preferredDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.preferredDate)
    ? raw.preferredDate
    : null;
  // El paciente nombró algo que no ofrecemos: la especialidad se descarta acá,
  // en código, y no solo por la regla del prompt. Si el modelo devuelve las dos
  // cosas ("fisioterapia" + medicina-general), lo que mandaba antes era el
  // fallback silencioso — el error que se le ofreció a un paciente real.
  const unavailableRequest = cleanText(raw?.unavailableRequest, 80);
  return {
    patientName: cleanText(raw?.patientName, 80),
    specialtyKey: unavailableRequest ? null : findSpecialty(raw?.specialtyKey)?.key ?? null,
    doctorName: cleanText(raw?.doctorName, 80),
    preferredTime: cleanText(raw?.preferredTime),
    preferredDate: date,
    preferredHour: cleanHour(raw?.preferredHour),
    visitType: raw?.visitType === "nueva" || raw?.visitType === "reconsulta" ? raw.visitType : null,
    paymentIntention: raw?.paymentIntention === "qr" || raw?.paymentIntention === "efectivo" ? raw.paymentIntention : null,
    unavailableRequest,
    needsHumanAction: raw?.needsHumanAction === true,
    wantsLead: raw?.wantsLead === true,
    wantsHuman: raw?.wantsHuman === true,
    frustrated: raw?.frustrated === true,
    confirms: raw?.confirms === true,
    wantsOut: raw?.wantsOut === true,
    isQuestion: raw?.isQuestion === true,
  };
}

// null si el modelo falla: el flujo sigue con lo que ya tenía (vuelve a pedir
// lo que falta) en vez de romper la conversación.
export async function analyzeTurn(
  ctx: LeadContext & { text: string; step: BookingStep; draft: LeadDraft | null },
): Promise<TurnAnalysis | null> {
  if (!ctx.text.trim()) return null;

  const now = localNow(ctx.clinic.timezone);
  // La lista de médicos es contexto opcional (sirve para mapear "quiero con la
  // Dra. Rosmery" a su especialidad). Si Supabase no responde, el análisis
  // sigue sin ella: quedarse sin analyzeTurn deja al paciente en el Q&A, que es
  // exactamente el agujero que estamos cerrando.
  const doctors = await getActiveDoctorsWithSpecialty(ctx.clinic.slug).catch((err) => {
    console.error("analyzeTurn: doctors lookup failed, continuing without them", getErrorMessage(err));
    return [] as { name: string; specialtyKey: string | null }[];
  });
  const context =
    ctx.step === "confirming_lead"
      ? "El asistente acaba de enviarle al paciente un RESUMEN de su solicitud y le preguntó si los datos están correctos."
      : ctx.step === "collecting_lead"
        ? `El asistente le está pidiendo los datos de su solicitud. Le faltan: ${missingFields(ctx.draft).join(", ") || "nada"}.`
        : "Es un mensaje nuevo, sin ninguna solicitud en curso.";
  const collected = ctx.draft
    ? JSON.stringify(Object.fromEntries(Object.entries(ctx.draft).filter(([, v]) => v !== null && v !== undefined)))
    : "{}";

  try {
    const { text } = await generateText({
      model: model(),
      system: ANALYSIS_SYSTEM,
      prompt: [
        `Fecha y hora actual en la clínica: ${now.dayName} ${now.date} ${now.hhmm}`,
        `Contexto: ${context}`,
        `Datos ya recopilados: ${collected}`,
        "",
        "Especialidades (clave: nombre):",
        ...CONSULTATION_SPECIALTIES.map((s) => `- ${s.key}: ${s.name}`),
        "",
        "Médicos de la clínica (nombre y clave de especialidad):",
        ...(doctors.length ? doctors.map((d) => `- ${d.name} (${d.specialtyKey ?? "sin especialidad"})`) : ["(sin datos)"]),
        "",
        `Mensaje del paciente: """${ctx.text}"""`,
      ].join("\n"),
      temperature: 0,
      abortSignal: AbortSignal.timeout(10000),
    });
    return sanitizeAnalysis(JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, "").trim()));
  } catch (err) {
    console.error("analyzeTurn failed", getErrorMessage(err));
    return null;
  }
}

// Respuesta libre con el prompt de la clínica (dudas en medio de la solicitud o
// Q&A general). null si el modelo falla.
export async function answerQuestion(ctx: LeadContext, text: string): Promise<string | null> {
  try {
    const history = await getRecentConversationHistory(ctx.conversationId, 8);
    const { text: answer } = await generateText({
      model: model(),
      system: buildClinicSystemPrompt(ctx.clinic),
      messages: [
        ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
        { role: "user" as const, content: text },
      ],
      temperature: 0.35,
      abortSignal: AbortSignal.timeout(15000),
    });
    return answer.trim() || null;
  } catch (err) {
    console.error("answerQuestion failed", err);
    await logSystemEvent({
      level: "error",
      eventType: "openai_generate_failed",
      business: ctx.clinic.slug,
      conversationId: ctx.conversationId,
      contactPhone: ctx.contactPhone,
      errorMessage: getErrorMessage(err),
    });
    return null;
  }
}

// ─── Datos de la solicitud ───────────────────────────────────────────────────

type Field = "specialty" | "name" | "time" | "visit";

function needsVisitType(draft: LeadDraft): boolean {
  if (draft.kind !== "ficha") return false;
  const spec = findSpecialty(draft.specialtyKey);
  // Todavía sin especialidad: no se sabe si aplica, así que se pregunta junto
  // con el resto y el paciente contesta todo en un mensaje.
  return spec ? Boolean(spec.reconsultaDays) : true;
}

function missingFields(draft: LeadDraft | null): Field[] {
  if (!draft) return [];
  const missing: Field[] = [];
  // La especialidad es obligatoria SIEMPRE. Antes bastaba con nombrar un médico
  // y la ficha se cerraba sin especialidad, con un nombre que nadie validaba
  // contra el plantel: el médico es un dato extra, nunca un reemplazo.
  if (draft.kind === "ficha" && !draft.specialtyKey) missing.push("specialty");
  if (!draft.patientName) missing.push("name");
  if (!draft.preferredTime) missing.push("time");
  if (needsVisitType(draft) && !draft.visitType) missing.push("visit");
  return missing;
}

// Suma lo nuevo del mensaje a lo ya recopilado. Un dato nuevo pisa al anterior
// (así el paciente corrige), pero nunca se borra uno por no mencionarlo.
function mergeAnalysis(draft: LeadDraft, analysis: TurnAnalysis | null): { draft: LeadDraft; changed: boolean } {
  if (!analysis) return { draft, changed: false };
  const next: LeadDraft = { ...draft };

  if (analysis.patientName) next.patientName = analysis.patientName;
  if (analysis.paymentIntention) next.paymentIntention = analysis.paymentIntention;
  if (analysis.preferredTime) {
    next.preferredTime = analysis.preferredTime;
    next.preferredDate = analysis.preferredDate;
    next.preferredHour = analysis.preferredHour;
  }
  if (draft.kind === "ficha") {
    if (analysis.specialtyKey) next.specialtyKey = analysis.specialtyKey;
    if (analysis.doctorName) next.doctorPreference = analysis.doctorName;
    if (analysis.visitType) next.visitType = analysis.visitType;
  }

  const fields = (d: LeadDraft) =>
    JSON.stringify([d.patientName, d.preferredTime, d.preferredDate, d.preferredHour, d.specialtyKey, d.doctorPreference, d.visitType, d.paymentIntention]);
  return { draft: next, changed: fields(next) !== fields(draft) };
}

function leadRowFields(draft: LeadDraft): LeadFields {
  return {
    patientName: draft.patientName ?? null,
    specialty: findSpecialty(draft.specialtyKey)?.name ?? null,
    doctorPreference: draft.doctorPreference ?? null,
    preferredTime: draft.preferredTime ?? null,
    visitType: draft.visitType ?? null,
    paymentIntention: draft.paymentIntention ?? null,
    serviceName: draft.serviceName ?? null,
  };
}

// ─── Mensajes ────────────────────────────────────────────────────────────────

function askMissing(draft: LeadDraft, missing: Field[], intro?: string): string {
  const pediatric = draft.specialtyKey === "pediatria";
  const items: Record<Field, string> = {
    specialty: "🩺 La *especialidad* que necesita",
    name: pediatric ? "👶 El *nombre completo del niño o niña* que será atendido" : "👤 El *nombre completo del paciente*",
    time: "🗓️ El *día y la hora* que le quedarían cómodos",
    visit: "🔁 Si es *consulta nueva* o *reconsulta*",
  };
  const questions: Record<Field, string> = {
    specialty: "¿Para qué *especialidad* es la consulta? Si además tiene un médico de preferencia, dígame su nombre y lo anoto 😊",
    name: pediatric
      ? "¿Cuál es el *nombre completo del niño o niña* que será atendido? 😊"
      : "¿Cuál es el *nombre completo del paciente*? 😊",
    time: "¿Qué *día y hora* le quedarían cómodos? 😊",
    visit: "¿Es *consulta nueva* o *reconsulta*? 😊",
  };

  const body =
    missing.length === 1
      ? questions[missing[0]]
      : ["Para pasarle su solicitud a un asesor necesito:", "", ...missing.map((f) => items[f]), "", "Puede responderme todo en un solo mensaje 😊"].join("\n");
  return intro ? `${intro}\n\n${body}` : body;
}

function priceLines(draft: LeadDraft, clinic: ClinicConfig): { lines: string[]; quote: string | null } {
  const holidayMessage = "Hoy es *feriado* y los precios cambian: el asesor le confirma el monto.";

  if (draft.kind === "servicio") {
    const today = localDateISO(new Date(), clinic.timezone);
    if (isHolidayToday(clinic.holidayDate, clinic.timezone) && (!draft.preferredDate || draft.preferredDate === today)) {
      return { lines: [`📅 ${holidayMessage}`], quote: "Feriado: precio a confirmar" };
    }
    return { lines: draft.serviceQuote ? [`💰 Precio: ${draft.serviceQuote}`] : [], quote: draft.serviceQuote ?? null };
  }

  const spec = findSpecialty(draft.specialtyKey);
  if (!spec) return { lines: ["💰 El asesor le confirma el precio de la consulta."], quote: null };

  if (draft.visitType === "reconsulta" && spec.reconsultaDays) {
    return {
      lines: [`💰 La reconsulta es *gratis* si es dentro de los ${spec.reconsultaDays} días desde su consulta.`],
      quote: `Reconsulta gratis dentro de ${spec.reconsultaDays} días`,
    };
  }

  const quote = quoteConsultation({
    spec,
    date: draft.preferredDate,
    hour: draft.preferredHour,
    holidayDate: clinic.holidayDate,
    timezone: clinic.timezone,
  });
  const lines = [
    quote.kind === "holiday"
      ? `📅 ${quote.text}`
      : quote.kind === "exact"
        ? `💰 Precio de la consulta en ese horario: *${quote.text}*`
        : `💰 Precio de la consulta: ${quote.text}`,
  ];
  if (spec.reconsultaDays && draft.visitType === "nueva") {
    lines.push(`ℹ️ Si luego necesita reconsulta, es *gratis* dentro de los ${spec.reconsultaDays} días siguientes a su consulta.`);
  }
  return { lines, quote: quote.kind === "holiday" ? "Feriado: precio a confirmar" : quote.text };
}

function buildSummary(draft: LeadDraft, clinic: ClinicConfig): { text: string; priceQuote: string | null } {
  const spec = findSpecialty(draft.specialtyKey);
  // En especialidades sin reconsulta no se menciona el tipo de consulta.
  const showVisitType = draft.kind === "ficha" && draft.visitType && (!spec || spec.reconsultaDays);
  const price = priceLines(draft, clinic);

  const lines = [
    "📋 *Resumen de su solicitud*",
    "",
    `${draft.specialtyKey === "pediatria" ? "👶" : "👤"} Paciente: ${draft.patientName}`,
    draft.kind === "servicio" ? `🩺 Servicio: ${draft.serviceName}` : null,
    draft.kind === "ficha" && spec ? `🩺 Especialidad: ${spec.name}` : null,
    draft.kind === "ficha" && draft.doctorPreference ? `👨‍⚕️ Médico de preferencia: ${draft.doctorPreference}` : null,
    `🗓️ Horario que prefiere: ${draft.preferredTime}`,
    showVisitType ? `🔁 ${draft.visitType === "reconsulta" ? "Reconsulta" : "Consulta nueva"}` : null,
    // Solo se confirma lo que el paciente dijo. El bot no cobra ni manda el QR:
    // el asesor ve el dato y sigue desde ahí.
    draft.paymentIntention
      ? `💳 Pago: ${draft.paymentIntention === "qr" ? "por QR" : "en efectivo al llegar"}`
      : null,
    "",
    ...price.lines,
    "🪪 Recuerde traer su *carnet de identidad*. Si no lo tiene, puede mostrar una foto del carnet en recepción.",
    "",
    draft.kind === "servicio"
      ? "Un asesor de la clínica le escribirá por aquí para confirmar el horario."
      : "Un asesor de la clínica le escribirá por aquí para confirmar el horario y el médico disponible.",
    "",
    "¿Los datos están correctos? Si algo está mal, dígame qué corregir 😊",
  ].filter((line) => line !== null);

  return { text: lines.join("\n"), priceQuote: price.quote?.replace(/\*/g, "") ?? null };
}

// ─── Flujo ───────────────────────────────────────────────────────────────────

type FlowContext = LeadContext & { session: BookingSession };

async function saveStep(ctx: FlowContext, step: BookingStep, lead: LeadDraft | null) {
  const draft: BookingDraft = { failedAttempts: ctx.session.draft.failedAttempts };
  if (lead) draft.lead = lead;
  await saveBookingSession({ conversationId: ctx.conversationId, business: ctx.clinic.slug, step, draft });
}

// Crea la fila de la solicitud (dispara la alarma) o actualiza la existente.
async function persistLead(ctx: FlowContext, draft: LeadDraft, summary: string, priceQuote: string | null): Promise<string | null> {
  const fields: LeadFields = { ...leadRowFields(draft), priceQuote, summary };
  if (draft.leadId) {
    await updateLead(draft.leadId, fields);
    return draft.leadId;
  }
  const id = await createLead({
    business: ctx.clinic.slug,
    conversationId: ctx.conversationId,
    contactPhone: ctx.contactPhone,
    contactName: ctx.contactName,
    kind: draft.kind,
    ...fields,
  });
  if (!id) {
    await logSystemEvent({
      level: "critical",
      eventType: "lead_create_failed",
      business: ctx.clinic.slug,
      conversationId: ctx.conversationId,
      contactPhone: ctx.contactPhone,
      errorMessage: "No se pudo crear la solicitud: el panel no va a sonar para este paciente.",
    });
  }
  return id;
}

async function sendSummary(ctx: FlowContext, draft: LeadDraft, intro?: string): Promise<LeadTurnResult> {
  const { text, priceQuote } = buildSummary(draft, ctx.clinic);
  const leadId = await persistLead(ctx, draft, text, priceQuote);
  await saveStep(ctx, "confirming_lead", { ...draft, leadId: leadId ?? draft.leadId ?? null });
  return { reply: intro ? `${intro}\n\n${text}` : text, pauseAfterReply: false };
}

async function askOrSummarize(ctx: FlowContext, draft: LeadDraft, intro?: string): Promise<LeadTurnResult> {
  const missing = missingFields(draft);
  if (!missing.length) return sendSummary(ctx, draft, intro);
  await saveStep(ctx, "collecting_lead", draft);
  return { reply: askMissing(draft, missing, intro), pauseAfterReply: false };
}

export async function startLead(
  ctx: FlowContext & { kind: "ficha" | "servicio"; service?: ServiceItem | null; analysis: TurnAnalysis | null },
): Promise<LeadTurnResult> {
  const base: LeadDraft = { kind: ctx.kind };
  let intro = "¡Con gusto le ayudo a pedir su ficha! 😊";

  if (ctx.kind === "servicio" && ctx.service) {
    base.serviceName = ctx.service.name;
    base.serviceQuote = formatServicePrice(ctx.service) + (ctx.service.note ? ` (${ctx.service.note})` : "");
    intro = isHolidayToday(ctx.clinic.holidayDate, ctx.clinic.timezone)
      ? `Con gusto le ayudo con *${ctx.service.name}* 😊 Hoy es *feriado* y los precios cambian: el asesor le confirma el monto.`
      : `*${ctx.service.name}*: ${base.serviceQuote} 😊`;
  }

  return askOrSummarize(ctx, mergeAnalysis(base, ctx.analysis).draft, intro);
}

export async function continueLead(
  ctx: FlowContext & { analysis: TurnAnalysis | null; text: string },
): Promise<LeadTurnResult> {
  const { session, analysis } = ctx;
  const lead = session.draft.lead;

  if (!lead) {
    await saveStep(ctx, "idle", null);
    return { reply: "¿En qué más le puedo ayudar? 😊", pauseAfterReply: false };
  }

  if (analysis?.wantsOut) {
    if (lead.leadId) await updateLead(lead.leadId, { status: "withdrawn", lastMessage: ctx.text.slice(0, 1000) });
    await saveStep(ctx, "idle", null);
    return {
      reply: "Entendido 😊 Dejé sin efecto su solicitud. Si más adelante la necesita, con gusto le ayudo.",
      pauseAfterReply: false,
    };
  }

  const { draft, changed } = mergeAnalysis(lead, analysis);

  if (session.step === "confirming_lead") {
    if (changed) return sendSummary(ctx, draft, "¡Listo! Actualicé sus datos 😊");

    if (analysis?.confirms) {
      // Si al enviar el resumen no se pudo crear la fila, se reintenta: sin ella
      // no suena ninguna alarma y el paciente quedaría esperando a nadie.
      if (!draft.leadId) {
        const { text, priceQuote } = buildSummary(draft, ctx.clinic);
        await persistLead(ctx, draft, text, priceQuote);
      }
      await saveStep(ctx, "idle", null);
      return {
        reply: "¡Gracias! 🙏 Ya pasé su solicitud a un asesor de la clínica, que le escribirá por aquí para confirmarla.",
        pauseAfterReply: true,
      };
    }

    const confirmQuestion = "¿Los datos de su resumen están correctos? Respóndame *sí* o dígame qué dato corregir 😊";
    if (analysis?.isQuestion) {
      const answer = await answerQuestion(ctx, ctx.text);
      return { reply: answer ? `${answer}\n\n_${confirmQuestion}_` : confirmQuestion, pauseAfterReply: false };
    }
    return { reply: confirmQuestion, pauseAfterReply: false };
  }

  // collecting_lead
  let intro: string | undefined;
  if (changed) intro = "¡Gracias! 😊";
  else if (analysis?.isQuestion) intro = (await answerQuestion(ctx, ctx.text)) ?? undefined;
  return askOrSummarize(ctx, draft, intro);
}

// ─── Derivaciones ────────────────────────────────────────────────────────────

// Deja la alarma en el panel para un pedido que solo resuelve una persona. No
// responde ni pausa: eso lo decide el webhook (con el bot en pausa, por ejemplo,
// solo se registra).
export async function registerEscalation(
  ctx: LeadContext & { kind: LeadKind; lastMessage: string; lead?: LeadDraft | null },
): Promise<string | null> {
  const fields: LeadFields = {
    ...(ctx.lead ? leadRowFields(ctx.lead) : {}),
    lastMessage: ctx.lastMessage.trim().slice(0, 1000) || null,
  };

  const since = new Date(Date.now() - ESCALATION_DEDUPE_MS).toISOString();
  const existing = await findRecentPendingLead(ctx.clinic.slug, ctx.contactPhone, ctx.kind, since);
  if (existing) {
    await updateLead(existing.id, fields);
    return existing.id;
  }

  const id = await createLead({
    business: ctx.clinic.slug,
    conversationId: ctx.conversationId,
    contactPhone: ctx.contactPhone,
    contactName: ctx.contactName,
    kind: ctx.kind,
    ...fields,
  });
  if (!id) {
    await logSystemEvent({
      level: "critical",
      eventType: "lead_create_failed",
      business: ctx.clinic.slug,
      conversationId: ctx.conversationId,
      contactPhone: ctx.contactPhone,
      errorMessage: `No se pudo registrar la derivación "${ctx.kind}": el panel no va a sonar.`,
    });
  }
  return id;
}
