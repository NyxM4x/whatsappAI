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

import type { TurnAnalysis } from "../lib/clinic/leads";
import type { BookingStep } from "../lib/clinic/types";

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

console.log("\n" + "─".repeat(84));
console.log(failures ? `✗ ${failures} caso(s) con fallos.` : `✓ Sin fallos. (${CASES.length} casos)`);
process.exit(failures ? 1 : 0);
