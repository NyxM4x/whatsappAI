// ============================================================================
// Fechas — el día que dice el paciente, resuelto por código.
// ----------------------------------------------------------------------------
// NO llama a OpenAI. El caso que lo motivó (2026-09-25, viernes): "a qué hora
// atiende hoy sábado" terminó en un resumen que confirmaba "hoy sábado".
//
//   npx tsx scripts/check-fechas.ts
// ============================================================================

import { dateConflictQuestion, readDateMention, upcomingDays } from "../lib/clinic/dates";
import { applyDateMention, mergeAnalysis, type TurnAnalysis } from "../lib/clinic/leads";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  →  ${detail}` : ""}`);
}

const VIERNES = "2026-09-25";

console.log("\nDÍA QUE DICE EL PACIENTE (hoy es viernes 25/09)\n");

const FECHAS: [string, string | null][] = [
  ["para hoy", "2026-09-25"],
  ["ahora mismo si se puede", "2026-09-25"],
  ["esta tarde", "2026-09-25"],
  ["mañana a las 10", "2026-09-26"],
  ["manana temprano", "2026-09-26"],
  ["mañana en la mañana", "2026-09-26"],
  ["pasado mañana", "2026-09-27"],
  ["a las 10 de la mañana", null],
  ["en la mañana", null],
  ["el sábado", "2026-09-26"],
  ["el viernes", "2026-09-25"],
  ["el lunes en la tarde", "2026-09-28"],
  ["el miércoles", "2026-09-30"],
  ["el 30 de septiembre", "2026-09-30"],
  ["el 2 de octubre", "2026-10-02"],
  ["el 20 de setiembre", "aclaración"],
  ["el 20 de septiembre de 2027", "2027-09-20"],
  ["para el 5", "2026-10-05"],
  ["el 28", "2026-09-28"],
  ["02/10", "2026-10-02"],
  ["de 10-12", null],
  ["a las 10", null],
  ["el lunes o el martes", null],
  ["lo antes posible", null],
];

for (const [texto, esperado] of FECHAS) {
  const m = readDateMention(texto, VIERNES);
  const got = m.kind === "date" ? m.date : m.kind === "conflict" ? "conflicto" : m.kind === "past" ? "aclaración" : null;
  check(`"${texto}" → ${esperado ?? "sin fecha"}`, got === esperado, String(got));
}

console.log("\nDÍAS QUE NO CALZAN\n");

const CONFLICTOS = [
  "A que hora atiende hoy sábado",
  "hoy domingo",
  "mañana domingo",
  "el sábado 27",
];
for (const texto of CONFLICTOS) {
  const m = readDateMention(texto, VIERNES);
  check(`"${texto}" → se pregunta`, m.kind === "conflict", m.kind === "conflict" ? dateConflictQuestion(m, VIERNES) : m.kind);
}

const SIN_CONFLICTO = ["hoy viernes", "mañana sábado", "el sábado 26", "pasado mañana domingo"];
for (const texto of SIN_CONFLICTO) {
  const m = readDateMention(texto, VIERNES);
  check(`"${texto}" → calza`, m.kind === "date", m.kind === "date" ? m.date : m.kind);
}

// "ahora" o "hoy" de muletilla, separados del día: no se le pregunta nada.
const MULETILLAS = ["ahora quiero ficha para el sábado", "hoy le escribo para pedir ficha el lunes"];
for (const texto of MULETILLAS) {
  const m = readDateMention(texto, VIERNES);
  check(`"${texto}" → no se pregunta`, m.kind !== "conflict", m.kind);
}

const caso = readDateMention("A que hora atiende hoy sábado", VIERNES);
const pregunta = caso.kind === "conflict" ? dateConflictQuestion(caso, VIERNES) : "";
check("la pregunta dice qué día es hoy", pregunta.includes("hoy es *viernes 25 de septiembre*"), pregunta);
check("ofrece hoy viernes y mañana sábado", pregunta.includes("hoy viernes 25/09") && pregunta.includes("mañana sábado 26/09"));

console.log("\nEL ANÁLISIS USA LA FECHA DEL CÓDIGO\n");

const base: TurnAnalysis = {
  patientName: null, patientAge: null, specialtyKey: null, doctorName: null,
  preferredTime: null, preferredDate: null, preferredHour: null,
  visitType: null, paymentIntention: null, unavailableRequest: null,
  needsHumanAction: false, wantsLead: false, wantsHuman: false,
  frustrated: false, confirms: false, wantsOut: false, isQuestion: false,
  dateConflict: null,
};

// El modelo copió "hoy sábado" y calculó mal la fecha.
const conflicto = applyDateMention({ ...base, preferredTime: "hoy sábado", preferredDate: "2026-09-26" }, "A que hora atiende hoy sábado", VIERNES);
check("conflicto: se descarta el horario", conflicto.preferredTime === null && conflicto.preferredDate === null);
check("conflicto: queda la pregunta", Boolean(conflicto.dateConflict));

const pasada = applyDateMention({ ...base, preferredTime: "20 de septiembre", preferredDate: "2027-09-20" }, "20 de septiembre", VIERNES);
check("fecha explícita pasada: no se traslada al año siguiente", pasada.preferredTime === null && pasada.preferredDate === null);
check("fecha explícita pasada: queda una pregunta", Boolean(pasada.dateConflict?.includes("ya pasó")), pasada.dateConflict ?? "");
// Una fecha que cuenta un hecho ("me hice el PAP el 24") no es el horario de la
// solicitud. Si el modelo la devolvió como horario, se descarta sin preguntar, y
// el horario que ya estaba en la solicitud sigue valiendo.
const fechaHistorica = applyDateMention({ ...base, preferredTime: "24 de septiembre", preferredDate: "2026-09-24" }, "me hice el PAP el 24 de septiembre, ¿ya está?", VIERNES);
check("fecha de un hecho: no pregunta", fechaHistorica.dateConflict === null);
check("fecha de un hecho: no se toma como horario", fechaHistorica.preferredTime === null && fechaHistorica.preferredDate === null);
const borrador = mergeAnalysis({ kind: "ficha", preferredTime: "mañana a las 10", preferredDate: "2026-09-26" }, fechaHistorica).draft;
check("fecha de un hecho: el horario de la solicitud se conserva", borrador.preferredTime === "mañana a las 10", String(borrador.preferredTime));
const otroAnio = applyDateMention({ ...base, preferredTime: "24 de septiembre", preferredDate: "2027-09-24" }, "me hice el PAP el 24 de septiembre", VIERNES);
check("fecha de un hecho movida al año siguiente: tampoco es horario", otroAnio.preferredTime === null && otroAnio.dateConflict === null);
const terceraPersona = applyDateMention({ ...base, preferredTime: "20 de septiembre" }, "a mi hijo le hicieron análisis el 20 de septiembre", VIERNES);
check("'le hicieron… el 20': es un hecho, no pregunta", terceraPersona.dateConflict === null && terceraPersona.preferredTime === null);
const otroHorario = applyDateMention({ ...base, preferredTime: "el lunes", preferredDate: "2026-09-28" }, "me hice análisis el 20 de septiembre, quiero ficha el lunes", VIERNES);
check("hecho pasado + horario nuevo: queda el horario nuevo", otroHorario.preferredTime === "el lunes" && otroHorario.dateConflict === null, String(otroHorario.preferredTime));

// El modelo se equivocó de día: manda el código.
const corregido = applyDateMention({ ...base, preferredTime: "el lunes", preferredDate: "2026-09-29" }, "el lunes", VIERNES);
check("fecha del modelo equivocada → la del código", corregido.preferredDate === "2026-09-28", String(corregido.preferredDate));

// Sin un día que el código entienda, queda lo del modelo.
const vago = applyDateMention({ ...base, preferredTime: "la otra semana", preferredDate: null }, "la otra semana", VIERNES);
check("sin día claro → queda lo del modelo", vago.preferredTime === "la otra semana" && vago.dateConflict === null);

console.log("\nCALENDARIO PARA EL PROMPT\n");
const dias = upcomingDays(VIERNES);
check("empieza por mañana sábado", dias.startsWith("mañana sábado 26/09"), dias);

console.log(failures === 0 ? "\n✅ Fechas en orden." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
