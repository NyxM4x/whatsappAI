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
import { matchService, mentionsOffCatalogRequest, type ServiceItem } from "@/lib/clinic/services";
import type { TurnAnalysis } from "@/lib/clinic/leads";
import type { AuditIntent, BookingStep, LeadDraft, LeadKind } from "@/lib/clinic/types";

// Lo que el webhook tiene que hacer. Cada variante lleva su `intent`, que es lo
// que se guarda en clinic_webhook_audits.
export type Action =
  // Responder un texto fijo y nada más.
  | { type: "reply"; text: string; intent: AuditIntent }
  // Derivar: alarma en el panel, aviso al paciente y pausa del bot.
  | { type: "escalate"; kind: LeadKind; reply: string; intent: AuditIntent }
  // Abrir una solicitud nueva y pedir lo que falte.
  | { type: "startLead"; kind: LeadDraft["kind"]; service?: ServiceItem | null; intent: AuditIntent }
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
};

// Respuestas a una pregunta cerrada. Se resuelven con patrones y no con el
// modelo a propósito: el análisis no distingue "No" de un mensaje neutral
// —devuelve wantsOut:false para los dos— porque sin saber que hubo una oferta,
// un "No" suelto no significa "ya no quiero la solicitud". En el contexto de
// una pregunta de sí/no, en cambio, reconocerlo es determinista.
const AFFIRMATIVE = /^\s*(?:s[ií]|sip+|claro|dale|ya|bueno|ok(?:ay)?|por ?favor|de una|obvio|as[ií] es|est[aá] bien|me parece|dele|dal[eé])\b/i;
const NEGATIVE = /^\s*(?:no|nop+|nel|negativo|mejor no|ya no|d[eé]j[eaá]lo|olv[ií]delo|gracias no|nada m[aá]s|as[ií] nom[aá]s)\b/i;

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
    `¡Con gusto le ayudo con *${request}*! 😊 El precio y el horario se los confirma ` +
    `un asesor de la clínica por aquí mismo.\n\n` +
    `¿Me dice el *nombre completo del paciente* y qué *día y hora* le quedarían cómodos? ` +
    `Así le paso su pedido 🙏`
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
  if (clinic.qrRequestIntentPatterns.test(text)) {
    return { type: "escalate", kind: "pago", reply: PAYMENT_REPLY, intent: "pago" };
  }

  // ── 8. Lo que dependa del análisis ────────────────────────────────────────
  if (analysis?.wantsHuman) {
    return { type: "escalate", kind: "humano", reply: clinic.replies.humanHandoff, intent: "handoff_humano" };
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
  const service = matchService(text, clinic.services);
  if (service && service.category !== "emergencia") {
    return { type: "startLead", kind: "servicio", service, intent: "servicio" };
  }

  // ── 10. Ficha / consulta ──────────────────────────────────────────────────
  if (clinic.bookingIntentPatterns.test(text) || (analysis && wantsToRequest(analysis))) {
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
const PAYMENT_REPLY = "Los datos de pago se los envía un asesor de la clínica cuando confirme su ficha o servicio 🙏 Ya le aviso para que le escriba por aquí.";
const ACTION_REPLY = "Entendido 🙏 Eso se lo tiene que confirmar una persona de la clínica: ya le aviso para que le escriba por aquí en un momento.";
