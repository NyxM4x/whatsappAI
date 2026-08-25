// ============================================================================
// Verificación de detección de intención y tarifario.
// ----------------------------------------------------------------------------
// No necesita OpenAI ni Google Calendar: prueba las regex de intención de
// config.ts y matchService() contra frases reales de pacientes, y contrasta el
// precio que el bot INFORMA (tarifario) con el que COBRA (clinic_doctors).
//
//   npx tsx scripts/check-intenciones.ts
// ============================================================================

import { readFileSync } from "node:fs";
import { getClinicConfig } from "../lib/clinic/config";
import { matchService, formatServicePrice } from "../lib/clinic/services";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const clinic = await getClinicConfig();
let fallos = 0;

function chequear(etiqueta: string, ok: boolean, detalle: string) {
  if (!ok) fallos++;
  console.log(`  ${ok ? "✓" : "✗"} ${etiqueta.padEnd(46)} ${detalle}`);
}

// ── Intención de agendar (fast-path por regex; si falla, el webhook usa GPT) ──
console.log("\nINTENCIÓN DE AGENDAR  (deben entrar por regex, sin gastar una llamada a GPT)");
for (const frase of [
  "quiero agendar una cita",
  "Se puede pedir ficha x este medio", // paciente real, 2026-08-24
  "Quería reservar ficha?",
  "Buenas tardes doctor quisiera una ficha para pediatría porfavor", // paciente real
  "necesito un turno con el pediatra",
  "quiero que me atienda un doctor",
  "quiero una ficha para pediatria",
  "hay fichas para hoy?",
]) {
  const hit = clinic.bookingIntentPatterns.test(frase);
  chequear(`"${frase.slice(0, 42)}"`, hit, hit ? "agenda" : "✗ cae a GPT");
}

// ── Preguntas de horario: NO deben arrancar una reserva ──────────────────────
// Este bloque es la red de seguridad del alias "me atiend…": si alguna vez se
// afloja a "atiend\w*" suelto, estas frases empiezan a fallar acá antes de
// llegar a un paciente.
console.log("\nPREGUNTAS DE HORARIO  (no deben disparar el flujo de reserva)");
for (const frase of [
  "a que hora atienden?",
  "atienden los domingos?",
  "atienden por seguro?",
  "hasta que hora atiende la clinica?",
]) {
  const hit = clinic.bookingIntentPatterns.test(frase);
  chequear(`"${frase}"`, !hit, hit ? "✗ arranca una reserva que nadie pidió" : "va a Q&A");
}

// ── Otras intenciones ────────────────────────────────────────────────────────
console.log("\nOTRAS INTENCIONES");
chequear('"quiero cancelar mi cita"', clinic.cancelIntentPatterns.test("quiero cancelar mi cita"), "cancelar");
chequear('"necesito reprogramar"', clinic.rescheduleIntentPatterns.test("necesito reprogramar"), "reprogramar");
chequear('"cuando es mi cita?"', clinic.checkAppointmentIntentPatterns.test("cuando es mi cita?"), "consultar");
chequear('"quiero hablar con una persona"', clinic.humanHandoffIntentPatterns.test("quiero hablar con una persona"), "derivar");
chequear('"esto es un pésimo servicio"', clinic.humanHandoffIntentPatterns.test("esto es un pésimo servicio"), "derivar");

// Falsos positivos: NO deben disparar nada.
console.log("\nFALSOS POSITIVOS  (no deben disparar)");
for (const [frase, patron, nombre] of [
  ["no es nada grave", clinic.cancelIntentPatterns, "cancelar"],
  ["gracias, muy amable", clinic.humanHandoffIntentPatterns, "derivar"],
  ["para las 5 de la tarde", clinic.cancelIntentPatterns, "cancelar"],
] as const) {
  const hit = patron.test(frase);
  chequear(`"${frase}"`, !hit, hit ? `✗ dispara ${nombre}` : "inerte");
}

// ── Tarifario ────────────────────────────────────────────────────────────────
console.log("\nTARIFARIO  (bookable = entra a la agenda; el resto deriva a un asesor)");
for (const [frase, esperaBookable] of [
  ["cuanto sale una consulta general", true],
  ["quiero hacerme un papanicolao", false],
  ["cuanto cuesta la eco de embarazo", false],
  ["precio de una cesarea", false],
  ["lavado de oido cuanto es", false],
  // Conjugadas: el catálogo guarda infinitivos y el paciente conjuga.
  ["necesito que me saquen puntos", false],
  ["quiero sacarme los puntos", false],
  ["quiero que me quiten el implante", false],
  ["cuanto sale ponerme el implante", false],
  ["pueden destaparme el oido", false],
  ["vengo a que me retiren el diu", false],
  // Regresión: "uña" pierde la tilde de la ñ al normalizar y queda como "una".
  // Si alguna vez se agrega borrado de artículos a normalize(), estos revientan.
  ["tengo una uña encarnada", false],
  ["necesito retiro de uña", false],
] as const) {
  const s = matchService(frase, clinic.services);
  if (!s) {
    chequear(`"${frase.slice(0, 42)}"`, false, "✗ no reconoció ningún servicio");
    continue;
  }
  const ok = Boolean(s.bookable) === esperaBookable;
  chequear(`"${frase.slice(0, 42)}"`, ok, `${s.name} — ${formatServicePrice(s)}${s.bookable ? " [agenda]" : " [asesor]"}`);
}

// ── Precio informado vs precio cobrado ───────────────────────────────────────
console.log("\nPRECIO INFORMADO vs COBRADO");
const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const [dRes, sRes] = await Promise.all([
  fetch(`${url}/rest/v1/clinic_doctors?select=name,specialty_id,consultation_price`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }),
  fetch(`${url}/rest/v1/clinic_specialties?select=id,slug`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }),
]);
const specs = new Map(((await sRes.json()) as any[]).map((s) => [s.id, s.slug]));
const cobrado = new Map<string, number>();
for (const d of (await dRes.json()) as any[]) {
  cobrado.set(specs.get(d.specialty_id)!, Number(d.consultation_price));
}

for (const [slug, frase] of [
  ["medicina-general", "consulta general"],
  ["pediatria", "consulta pediatria"],
  ["ginecologia", "consulta ginecologia"],
] as const) {
  const s = matchService(frase, clinic.services);
  const informa = s?.price ?? null;
  const cobra = cobrado.get(slug) ?? null;
  chequear(slug, informa === cobra, `informa ${informa} Bs · cobra ${cobra} Bs`);
}

console.log(`\n${"─".repeat(72)}`);
console.log(fallos === 0 ? "✓ Sin fallos." : `${fallos} punto(s) a revisar.`);
