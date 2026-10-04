// ============================================================================
// Verificación de decideAction() — el ruteo, sin webhook y sin OpenAI.
// ----------------------------------------------------------------------------
// decideAction() es una función pura: entra (texto + análisis + estado) y sale
// una Action. Acá el análisis se arma a mano, así que estos casos prueban LA
// DECISIÓN aislada: son deterministas, gratis y corren en un segundo.
//
// Lo que el modelo devuelve de verdad para cada mensaje se prueba aparte, en
// scripts/check-analisis.ts (ese sí llama a OpenAI).
//
//   npx tsx scripts/check-routing.ts
// ============================================================================

import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
}

const { getClinicConfig } = await import("../lib/clinic/config");
const { decideAction, isEmergencyText } = await import("../lib/clinic/routing");
const { analysisForLocationFollowup, answerKnownLeadQuestion, hasPriceDispute, looksLikeName, mergeAnalysis, needsVisitType, visitTypeFromText, readAge, applyPediatricAgeLimit, missingFields, doctorScheduleNotes } = await import("../lib/clinic/leads");

import type { TurnAnalysis } from "../lib/clinic/leads";
import type { BookingStep, LeadDraft } from "../lib/clinic/types";

const clinic = await getClinicConfig();

// Análisis vacío: cada caso sobrescribe solo lo que le importa.
function analysis(patch: Partial<TurnAnalysis> = {}): TurnAnalysis {
  return {
    patientName: null, patientAge: null, specialtyKey: null, doctorName: null,
    preferredTime: null, preferredDate: null, preferredHour: null,
    visitType: null, paymentIntention: null, unavailableRequest: null,
    needsHumanAction: false, wantsLead: false, wantsHuman: false,
    frustrated: false, confirms: false, wantsOut: false, isQuestion: false,
    dateConflict: null,
    ...patch,
  };
}

type Case = {
  name: string;
  text: string;
  analysis?: TurnAnalysis | null;
  step?: BookingStep;
  proof?: "receipt" | "unverified" | null;
  greetingOnly?: boolean;
  pendingOffer?: string | null;
  priceDispute?: boolean;
  pendingClarify?: string | null;
  pendingUrgency?: boolean;
  // Qué se espera de la Action resultante.
  expect: { type: string; kind?: string; intent?: string; pause?: boolean; offer?: boolean };
};

const CASES: Case[] = [
  // Casos reales: la seguridad clínica debe ganar incluso con el flag apagado
  // y mientras ya hay una ficha en curso.
  {
    name: "golpe en la cabeza con ladrillo → derivación clínica, no cotización",
    text: "Por accidente lo golpearon en la cabeza con un ladrillo y tiene un tajo",
    analysis: null,
    step: "collecting_lead",
    expect: { type: "escalate", kind: "accion", intent: "emergencia" },
  },
  {
    name: "golpe en costilla → no recomendar ecografía",
    text: "¿Cuál ecografía sería para un golpe en el lado de la costilla?",
    analysis: null,
    expect: { type: "escalate", kind: "accion", intent: "emergencia" },
  },
  {
    // Pregunta el precio, no cómo dosificar: se le da el precio de la
    // nebulización (cargada el 2026-10-03) sin comentar la dosis.
    name: "nebulización con medicamento recetado, pregunta precio → precio",
    text: "¿Hacen nebulización? Me dijeron 2 gotas de salbutamol, ¿cuánto está?",
    analysis: null,
    expect: { type: "startLead", kind: "servicio", offer: true },
  },
  // ── Huecos de la auditoría del 2026-10-01: mensajes normales que la primera
  // versión derivaba (y pausaba el bot), o casos graves que no veía ────────
  {
    name: "'¿se puede dar ficha?' no es pedir una dosis",
    text: "¿se puede dar ficha para mañana?",
    analysis: null,
    expect: { type: "startLead", kind: "ficha" },
  },
  {
    name: "'¿puedo darle el nombre después?' sigue la ficha",
    text: "¿puedo darle el nombre después?",
    analysis: null,
    step: "collecting_lead",
    expect: { type: "continueLead" },
  },
  {
    name: "le recetaron antibióticos y pregunta el precio → no deriva",
    text: "le recetaron antibióticos, ¿cuánto cuesta la consulta?",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "caída de cabello en la cabeza no es un golpe",
    text: "tengo caída de cabello en la cabeza",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "se cayó y se golpeó la cabeza → deriva",
    text: "mi hijo se cayó y se golpeó la cabeza",
    analysis: null,
    expect: { type: "escalate", kind: "accion", intent: "emergencia" },
  },
  {
    name: "convulsión con tilde → emergencia",
    text: "mi bebé tuvo una convulsión",
    analysis: null,
    expect: { type: "escalate", intent: "emergencia" },
  },
  {
    name: "'fuerte dolor en el pecho' → emergencia",
    text: "tengo un fuerte dolor en el pecho",
    analysis: null,
    expect: { type: "escalate", intent: "emergencia" },
  },
  {
    name: "'se queja de dolor' es un síntoma, no una queja",
    text: "mi hijo se queja de dolor de barriga",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "'quiero poner una queja' sí deriva",
    text: "quiero poner una queja",
    analysis: null,
    expect: { type: "escalate", kind: "humano" },
  },
  {
    name: "'me puede avisar el precio' se responde, no se deriva",
    text: "me puede avisar el precio de la eco",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "'me confirma el precio' se responde, no se deriva",
    text: "me confirma el precio por favor",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "'están llegando los doctores' no es una gestión",
    text: "¿a qué hora están llegando los doctores?",
    analysis: null,
    expect: { type: "qa" },
  },
  // Caso real del panel (2026-10-03): lo escribió personal de la clínica al
  // número del bot y sonó una alarma que quedó 7 horas sin atender.
  {
    name: "aviso interno real ('Confirmo la paciente… para las 4?') → silencio",
    text: "Licen buenas tardes. Confirmo la paciente Jhoselin Días rodas para las 4?",
    analysis: null,
    expect: { type: "silent", intent: "accion" },
  },
  {
    name: "lo mismo cuando el modelo lo marca como gestión",
    text: "Licen buenas tardes. Confirmo la paciente Jhoselin Días rodas para las 4?",
    analysis: analysis({ needsHumanAction: true, isQuestion: true }),
    expect: { type: "silent", intent: "accion" },
  },
  {
    name: "'¿ya está mi resultado?' es de un paciente → se le responde y llega a un asesor",
    text: "¿ya está mi resultado?",
    analysis: null,
    expect: { type: "escalate", kind: "accion", intent: "resultado", pause: false },
  },
  {
    name: "'ya estoy llegando' es un aviso interno → silencio",
    text: "ya estoy llegando",
    analysis: null,
    expect: { type: "silent", intent: "accion" },
  },
  {
    name: "confirma el resumen con 'me confirma' → confirma, no deriva",
    text: "Sí, correcto, me confirma por favor",
    analysis: analysis({ confirms: true }),
    step: "confirming_lead",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → da sus datos y pregunta algo → acepta y conserva los datos",
    text: "Sí, Juan Pérez, mañana a las 10. ¿Cuánto cuesta?",
    analysis: analysis({ patientName: "Juan Pérez", preferredTime: "mañana a las 10", isQuestion: true }),
    step: "collecting_lead",
    pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  // ── Emergencias con motivo propio (2026-10-03) ────────────────────────────
  {
    name: "'fiebre de 40 y no reacciona' → emergencia",
    text: "mi bebé tiene fiebre de 40 y no reacciona",
    analysis: null,
    expect: { type: "escalate", kind: "emergencia", intent: "emergencia" },
  },
  {
    name: "'se atragantó' → emergencia",
    text: "mi hijo se atragantó con una moneda",
    analysis: null,
    expect: { type: "escalate", kind: "emergencia" },
  },
  {
    name: "emergencia en medio de una ficha → emergencia igual",
    text: "no respira bien, se está ahogando",
    analysis: null,
    step: "collecting_lead",
    expect: { type: "escalate", kind: "emergencia" },
  },
  // Signo dudoso: una sola pregunta (decisión de la clínica, 2026-10-03).
  {
    name: "'mi bebé está muy decaído' → pregunta si es urgente",
    text: "mi bebé está muy decaído",
    analysis: null,
    expect: { type: "askUrgency" },
  },
  {
    name: "¿es urgente? → 'sí' → emergencia, lo esperan listos",
    text: "sí",
    analysis: null,
    pendingUrgency: true,
    expect: { type: "escalate", kind: "emergencia", intent: "emergencia" },
  },
  {
    name: "¿es urgente? → 'sí, es urgente' → emergencia",
    text: "Sí, es urgente",
    analysis: null,
    pendingUrgency: true,
    expect: { type: "escalate", kind: "emergencia" },
  },
  {
    name: "¿es urgente? → 'no' → se ofrece la ficha",
    text: "no",
    analysis: null,
    pendingUrgency: true,
    expect: { type: "reply", intent: "qa" },
  },
  {
    name: "¿es urgente? → habla de otra cosa → se decide normal",
    text: "¿dónde están ubicados?",
    analysis: null,
    pendingUrgency: true,
    expect: { type: "reply", intent: "ubicacion" },
  },
  {
    name: "'sí' sin pregunta de urgencia pendiente no es una emergencia",
    text: "sí",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "'ecografía de emergencia' es un servicio, no una emergencia",
    text: "¿cuánto cuesta la ecografía de emergencia?",
    analysis: null,
    expect: { type: "startLead", kind: "servicio" },
  },
  {
    name: "'consulta de emergencia' (precio) no es una emergencia",
    text: "¿cuánto sale la consulta de emergencia?",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "validar una dosis ('¿está bien?') → deriva",
    text: "Me dijeron 2 gotas de salbutamol, ¿está bien?",
    analysis: null,
    expect: { type: "escalate", kind: "accion", intent: "accion" },
  },
  {
    name: "'está bien' como 'ok' no es validar una dosis",
    text: "le recetaron antibióticos, está bien, ¿cuánto cuesta la consulta?",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "preguntar si hay un producto no es pedir una dosis (farmacia)",
    text: "¿tienen salbutamol?",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "pide una dosis → no dar instrucciones, deriva",
    text: "¿cuántas gotas de salbutamol le doy a mi bebé para la nebulización?",
    analysis: null,
    expect: { type: "escalate", kind: "accion", intent: "accion" },
  },
  {
    name: "convulsión con tilde → emergencia",
    text: "Tuvo una convulsión",
    analysis: null,
    expect: { type: "escalate", kind: "emergencia", intent: "emergencia" },
  },
  {
    name: "fuerte dolor en el pecho → emergencia",
    text: "Siento fuerte dolor en el pecho",
    analysis: null,
    expect: { type: "escalate", kind: "emergencia", intent: "emergencia" },
  },
  {
    name: "cada cuánto atienden → pregunta normal, no alarma clínica",
    text: "¿Cada cuánto atienden los pediatras?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "qa" },
  },
  {
    name: "precio de una inyección → no se confunde con dosis",
    text: "¿Cuánto cuesta poner una inyección?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "qa" },
  },
  {
    name: "ficha para tratamiento de diabetes → solicitud normal",
    text: "Quiero ficha para tratamiento de la diabetes",
    analysis: analysis({ specialtyKey: "medicina-general", wantsLead: true }),
    expect: { type: "startLead", kind: "ficha" },
  },
  {
    name: "horario no me sirve → pregunta otra franja, no handoff",
    text: "El horario de la mañana no me sirve, ¿hay en la tarde?",
    analysis: analysis({ frustrated: true, isQuestion: true }),
    expect: { type: "qa" },
  },
  {
    name: "C0066: contradicción con precio publicado → asesor verifica",
    text: "No es 100 Bs, vi en la publicación por WhatsApp",
    analysis: null,
    step: "collecting_lead",
    priceDispute: true,
    expect: { type: "escalate", kind: "accion", intent: "accion" },
  },
  {
    name: "menciona anuncio PAP sin precio distinto → no disputa",
    text: "Vi en el anuncio el PAP, ¿cuánto cuesta?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "startLead", kind: "servicio" },
  },
  {
    name: "no es urgente + precio → no disputa",
    text: "No es urgente, ¿cuánto cuesta la consulta?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "qa" },
  },
  {
    name: "vale gracias, no es necesario → no disputa",
    text: "Vale, gracias, no es necesario",
    analysis: analysis(),
    expect: { type: "qa" },
  },
  {
    name: "C0031: queja explícita → deriva, no repite disculpas",
    text: "Racista",
    analysis: null,
    expect: { type: "escalate", kind: "humano", intent: "handoff_humano" },
  },
  {
    name: "C0031: término ambiguo → pregunta antes de interpretar",
    text: "Quiero solucionar mi pelada",
    analysis: null,
    expect: { type: "reply", intent: "qa" },
  },
  {
    name: "embarazo y eco con 'pelada' → servicio gana a aclaración",
    text: "Quiero una ecografía obstétrica para mi pelada embarazada",
    analysis: analysis({ isQuestion: false, wantsLead: true }),
    expect: { type: "startLead", kind: "servicio", intent: "servicio" },
  },
  {
    name: "pelada embarazada con eco → no pedir aclaración",
    text: "Mi pelada está embarazada, quiero una ecografía obstétrica",
    analysis: analysis({ isQuestion: false, wantsLead: true }),
    expect: { type: "startLead", kind: "servicio", intent: "servicio" },
  },

  // ── Lo que motivó el cambio: preguntar ≠ pedir ────────────────────────────
  {
    name: "pregunta por algo no catalogado → ofrecer, NO abrir ficha",
    text: "¿Tienen electrocardiograma?",
    analysis: analysis({ unavailableRequest: "electrocardiograma", isQuestion: true, wantsLead: false }),
    expect: { type: "offerLead", intent: "no_disponible" },
  },
  {
    name: "pide algo no catalogado → recopila, pero NO como ficha médica",
    text: "Quiero hacerme un electrocardiograma",
    analysis: analysis({ unavailableRequest: "electrocardiograma", isQuestion: false, wantsLead: true }),
    expect: { type: "startLead", kind: "no_disponible", intent: "no_disponible" },
  },
  {
    name: "pide no catalogado sin wantsLead del modelo, pero no pregunta → recopila",
    text: "para fisioterapia",
    analysis: analysis({ unavailableRequest: "fisioterapia", isQuestion: false, wantsLead: false }),
    expect: { type: "startLead", kind: "no_disponible" },
  },

  // ── Caso real 2026-09-18: el analisis se cae y el mensaje no puede llegar
  // al Q&A libre, que es donde el bot se pone a opinar sobre disponibilidad.
  // Sin analysis no hay criterio del modelo, pero "radiografia" no esta en
  // ningun catalogo y eso se sabe comparando strings.
  {
    name: "sin análisis (timeout) + examen no catalogado → toma el pedido, no Q&A",
    text: "Por favor el precio de la Radiografía",
    analysis: null,
    expect: { type: "offerLead", intent: "no_disponible" },
  },
  {
    name: "sin análisis + rayos x → toma el pedido",
    text: "necesitan orden para los rayos x?",
    analysis: null,
    expect: { type: "offerLead", intent: "no_disponible" },
  },
  {
    name: "sin análisis + servicio DEL tarifario → gana el tarifario, se cotiza",
    text: "cuanto cuesta la ecografia abdominal",
    analysis: null,
    expect: { type: "startLead", kind: "servicio" },
  },
  {
    name: "sin análisis + pregunta común → sigue yendo al Q&A",
    text: "a que hora abren?",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "CON análisis manda el modelo: pregunta por no catalogado sigue siendo oferta",
    text: "Por favor el precio de la Radiografía",
    analysis: analysis({ unavailableRequest: "Radiografía", isQuestion: true }),
    expect: { type: "offerLead", intent: "no_disponible" },
  },

  // ── Oferta pendiente: no es una recolección aceptada ────────────────
  // El bot ofreció consultar un electrocardiograma. Lo que diga ahora el
  // paciente decide: aceptar sigue, rechazar cierra, y cualquier otra cosa
  // descarta la oferta y se atiende como un mensaje nuevo.
  {
    name: "oferta → sí → sigue la recolección",
    text: "Sí",
    analysis: analysis({ unavailableRequest: "electrocardiograma", confirms: true }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → sí (sin confirms del modelo) → sigue igual",
    text: "ya pues, dale",
    analysis: analysis({ unavailableRequest: "electrocardiograma" }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → sí con modelo caído → acepta",
    text: "Sí",
    analysis: null,
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → ya pues sin análisis → acepta",
    text: "Ya pues",
    analysis: null,
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → ya por favor sin análisis → acepta",
    text: "Ya, por favor",
    analysis: null,
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → ya bueno sin análisis → acepta",
    text: "Ya bueno",
    analysis: null,
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → bueno, pero pregunta horario → no acepta",
    text: "Bueno, pero ¿atienden el sábado?",
    analysis: analysis({ isQuestion: true, unavailableRequest: "electrocardiograma" }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "qa", intent: "qa" },
  },
  {
    name: "oferta → ya aislado → acepta",
    text: "Ya",
    analysis: analysis({ unavailableRequest: "electrocardiograma" }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → ya, pero pregunta precio → no acepta",
    text: "Ya, pero ¿cuánto cuesta?",
    analysis: analysis({ unavailableRequest: "electrocardiograma", isQuestion: true }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "qa", intent: "qa" },
  },
  {
    name: "C0064: solo quiere ECG, no ficha → deja de pedir datos",
    text: "solo quiero electrocardiograma no una ficha",
    analysis: analysis({ unavailableRequest: "electrocardiograma", wantsLead: true }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "escalate", kind: "no_disponible", intent: "no_disponible" },
  },
  {
    name: "oferta → da los datos directamente → sigue",
    text: "Juan Pérez, mañana a las 10",
    analysis: analysis({ patientName: "Juan Pérez", preferredTime: "mañana a las 10" }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta → no → cancela (el modelo da wantsOut=false)",
    text: "No",
    analysis: analysis({ unavailableRequest: "electrocardiograma", wantsOut: false, confirms: false }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "cancelOffer", intent: "no_disponible" },
  },
  {
    name: "oferta → no gracias → cancela",
    text: "no gracias, era solo para saber",
    analysis: analysis({ unavailableRequest: "electrocardiograma", isQuestion: true, wantsOut: false }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "cancelOffer" },
  },
  {
    name: "oferta → pregunta distinta → se responde, NO se toma como dato",
    text: "¿Qué horarios tienen?",
    analysis: analysis({ unavailableRequest: "electrocardiograma", isQuestion: true }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "qa", intent: "qa" },
  },
  {
    name: "oferta → pregunta cuánto cuesta → se responde, no repregunta ficha",
    text: "Cuánto está su costo",
    analysis: analysis({ unavailableRequest: "ecografía transvaginal", isQuestion: true }),
    step: "collecting_lead", pendingOffer: "ecografía transvaginal",
    expect: { type: "qa", intent: "qa" },
  },
  {
    name: "oferta → pregunta por pediatría → no pisa la solicitud en silencio",
    text: "También quería preguntar si tienen pediatría",
    analysis: analysis({ specialtyKey: "pediatria", isQuestion: true }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "qa" },
  },
  {
    name: "oferta → saludo → saluda, no pide datos",
    text: "Hola",
    analysis: analysis(),
    step: "collecting_lead", pendingOffer: "electrocardiograma", greetingOnly: true,
    expect: { type: "reply", intent: "saludo" },
  },
  {
    name: "oferta → pide una persona → deriva",
    text: "quiero hablar con alguien",
    analysis: analysis({ wantsHuman: true }),
    step: "collecting_lead", pendingOffer: "electrocardiograma",
    expect: { type: "escalate", kind: "humano" },
  },
  {
    name: "recolección ACEPTADA: un 'no' suelto NO la cancela (sigue el flujo)",
    text: "No",
    analysis: analysis(),
    step: "collecting_lead",
    expect: { type: "continueLead" },
  },

  // ── Flujo normal de ficha: no debe cambiar ────────────────────────────────
  {
    name: "ficha con especialidad catalogada",
    text: "Quiero sacar ficha con cardiología",
    analysis: analysis({ specialtyKey: "cardiologia", wantsLead: true }),
    expect: { type: "startLead", kind: "ficha", intent: "ficha" },
  },
  // ── "Una consulta" y el precio de un servicio (caso real 2026-10-03) ──────
  // "Una consulta / La nebulización cuánto está???" terminó pidiendo
  // especialidad, nombre y horario cuando solo quería el precio.
  {
    name: "una consulta + precio de un servicio → pregunta cuál de las dos",
    text: "Buenos dias\nUna consulta\nLa nebulización cuánto está???",
    analysis: null,
    expect: { type: "clarify", intent: "qa" },
  },
  {
    name: "lo mismo con el modelo diciendo wantsLead",
    text: "Buenos dias\nUna consulta\nLa nebulización cuánto está???",
    analysis: analysis({ wantsLead: true, isQuestion: true }),
    expect: { type: "clarify" },
  },
  {
    name: "'una consulta' sola → pregunta en qué ayudar, no abre ficha",
    text: "Una consulta",
    analysis: analysis({ wantsLead: true }),
    expect: { type: "reply", intent: "qa" },
  },
  {
    name: "'tengo una consulta' + pregunta general → no abre ficha",
    text: "tengo una consulta, ¿atienden los domingos?",
    analysis: analysis({ wantsLead: true, isQuestion: true }),
    expect: { type: "qa" },
  },
  {
    name: "'una consulta para pediatría' → es pedido de consulta, sin aclaración",
    text: "una consulta para pediatría",
    analysis: analysis({ specialtyKey: "pediatria", wantsLead: true }),
    expect: { type: "startLead", kind: "ficha" },
  },
  {
    name: "'quiero una consulta' → pedido claro",
    text: "quiero una consulta para mi hijo",
    analysis: analysis({ wantsLead: true }),
    expect: { type: "startLead", kind: "ficha" },
  },
  {
    name: "precio de un servicio sin choque → precio y se le ofrece",
    text: "La nebulización cuánto está???",
    analysis: null,
    expect: { type: "startLead", kind: "servicio", offer: true },
  },
  {
    name: "pide el servicio → solicitud directa",
    text: "quiero hacerle nebulización a mi hijo mañana",
    analysis: null,
    expect: { type: "startLead", kind: "servicio", offer: false },
  },
  {
    name: "'quiero saber cuánto cuesta' sigue siendo pregunta",
    text: "quiero saber cuánto cuesta la ecografía abdominal",
    analysis: null,
    expect: { type: "startLead", kind: "servicio", offer: true },
  },
  {
    name: "aclaración → 'el precio' → precio y oferta",
    text: "el precio",
    analysis: null,
    pendingClarify: "Nebulización",
    expect: { type: "startLead", kind: "servicio", offer: true },
  },
  {
    name: "aclaración → 'una consulta' → ficha",
    text: "una consulta",
    analysis: null,
    pendingClarify: "Nebulización",
    expect: { type: "startLead", kind: "ficha" },
  },
  {
    name: "aclaración → habla de otra cosa → se decide normal",
    text: "¿dónde están ubicados?",
    analysis: null,
    pendingClarify: "Nebulización",
    expect: { type: "reply", intent: "ubicacion" },
  },
  {
    name: "oferta de servicio → 'sí' → sigue la solicitud",
    text: "Sí",
    analysis: null,
    step: "collecting_lead",
    pendingOffer: "Nebulización",
    expect: { type: "continueLead" },
  },
  {
    name: "oferta de servicio → 'no gracias' → se descarta",
    text: "no gracias",
    analysis: null,
    step: "collecting_lead",
    pendingOffer: "Nebulización",
    expect: { type: "cancelOffer" },
  },
  {
    name: "oferta de servicio → pregunta otro servicio → se atiende ese",
    text: "¿y el lavado de oído cuánto está?",
    analysis: null,
    step: "collecting_lead",
    pendingOffer: "Nebulización",
    expect: { type: "startLead", kind: "servicio", offer: true },
  },

  // Caso real 2026-09-28: "sacar una" enganchaba el alias "sacar uña" y el
  // pedido de consulta con el pediatra se cotizaba como retiro de uña.
  {
    name: "'sacar una consulta' con el doctor mal escrito → ficha, no retiro de uña",
    text: "Quiero saber si ya están los resultados de laboratorio así poder sacar una consulta para el doctor dagiino",
    analysis: analysis({ specialtyKey: "pediatria", doctorName: "Dr. Miguel Edgar Daguino Delgadillo", wantsLead: true }),
    expect: { type: "startLead", kind: "ficha", intent: "ficha" },
  },
  {
    name: "lo mismo con el modelo caído",
    text: "quería saber si ya salió los laboratorios de Danna así poder sacar una consulta con el doctor dagiino",
    analysis: null,
    expect: { type: "startLead", kind: "ficha", intent: "ficha" },
  },
  {
    name: "especialidad a secas, sin wantsLead del modelo (el ruteo lo deduce)",
    text: "Para ginecología",
    analysis: analysis({ specialtyKey: "ginecologia", wantsLead: false, isQuestion: false }),
    expect: { type: "startLead", kind: "ficha" },
  },
  {
    name: "pregunta el precio de una especialidad → Q&A, no ficha",
    text: "cuanto cuesta la consulta de neurologia?",
    analysis: analysis({ specialtyKey: "neurologia", isQuestion: true, wantsLead: false }),
    expect: { type: "qa", intent: "qa" },
  },
  {
    name: "servicio del tarifario",
    text: "cuanto sale una ecografia abdominal",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "startLead", kind: "servicio", intent: "servicio" },
  },

  // ── Solicitud en curso: no la roba ninguna otra rama ──────────────────────
  {
    name: "collecting_lead: un dato cualquiera sigue la solicitud",
    text: "Juan Pérez, mañana a las 10",
    analysis: analysis({ patientName: "Juan Pérez", preferredTime: "mañana a las 10" }),
    step: "collecting_lead",
    expect: { type: "continueLead", intent: "solicitud_en_curso" },
  },
  {
    name: "collecting_lead: nombrar otra cosa NO abre una solicitud nueva",
    text: "aunque tambien queria preguntar por electrocardiograma",
    analysis: analysis({ unavailableRequest: "electrocardiograma", isQuestion: true }),
    step: "collecting_lead",
    expect: { type: "continueLead" },
  },
  {
    name: "confirming_lead: confirma",
    text: "si, está correcto",
    analysis: analysis({ confirms: true }),
    step: "confirming_lead",
    expect: { type: "continueLead" },
  },
  {
    name: "collecting_lead: pedir una persona SÍ corta la solicitud",
    text: "mejor quiero hablar con una persona",
    analysis: analysis({ wantsHuman: true }),
    step: "collecting_lead",
    expect: { type: "escalate", kind: "humano", intent: "handoff_humano" },
  },

  // ── Regex previas: siguen mandando ────────────────────────────────────────
  {
    name: "regex de handoff corta incluso con análisis en contra",
    text: "quiero hablar con una persona",
    analysis: analysis({ wantsLead: true, specialtyKey: "pediatria" }),
    expect: { type: "escalate", kind: "humano" },
  },
  {
    name: "regex de ubicación responde determinista",
    text: "donde estan ubicados?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "reply", intent: "ubicacion" },
  },
  {
    name: "ubicación durante ficha → responde y conserva los datos",
    text: "Juan Pérez, mañana a las 10. ¿Dónde están ubicados?",
    analysis: analysis({ patientName: "Juan Pérez", preferredTime: "mañana a las 10" }),
    step: "collecting_lead",
    expect: { type: "locationAndContinueLead", intent: "ubicacion" },
  },
  {
    name: "ubicación en ficha → no repetir dirección vía Q&A",
    text: "¿Dónde están?",
    analysis: analysis({ isQuestion: true }),
    step: "collecting_lead",
    expect: { type: "locationAndContinueLead", intent: "ubicacion" },
  },
  {
    name: "cancelar de verdad → deriva",
    text: "quiero cancelar mi cita",
    analysis: analysis(),
    expect: { type: "escalate", kind: "cancelar", intent: "cancelar" },
  },
  {
    name: "'cancelar' como pagar NO deriva como cancelación",
    text: "va cancelar por QR",
    analysis: analysis({ paymentIntention: "qr" }),
    expect: { type: "sendQr", intent: "pago" },
  },
  // QR, opción (b) de la clínica (2026-10-03): se envía solo si lo pide.
  {
    name: "pide el QR → se le envía",
    text: "me puede pasar el QR para pagar",
    analysis: null,
    expect: { type: "sendQr", intent: "pago" },
  },
  {
    name: "pregunta el precio sin pedir QR → no se envía",
    text: "¿cuánto cuesta la ecografía abdominal?",
    analysis: null,
    expect: { type: "startLead", kind: "servicio" },
  },

  // ── REGRESIÓN: el orden de las reglas protege de un falso positivo ─────
  // Verificado contra el modelo: "Quiero sacar ficha con cardiología, soy Juan
  // Pérez" devuelve needsHumanAction=true. No hace daño porque la rama de ficha
  // va ANTES que la de gestión. Si alguien invierte ese orden, un pedido de
  // ficha normal se convierte en derivación con pausa de 12 h.
  {
    name: "REGRESIÓN: ficha + needsHumanAction falso → gana la ficha",
    text: "Quiero sacar ficha con cardiología, soy Juan Pérez",
    analysis: analysis({ specialtyKey: "cardiologia", patientName: "Juan Pérez", wantsLead: true, needsHumanAction: true }),
    expect: { type: "startLead", kind: "ficha" },
  },
  {
    name: "REGRESIÓN: servicio + needsHumanAction falso → gana el servicio",
    text: "quiero una ecografia abdominal, me confirma",
    analysis: analysis({ wantsLead: true, needsHumanAction: true }),
    expect: { type: "startLead", kind: "servicio" },
  },
  {
    name: "REGRESIÓN: no catalogado + needsHumanAction → gana la solicitud",
    text: "quiero un electrocardiograma",
    analysis: analysis({ unavailableRequest: "electrocardiograma", wantsLead: true, needsHumanAction: true }),
    expect: { type: "startLead", kind: "no_disponible" },
  },

  // ── Red de seguridad y cajón de sastre ────────────────────────────────────
  {
    name: "aviso interno ('me confirma') → silencio: ni respuesta ni alarma",
    text: "Me confirma",
    analysis: analysis({ needsHumanAction: true }),
    expect: { type: "silent", intent: "accion" },
  },
  {
    name: "me confirma con análisis caído → silencio",
    text: "Me confirma por favor",
    analysis: null,
    expect: { type: "silent", intent: "accion" },
  },
  {
    name: "me dice el precio con análisis caído → no deriva",
    text: "¿Me dice el precio de la ecografía?",
    analysis: null,
    expect: { type: "qa" },
  },
  {
    name: "ya llegué con análisis caído → silencio",
    text: "Ya llegué a la clínica",
    analysis: null,
    expect: { type: "silent", intent: "accion" },
  },
  {
    name: "llegué durante una ficha con análisis caído → sigue la ficha",
    text: "Ya llegué",
    analysis: null,
    step: "collecting_lead",
    expect: { type: "continueLead" },
  },
  {
    name: "me lo dice a la licenciada con análisis caído → silencio",
    text: "Me lo dice a la licenciada por favor",
    analysis: null,
    expect: { type: "silent", intent: "accion" },
  },
  {
    name: "dígale a la doctora con análisis caído → silencio",
    text: "Dígale a la doctora que ya llegué",
    analysis: null,
    expect: { type: "silent", intent: "accion" },
  },
  {
    name: "pregunta general → Q&A",
    text: "a que hora abren?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "qa" },
  },
  {
    name: "saludo suelto",
    text: "hola buenas",
    analysis: null,
    greetingOnly: true,
    expect: { type: "reply", intent: "saludo" },
  },
  {
    name: "comprobante de pago",
    text: "",
    analysis: null,
    proof: "receipt",
    expect: { type: "reply", intent: "comprobante" },
  },
  {
    name: "sin texto ni adjunto útil → bienvenida",
    text: "",
    analysis: null,
    expect: { type: "reply", intent: "bienvenida" },
  },
  {
    name: "análisis nulo (el modelo falló) no rompe el ruteo",
    text: "necesito algo raro que no entiendo",
    analysis: null,
    expect: { type: "qa" },
  },

  // ── Campaña PAP (2026-09-21) ──────────────────────────────────────────────
  {
    name: "texto del anuncio de Facebook → solicitud del PAP",
    text: "PAPANICOLAO 50% DESCUENTO",
    analysis: analysis({ isQuestion: false }),
    expect: { type: "startLead", kind: "servicio", intent: "servicio" },
  },
  {
    name: "anuncio de Facebook sin análisis (modelo caído) → igual PAP",
    text: "PAPANICOLAO 50% DESCUENTO",
    analysis: null,
    expect: { type: "startLead", kind: "servicio" },
  },
  {
    name: "pregunta el precio del PAP → solicitud con la info de la campaña",
    text: "cuanto cuesta el papa nicolau?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "startLead", kind: "servicio" },
  },
  {
    name: "¿ya está mi resultado? → asesor con alarma, SIN pausa",
    text: "buenas, ya está mi resultado del pap?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "escalate", kind: "accion", intent: "resultado", pause: false },
  },
  {
    name: "¿salieron los resultados? → asesor con alarma",
    text: "ya salieron los resultados?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "escalate", intent: "resultado", pause: false },
  },
  {
    name: "ficha para que lean los resultados → es una solicitud, no una consulta de estado",
    text: "quiero una ficha para que el ginecologo lea mis resultados",
    analysis: analysis({ specialtyKey: "ginecologia", wantsLead: true }),
    expect: { type: "startLead", kind: "ficha" },
  },
  {
    name: "¿en cuánto sale el resultado? → pregunta del servicio, no de estado",
    text: "en cuantos dias sale el resultado?",
    analysis: analysis({ isQuestion: true }),
    expect: { type: "qa" },
  },
  {
    name: "prueba de VPH sin análisis → no cae al Q&A (no es el PAP)",
    text: "cuanto cuesta la prueba de VPH?",
    analysis: null,
    expect: { type: "offerLead", intent: "no_disponible" },
  },
];

let failures = 0;
console.log("\nDECISIÓN DE RUTEO  (sin OpenAI, sin webhook)\n");

for (const c of CASES) {
  const action = decideAction({
    clinic,
    text: c.text,
    analysis: c.analysis ?? null,
    step: c.step ?? "idle",
    pendingOffer: c.pendingOffer ?? null,
    proof: c.proof ?? null,
    priceDispute: c.priceDispute ?? false,
    pendingClarify: c.pendingClarify ?? null,
    pendingUrgency: c.pendingUrgency ?? false,
    emergencyDetectionEnabled: false,
    greetingOnly: c.greetingOnly ?? false,
  });

  const problems: string[] = [];
  if (action.type !== c.expect.type) problems.push(`type=${action.type} (esperado ${c.expect.type})`);
  if (c.expect.kind !== undefined) {
    const kind = "kind" in action ? action.kind : undefined;
    if (kind !== c.expect.kind) problems.push(`kind=${kind} (esperado ${c.expect.kind})`);
  }
  if (c.expect.intent !== undefined && action.intent !== c.expect.intent) {
    problems.push(`intent=${action.intent} (esperado ${c.expect.intent})`);
  }
  if (c.expect.offer !== undefined) {
    const offer = action.type === "startLead" ? Boolean(action.offer) : undefined;
    if (offer !== c.expect.offer) problems.push(`offer=${offer} (esperado ${c.expect.offer})`);
  }
  if (c.expect.pause !== undefined) {
    const pause = action.type === "escalate" ? action.pause ?? true : undefined;
    if (pause !== c.expect.pause) problems.push(`pause=${pause} (esperado ${c.expect.pause})`);
  }

  if (problems.length) {
    failures++;
    console.log(`  ✗ ${c.name}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    const detalle = action.type + ("kind" in action && action.kind ? `:${action.kind}` : "");
    console.log(`  ✓ ${c.name}`.padEnd(72) + detalle);
  }
}

console.log("\nPREGUNTAS DURANTE UNA SOLICITUD (respuesta determinista, sin repetir el formulario)\n");
const knownPrice = answerKnownLeadQuestion(
  { kind: "servicio", serviceName: "Ecografía transvaginal", serviceQuote: "150 Bs" },
  clinic,
  "Cuánto está su costo",
);
if (!knownPrice?.includes("150 Bs")) {
  failures++;
  console.log(`  ✗ precio del catálogo: ${knownPrice ?? "sin respuesta"}`);
} else {
  console.log("  ✓ precio del catálogo: Ecografía transvaginal — 150 Bs");
}

const locationFollowup = analysisForLocationFollowup(analysis({
  patientName: "Juan Pérez", preferredTime: "mañana a las 10", isQuestion: true,
}));
if (!locationFollowup || locationFollowup.isQuestion || locationFollowup.patientName !== "Juan Pérez" || locationFollowup.preferredTime !== "mañana a las 10") {
  failures++;
  console.log("  ✗ dirección+respuesta pierde datos o conserva el indicador de Q&A");
} else {
  console.log("  ✓ dirección+respuesta conserva nombre y horario sin repetir Q&A");
}
const locationDraft = locationFollowup ? mergeAnalysis({ kind: "ficha" }, locationFollowup).draft : null;
if (locationDraft?.patientName !== "Juan Pérez" || locationDraft.preferredTime !== "mañana a las 10") {
  failures++;
  console.log("  ✗ los campos extraídos no llegan al borrador de la ficha");
} else {
  console.log("  ✓ nombre y horario se fusionan realmente en el borrador");
}

const quotedService = { kind: "servicio" as const, serviceName: "Ecografía transvaginal", serviceQuote: "150 Bs" };
if (!hasPriceDispute(quotedService, clinic, "No es 100 Bs, vi en la publicación por WhatsApp") || hasPriceDispute(quotedService, clinic, "No es 150 Bs")) {
  failures++;
  console.log("  ✗ disputa de precio: no comparó la cifra con la cotización");
} else {
  console.log("  ✓ no confirma un precio hasta verificar la publicación");
}
if (hasPriceDispute(quotedService, clinic, "Vi en el anuncio el PAP, ¿cuánto cuesta?") || hasPriceDispute(quotedService, clinic, "No es urgente, ¿cuánto cuesta?") || hasPriceDispute(quotedService, clinic, "Vale gracias, no es necesario")) {
  failures++;
  console.log("  ✗ palabras de anuncio/negación sin importe distinto dispararon una disputa");
} else {
  console.log("  ✓ anuncio sin precio en conflicto no genera una disputa");
}
if (answerKnownLeadQuestion(quotedService, clinic, "¿Cuánto demora el resultado?") !== null || answerKnownLeadQuestion(quotedService, clinic, "¿En cuánto tiempo sale el resultado?") !== null) {
  failures++;
  console.log("  ✗ pregunta de duración contestada como precio");
} else {
  console.log("  ✓ pregunta de duración no se contesta con el precio");
}

const unknownPrice = answerKnownLeadQuestion(
  { kind: "no_disponible", unmatchedRequestText: "electrocardiograma" },
  clinic,
  "Cuánto cuesta",
);
if (!unknownPrice?.includes("asesor")) {
  failures++;
  console.log(`  ✗ precio fuera de catálogo: ${unknownPrice ?? "sin respuesta"}`);
} else {
  console.log("  ✓ precio fuera de catálogo: deriva sin inventar ni negar");
}

// Disputa de precio: se comparan TODAS las cifras de la cotización (campaña,
// rango, franjas). Antes solo la primera, y "fuera de horario es 200 Bs" o
// "me dijeron 50 Bs" (en un rango 50 a 120) disparaban una disputa falsa.
console.log("\nDISPUTA DE PRECIO\n");
const papQuote = "50 Bs (promoción 50% de descuento, regular 100 Bs) de lunes a viernes de 8:00 a 12:00 y de 14:00 a 18:00; fuera de ese horario, 200 Bs (a llamado, como emergencia; incluye la toma y el análisis)";
const DISPUTAS: [string, LeadDraft, string, boolean][] = [
  ["campaña: 'fuera de horario es 200 Bs'", { kind: "servicio", serviceName: "Papanicolaou", serviceQuote: papQuote }, "me dijeron que fuera de horario es 200 bs", false],
  ["campaña: 'no es 100, en el anuncio dice 50'", { kind: "servicio", serviceName: "Papanicolaou", serviceQuote: papQuote }, "no es 100 bs, en el anuncio dice 50 bs", false],
  ["campaña: una cifra que no está", { kind: "servicio", serviceName: "Papanicolaou", serviceQuote: papQuote }, "me dijeron que es 30 bs", true],
  ["rango 50 a 120: el extremo bajo", { kind: "servicio", serviceName: "Certificado de seguro médico", serviceQuote: "50 a 120 Bs" }, "me dijeron que es 50 bs", false],
  ["rango 50 a 120: fuera del rango", { kind: "servicio", serviceName: "Certificado de seguro médico", serviceQuote: "50 a 120 Bs" }, "me dijeron que es 30 bs", true],
  ["consulta por franja: el de noche", { kind: "ficha", specialtyKey: "medicina-general" }, "me dijeron que de noche es 80 bs", false],
  ["consulta por franja: otra cifra", { kind: "ficha", specialtyKey: "medicina-general" }, "me dijeron que es 100 bs", true],
  ["sin cotización: no es disputa", { kind: "ficha" }, "me dijeron 60 bs", false],
  ["miles con punto", { kind: "servicio", serviceName: "Cesárea programada", serviceQuote: "4000 Bs" }, "me dijeron 4.000 bs", false],
];
for (const [nombre, draft, texto, esperado] of DISPUTAS) {
  const got = hasPriceDispute(draft, clinic, texto);
  if (got !== esperado) failures++;
  console.log(`  ${got === esperado ? "✓" : "✗"} ${nombre}`.padEnd(52) + `disputa=${got}`);
}

const valeOk = answerKnownLeadQuestion({ kind: "ficha", specialtyKey: "medicina-general" }, clinic, "vale, mañana a las 10");
if (valeOk !== null) failures++;
console.log(`  ${valeOk === null ? "✓" : "✗"} "vale, mañana a las 10" no es pregunta de precio`);

// ─── Aviso de horario del Dr. Daguino (domingos y feriados desde las 19:00) ──
// 2026-10-04 es domingo; 2026-10-05, lunes.
console.log("\nAVISO DE HORARIO POR MÉDICO\n");
const DAGUINO = "Dr. Miguel Edgar Daguino Delgadillo";
const AVISOS: [string, LeadDraft, string[], boolean][] = [
  ["domingo 10:00 con el Dr. Daguino → avisa", { kind: "ficha", doctorPreference: DAGUINO, preferredDate: "2026-10-04", preferredHour: "10:00" }, [], true],
  ["domingo sin hora con el Dr. Daguino → avisa", { kind: "ficha", doctorPreference: DAGUINO, preferredDate: "2026-10-04" }, [], true],
  ["domingo 19:30 con el Dr. Daguino → no hace falta", { kind: "ficha", doctorPreference: DAGUINO, preferredDate: "2026-10-04", preferredHour: "19:30" }, [], false],
  ["lunes 10:00 con el Dr. Daguino → no aplica", { kind: "ficha", doctorPreference: DAGUINO, preferredDate: "2026-10-05", preferredHour: "10:00" }, [], false],
  ["lunes feriado 10:00 con el Dr. Daguino → avisa", { kind: "ficha", doctorPreference: DAGUINO, preferredDate: "2026-10-05", preferredHour: "10:00" }, ["2026-10-05"], true],
  ["domingo 10:00 con otro médico → no aplica", { kind: "ficha", doctorPreference: "Dra. Rosmery Medina", preferredDate: "2026-10-04", preferredHour: "10:00" }, [], false],
  ["domingo 10:00 sin médico de preferencia → no aplica", { kind: "ficha", specialtyKey: "pediatria", preferredDate: "2026-10-04", preferredHour: "10:00" }, [], false],
];
for (const [nombre, draft, feriados, esperado] of AVISOS) {
  const notas = doctorScheduleNotes(draft, feriados);
  const ok = (notas.length > 0) === esperado && (!esperado || /desde las 19:00/.test(notas[0]));
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${nombre}`);
}

// ─── Edad en pediatría (hasta los 12 años, 2026-10-03) ──────────────────────
console.log("\nEDAD EN PEDIATRÍA\n");
const EDADES: [string, string | null][] = [
  ["Juan Pérez, 5 años", "5 años"],
  ["tiene un año", "1 año"],
  ["mi bebé de 8 meses", "8 meses"],
  ["tiene 3 añitos", "3 años"],
  ["tiene 13 años", "13 años"],
  ["tiene fiebre hace 3 días", null],
  ["desde hace 2 meses le duele", null],
  ["viene cada 3 meses", null],
  ["¿hasta los 12 años atienden?", null],
  ["mañana a las 10", null],
];
for (const [texto, esperado] of EDADES) {
  const got = readAge(texto);
  if (got !== esperado) failures++;
  console.log(`  ${got === esperado ? "✓" : "✗"} "${texto}"`.padEnd(50) + String(got));
}

const pidePediatria = missingFields({ kind: "ficha", specialtyKey: "pediatria", patientName: "Ana", preferredTime: "mañana", visitType: "nueva" });
const pideMG = missingFields({ kind: "ficha", specialtyKey: "medicina-general", patientName: "Ana", preferredTime: "mañana", visitType: "nueva" });
const edadOk = pidePediatria.includes("age") && !pideMG.includes("age");
if (!edadOk) failures++;
console.log(`  ${edadOk ? "✓" : "✗"} se pide la edad en pediatría y no en otras especialidades`);

const LIMITE: [string, string, string][] = [
  ["12 años sigue en pediatría", "12 años", "pediatria"],
  ["8 meses sigue en pediatría", "8 meses", "pediatria"],
  ["13 años pasa a Medicina General", "13 años", "medicina-general"],
  ["15 años pasa a Medicina General", "15 años", "medicina-general"],
];
for (const [nombre, edad, esperado] of LIMITE) {
  const { draft, note } = applyPediatricAgeLimit({ kind: "ficha", specialtyKey: "pediatria", patientAge: edad });
  const ok = draft.specialtyKey === esperado && (esperado === "pediatria" ? note === null : Boolean(note?.includes("hasta los 12 años")));
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${nombre}`.padEnd(50) + `${draft.specialtyKey}${note ? " + explicación" : ""}`);
}

// ─── Qué se le responde ──────────────────────────────────────────────────────
// Dosis: se le confirma que su duda llegó a la clínica, sin "no puedo…"
// (pedido de la clínica, 2026-10-03). Emergencia: el texto que configuró la
// clínica, sin preguntarle nada.
console.log("\nRESPUESTAS DE SEGURIDAD\n");
const decide = (text: string) =>
  decideAction({ clinic, text, analysis: null, step: "idle", pendingOffer: null, proof: null, emergencyDetectionEnabled: false, greetingOnly: false });
const dosis = decide("¿Cuántas gotas de salbutamol le doy a mi bebé?");
const dosisText = dosis.type === "escalate" ? dosis.reply : "";
const dosisOk = /llegar a personal de la cl[ií]nica/i.test(dosisText) && /lo antes posible/i.test(dosisText) && !/no puedo/i.test(dosisText);
if (!dosisOk) failures++;
console.log(`  ${dosisOk ? "✓" : "✗"} dosis: confirma que su duda llegó, sin "no puedo"`);
const emergencia = decide("mi bebé tuvo una convulsión");
// "¿" y no "?": el texto trae el link de Maps, que lleva un "?" adentro.
const emergenciaOk = emergencia.type === "escalate" && emergencia.reply === clinic.emergencyResponse && !/¿/.test(emergencia.reply);
if (!emergenciaOk) failures++;
console.log(`  ${emergenciaOk ? "✓" : "✗"} emergencia: texto de la clínica, sin preguntas`);
const resultado = decide("¿ya está mi resultado?");
const resultadoOk = resultado.type === "escalate" && /enviar su pregunta a un asesor/i.test(resultado.reply) && /lo antes posible/i.test(resultado.reply);
if (!resultadoOk) failures++;
console.log(`  ${resultadoOk ? "✓" : "✗"} resultado: "acabamos de enviar su pregunta a un asesor…"`);

// La detección temprana del webhook (antes de esperar y de llamar al modelo).
console.log("\n¿EMERGENCIA? (detección temprana)\n");
const EMERGENCIAS: [string, boolean][] = [
  ["mi bebé tuvo una convulsión", true],
  ["está convulsionando", true],
  ["no puede respirar", true],
  ["no respira", true],
  ["no está respirando", true],
  ["dejó de respirar", true],
  ["le cuesta respirar", true],
  ["respira con dificultad", true],
  ["se puso morado", true],
  ["no puedo respirar", true],
  ["tengo un morado en la pierna", false],
  // Expresiones de todos los días (2026-10-03): no son un desmayo ni un ataque.
  ["casi me desmayo de la risa", false],
  ["me desmayo de hambre jaja", false],
  ["le dio un ataque de risa", false],
  ["le dio un ataque de tos", false],
  ["se desmayó en el baño", true],
  ["le dio un ataque y no reacciona", true],
  ["no respiren el humo, nos vemos mañana", false],
  ["se desmayó", true],
  ["tiene fiebre de 40 y no reacciona", true],
  ["no despierta", true],
  ["se está ahogando", true],
  ["se atragantó con un caramelo", true],
  ["le dio un ataque", true],
  ["tengo un dolor muy fuerte en el pecho", true],
  ["tiene una hemorragia", true],
  // Decisiones de la clínica del 2026-10-03.
  ["¡Emergencia!!!", true],
  ["emergencia", true],
  ["es una emergencia, mi hijo se cortó", true],
  ["sangra mucho de la cabeza", true],
  ["tengo sangrado abundante en mi regla", false],
  ["hemorragia en mi periodo", false],
  ["tengo dolor de pecho", false],
  ["ayuda urgente", false],
  ["emergencia de cardiología cuánto cuesta", false],
  ["¿atienden emergencias?", false],
  ["mi bebé está muy decaído", false],
  ["¿cuánto cuesta la consulta de emergencia?", false],
  ["quiero una ecografía de emergencia", false],
  ["mi hijo se queja de dolor de barriga", false],
  ["tengo caída de cabello", false],
  ["me ahogo de calor jaja", false],
  ["¿se puede dar ficha para mañana?", false],
];
for (const [texto, esperado] of EMERGENCIAS) {
  const got = isEmergencyText(texto);
  if (got !== esperado) failures++;
  console.log(`  ${got === esperado ? "✓" : "✗"} "${texto}"`.padEnd(52) + (got ? "emergencia" : "no"));
}

// ─── needsVisitType: nunca preguntar nueva/reconsulta sin especialidad ──────
// El fallback era `true`, y como lo que no está en catálogo nunca tiene
// specialtyKey, terminaba preguntándole a un electrocardiograma si era
// "consulta nueva o reconsulta".
console.log("\n¿PREGUNTA NUEVA/RECONSULTA?\n");

const VISIT: [string, LeadDraft, boolean][] = [
  ["electrocardiograma (no catalogado)", { kind: "no_disponible", unmatchedRequestText: "electrocardiograma" }, false],
  ["radiografía (no catalogado)", { kind: "no_disponible", unmatchedRequestText: "radiografia de torax" }, false],
  ["análisis de laboratorio suelto", { kind: "no_disponible", unmatchedRequestText: "analisis de sangre" }, false],
  ["fisioterapia (no catalogado)", { kind: "no_disponible", unmatchedRequestText: "fisioterapia" }, false],
  ["ficha sin especialidad todavía", { kind: "ficha" }, false],
  ["servicio del tarifario", { kind: "servicio", serviceName: "Ecografía abdominal" }, false],
  ["medicina general (reconsulta 7d)", { kind: "ficha", specialtyKey: "medicina-general" }, true],
  ["pediatría (reconsulta 3d)", { kind: "ficha", specialtyKey: "pediatria" }, true],
  ["ginecología (reconsulta 7d)", { kind: "ficha", specialtyKey: "ginecologia" }, true],
  // Solo Medicina General, Ginecología y Pediatría tienen reconsulta (2026-10-03).
  ["cardiología (sin reconsulta)", { kind: "ficha", specialtyKey: "cardiologia" }, false],
  ["neurología (sin reconsulta)", { kind: "ficha", specialtyKey: "neurologia" }, false],
];

for (const [nombre, draft, esperado] of VISIT) {
  const got = needsVisitType(draft);
  if (got !== esperado) {
    failures++;
    console.log(`  ✗ ${nombre}`.padEnd(50) + `pregunta=${got} (esperado ${esperado})`);
  } else {
    console.log(`  ✓ ${nombre}`.padEnd(50) + (got ? "sí pregunta" : "no pregunta"));
  }
}

// La reconsulta la declara el paciente: el código la toma cuando la dice con
// todas las letras, y pedir "una consulta" o traer resultados no la decide.
console.log("\n¿NUEVA O RECONSULTA EN EL TEXTO?\n");
const VISIT_TEXT: [string, string | null][] = [
  ["es reconsulta", "reconsulta"],
  ["Reconsulta", "reconsulta"],
  ["es re-consulta con el pediatra", "reconsulta"],
  ["no es reconsulta, es la primera vez", "nueva"],
  ["nueva", "nueva"],
  ["es consulta nueva", "nueva"],
  ["primera vez que vengo", "nueva"],
  ["quiero sacar una consulta", null],
  ["quiero una ficha nueva para mi hijo", null],
  ["vengo a mostrar resultados", null],
  ["para control", null],
];
for (const [texto, esperado] of VISIT_TEXT) {
  const got = visitTypeFromText(texto);
  if (got !== esperado) failures++;
  console.log(`  ${got === esperado ? "✓" : "✗"} "${texto}"`.padEnd(50) + String(got));
}

// ─── looksLikeName: "pa mi" no es un nombre ─────────────────────────────────
// Contestan PARA QUIÉN es, no cómo se llaman. Ante la duda, null: un nombre
// faltante se pregunta; uno inventado llega al panel y el asesor llama a "pa mi".
console.log("\n¿ES UN NOMBRE?\n");

const NOMBRES: [string, boolean][] = [
  ["sí", false],
  ["ok", false],
  ["mañana", false],
  ["1 año y 5 meses", false],
  ["pa mi", false],
  ["para mi", false],
  ["para mí", false],
  ["para mi mamá", false],
  ["para mi hijo", false],
  ["para mi esposa", false],
  ["para mi señor", false],
  ["es para mí", false],
  ["yo mismo", false],
  ["yo misma", false],
  ["yo nomás", false],
  ["yo", false],
  ["mi hijo", false],
  ["mi señora", false],
  ["Juan Pérez", true],
  ["María López", true],
  ["Carlos Rojas", true],
  ["Ana Fernández", true],
  ["Juan", true],
  ["María José Gutiérrez Vargas", true],
];

for (const [texto, esperado] of NOMBRES) {
  const got = looksLikeName(texto);
  if (got !== esperado) {
    failures++;
    console.log(`  ✗ "${texto}"`.padEnd(42) + `looksLikeName=${got} (esperado ${esperado})`);
  } else {
    console.log(`  ✓ "${texto}"`.padEnd(42) + (got ? "nombre" : "descartado"));
  }
}

// ─── Saludo: la base nunca deja al bot sin texto ────────────────────────────
// `??` solo cubre null/undefined, así que un "" guardado por error dejaba al
// bot enviando un cuerpo vacío. Ahora cualquier texto en blanco cae al default.
console.log("\n¿EL SALUDO SIEMPRE TIENE TEXTO?\n");

const { mapClinicSettingsRowForTest } = await import("../lib/clinic/config");
const SALUDOS: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["vacío", ""],
  ["solo espacios", "   "],
  ["salto de línea", "\n\t "],
  ["ausente (config antigua)", Symbol.for("ausente")],
];

for (const [nombre, valor] of SALUDOS) {
  const replies = valor === Symbol.for("ausente") ? {} : { welcome: valor };
  const cfg = mapClinicSettingsRowForTest({ business: "clinica-san-martin", replies });
  const ok = typeof cfg.replies.welcome === "string" && cfg.replies.welcome.trim().length > 0;
  if (!ok) {
    failures++;
    console.log(`  ✗ ${nombre}`.padEnd(42) + `welcome=${JSON.stringify(cfg.replies.welcome)}`);
  } else {
    console.log(`  ✓ ${nombre}`.padEnd(42) + `"${cfg.replies.welcome.slice(0, 34)}…"`);
  }
}

console.log("\n" + "─".repeat(84));
console.log(
  failures
    ? `✗ ${failures} caso(s) con fallos.`
    : `✓ Sin fallos. (${CASES.length} decisiones + ${VISIT.length} visitType + ${NOMBRES.length} nombres + ${SALUDOS.length} saludos)`,
);
process.exit(failures ? 1 : 0);
