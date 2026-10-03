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
  // Servicio sobre el que el bot preguntó "¿consulta o precio?" en el turno
  // anterior. null = no hay aclaración pendiente.
  pendingClarify?: string | null;
};

// Respuestas a una pregunta cerrada. Se resuelven con patrones y no con el
// modelo a propósito: el análisis no distingue "No" de un mensaje neutral
// —devuelve wantsOut:false para los dos— porque sin saber que hubo una oferta,
// un "No" suelto no significa "ya no quiero la solicitud". En el contexto de
// una pregunta de sí/no, en cambio, reconocerlo es determinista.
// El cierre no es \b: en JS \b solo conoce letras ASCII, así que "Sí" con tilde
// nunca coincidía.
const AFFIRMATIVE = /^\s*(?:s[ií]|sip+|claro|dale|ya|bueno|ok(?:ay)?|por ?favor|de una|obvio|as[ií] es|est[aá] bien|me parece|dele|dal[eé])(?=$|[\s,.!?])/i;
const NEGATIVE = /^\s*(?:no|nop+|nel|negativo|mejor no|ya no|d[eé]j[eaá]lo|olv[ií]delo|gracias no|nada m[aá]s|as[ií] nom[aá]s)\b/i;

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
  if (a?.confirms) return true;
  if (a?.patientName || a?.preferredTime) return true;
  return AFFIRMATIVE.test(text);
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
    return {
      type: "reply",
      text: `📍 Nuestra dirección es: ${clinic.generalInfo.address}\n\n🗺️ Ubicación en Google Maps:\n${clinic.generalInfo.mapsUrl}`,
      intent: "ubicacion",
    };
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

    // Una OFERTA pendiente no es una solicitud aceptada. El paciente solo
    // preguntó si teníamos algo; que el bot se haya ofrecido a averiguarlo no
    // lo obliga a seguir por ahí.
    if (input.pendingOffer) {
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
  if (analysis?.needsHumanAction) {
    return { type: "escalate", kind: "accion", reply: ACTION_REPLY, intent: "accion" };
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
const QR_CAPTION =
  "Este es el QR de pago de la clínica 😊 Cuando pague, envíeme el comprobante por aquí y un asesor lo verifica.";
const PAYMENT_REPLY ="Los datos de pago se los envía un asesor de la clínica cuando confirme su ficha o servicio 🙏 Ya le aviso para que le escriba por aquí.";
const ACTION_REPLY = "Entendido 🙏 Eso se lo tiene que confirmar una persona de la clínica: ya le aviso para que le escriba por aquí en un momento.";
const RESULT_REPLY = "Su resultado se lo confirma un asesor de la clínica 🙏 Ya le aviso para que le escriba por aquí.";
