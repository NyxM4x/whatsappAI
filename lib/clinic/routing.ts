// ============================================================================
// Decisión de ruteo — qué debe pasar con un mensaje, sin hacerlo todavía
// ----------------------------------------------------------------------------
// Antes esto eran trece `if` dentro del webhook que decidían, ejecutaban y
// respondían en las mismas líneas: no había forma de probar una decisión sin
// levantar el webhook entero, con Supabase, Kapso y OpenAI detrás.
//
// Acá solo se decide. Nada de esto escribe en base de datos, manda WhatsApp ni
// llama a ninguna API: entra (texto + análisis + estado + config) y sale una
// Action que el webhook ejecuta. Es una función pura, así que
// scripts/check-routing.ts la prueba con tablas de casos y sin red.
//
// El orden de las ramas es el mismo que tenía el webhook, a propósito: es
// comportamiento probado en producción y cambiarlo de orden mueve cosas que hoy
// funcionan. Lo que cambió es QUIÉN decide, no CUÁNDO.
// ============================================================================

import type { ClinicConfig } from "@/lib/clinic/config";
import { matchSpecialtyText } from "@/lib/clinic/pricing";
import { matchService, mentionsOffCatalogRequest, type ServiceItem } from "@/lib/clinic/services";
import type { TurnAnalysis } from "@/lib/clinic/leads";
import type { AuditIntent, BookingStep, LeadDraft, LeadKind } from "@/lib/clinic/types";

// Lo que el webhook tiene que hacer. Cada variante lleva su `intent`, que es lo
// que se guarda en clinic_webhook_audits.
export type Action =
  // Responder un texto fijo y nada más.
  | { type: "reply"; text: string; intent: AuditIntent }
  // Responder ubicación y continuar una solicitud que ya estaba en curso.
  | { type: "locationAndContinueLead"; text: string; intent: AuditIntent }
  // Derivar: alarma en el panel, aviso al paciente y pausa del bot. Con
  // pause: false deja la alarma sin pausar (el paciente puede seguir
  // preguntando otras cosas mientras el asesor le responde).
  | { type: "escalate"; kind: LeadKind; reply: string; intent: AuditIntent; pause?: boolean }
  // Abrir una solicitud nueva y pedir lo que falte. Con offer, el paciente solo
  // preguntó el precio: se le da y se le ofrece el servicio, sin darlo por pedido.
  | { type: "startLead"; kind: LeadDraft["kind"]; service?: ServiceItem | null; offer?: boolean; intent: AuditIntent }
  // Enviar la imagen del QR de pago (con este texto al pie) y avisar al asesor,
  // sin pausar el bot.
  | { type: "sendQr"; caption: string; intent: AuditIntent }
  // Un signo que puede ser grave o no: se pregunta una sola vez si es urgente.
  | { type: "askUrgency"; text: string; intent: AuditIntent }
  // El mensaje admite dos lecturas que llevan a lugares distintos: se pregunta
  // cuál quiso decir y se recuerda el servicio para entender la respuesta.
  | { type: "clarify"; text: string; serviceName: string; intent: AuditIntent }
  // Tomar el pedido de algo que no está en catálogo. El paciente ve una
  // solicitud normal (se le piden los datos); por dentro queda como oferta, así
  // que si contesta otra cosa el mensaje se re-decide en vez de consumirse.
  | { type: "offerLead"; request: string; intent: AuditIntent }
  // El paciente rechazó la oferta: se descarta y la conversación vuelve a cero.
  | { type: "cancelOffer"; intent: AuditIntent }
  // Seguir una solicitud ya empezada.
  | { type: "continueLead"; intent: AuditIntent }
  // Q&A libre con el prompt de la clínica.
  | { type: "qa"; intent: AuditIntent };

export type RoutingInput = {
  clinic: ClinicConfig;
  // Texto consolidado del paciente. "" si solo mandó una imagen o un audio.
  text: string;
  // null si el modelo falló o si no había texto que analizar.
  analysis: TurnAnalysis | null;
  step: BookingStep;
  // Qué ofreció consultar el bot y el paciente todavía no aceptó. null = no hay
  // oferta pendiente. Se guarda el TEXTO y no un booleano porque hace falta
  // saber si el mensaje siguiente insiste con lo mismo o trae otra cosa.
  pendingOffer?: string | null;
  // Resultado de registrar adjuntos, ya calculado por el webhook.
  proof: "receipt" | "unverified" | null;
  emergencyDetectionEnabled: boolean;
  greetingOnly: boolean;
  priceDispute?: boolean;
  // Servicio sobre el que el bot preguntó "¿consulta o precio?" en el turno
  // anterior. null = no hay aclaración pendiente.
  pendingClarify?: string | null;
  // El bot preguntó "¿Es urgente?" en el turno anterior.
  pendingUrgency?: boolean;
};

// Respuestas a una pregunta cerrada. Se resuelven con patrones y no con el
// modelo a propósito: el análisis no distingue "No" de un mensaje neutral
// —devuelve wantsOut:false para los dos— porque sin saber que hubo una oferta,
// un "No" suelto no significa "ya no quiero la solicitud". En el contexto de
// una pregunta de sí/no, en cambio, reconocerlo es determinista.
const AFFIRMATIVE = /^\s*(?:s[ií]|sip+|claro|dale|bueno|ok(?:ay)?|por ?favor|de una|obvio|as[ií] es|est[aá] bien|me parece|dele|dal[eé])(?=$|[\s,.!?])/i;
const NEGATIVE = /^\s*(?:no|nop+|nel|negativo|mejor no|ya no|d[eé]j[eaá]lo|olv[ií]delo|gracias no|nada m[aá]s|as[ií] nom[aá]s)\b/i;
const DECLINES_LEAD_CAPTURE =
  /\bsolo\s+(?:quiero|necesito)\b.{0,80}\bno\s+(?:quiero\s+)?(?:una?\s+)?(?:ficha|cita|turno|consulta)\b|\bno\s+(?:quiero|deseo|necesito)\s+(?:una?\s+)?(?:ficha|cita|turno|consulta)\b/i;

// Nunca dejamos que el Q&A ni una ficha interpreten señales clínicas. Hay dos
// niveles, y ninguno diagnostica ni indica nada:
//
// - Signos graves (no respira, convulsiona, inconsciente, dolor fuerte en el
//   pecho, hemorragia): se responde con el texto de emergencia que configuró la
//   clínica (emergencyResponse: ir a Emergencias, dirección y teléfono) y se
//   avisa a una persona.
// - Golpes en zonas de riesgo y pedidos de indicación de medicamentos: se deriva
//   a personal clínico con un texto prudente.
//
// La "ó" va explícita: "convulsión" con tilde no coincidía con "convulsion".
//
// "No reacciona", "no despierta", "se ahoga" y "se atragantó" se sumaron el
// 2026-10-03: "mi bebé tiene fiebre de 40 y no reacciona" caía al Q&A. Las
// formas de "no respira" también ("no está respirando", "dejó de respirar", "le
// cuesta respirar", "se puso morado"): solo estaba la primera persona.
//
// Es una lista de frases, no un triage: cubre lo que se probó, no toda forma
// posible de contar un cuadro grave. La red de abajo es la persona del panel.
const CLINICAL_SEVERE_PATTERN =
  /\b(?:no\s+(?:puedo\s+|puede\s+|est[aá]\s+)?respir(?:a|o|aba|ando|ar)\b|dej[oó]\s+de\s+respirar|(?:le|me)\s+cuesta\s+respirar|respira\s+con\s+dificultad|dificultad(?:es)?\s+para\s+respirar|se\s+(?:puso|est[aá]\s+poniendo)\s+morad[oa]|labios\s+morados|convulsi[oó]n(?:es)?|convulsion\w*|desmay\w*\b(?!\s+de\s+(?:la\s+)?(?:risa|hambre|sue[nñ]o|cansancio|calor))|perdi[oó] el conocimiento|inconsciente|no reacciona|no despierta|se\s+(?:est[aá]\s+)?ahog\w*|atragant\w*|(?:le|me)\s+dio\s+un\s+ataque\b(?!\s+de\s+(?:risa|tos|nervios|hambre|celos))|ataque\s+(?:al\s+coraz[oó]n|card[ií]aco|epil[eé]ptico)|dolor(?:\s+\w+){0,3}\s+fuerte\s+(?:en\s+)?(?:el\s+)?pecho|fuerte\s+dolor\s+(?:en\s+)?(?:el\s+)?pecho)/i;
// El sangrado va aparte porque la regla abundante NO es una emergencia
// (decisión de la clínica, 2026-10-03): "sangrado abundante en mi regla" se
// atiende como cualquier consulta.
const SEVERE_BLEEDING = /\b(?:hemorragia|sangrado\s+abundante|sangra\s+mucho|no\s+para\s+de\s+sangrar)\b/i;
const MENSTRUAL = /\b(?:regla|menstrua\w*|periodo|per[ií]odo)\b/i;
// "¡Emergencia!" o "es una emergencia" sí (decisión de la clínica); el servicio
// no: "ecografía de emergencia", "consulta de emergencia", "emergencia de
// cardiología" tienen precio. "Ayuda urgente" sin más tampoco.
const EMERGENCY_CALL = /^[\s¡!]*emergencia\b(?!\s+de\b)|\b(?:es|tengo|tenemos)\s+una\s+emergencia\b/i;

// Una sola pregunta para el webhook (que la hace apenas llega el mensaje, antes
// de esperar a que termine de escribir y antes de llamar al modelo) y para el
// ruteo normal. Lo grave no espera.
export function isEmergencyText(text: string): boolean {
  if (!text) return false;
  return (
    CLINICAL_SEVERE_PATTERN.test(text) ||
    EMERGENCY_CALL.test(text) ||
    (SEVERE_BLEEDING.test(text) && !MENSTRUAL.test(text))
  );
}

// Signos que pueden ser graves o no ("mi bebé está muy decaído"): no se decide
// por el paciente ni se le hace un interrogatorio. Una sola pregunta, sí o no:
// si es urgente, se avisa al personal para que lo esperen listos (decisión de
// la clínica, 2026-10-03). La lista crece con lo que la clínica defina.
const MAYBE_URGENT = /\bdeca[ií]d[oa]s?\b/i;
const URGENT_YES = /^\s*(?:s[ií]|sip|ya|urgente|es\s+urgente|s[ií],?\s+es\s+urgente|r[aá]pido|ayuda|por\s+favor)(?=$|[\s,.!?])/i;
const URGENT_NO = /^\s*(?:no|nop|no\s+es\s+urgente)(?=$|[\s,.!?])/i;

export function needsUrgencyCheck(text: string): boolean {
  return Boolean(text) && MAYBE_URGENT.test(text) && !isEmergencyText(text);
}

export function confirmsUrgency(text: string): boolean {
  return URGENT_YES.test(text) && !URGENT_NO.test(text);
}

export const URGENCY_QUESTION =
  "¿Es urgente? 🙏 Si lo es, respóndame *sí* y aviso ya mismo al personal de la clínica para que lo esperen listos en Emergencias.";

// Lo que se le dice cuando confirma que es urgente: ya se avisó y lo esperan,
// con cómo llegar. Sin preguntas.
export function urgentConfirmedReply(clinic: ClinicConfig): string {
  const info = clinic.generalInfo;
  return [
    "🚨 Ya avisamos al personal de la clínica: lo esperan en Emergencias. Venga lo antes posible.",
    "",
    `📍 ${info.address}`,
    info.mapsUrl ? `🗺️ ${info.mapsUrl}` : null,
    info.phone ? `📞 ${info.phone}` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}
// "Caída" y "corte" sin "de cabello/pelo" detrás: "caída de cabello en la
// cabeza" no es un golpe.
const INJURY = String.raw`(?:golpe\w*|golpearon|se\s+cay[oó]|ca[ií]da(?!\s+del?\s+(?:cabello|pelo))|ladrillo|tajo|corte(?!\s+del?\s+(?:cabello|pelo))|sangra\w*)`;
const RISK_ZONE = String.raw`(?:cabeza|cr[aá]neo|costilla|pecho|abdomen)`;
const CLINICAL_INJURY_PATTERN = new RegExp(String.raw`\b${INJURY}\b.{0,60}\b${RISK_ZONE}\b|\b${RISK_ZONE}\b.{0,60}\b${INJURY}`, "i");
// Pedir una indicación es nombrar un medicamento Y preguntar cómo darlo o
// tomarlo. Cualquiera de las dos sola no alcanza: "¿se puede dar ficha para
// mañana?" o "le recetaron antibióticos, ¿cuánto cuesta la consulta?" no piden
// una indicación.
//
// PENDIENTE (módulo de farmacia): nombrar un producto tampoco es hablar de una
// receta; puede ser preguntar si lo hay en farmacia ("¿tienen salbutamol?").
// Hoy eso no se deriva porque falta la pregunta de dosis, pero cuando exista el
// módulo de farmacia esta lista va a chocar con la de productos: revisarlas
// juntas.
const MEDICATION = /\b(?:salbutamol|acetilciste[ií]na|antibi[oó]tic\w*|amoxicilina|paracetamol|ibuprofeno|jarabe|pastillas?|gotas|remedio|medicamento\w*)\b/i;
// También cuenta pedir que le validen la dosis: "me dijeron 2 gotas de
// salbutamol, ¿está bien?" caía al Q&A, que podía opinar.
const DOSING_QUESTION = /\b(?:qu[eé]\s+dosis|dosis\s+de|cu[aá]nt[oa]s?\s+(?:gotas|pastillas|ml)?\s*le\s+doy|le\s+doy|puedo\s+darle|se\s+(?:le\s+)?puede\s+dar|puedo\s+tomar|debo\s+tomar|cada\s+cu[aá]nto|debo\s+suspender|suspender\s+el\s+tratamiento|lo\s+sigo\s+tomando)\b|\b(?:est[aá]\s+bien|es\s+(?:mucho|poco|correct[oa]))\s*\?/i;
function asksForDosing(text: string): boolean {
  return /\b(?:qu[eé]\s+dosis|dosis\s+de)\b/i.test(text) || (MEDICATION.test(text) && DOSING_QUESTION.test(text));
}
// ─── Gestiones que solo resuelve una persona ────────────────────────────────
// "Me confirma", "avísele a la licenciada", "ya llegué", "dígale a la doctora".
// Un solo detector para el análisis (leads.ts, que lo suma al del modelo) y para
// el ruteo cuando el modelo no respondió: antes había dos listas distintas.
//
// Si en el mismo mensaje pregunta un precio o un horario, es información y se
// responde: "me confirma el precio" o "me puede avisar cuánto cuesta" no son una
// gestión. "Llegando" suelto tampoco ("¿a qué hora están llegando los
// doctores?"): solo "estoy llegando".
const HUMAN_ACTION_PATTERN =
  /\bme\s+(?:puede\s+)?(?:confirm\w*|avis\w*|pasar\s+(?:su\s+)?n[uú]mero)\b|\bconf[ií]rmeme\b|\bav[ií]s[ea]le\b|\bd[ií][gc]ale\b|\bd[ií]cele\b|\bme\s+lo\s+dice\s+(?:a\s+)?(?:la\s+|el\s+)?(?:licen\w*|doctora?|dra|dr|m[eé]dic[oa]|enfermer[oa])\b|\bhable\s+con\b|\bqu[eé]\s+n[uú]mero\s+(?:soy|me\s+toc[oó])\b|\bya\s+llegu[eé](?=\W|$)|\b(?:ya\s+)?estoy\s+llegando\b|\bestoy\s+(?:aqu[ií]|afuera|en\s+camino|en\s+la\s+puerta|en\s+recepci[oó]n)\b/i;
const INFO_QUESTION = /\b(?:precio|cu[aá]nto|costo|cuesta|tarifa|horarios?|a\s+qu[eé]\s+hora|qu[eé]\s+d[ií]as?)\b/i;

export function asksHumanAction(text: string): boolean {
  return HUMAN_ACTION_PATTERN.test(text) && !INFO_QUESTION.test(text);
}

// "Queja" y "reclamo" solo como sustantivo de una queja contra la clínica: "mi
// hijo se queja de dolor" es un síntoma, no una queja.
const FRUSTRATION_PATTERN =
  /\b(?:racista|racismo|sin verg[uü]enza|me ofendi[oó]|me ofendiste|p[eé]sim[oa] servicio|(?:una|mi|poner|presentar|hacer|dejar)\s+(?:queja|reclamo))\b/i;
const AMBIGUOUS_PELADA_PATTERN = /\bpelada\b/i;
const CLEAR_PELADA_CONTEXT = /\b(?:cabello|pelo|calvicie|alopecia|piel|herida|corte|embarazad\w*|ecograf\w*|eco|ultrasonido)\b/i;

// "Una consulta" al empezar el mensaje, en Bolivia, casi siempre es "tengo una
// pregunta". El modelo lo leía como pedido de consulta médica y abría una ficha
// (caso real 2026-10-03: "Una consulta / La nebulización cuánto está???" terminó
// pidiendo especialidad, nombre y horario). "Quiero/necesito una consulta" o
// "sacar una consulta" no entran: ahí sí está pidiendo una consulta médica.
const CONSULTA_AS_QUESTION =
  /^\s*(?:(?:hola|buen[oa]s?(?:\s+(?:d[ií]as|tardes|noches))?)[\s,.!]*)?(?:(?:tengo|le\s+hago|hago|quisiera\s+hacer(?:le)?|quiero\s+hacer(?:le)?)\s+)?una\s+consult(?:a|ita)\b/i;
// Con esto en el mensaje no hay duda de que pide atención médica.
const CLEAR_CONSULTATION_REQUEST = /\b(?:ficha|cita|turno|agend\w*|reserv\w*|dr|dra|doctora?|m[eé]dic[oa])\b/i;

// La respuesta a "¿consulta para X o el precio de X?".
const CLARIFY_PRICE = /\b(?:precio|cu[aá]nto|costo|valor|tarifa|lo\s+segundo|la\s+segunda|el\s+segundo)\b|^\s*2\s*[.)]?\s*$/i;
const CLARIFY_CONSULTATION = /\b(?:consulta|ficha|cita|turno|m[eé]dic[oa]|doctora?|lo\s+primero|la\s+primera|el\s+primero)\b|^\s*1\s*[.)]?\s*$/i;

// Pregunta el precio de un servicio sin decir que lo quiere hacer: se le da el
// precio y se le ofrece. "Quiero saber cuánto cuesta" sigue siendo pregunta.
const PRICE_QUESTION = /\b(?:cu[aá]nto|precio|costo|cuesta|vale|tarifa)\b/i;
const WANTS_SERVICE = /\b(?:quiero|quisiera|necesito|deseo)\b(?!\s+saber)|\b(?:agend\w*|reserv\w*|ficha|cita|turno)\b/i;

// Aceptó la oferta: lo dijo, o directamente pasó a dar los datos.
function acceptsOffer(text: string, a: TurnAnalysis | null): boolean {
  // Si ya dio sus datos, aceptó, aunque además pregunte algo ("Sí, Juan Pérez,
  // mañana a las 10. ¿Cuánto cuesta?"): descartar la oferta le perdería los datos.
  if (a?.patientName || a?.preferredTime) return true;
  // "Ya, pero ¿cuánto cuesta?": la afirmación viene con una objeción o una
  // pregunta, así que todavía no aceptó.
  const startsWithAffirmation = AFFIRMATIVE.test(text) || /^\s*ya(?=$|[\s,.!?])/i.test(text);
  if (startsWithAffirmation && (/\bpero\b|[?¿]/i.test(text))) return false;
  if (a?.confirms) return true;
  return AFFIRMATIVE.test(text) || /^\s*ya(?:[, ]+(?:pues|bueno|por\s+favor))?(?:[, ]+dale)?[.!\s]*$/i.test(text);
}

// ¿Es el mismo pedido que ya se ofreció? Comparación laxa: el modelo no
// siempre repite el texto igual ("electrocardiograma" / "un electrocardiograma").
function sameRequest(a: string, b: string): boolean {
  const norm = (t: string) =>
    t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
}

function rejectsOffer(text: string, a: TurnAnalysis | null): boolean {
  if (a?.wantsOut) return true;
  return NEGATIVE.test(text);
}

// El paciente nombró algo que no está en ningún catálogo nuestro, y está
// PREGUNTANDO, no pidiéndolo.
//
// Acá NO se niega nada. La versión anterior abría con "No tengo X dentro de los
// servicios que tengo registrados" y recién después aclaraba que la lista podía
// estar incompleta: el paciente lee la primera línea y se va (caso real
// 2026-09-18, radiografía de pie — la clínica sí la hacía). El matiz no salva la
// negación, y contarle al paciente cómo estamos de catálogos no le sirve de
// nada. Nuestro tarifario está incompleto por definición: lo que no sabemos no
// se niega, se pregunta a un asesor.
//
// Tampoco se ofrece "consultarlo con el equipo": eso suena a una gestión que el
// bot haría solo, y lo único que hace es tomar el pedido. Se piden los datos
// directamente, como en cualquier otra solicitud.
//
// La mecánica de oferta sigue igual por debajo (offerPending): si el paciente
// contesta otra cosa en vez de los datos, el mensaje se re-decide desde cero en
// lugar de consumirse. Dar los datos ya cuenta como aceptar (ver acceptsOffer).
export function unlistedAnswer(request: string): string {
  return (
    `¡Con gusto le ayudo con *${request}*! 😊 Le paso su solicitud a un asesor de la ` +
    `clínica para que le responda lo antes posible con el precio y la disponibilidad.\n\n` +
    `¿Qué *día y hora* le quedarían cómodos? 🙏`
  );
}

// Nombró una especialidad nuestra (o algo fuera de catálogo) y no está
// preguntando: viene a pedirlo. Antes esto vivía dentro de sanitizeAnalysis
// pisando el wantsLead del modelo; es una decisión de flujo, así que vive acá.
function wantsToRequest(a: TurnAnalysis): boolean {
  if (a.wantsLead) return true;
  return Boolean((a.specialtyKey || a.unavailableRequest) && !a.isQuestion);
}

export function decideAction(input: RoutingInput): Action {
  const { clinic, text, analysis, step, proof } = input;

  // Prioridad absoluta: una señal clínica no se consume como dato de una ficha
  // ni se entrega al modelo general, incluso si el detector configurable está
  // apagado o el análisis de intención falló.
  // El webhook ya atiende las emergencias antes de esperar y de llamar al
  // modelo; esto las vuelve a ver en el texto completo, por si el signo grave
  // quedó repartido entre varios mensajes.
  if (isEmergencyText(text)) {
    return { type: "escalate", kind: "emergencia", reply: clinic.emergencyResponse, intent: "emergencia" };
  }
  if (text && CLINICAL_INJURY_PATTERN.test(text)) {
    return {
      type: "escalate",
      kind: "accion",
      reply: `Por seguridad, no puedo valorar lesiones ni indicar estudios, medicamentos o tratamientos por este chat. Ya aviso a personal clínico para que le oriente 🙏 Si siente que es una emergencia, acuda a Emergencias o llame al ${clinic.generalInfo.phone}.`,
      intent: "emergencia",
    };
  }
  // Dudas de dosis: no se le dice lo que el bot no puede hacer; se le confirma
  // que su duda ya llegó a la clínica y que le responden pronto (pedido de la
  // clínica, 2026-10-03).
  if (text && asksForDosing(text)) {
    return { type: "escalate", kind: "accion", reply: DOSING_REPLY, intent: "accion" };
  }

  // Respuesta a "¿Es urgente?": sí → emergencia, se avisa y lo esperan listos;
  // no → sigue como una consulta. Otra cosa: el mensaje se decide normal.
  if (input.pendingUrgency) {
    if (confirmsUrgency(text)) {
      return { type: "escalate", kind: "emergencia", reply: urgentConfirmedReply(clinic), intent: "emergencia" };
    }
    if (URGENT_NO.test(text)) {
      return {
        type: "reply",
        text: "Entendido 😊 Si desea que lo vea un médico, le ayudo a pedir una ficha. ¿Para qué especialidad sería?",
        intent: "qa",
      };
    }
  }
  if (needsUrgencyCheck(text)) return { type: "askUrgency", text: URGENCY_QUESTION, intent: "qa" };

  if (input.priceDispute) {
    return {
      type: "escalate",
      kind: "accion",
      reply: PRICE_REVIEW_REPLY,
      intent: "accion",
    };
  }

  if (FRUSTRATION_PATTERN.test(text)) {
    return { type: "escalate", kind: "humano", reply: clinic.replies.humanHandoff, intent: "handoff_humano" };
  }

  // ── 1. Emergencias (apagado salvo CLINIC_EMERGENCY_DETECTION=true) ────────
  if (input.emergencyDetectionEnabled) {
    const lower = text.toLowerCase();
    if (clinic.emergencyKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return { type: "reply", text: clinic.emergencyResponse, intent: "emergencia" };
    }
  }

  // ── 2. Pide hablar con una persona ────────────────────────────────────────
  // Corta cualquier flujo, incluso una solicitud a medio recopilar.
  if (text && clinic.humanHandoffIntentPatterns.test(text)) {
    return { type: "escalate", kind: "humano", reply: clinic.replies.humanHandoff, intent: "handoff_humano" };
  }

  // ── 3. Ubicación ──────────────────────────────────────────────────────────
  if (text && clinic.locationRequestIntentPatterns.test(text)) {
    const locationReply = `📍 Nuestra dirección es: ${clinic.generalInfo.address}\n\n🗺️ Ubicación en Google Maps:\n${clinic.generalInfo.mapsUrl}`;
    if ((step === "collecting_lead" || step === "confirming_lead") && !input.pendingOffer) {
      return { type: "locationAndContinueLead", text: locationReply, intent: "ubicacion" };
    }
    return { type: "reply", text: locationReply, intent: "ubicacion" };
  }

  // ── 4. Comprobante o archivo ──────────────────────────────────────────────
  if (proof) {
    return {
      type: "reply",
      text: proof === "receipt" ? RECEIPT_REPLY : FILE_REPLY,
      intent: "comprobante",
    };
  }

  // ── 5. Solicitud en curso ─────────────────────────────────────────────────
  // Va antes que todo lo demás (salvo pedir una persona): quien está a mitad de
  // dar sus datos no debe caer en otra rama por nombrar algo de paso.
  if (step === "collecting_lead" || step === "confirming_lead") {
    if (analysis?.wantsHuman) {
      return { type: "escalate", kind: "humano", reply: clinic.replies.humanHandoff, intent: "handoff_humano" };
    }
    // Una gestión ("me confirma", "ya llegué") se deriva, salvo que esté
    // confirmando el resumen o dando sus datos: ahí el "me confirma" es parte de
    // la solicitud y la alarma ya la levanta la ficha.
    const givesLeadData = Boolean(analysis?.confirms || analysis?.patientName || analysis?.preferredTime);
    if (asksHumanAction(text) && !givesLeadData) {
      return { type: "escalate", kind: "accion", reply: ACTION_REPLY, intent: "accion" };
    }

    // Una OFERTA pendiente no es una solicitud aceptada. El paciente solo
    // preguntó si teníamos algo; que el bot se haya ofrecido a averiguarlo no
    // lo obliga a seguir por ahí.
    if (input.pendingOffer) {
      if (DECLINES_LEAD_CAPTURE.test(text)) {
        return {
          type: "escalate",
          kind: "no_disponible",
          reply: NO_CAPTURE_REPLY,
          intent: "no_disponible",
        };
      }
      if (acceptsOffer(text, analysis)) return { type: "continueLead", intent: "solicitud_en_curso" };
      if (rejectsOffer(text, analysis)) return { type: "cancelOffer", intent: "no_disponible" };

      // Ni aceptó ni rechazó: cambió de tema, saludó o preguntó otra cosa. La
      // oferta se descarta y este mismo mensaje se decide desde cero, como si
      // no hubiera nada en curso. Así "¿Qué horarios tienen?" se responde en
      // vez de consumirse como un dato de la solicitud.
      //
      // Con una salvedad: el análisis recibe el draft como contexto, así que
      // sigue devolviendo el pedido anterior aunque el mensaje nuevo no lo
      // mencione. Sin limpiarlo, el bot volvería a ofrecer lo mismo una y otra
      // vez. Se descarta solo si es EL MISMO pedido; si nombró otra cosa fuera
      // de catálogo, esa sí es nueva y se atiende.
      const repiteLoMismo =
        analysis?.unavailableRequest && sameRequest(analysis.unavailableRequest, input.pendingOffer);
      return decideAction({
        ...input,
        step: "idle",
        pendingOffer: null,
        analysis: repiteLoMismo ? { ...analysis!, unavailableRequest: null } : analysis,
      });
    }

    return { type: "continueLead", intent: "solicitud_en_curso" };
  }

  // ── 6. Sin texto, o saludo suelto ─────────────────────────────────────────
  if (!text) return { type: "reply", text: clinic.replies.welcome, intent: "bienvenida" };
  if (input.greetingOnly) return { type: "reply", text: clinic.replies.welcome, intent: "saludo" };

  // Respuesta a la aclaración del turno anterior. Si no contesta ninguna de las
  // dos cosas, el mensaje sigue de largo como cualquier otro.
  if (input.pendingClarify) {
    const clarified = clinic.services.find((s) => s.name === input.pendingClarify);
    if (clarified && CLARIFY_PRICE.test(text)) {
      return { type: "startLead", kind: "servicio", service: clarified, offer: true, intent: "servicio" };
    }
    if (CLARIFY_CONSULTATION.test(text)) return { type: "startLead", kind: "ficha", intent: "ficha" };
  }

  // ── 7. Pedidos que solo resuelve una persona ──────────────────────────────
  // "Cancelar" con un medio o un momento de pago al lado es PAGAR, no anular.
  if (clinic.cancelIntentPatterns.test(text) && !clinic.cancelMeansPayingPatterns.test(text)) {
    return { type: "escalate", kind: "cancelar", reply: TO_ADVISOR_REPLY, intent: "cancelar" };
  }
  if (clinic.rescheduleIntentPatterns.test(text)) {
    return { type: "escalate", kind: "reprogramar", reply: TO_ADVISOR_REPLY, intent: "reprogramar" };
  }
  if (clinic.checkAppointmentIntentPatterns.test(text)) {
    return { type: "escalate", kind: "consulta_cita", reply: TO_ADVISOR_REPLY, intent: "consulta_cita" };
  }
  // Pide el QR: se le envía (decisión de la clínica, 2026-10-03: solo cuando el
  // paciente lo pide) y queda la alarma para que un asesor verifique el pago.
  // Sin imagen cargada, como antes: lo manda el asesor.
  if (clinic.qrRequestIntentPatterns.test(text)) {
    return clinic.qrImageUrl
      ? { type: "sendQr", caption: QR_CAPTION, intent: "pago" }
      : { type: "escalate", kind: "pago", reply: PAYMENT_REPLY, intent: "pago" };
  }
  // "¿Ya está mi resultado?" El bot no ve resultados: si contesta, inventa.
  // Alarma sin pausa (D6). Si en el mismo mensaje pide una ficha para que se
  // los lean, eso manda: es una solicitud, no una consulta de estado.
  if (clinic.resultInquiryPatterns.test(text) && !clinic.bookingIntentPatterns.test(text) && !analysis?.wantsLead) {
    return { type: "escalate", kind: "accion", reply: RESULT_REPLY, intent: "resultado", pause: false };
  }

  // ── 8. Lo que dependa del análisis ────────────────────────────────────────
  if (analysis?.wantsHuman) {
    return { type: "escalate", kind: "humano", reply: clinic.replies.humanHandoff, intent: "handoff_humano" };
  }

  // "Una consulta" como pregunta. Si en el mismo mensaje nombra un servicio, las
  // dos lecturas chocan (¿consulta médica para eso, o el precio?) y se pregunta
  // cuál. Sola, se le pide que cuente qué necesita. Con una especialidad, un
  // médico o "ficha/cita", no hay choque: está pidiendo una consulta.
  const consultaAsQuestion =
    CONSULTA_AS_QUESTION.test(text) && !CLEAR_CONSULTATION_REQUEST.test(text) && !matchSpecialtyText(text);
  if (consultaAsQuestion) {
    const mentioned = matchService(text, clinic.services);
    if (mentioned && mentioned.category !== "emergencia") {
      const label = mentioned.name.toLowerCase();
      return {
        type: "clarify",
        text: `¿Quisiera una *consulta* para ${label} o el *precio* de ${label}? 😊`,
        serviceName: mentioned.name,
        intent: "qa",
      };
    }
    if (!text.replace(CONSULTA_AS_QUESTION, "").replace(/[\s.,;:!¡?¿😊🙏]/g, "")) {
      return { type: "reply", text: "¡Claro! 😊 Dígame, ¿en qué le puedo ayudar?", intent: "qa" };
    }
  }

  // Algo que no está en ningún catálogo nuestro. Acá está la corrección de
  // fondo: antes esta rama abría una ficha SIEMPRE, sin mirar si el paciente
  // pedía o solo preguntaba, y las dos cosas daban la misma respuesta.
  if (analysis?.unavailableRequest) {
    return wantsToRequest(analysis)
      ? { type: "startLead", kind: "no_disponible", intent: "no_disponible" }
      : { type: "offerLead", request: analysis.unavailableRequest, intent: "no_disponible" };
  }

  // Misma rama, pero sin el modelo. Si analyzeTurn no devolvió nada (timeout,
  // JSON roto, OpenAI caído) y el texto nombra algo que no está en NINGÚN
  // catálogo nuestro, el mensaje no puede seguir de largo hasta el Q&A libre:
  // ahí es donde el bot se pone a opinar sobre disponibilidad. Reconocer estos
  // nombres es comparación de strings, no criterio — no hace falta un modelo
  // para saber que "radiografía" no está en el tarifario.
  //
  // Va DESPUÉS de la rama con análisis y ANTES del tarifario, y solo cuando no
  // hay análisis: con el modelo respondiendo manda él, que distingue preguntar
  // de pedir. Si el término se carga algún día al catálogo, matchService lo
  // atrapa en la rama 9 y esto deja de verlo solo.
  if (!analysis && !matchService(text, clinic.services) && mentionsOffCatalogRequest(text)) {
    return { type: "offerLead", request: text.slice(0, 80), intent: "no_disponible" };
  }

  // ── 9. Servicio del tarifario ─────────────────────────────────────────────
  // Las consultas de emergencia solo se informan: no esperan a un asesor.
  // Si solo pregunta el precio, se le da y se le ofrece el servicio; si dice
  // que lo quiere, se abre la solicitud directamente.
  const service = matchService(text, clinic.services);
  if (service && service.category !== "emergencia") {
    const offer = PRICE_QUESTION.test(text) && !WANTS_SERVICE.test(text);
    return { type: "startLead", kind: "servicio", service, offer, intent: "servicio" };
  }

  // ── 10. Ficha / consulta ──────────────────────────────────────────────────
  // "Una consulta" como pregunta no es un pedido, aunque el modelo diga wantsLead.
  if (clinic.bookingIntentPatterns.test(text) || (analysis && !consultaAsQuestion && wantsToRequest(analysis))) {
    return { type: "startLead", kind: "ficha", intent: "ficha" };
  }

  // ── 11. Red de seguridad: pide una gestión, no información ────────────────
  // Va después de servicio y ficha para no robarle mensajes a la recolección
  // ("quiero una ficha, me confirma"), y antes del Q&A, que es donde el bot
  // contestaba "Ok" sin que nadie se enterara.
  // Con el modelo caído decide el mismo detector que el análisis suma al suyo.
  if (analysis ? analysis.needsHumanAction : asksHumanAction(text)) {
    return { type: "escalate", kind: "accion", reply: ACTION_REPLY, intent: "accion" };
  }

  if (text && AMBIGUOUS_PELADA_PATTERN.test(text) && !CLEAR_PELADA_CONTEXT.test(text)) {
    return {
      type: "reply",
      text: "Para no asumir algo incorrecto, ¿me explica qué quiere decir con *“pelada”* en este contexto y qué necesita? 😊",
      intent: "qa",
    };
  }

  // ── 12. Q&A general ───────────────────────────────────────────────────────
  return { type: "qa", intent: "qa" };
}

// Textos que la decisión necesita nombrar. Se importan desde leads.ts en el
// webhook; acá se declaran aparte para que este módulo no dependa de él en
// tiempo de ejecución (evita un ciclo de imports con TurnAnalysis).
const RECEIPT_REPLY = "¡Gracias! 🙏 Recibimos su comprobante. Un asesor de la clínica lo revisará y le confirmará por aquí.";
const FILE_REPLY = "¡Gracias! 🙏 Recibimos su archivo. Un asesor de la clínica lo revisará.";
const TO_ADVISOR_REPLY = "Le paso su pedido a un asesor de la clínica 🙏 En un momento le escribe por aquí.";
const DOSING_REPLY =
  "Recibimos su consulta sobre el medicamento 🙏 Ya se la hicimos llegar a personal de la clínica y le responderán por aquí lo antes posible.";
const QR_CAPTION =
  "Este es el QR de pago de la clínica 😊 Cuando pague, envíeme el comprobante por aquí y un asesor lo verifica.";
const PAYMENT_REPLY ="Los datos de pago se los envía un asesor de la clínica cuando confirme su ficha o servicio 🙏 Ya le aviso para que le escriba por aquí.";
const ACTION_REPLY = "Entendido 🙏 Eso se lo tiene que confirmar una persona de la clínica: ya le aviso para que le escriba por aquí en un momento.";
const RESULT_REPLY = "Su resultado se lo confirma un asesor de la clínica 🙏 Ya le aviso para que le escriba por aquí.";
const NO_CAPTURE_REPLY =
  "Entiendo, no le pediré datos para una ficha 🙏 Un asesor de la clínica le confirmará si realizamos ese servicio y su precio.";
const PRICE_REVIEW_REPLY =
  "Veo que menciona un monto distinto del cotizado. No le confirmaré otro precio hasta verificar cuál está vigente; ya aviso a un asesor para que lo revise 🙏";
