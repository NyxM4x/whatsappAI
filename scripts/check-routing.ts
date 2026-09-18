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
const { decideAction } = await import("../lib/clinic/routing");
const { looksLikeName, needsVisitType } = await import("../lib/clinic/leads");

import type { TurnAnalysis } from "../lib/clinic/leads";
import type { BookingStep, LeadDraft } from "../lib/clinic/types";

const clinic = await getClinicConfig();

// Análisis vacío: cada caso sobrescribe solo lo que le importa.
function analysis(patch: Partial<TurnAnalysis> = {}): TurnAnalysis {
  return {
    patientName: null, specialtyKey: null, doctorName: null,
    preferredTime: null, preferredDate: null, preferredHour: null,
    visitType: null, paymentIntention: null, unavailableRequest: null,
    needsHumanAction: false, wantsLead: false, wantsHuman: false,
    frustrated: false, confirms: false, wantsOut: false, isQuestion: false,
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
  // Qué se espera de la Action resultante.
  expect: { type: string; kind?: string; intent?: string };
};

const CASES: Case[] = [
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
    name: "cancelar de verdad → deriva",
    text: "quiero cancelar mi cita",
    analysis: analysis(),
    expect: { type: "escalate", kind: "cancelar", intent: "cancelar" },
  },
  {
    name: "'cancelar' como pagar NO deriva como cancelación",
    text: "va cancelar por QR",
    analysis: analysis({ paymentIntention: "qr" }),
    expect: { type: "escalate", kind: "pago", intent: "pago" },
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
    name: "pide una gestión → alarma, no 'Ok'",
    text: "Me confirma",
    analysis: analysis({ needsHumanAction: true }),
    expect: { type: "escalate", kind: "accion", intent: "accion" },
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

  if (problems.length) {
    failures++;
    console.log(`  ✗ ${c.name}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    const detalle = action.type + ("kind" in action && action.kind ? `:${action.kind}` : "");
    console.log(`  ✓ ${c.name}`.padEnd(72) + detalle);
  }
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
  ["ginecología (reconsulta 3d)", { kind: "ficha", specialtyKey: "ginecologia" }, true],
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

// ─── looksLikeName: "pa mi" no es un nombre ─────────────────────────────────
// Contestan PARA QUIÉN es, no cómo se llaman. Ante la duda, null: un nombre
// faltante se pregunta; uno inventado llega al panel y el asesor llama a "pa mi".
console.log("\n¿ES UN NOMBRE?\n");

const NOMBRES: [string, boolean][] = [
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
