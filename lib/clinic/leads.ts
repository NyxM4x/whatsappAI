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
  matchSpecialtyText,
  localDateISO,
  localNow,
  quoteConsultation,
} from "@/lib/clinic/pricing";
import {
  formatServicePrice,
  matchService,
  mentionsOffCatalogRequest,
  type ServiceItem,
} from "@/lib/clinic/services";
import {
  createLead,
  findRecentPendingLead,
  getActiveDoctorsWithSpecialty,
  saveBookingSession,
  updateLead,
  type LeadFields,
} from "@/lib/clinic/data";
import type { BookingDraft, BookingSession, BookingStep, LeadDraft, LeadKind, PaymentIntention, VisitType } from "@/lib/clinic/types";
import { unlistedAnswer } from "@/lib/clinic/routing";
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
- unavailableRequest: si el paciente PIDE POR SU NOMBRE (o pregunta el precio de) una especialidad, un servicio, un examen o un procedimiento que NO está en la lista de especialidades (por ejemplo fisioterapia, odontología, oftalmología, psiquiatría, oncología, rehabilitación, kinesiología, nutrición, electrocardiograma, radiografía, un examen de laboratorio puntual), poné acá eso que pidió, tal como lo escribió. Esto NO es un rechazo: solo marca que hay que verificarlo con un asesor. Si lo que pide SÍ está en la lista de especialidades, null.
- ANTES de marcar unavailableRequest, repasá la lista entera. La gente nombra al médico, no a la especialidad: "ginecólogo" es ginecologia, "pediatra" es pediatria, "traumatólogo" es traumatologia, "cardiólogo" es cardiologia, "urólogo" es urologia, "médico general" o "clínico" es medicina-general. Todas esas SÍ las tenemos: van en specialtyKey y unavailableRequest queda en null. Marcá unavailableRequest solo cuando no haya NINGUNA de la lista que corresponda.
- REGLA DURA: cuando unavailableRequest tiene valor, specialtyKey es SIEMPRE null. Que el paciente nombre algo que no ofrecemos NUNCA se traduce a medicina-general ni a ninguna otra especialidad de la lista: el fallback a medicina-general vale solo para síntomas, jamás para una especialidad que el paciente nombró.
- paymentIntention: cómo dice que va a pagar. "qr" si menciona QR, transferencia o pago por banco; "efectivo" si dice que paga al llegar, en caja, en recepción o en efectivo. null si no dice nada de pago. Es solo un dato para el asesor: no cambia nada del resto.
- OJO con "cancelar": en Bolivia significa PAGAR, no anular. "Voy a cancelar llegando" es paymentIntention "efectivo"; "va a cancelar por QR" es "qr". Solo es una cancelación de verdad cuando dice que ya no quiere la cita o la ficha (eso va en wantsOut).
- needsHumanAction: true si el mensaje pide una GESTIÓN o avisa de un HECHO FÍSICO que solo puede resolver una persona de la clínica: que se avise a alguien ("dígale a la doctora", "avise a la licenciada"), que se le confirme algo ("me confirma", "confírmeme"), que ya llegó o está por llegar ("ya llegué", "estoy en la puerta", "llego a las 5"), que ya pagó, o cualquier pedido de que alguien haga algo fuera de este chat. false si solo pide una ficha, un servicio o información, y también false si solo dice CÓMO va a pagar sin pedir nada más (eso ya va en paymentIntention). Pedir una ficha para un día y una hora ("quiero ficha para pediatría mañana a las 10") NO es needsHumanAction por mencionar un horario: es una solicitud normal.
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

// El paciente dice PARA QUIÉN es, no cómo se llama: "pa mi", "para mi hijo",
// "es para mi señora". El modelo lo devolvía como patientName y la ficha se
// cerraba con eso de nombre — verificado en producción con "pa mi".
//
// No es una lista de casos: son las dos formas en que se contesta "¿para
// quién?" sin dar un nombre. Todo lo que empiece con una preposición de
// destinatario, o que sea solo un parentesco, no es un nombre. Ante la duda se
// descarta: un nombre faltante se pregunta, uno inventado llega al panel.
const NOT_A_NAME = [
  // "pa mi", "para mí", "es para mi hijo", "para la señora"…
  /^(?:es\s+)?p(?:a|ara)'?\s/i,
  // "mi hijo", "mi señora", "el niño", "la bebé" — parentesco sin nombre propio.
  /^(?:mi|mí|el|la|su|un|una)\s+(?:hij[oa]|niñ[oa]|beb[eé]|mam[aá]|pap[aá]|madre|padre|espos[oa]|señor[a]?|hermi?an[oa]|nieto?a?|abuel[oa]|sobrin[oa]|t[ií][oa]|prim[oa]|suegr[oa]|yern[oa]|nuera|pareja|amig[oa])\b[\s.]*$/i,
  // Pronombres sueltos, con o sin refuerzo: "yo", "yo mismo", "yo misma",
  // "para mí nomás". Sin el refuerzo opcional, "yo mismo" pasaba como nombre.
  /^(?:yo|m[ií]|me|nosotros?)(?:\s+(?:mism[oa]s?|sol[oa]s?|nom[aá]s|no\s?m[aá]s))?[\s.]*$/i,
];

// true si el texto puede ser el nombre de una persona. Deliberadamente
// permisivo con lo que SÍ deja pasar (un solo nombre, apodos, nombres
// compuestos) y estricto solo con las formas de arriba.
export function looksLikeName(text: string): boolean {
  if (NOT_A_NAME.some((re) => re.test(text))) return false;
  // Sin una sola letra no hay nombre ("123", ".", "??").
  return /\p{L}/u.test(text);
}

function cleanHour(value: unknown): string | null {
  const match = typeof value === "string" ? value.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

// Pide una gestión con todas las letras. El modelo se pierde con estos mensajes
// sueltos —"Me confirma" a secas lo daba por false—, y son justo los que dejaron
// morir la conversación real. Acá no hace falta criterio: si lo dice, lo dice.
const HUMAN_ACTION_PATTERN =
  /\bme confirma\b|\bconfirmeme\b|\bconf[ií]rmeme\b|\bme avisa\b|\bav[ií]sele\b|\bav[ií]sale\b|\bd[ií]gale\b|\bd[ií]cele\b|\bhable con\b|\bya llegu[eé]\b|\bestoy (aqu[ií]|afuera|en la puerta|en recepci[oó]n)\b/i;

function sanitizeAnalysis(raw: any, text: string, services: ServiceItem[]): TurnAnalysis {
  const date = typeof raw?.preferredDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.preferredDate)
    ? raw.preferredDate
    : null;

  // ── Especialidad: primero el código, después el modelo ────────────────────
  // El modelo llegó a marcar "necesito un ginecologo" como algo que no
  // ofrecemos. Reconocer un nombre contra una lista cerrada es comparación de
  // strings: se resuelve acá y solo se le cree al modelo para lo que no se
  // puede resolver así (los síntomas).
  const fromText = matchSpecialtyText(text);
  let unavailableRequest = cleanText(raw?.unavailableRequest, 80);

  // Lo que dijo que no ofrecemos, ¿es en realidad una de las nuestras? Entonces
  // no era tal: se descarta el falso positivo y se usa la especialidad.
  const unavailableIsOurs = unavailableRequest ? matchSpecialtyText(unavailableRequest) : null;
  if (unavailableIsOurs) unavailableRequest = null;

  // Mismo chequeo contra el catálogo de SERVICIOS (ecografías, procedimientos,
  // enfermería…): si lo que el modelo marcó como no disponible es en realidad
  // un servicio catalogado, no era tal — se descarta y el webhook lo resuelve
  // solo con matchService() sobre el texto completo (más robusto que este
  // fragmento). Sin este chequeo, un falso positivo del modelo podría hacer
  // que un servicio real (con precio conocido) se tratara como "a confirmar".
  if (unavailableRequest && matchService(unavailableRequest, services)) unavailableRequest = null;

  // Refuerzo por código del caso inverso: el modelo NO lo marcó y sí correspondía.
  // Pasó con "cuanto está el electrocardiograma" y con "el precio de la
  // radiografía… para pie": el análisis volvió limpio, el mensaje cayó en el Q&A
  // general y el modelo libre contestó negando. Si el texto nombra algo que no
  // está en NINGÚN catálogo nuestro (ni servicio ni especialidad), se marca acá
  // y el webhook lo manda a recopilar datos en vez de dejar que alguien opine.
  if (!unavailableRequest && !fromText && !matchService(text, services) && mentionsOffCatalogRequest(text)) {
    unavailableRequest = cleanText(text, 80);
  }

  const fromModel = findSpecialty(raw?.specialtyKey)?.key ?? null;
  // Con una especialidad nombrada en el texto, esa manda: es un hecho, no una
  // inferencia. Si no hay, vale la del modelo (que ahí sí está infiriendo desde
  // un síntoma), salvo que de verdad haya pedido algo que no tenemos.
  const specialtyKey =
    fromText?.key ?? unavailableIsOurs?.key ?? (unavailableRequest ? null : fromModel);

  // wantsLead sale tal cual del modelo. Antes se forzaba acá ("nombró una
  // especialidad y no preguntó => quiere ficha"), pero eso es una decisión de
  // flujo, no normalización: vive en wantsToRequest() de lib/clinic/routing.ts,
  // donde se puede leer junto al resto del ruteo y probar sin llamar al modelo.
  const isQuestion = raw?.isQuestion === true;

  // El nombre pasa por looksLikeName(): el modelo devuelve "pa mi" o "mi
  // hijo" cuando el paciente contesta PARA QUIEN es en vez de como se llama.
  const rawName = cleanText(raw?.patientName, 80);
  const patientName = rawName && looksLikeName(rawName) ? rawName : null;

  return {
    patientName,
    specialtyKey,
    doctorName: cleanText(raw?.doctorName, 80),
    preferredTime: cleanText(raw?.preferredTime),
    preferredDate: date,
    preferredHour: cleanHour(raw?.preferredHour),
    visitType: raw?.visitType === "nueva" || raw?.visitType === "reconsulta" ? raw.visitType : null,
    paymentIntention: raw?.paymentIntention === "qr" || raw?.paymentIntention === "efectivo" ? raw.paymentIntention : null,
    unavailableRequest,
    needsHumanAction: raw?.needsHumanAction === true || HUMAN_ACTION_PATTERN.test(text),
    wantsLead: raw?.wantsLead === true,
    wantsHuman: raw?.wantsHuman === true,
    frustrated: raw?.frustrated === true,
    confirms: raw?.confirms === true,
    wantsOut: raw?.wantsOut === true,
    isQuestion,
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
    return sanitizeAnalysis(JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, "").trim()), ctx.text, ctx.clinic.services);
  } catch (err) {
    console.error("analyzeTurn failed", getErrorMessage(err));
    return null;
  }
}

// ─── Veto de negaciones ──────────────────────────────────────────────────────
// El Q&A es texto libre de un modelo: el prompt le prohíbe negar, pero un
// prompt es una instrucción, no una garantía. Esta es la garantía.
//
// Caso real 2026-09-18: preguntaron el precio de una radiografía de pie y el bot
// contestó "No tengo Radiografía para pie dentro de los servicios que tengo
// registrados 🙏 Eso no quiere decir que no lo hagan: mi lista puede estar
// incompleta". El matiz no sirve de nada — el paciente lee la primera línea y se
// va. Lo mismo había pasado con el electrocardiograma, que la clínica SÍ ofrece.
//
// Nuestros catálogos están incompletos por definición (el tarifario nunca llega
// entero), así que el bot no está en posición de negar nada: si la respuesta
// niega o se escuda en sus listas, no se envía.
const NEGATION_PATTERN =
  /\bno\s+(?:se\s+)?(?:l[oa]s?\s+|le\s+)?(?:tengo|tenemos|ten[eé]s|contamos|cuenta|dispongo|disponemos|ofrecemos|ofrece|brindamos|brinda|realizamos|realiza|hacemos|hace|manejamos|maneja|prestamos|trabajamos|figur\w+|aparec\w+|est[aá]\s+(?:disponible|registrad\w+|en\s+(?:mi|el|la|nuestr\w+)))\b/i;

// Escudarse en el catálogo propio ("dentro de los servicios que tengo
// registrados", "en mi lista"). Es la misma negación con otra ropa, y encima le
// cuenta al paciente cómo funciona el bot por dentro.
const SELF_CATALOG_PATTERN =
  /\b(?:mi|mis|nuestr[oa]s?|l[oa]s)\s+(?:lista|listas|cat[aá]logo|cat[aá]logos|registros?|servicios\s+registrados)\b|\bque\s+tengo\s+registrad\w+|\bdentro\s+de\s+l[oa]s\s+servicios\s+que\s+tengo\b/i;

// Prometer una gestión que el bot no puede hacer ("¿quiere que le consulte con
// el equipo?"). El paciente queda esperando una respuesta que nadie le va a dar,
// porque nadie se enteró: el Q&A no deja alarma en el panel.
const FAKE_ERRAND_PATTERN =
  /\b(?:le\s+)?(?:consulto|consultamos|averiguo|averiguamos|pregunto|preguntamos|verifico|verificamos)\b|\bquiere\s+que\s+(?:le\s+)?(?:consulte|pregunte|averig[uü]e|verifique)\b|\b(?:d[eé]jeme|perm[ií]tame|voy\s+a|puedo)\s+(?:consultar|averiguar|preguntar|verificar|revisar|confirmarle)\b/i;

// Lo que el Q&A nunca debe poder decirle a un paciente. Se evalúa sobre la
// respuesta generada, no sobre lo que pidió el paciente.
export function qaAnswerIsUnsafe(answer: string): boolean {
  return NEGATION_PATTERN.test(answer) || SELF_CATALOG_PATTERN.test(answer) || FAKE_ERRAND_PATTERN.test(answer);
}

export type QaAnswer =
  // "unsafe": el modelo respondió algo que no se le puede mandar al paciente.
  // No es un error técnico — el llamador tiene que resolverlo de otra forma
  // (recopilar los datos o derivar), nunca reenviando el texto.
  { status: "ok"; text: string } | { status: "unsafe" } | { status: "failed" };

// Respuesta libre con el prompt de la clínica (dudas en medio de la solicitud o
// Q&A general).
export async function answerQuestion(ctx: LeadContext, text: string): Promise<QaAnswer> {
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
    const clean = answer.trim();
    if (!clean) return { status: "failed" };

    if (qaAnswerIsUnsafe(clean)) {
      // Queda registrado en el panel: si esto empieza a saltar seguido, el
      // prompt se corrigió mal o falta algo en el tarifario.
      await logSystemEvent({
        level: "warning",
        eventType: "qa_answer_vetoed",
        business: ctx.clinic.slug,
        conversationId: ctx.conversationId,
        contactPhone: ctx.contactPhone,
        errorMessage: `Respuesta descartada por negar o prometer una gestión: "${clean.slice(0, 300)}"`,
      });
      return { status: "unsafe" };
    }

    return { status: "ok", text: clean };
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
    return { status: "failed" };
  }
}

// ─── Datos de la solicitud ───────────────────────────────────────────────────

type Field = "specialty" | "name" | "time" | "visit";

export function needsVisitType(draft: LeadDraft): boolean {
  if (draft.kind !== "ficha") return false;
  // Sin especialidad resuelta no se pregunta. El fallback era `true`, y como lo
  // que no está en catálogo nunca tiene specialtyKey, terminaba preguntándole a
  // alguien si su electrocardiograma era "consulta nueva o reconsulta".
  // Si la especialidad llega en un turno posterior, se pregunta ahí.
  const spec = findSpecialty(draft.specialtyKey);
  return spec ? Boolean(spec.reconsultaDays) : false;
}

function missingFields(draft: LeadDraft | null): Field[] {
  if (!draft) return [];
  const missing: Field[] = [];
  // La especialidad es obligatoria SIEMPRE. Antes bastaba con nombrar un médico
  // y la ficha se cerraba sin especialidad, con un nombre que nadie validaba
  // contra el plantel: el médico es un dato extra, nunca un reemplazo.
  // unmatchedRequestText también la satisface: si ya dijo qué pidió (aunque no
  // esté en catálogo), no se le vuelve a preguntar lo mismo.
  // En "no_disponible" el texto de lo pedido ya viene del primer mensaje, así
  // que nunca falta; se deja la misma condición para que un draft sin ninguno
  // de los dos vuelva a preguntar en vez de seguir a ciegas.
  if (draft.kind !== "servicio" && !draft.specialtyKey && !draft.unmatchedRequestText) missing.push("specialty");
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
  // Vale para "ficha" y para "no_disponible": en los dos el paciente puede
  // corregir qué necesita, nombrar un médico o decir si es reconsulta.
  if (draft.kind !== "servicio") {
    if (analysis.specialtyKey) {
      // Llegó una especialidad de catálogo real (p. ej. el paciente corrigió lo
      // que había pedido antes): gana sobre cualquier pedido fuera de catálogo
      // que hubiera quedado guardado.
      next.specialtyKey = analysis.specialtyKey;
      next.unmatchedRequestText = null;
      // Ya sabemos qué es: pasa a ser una ficha normal.
      if (next.kind === "no_disponible") next.kind = "ficha";
    } else if (analysis.unavailableRequest) {
      next.unmatchedRequestText = analysis.unavailableRequest;
    }
    if (analysis.doctorName) next.doctorPreference = analysis.doctorName;
    if (analysis.visitType) next.visitType = analysis.visitType;
  }

  const fields = (d: LeadDraft) =>
    JSON.stringify([
      d.patientName, d.preferredTime, d.preferredDate, d.preferredHour,
      d.specialtyKey, d.unmatchedRequestText, d.doctorPreference, d.visitType, d.paymentIntention,
    ]);
  return { draft: next, changed: fields(next) !== fields(draft) };
}

function leadRowFields(draft: LeadDraft): LeadFields {
  return {
    patientName: draft.patientName ?? null,
    specialty: findSpecialty(draft.specialtyKey)?.name ?? draft.unmatchedRequestText ?? null,
    // true cuando lo único que tenemos es el texto libre del paciente (una
    // especialidad, un servicio o un examen que no está en ningún catálogo
    // nuestro): no confirmamos ni negamos que la clínica lo ofrezca, se marca
    // para que el asesor lo revise antes de avisar nada.
    specialtyUnverified: Boolean(!draft.specialtyKey && draft.unmatchedRequestText),
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

  if (draft.kind === "no_disponible") {
    return { lines: ["💰 El precio se lo confirma el asesor junto con la disponibilidad."], quote: null };
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
  const showVisitType = draft.kind === "ficha" && draft.visitType && Boolean(spec?.reconsultaDays);
  const price = priceLines(draft, clinic);

  const lines = [
    "📋 *Resumen de su solicitud*",
    "",
    `${draft.specialtyKey === "pediatria" ? "👶" : "👤"} Paciente: ${draft.patientName}`,
    draft.kind === "servicio" ? `🩺 Servicio: ${draft.serviceName}` : null,
    draft.kind === "ficha" && spec ? `🩺 Especialidad: ${spec.name}` : null,
    // Fuera de catálogo (especialidad, servicio o examen): se anota tal cual
    // lo pidió, sin afirmar ni negar que la clínica lo ofrece. El asesor lo
    // confirma antes de avisarle nada al paciente.
    draft.kind !== "servicio" && !spec && draft.unmatchedRequestText
      ? `🩺 Pidió: ${draft.unmatchedRequestText} _(no está en nuestro catálogo — el asesor confirma si lo ofrecemos y el precio)_`
      : null,
    draft.kind !== "servicio" && draft.doctorPreference ? `👨‍⚕️ Médico de preferencia: ${draft.doctorPreference}` : null,
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
      : draft.kind === "no_disponible"
        ? "Un asesor de la clínica le escribirá por aquí para confirmarle si lo realizamos, el precio y el horario."
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
  ctx: FlowContext & { kind: LeadDraft["kind"]; service?: ServiceItem | null; analysis: TurnAnalysis | null },
): Promise<LeadTurnResult> {
  const base: LeadDraft = { kind: ctx.kind };
  let intro = "¡Con gusto le ayudo a pedir su ficha! 😊";

  // Fuera de catálogo: no se le habla de "su ficha" (puede ser un examen, no una
  // consulta) ni se afirma que lo ofrecemos. Solo se toma el pedido.
  if (ctx.kind === "no_disponible") {
    const pedido = mergeAnalysis(base, ctx.analysis).draft.unmatchedRequestText;
    base.unmatchedRequestText = pedido ?? null;
    intro = pedido
      ? `Con gusto le ayudo con *${pedido}* 😊 Se lo confirma un asesor de la clínica, junto con el precio.`
      : "Con gusto le ayudo 😊 Se lo confirma un asesor de la clínica.";
  }

  if (ctx.kind === "servicio" && ctx.service) {
    base.serviceName = ctx.service.name;
    base.serviceQuote = formatServicePrice(ctx.service) + (ctx.service.note ? ` (${ctx.service.note})` : "");
    intro = isHolidayToday(ctx.clinic.holidayDate, ctx.clinic.timezone)
      ? `Con gusto le ayudo con *${ctx.service.name}* 😊 Hoy es *feriado* y los precios cambian: el asesor le confirma el monto.`
      : `*${ctx.service.name}*: ${base.serviceQuote} 😊`;
  }

  return askOrSummarize(ctx, mergeAnalysis(base, ctx.analysis).draft, intro);
}

// El paciente PREGUNTÓ por algo que no está en catálogo ("¿tienen
// electrocardiograma?"). No pidió nada todavía, así que no se le piden datos: se
// le dice lo que sabemos y se le ofrece averiguarlo.
//
// La solicitud queda abierta en collecting_lead con lo pedido ya anotado, pero
// SIN preguntar nada. Si contesta que sí, continueLead pide lo que falta; si
// dice que no, wantsOut la cierra. No hace falta un paso nuevo en la máquina.
export async function offerLead(
  ctx: FlowContext & { request: string; analysis: TurnAnalysis | null },
): Promise<LeadTurnResult> {
  const base: LeadDraft = { kind: "no_disponible", unmatchedRequestText: ctx.request, offerPending: true };
  const draft = mergeAnalysis(base, ctx.analysis).draft;
  await saveStep(ctx, "collecting_lead", draft);
  return { reply: unlistedAnswer(ctx.request), pauseAfterReply: false };
}

// El paciente rechazó la oferta ("no", "no gracias"). Se descarta sin dejar
// nada pendiente: nunca hubo solicitud, así que no hay fila que retirar.
export async function cancelOffer(ctx: FlowContext): Promise<LeadTurnResult> {
  await saveStep(ctx, "idle", null);
  return {
    reply: "Entendido 😊 Si más adelante lo necesita, o quiere consultar otra cosa, escríbame nomás.",
    pauseAfterReply: false,
  };
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

  // Si venía de una oferta, llegar acá significa que el paciente la aceptó
  // (decideAction ya descartó el rechazo y el cambio de tema): deja de estar
  // pendiente y sigue como cualquier otra recolección.
  const accepted = lead.offerPending ? { ...lead, offerPending: false } : lead;
  const { draft, changed } = mergeAnalysis(accepted, analysis);

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
      // Si la respuesta se descartó (negaba algo o prometía una gestión) se
      // sigue igual con la confirmación: el asesor ya tiene la solicitud y le
      // resuelve la duda. Nunca se le manda al paciente el texto vetado.
      const answer = await answerQuestion(ctx, ctx.text);
      return { reply: answer.status === "ok" ? `${answer.text}\n\n_${confirmQuestion}_` : confirmQuestion, pauseAfterReply: false };
    }
    return { reply: confirmQuestion, pauseAfterReply: false };
  }

  // collecting_lead
  let intro: string | undefined;
  if (changed) intro = "¡Gracias! 😊";
  else if (analysis?.isQuestion) {
    const answer = await answerQuestion(ctx, ctx.text);
    intro = answer.status === "ok" ? answer.text : undefined;
  }
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
