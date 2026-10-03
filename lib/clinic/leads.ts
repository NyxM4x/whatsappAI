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
//   o reconsulta (solo en las especialidades con reconsulta; lo declara el
//   paciente).
// Servicio (ecografía, procedimiento…): nombre y día y hora cómodos, sin
//   consulta nueva o reconsulta.
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
  isHoliday,
  matchSpecialtyText,
  localDateISO,
  localNow,
  quoteConsultation,
} from "@/lib/clinic/pricing";
import { dateConflictQuestion, longDate, readDateMention, shortDayLabel } from "@/lib/clinic/dates";
import {
  activePromo,
  editDistance,
  formatServicePrice,
  matchService,
  mentionsOffCatalogRequest,
  promoIntro,
  promoMentions,
  quoteService,
  serviceForDay,
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
  // Dijo un día que no calza con la fecha real ("hoy sábado" un viernes): la
  // pregunta para aclararlo, armada por código. Mientras tanto el horario no
  // se toma (ver lib/clinic/dates.ts).
  dateConflict: string | null;
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
- doctorName: el médico que pide el paciente, tal como lo escribió. Si no nombra a nadie pero pide que la atienda una mujer ("con una doctora", "que sea mujer"), poné "doctora (mujer)". null si no dice nada de eso.
- Si el apellido que nombra coincide con más de un médico de la lista (por ejemplo "Dra. Medina"), decidí por el contexto: PAP, papanicolaou, embarazo o ginecología → el de ginecología; un niño o un bebé → el de pediatría. Sin contexto, specialtyKey null.
- preferredTime: el día y/o la hora que prefiere, en pocas palabras y como lo dijo ("mañana a las 10", "el sábado en la tarde", "lo antes posible"). null si no dijo nada de horario.
- preferredDate: la fecha de ese día en formato YYYY-MM-DD, calculada con la fecha actual ("hoy", "ahora", "mañana", "el lunes", "20 de septiembre"). null si no dijo un día claro.
- preferredHour: la hora en formato 24 h solo si es clara ("10 de la mañana" → 10:00, "7 de la noche" → 19:00, "15:30" → 15:30). Una hora de 1 a 6 sin mañana/tarde/noche es de la tarde (13:00 a 18:00). Una hora de 7 a 12 sin mañana/tarde/noche es ambigua → null. "ahora" o "lo antes posible" → la hora actual.
- visitType: lo DECLARA el paciente, no se deduce. "reconsulta" solo si dice que es reconsulta o que vuelve con el mismo médico por la misma consulta. "nueva" solo si dice consulta nueva, primera vez o que nunca vino. Pedir "una consulta" o "una ficha", hablar de "control" o de mostrar resultados NO alcanza: en esos casos null, y el asistente se lo pregunta.
- wantsLead: true si quiere pedir ficha, cita, turno o consulta, o atenderse con un médico o una especialidad. OJO: "una consulta", "tengo una consulta" o "le hago una consulta" al empezar el mensaje significan que tiene una PREGUNTA, no que pide una consulta médica: eso solo no es wantsLead. Preguntar el precio de algo tampoco es wantsLead.
- wantsHuman: true SOLO si pide hablar con una persona (doctora, doctor, enfermera, recepcionista, secretaria, asesor, alguien) o dice que no quiere seguir con el asistente. Pedir una ficha o consulta con un médico NO es wantsHuman. Pedir que la atienda una doctora o una mujer para un examen o un servicio ("quiero el PAP con una doctora", "¿me lo puede hacer una mujer?") tampoco: eso va en doctorName.
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

// Lo que distingue "quiero hablar con la doctora" (derivar) de "quiero el PAP
// con una doctora" (un dato de la solicitud). El modelo marcaba wantsHuman en
// el segundo y el bot se pausaba (verificado 2026-09-21). Es la misma regla que
// humanHandoffIntentPatterns en config.ts: sin el verbo, no es derivación.
const TALK_TO_SOMEONE_PATTERN =
  /\b(?:hablar|comunic\w+|conversar|contact\w+)\b|\b(?:persona|humano|asesor[a]?|alguien)\b|\b(?:bot|robot|m[aá]quina|asistente)\b/i;

// ─── Médico nombrado en el texto ─────────────────────────────────────────────
// "consulta con el doctor dagiino": la gente escribe el apellido como lo
// escucha. El modelo recibe la lista de médicos y suele acertar, pero reconocer
// un nombre contra una lista cerrada es comparación de strings, igual que con
// las especialidades: se resuelve acá, tolerando errores de tipeo.
//
// Solo se miran las palabras que siguen a un título ("doctor", "dra", "doc",
// "licenciada"): sin ese ancla, el paciente que se llama Miguel se volvería el
// Dr. Miguel Daguino.
export type DoctorRef = { name: string; specialtyKey: string | null };

const DOCTOR_TITLE =
  /(?<![a-zñ])(?:dr|dra|doc|doct|doctor|doctora|dotor|dotora|lic|licenciad[oa])\b\.?\s+((?:[a-zñ]+\s*){1,3})/g;
const DOCTOR_NAME_TITLE = /^(?:dr|dra|lic)\.?$/;
const DOCTOR_MIN_WORD = 4;

function normalizeName(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/ñ/g, "ñ").replace(/[̀-ͯ]/g, "");
}

// Un error hasta 6 letras, dos desde 7 ("dagiino" → "daguino"), y la primera
// letra igual: con menos candados, dos apellidos cortos se confunden.
function sameNameWord(word: string, token: string): boolean {
  if (word[0] !== token[0]) return false;
  const max = token.length >= 7 ? 2 : 1;
  return editDistance(word, token, max) <= max;
}

// El médico (o al menos su especialidad) que nombra el texto. Si el nombre
// calza con médicos de especialidades distintas ("Dra. Medina", "Dr.
// Delgadillo"), devuelve null: eso lo decide el contexto, que es cosa del modelo.
export function matchDoctorText(
  text: string,
  doctors: DoctorRef[],
): { doctor: string | null; specialtyKey: string } | null {
  const words = [...normalizeName(text).matchAll(DOCTOR_TITLE)]
    .flatMap((m) => m[1].trim().split(/\s+/))
    .filter((w) => w.length >= DOCTOR_MIN_WORD);
  if (!words.length) return null;

  const hits = doctors.filter((doctor) => {
    const tokens = normalizeName(doctor.name)
      .split(/\s+/)
      .filter((t) => t.length >= DOCTOR_MIN_WORD && !DOCTOR_NAME_TITLE.test(t));
    return tokens.some((token) => words.some((word) => sameNameWord(word, token)));
  });

  const specialties = new Set(hits.map((d) => d.specialtyKey));
  const [specialtyKey] = [...specialties];
  if (specialties.size !== 1 || !specialtyKey) return null;
  return { doctor: hits.length === 1 ? hits[0].name : null, specialtyKey };
}

// Consulta nueva o reconsulta, cuando el paciente lo dice con todas las letras
// (o contesta "nueva" a la pregunta). Lo que diga así manda sobre el modelo,
// que llegó a deducir "reconsulta" de un "traigo resultados" y a prometer que
// era gratis.
const NOT_RECONSULTA = /\bno\s+(?:es\s+)?(?:una\s+)?re\s?-?consulta\b/i;
const RECONSULTA = /\bre\s?-?consulta\b/i;
const NUEVA = /\b(?:consulta\s+nueva|nueva\s+consulta|primera\s+vez|nunca\s+(?:vine|vino|fui|fue))\b|^\s*(?:es\s+)?(?:una\s+)?nuev[oa]\b/i;

export function visitTypeFromText(text: string): VisitType | null {
  if (NOT_RECONSULTA.test(text)) return "nueva";
  if (RECONSULTA.test(text)) return "reconsulta";
  if (NUEVA.test(text)) return "nueva";
  return null;
}

function sanitizeAnalysis(raw: any, text: string, services: ServiceItem[], doctors: DoctorRef[] = []): TurnAnalysis {
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

  // Y contra los médicos: un apellido mal escrito ("doctor dagiino") no es un
  // servicio que no ofrecemos.
  const fromDoctor = matchDoctorText(text, doctors);
  if (unavailableRequest && matchDoctorText(unavailableRequest, doctors)) unavailableRequest = null;

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
  // inferencia. Después, la del médico que nombró. Si no hay ninguna, vale la
  // del modelo (que ahí sí está infiriendo desde un síntoma), salvo que de
  // verdad haya pedido algo que no tenemos.
  const specialtyKey =
    fromText?.key ?? unavailableIsOurs?.key ?? (unavailableRequest ? null : (fromDoctor?.specialtyKey ?? fromModel));

  // wantsLead sale tal cual del modelo. Antes se forzaba acá ("nombró una
  // especialidad y no preguntó => quiere ficha"), pero eso es una decisión de
  // flujo, no normalización: vive en wantsToRequest() de lib/clinic/routing.ts,
  // donde se puede leer junto al resto del ruteo y probar sin llamar al modelo.
  const isQuestion = raw?.isQuestion === true;

  // El nombre pasa por looksLikeName(): el modelo devuelve "pa mi" o "mi
  // hijo" cuando el paciente contesta PARA QUIEN es en vez de como se llama.
  const rawName = cleanText(raw?.patientName, 80);
  const patientName = rawName && looksLikeName(rawName) ? rawName : null;

  // Si lo que el modelo vio como "quiere una persona" es en realidad el médico
  // de preferencia, y no hay verbo de hablar/comunicarse, es un dato.
  //
  // Si el médico se reconoció sin ambigüedad, al asesor le llega su nombre real
  // y no "dagiino".
  const doctorName = fromDoctor?.doctor ?? cleanText(raw?.doctorName, 80);
  const wantsHuman = raw?.wantsHuman === true && !(doctorName && !TALK_TO_SOMEONE_PATTERN.test(text));

  return {
    patientName,
    specialtyKey,
    doctorName,
    preferredTime: cleanText(raw?.preferredTime),
    preferredDate: date,
    preferredHour: cleanHour(raw?.preferredHour),
    visitType: visitTypeFromText(text) ?? (raw?.visitType === "nueva" || raw?.visitType === "reconsulta" ? raw.visitType : null),
    paymentIntention: raw?.paymentIntention === "qr" || raw?.paymentIntention === "efectivo" ? raw.paymentIntention : null,
    unavailableRequest,
    needsHumanAction: raw?.needsHumanAction === true || HUMAN_ACTION_PATTERN.test(text),
    wantsLead: raw?.wantsLead === true,
    wantsHuman,
    frustrated: raw?.frustrated === true,
    confirms: raw?.confirms === true,
    wantsOut: raw?.wantsOut === true,
    isQuestion,
    dateConflict: null,
  };
}

// La fecha del horario la calcula el código, no el modelo. Si el texto nombra
// un día claro, esa fecha manda sobre la que devolvió el modelo; si no nombra
// ninguno ("lo antes posible", "la otra semana"), queda la del modelo. Un día
// que no calza con la fecha real anula el horario hasta que el paciente aclare.
export function applyDateMention(analysis: TurnAnalysis, text: string, today: string): TurnAnalysis {
  const mention = readDateMention(text, today);
  if (mention.kind === "conflict") {
    return {
      ...analysis,
      preferredTime: null,
      preferredDate: null,
      preferredHour: null,
      dateConflict: dateConflictQuestion(mention, today),
    };
  }
  if (mention.kind === "date" && analysis.preferredTime) return { ...analysis, preferredDate: mention.date };
  return analysis;
}

// "mañana a las 10 (sábado 26/09)": lo que dijo, con la fecha real al lado
// para que el paciente y el asesor vean el mismo día.
function preferredTimeWithDate(draft: LeadDraft): string | null {
  if (!draft.preferredTime) return null;
  return draft.preferredDate ? `${draft.preferredTime} (${shortDayLabel(draft.preferredDate)})` : draft.preferredTime;
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
    const analysis = sanitizeAnalysis(JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, "").trim()), ctx.text, ctx.clinic.services, doctors);
    return applyDateMention(analysis, ctx.text, now.date);
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
//
// Lo que sigue al verbo importa: "el PAP no se realiza si está con su regla"
// es un REQUISITO, no una negación. Sin esa salvedad, explicar los requisitos
// de la campaña derivaba al asesor y pausaba el bot (verificado 2026-09-21).
// Solo se exceptúan las condiciones ("si", "durante", "con la regla"…): "no
// realizamos PAP" o "no se hace en feriados" siguen vetadas.
const NEGATION_PATTERN =
  /\bno\s+(?:se\s+)?(?:l[oa]s?\s+|le\s+)?(?:tengo|tenemos|ten[eé]s|contamos|cuenta|dispongo|disponemos|ofrecemos|ofrece|brindamos|brinda|realizamos|realiza|hacemos|hace|manejamos|maneja|prestamos|trabajamos|figur\w+|aparec\w+|est[aá]\s+(?:disponible|registrad\w+|en\s+(?:mi|el|la|nuestr\w+)))\b(?!\s+(?:si|cuando|durante|mientras|antes|hasta|despu[eé]s)\b|\s+con\s+(?:la\s+|el\s+|su\s+)?(?:regla|peri[oó]do|menstruaci[oó]n|sangrado))/i;

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
  // "¿A qué hora atienden hoy sábado?" un viernes: la aclaración la escribe el
  // código (no se deja a criterio del modelo) y el modelo responde por el día real.
  const today = localNow(ctx.clinic.timezone).date;
  const mention = readDateMention(text, today);
  const conflict = mention.kind === "conflict" ? mention : null;
  const correction = conflict ? `Una aclaración: hoy es *${longDate(today)}* 😊` : null;
  const system = conflict
    ? `${buildClinicSystemPrompt(ctx.clinic)}\n\nEl paciente dijo "${conflict.said}", pero hoy es ${longDate(today)}. Tu respuesta va a continuación de un mensaje que ya le aclara qué día es hoy: no lo repitas y respondé según la fecha real.`
    : buildClinicSystemPrompt(ctx.clinic);

  try {
    const history = await getRecentConversationHistory(ctx.conversationId, 8);
    const { text: answer } = await generateText({
      model: model(),
      system,
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

    return { status: "ok", text: correction ? `${correction}\n\n${clean}` : clean };
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

// Solo en las especialidades con reconsulta (Medicina General, Ginecología y
// Pediatría, confirmado 2026-10-03): en las demás no existe, así que la
// respuesta no cambiaría nada. En servicios tampoco se pregunta.
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
  // Lo que no está en catálogo solo pide día y hora (pedido de la clínica,
  // 2026-10-03): el asesor responde lo antes posible y el nombre lo toma él.
  if (!draft.patientName && draft.kind !== "no_disponible") missing.push("name");
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
  // corregir qué necesita o decir si es reconsulta.
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
    if (analysis.visitType) next.visitType = analysis.visitType;
  }
  // El médico de preferencia vale también para un servicio: en el PAP, pedir
  // que la atienda una doctora cambia el precio (es a llamado).
  if (analysis.doctorName) next.doctorPreference = analysis.doctorName;

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
    preferredTime: preferredTimeWithDate(draft),
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
  if (draft.kind === "servicio") {
    const today = localDateISO(new Date(), clinic.timezone);
    const holidays = clinic.holidayDates;
    const day = draft.preferredDate ?? today;
    const matched = clinic.services.find((s) => s.name === draft.serviceName);
    // Con el día pedido se elige la variante que corresponde: "Retiro de uña"
    // un sábado o un feriado se cobra como "Retiro de uña fin de semana".
    const service = matched && draft.preferredDate
      ? serviceForDay(matched, clinic.services, draft.preferredDate, holidays)
      : matched;

    // Con promo, el precio depende del día y la hora que pidió (la promo tiene
    // franja y fecha de fin): se calcula acá, no se repite el de la apertura.
    if (service && activePromo(service, day)) {
      const quote = quoteService(service, {
        today,
        date: draft.preferredDate,
        hour: draft.preferredHour,
        holidays,
        doctorPreference: draft.doctorPreference,
      });
      return { lines: [`💰 Precio: ${quote}`], quote };
    }

    // Si la promo venció entre la apertura y el resumen, el precio guardado ya
    // no vale: se recalcula con el regular. En feriado, la nota de la variante
    // ("sábado y domingo") confundiría: se dice que es feriado.
    const note = service && isHoliday(day, holidays) && draft.preferredDate
      ? " (feriado)"
      : service?.note ? ` (${service.note})` : "";
    const serviceQuote = service ? formatServicePrice(service, day) + note : draft.serviceQuote;
    return { lines: serviceQuote ? [`💰 Precio: ${serviceQuote}`] : [], quote: serviceQuote ?? null };
  }

  if (draft.kind === "no_disponible") {
    return { lines: ["💰 El precio se lo confirma el asesor junto con la disponibilidad."], quote: null };
  }

  const spec = findSpecialty(draft.specialtyKey);
  if (!spec) return { lines: ["💰 El asesor le confirma el precio de la consulta."], quote: null };

  // Reconsulta: la declara el paciente y se le confirma en una línea, con el
  // plazo entre paréntesis.
  if (draft.visitType === "reconsulta" && spec.reconsultaDays) {
    return {
      lines: [`💰 Reconsulta *gratis* (si pasaron más de ${spec.reconsultaDays} días desde su consulta, se cobra como consulta nueva).`],
      quote: `Reconsulta gratis dentro de ${spec.reconsultaDays} días`,
    };
  }

  const quote = quoteConsultation({
    spec,
    date: draft.preferredDate,
    hour: draft.preferredHour,
    holidays: clinic.holidayDates,
  });
  const lines = [
    quote.kind === "exact"
      ? `💰 Precio de la consulta en ese horario: *${quote.text}*`
      : `💰 Precio de la consulta: ${quote.text}`,
  ];
  if (spec.reconsultaDays && draft.visitType === "nueva") {
    lines.push(`ℹ️ Si luego necesita reconsulta, es *gratis* dentro de los ${spec.reconsultaDays} días siguientes a su consulta.`);
  }
  // Dijo "reconsulta" en una especialidad que no la tiene: se lo aclaramos en
  // vez de dejarle creer que es gratis.
  if (!spec.reconsultaDays && draft.visitType === "reconsulta") {
    lines.push(`ℹ️ En ${spec.name} no hay reconsulta gratis: se cobra como consulta.`);
  }
  return { lines, quote: quote.text };
}

function buildSummary(draft: LeadDraft, clinic: ClinicConfig): { text: string; priceQuote: string | null } {
  const spec = findSpecialty(draft.specialtyKey);
  // En especialidades sin reconsulta no se menciona el tipo de consulta.
  const showVisitType = draft.kind === "ficha" && draft.visitType && Boolean(spec?.reconsultaDays);
  const price = priceLines(draft, clinic);

  const lines = [
    "📋 *Resumen de su solicitud*",
    "",
    draft.patientName ? `${draft.specialtyKey === "pediatria" ? "👶" : "👤"} Paciente: ${draft.patientName}` : null,
    draft.kind === "servicio" ? `🩺 Servicio: ${draft.serviceName}` : null,
    draft.kind === "ficha" && spec ? `🩺 Especialidad: ${spec.name}` : null,
    // Fuera de catálogo (especialidad, servicio o examen): se anota tal cual
    // lo pidió, sin afirmar ni negar que la clínica lo ofrece. El asesor lo
    // confirma antes de avisarle nada al paciente.
    draft.kind !== "servicio" && !spec && draft.unmatchedRequestText
      ? `🩺 Pidió: ${draft.unmatchedRequestText} _(no está en nuestro catálogo — el asesor confirma si lo ofrecemos y el precio)_`
      : null,
    draft.doctorPreference ? `👨‍⚕️ Médico de preferencia: ${draft.doctorPreference}` : null,
    `🗓️ Horario que prefiere: ${preferredTimeWithDate(draft)}`,
    showVisitType ? `🔁 ${draft.visitType === "reconsulta" ? "Reconsulta" : "Consulta nueva"}` : null,
    // Solo se confirma lo que el paciente dijo. El bot no cobra ni manda el QR:
    // el asesor ve el dato y sigue desde ahí.
    draft.paymentIntention
      ? `💳 Pago: ${draft.paymentIntention === "qr" ? "por QR" : "en efectivo al llegar"}`
      : null,
    "",
    ...price.lines,
    ...(draft.kind === "ficha"
      ? promoMentions(clinic.services, draft.specialtyKey, localDateISO(new Date(), clinic.timezone))
      : []),
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

// El paciente dijo un día que no calza con la fecha real. Se descarta el
// horario (el anterior también: lo está cambiando) y se le pregunta cuál quiso
// decir; con la respuesta, el flujo sigue normal.
async function askDateAgain(ctx: FlowContext, draft: LeadDraft, question: string, intro?: string): Promise<LeadTurnResult> {
  await saveStep(ctx, "collecting_lead", { ...draft, preferredTime: null, preferredDate: null, preferredHour: null });
  return { reply: intro ? `${intro}\n\n${question}` : question, pauseAfterReply: false };
}

async function askOrSummarize(ctx: FlowContext, draft: LeadDraft, intro?: string): Promise<LeadTurnResult> {
  const missing = missingFields(draft);
  if (!missing.length) return sendSummary(ctx, draft, intro);
  await saveStep(ctx, "collecting_lead", draft);
  return { reply: askMissing(draft, missing, intro), pauseAfterReply: false };
}

export async function startLead(
  ctx: FlowContext & { kind: LeadDraft["kind"]; service?: ServiceItem | null; offer?: boolean; analysis: TurnAnalysis | null },
): Promise<LeadTurnResult> {
  const base: LeadDraft = { kind: ctx.kind };
  let intro = "¡Con gusto le ayudo a pedir su ficha! 😊";

  // Fuera de catálogo: no se le habla de "su ficha" (puede ser un examen, no una
  // consulta) ni se afirma que lo ofrecemos. Solo se toma el pedido.
  if (ctx.kind === "no_disponible") {
    const pedido = mergeAnalysis(base, ctx.analysis).draft.unmatchedRequestText;
    base.unmatchedRequestText = pedido ?? null;
    intro = pedido
      ? `Con gusto le ayudo con *${pedido}* 😊 Le paso su solicitud a un asesor de la clínica para que le responda lo antes posible con el precio y la disponibilidad.`
      : "Con gusto le ayudo 😊 Le paso su solicitud a un asesor de la clínica para que le responda lo antes posible.";
  }

  if (ctx.kind === "servicio" && ctx.service) {
    const today = localDateISO(new Date(), ctx.clinic.timezone);
    const holidayToday = isHoliday(today, ctx.clinic.holidayDates);
    const promo = activePromo(ctx.service, today);
    base.serviceName = ctx.service.name;
    base.serviceQuote = formatServicePrice(ctx.service, today) + (ctx.service.note ? ` (${ctx.service.note})` : "");

    if (promo) {
      // La información de la campaña reemplaza a la del servicio normal (D2:
      // todo en un mensaje, como la respuesta rápida de la clínica).
      const holidayLine = holidayToday && promo.outside
        ? `\n\n📅 Hoy es *feriado*: para hoy la promoción no aplica y rige ${promo.outside.price} Bs (${promo.outside.label}).`
        : "";
      intro = promoIntro(ctx.service, promo) + holidayLine;
    } else {
      intro = `*${ctx.service.name}*: ${base.serviceQuote} 😊`;
    }
  }

  const draft = mergeAnalysis(base, ctx.analysis).draft;
  if (ctx.analysis?.dateConflict) return askDateAgain(ctx, draft, ctx.analysis.dateConflict, intro);

  // Solo preguntó el precio: se le da y se le ofrece el servicio, sin darlo por
  // pedido. Queda como oferta, así que si contesta otra cosa el mensaje se
  // re-decide en vez de consumirse como dato (ver decideAction).
  const missing = missingFields(draft);
  if (ctx.offer && ctx.kind === "servicio" && missing.length) {
    await saveStep(ctx, "collecting_lead", { ...draft, offerPending: true });
    const asks = missing.map((f) => (f === "name" ? "el *nombre del paciente*" : "el *día y la hora* que le quedarían cómodos"));
    return {
      reply: `${intro}\n\n¿Desea hacerse el servicio? Si es así, dígame ${asks.join(" y ")} 😊`,
      pauseAfterReply: false,
    };
  }
  return askOrSummarize(ctx, draft, intro);
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

  // Un día que no calza manda sobre todo lo demás: si se siguiera, el resumen
  // le confirmaría un día que no es.
  if (analysis?.dateConflict) return askDateAgain(ctx, draft, analysis.dateConflict);

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
