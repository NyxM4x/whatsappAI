// ============================================================================
// Verificación de detección de intención, tarifario y precios de consulta.
// ----------------------------------------------------------------------------
// No necesita OpenAI: prueba las regex de intención de config.ts,
// matchService() contra frases reales de pacientes y las franjas de precio de
// lib/clinic/pricing.ts. Sin .env.local usa la config estática del código.
//
//   npx tsx scripts/check-intenciones.ts
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { getClinicConfig } from "../lib/clinic/config";
import { findSpecialty, priceAt } from "../lib/clinic/pricing";
import { matchService, formatServicePrice } from "../lib/clinic/services";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
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
// En Bolivia "cancelar" es pagar: estos NO deben derivar como cancelación.
for (const frase of ["Va cancelar por QR", "voy a cancelar llegando nomas", "le cancelo al llegar", "cancelo en efectivo"]) {
  chequear(`"${frase}" NO es cancelación`, clinic.cancelMeansPayingPatterns.test(frase), "sentido de pago");
}
// ...pero una cancelación real se sigue detectando.
for (const frase of ["quiero cancelar mi cita", "necesito anular la consulta"]) {
  chequear(`"${frase}" SÍ es cancelación`, clinic.cancelIntentPatterns.test(frase) && !clinic.cancelMeansPayingPatterns.test(frase), "cancelar");
}
chequear('"necesito reprogramar"', clinic.rescheduleIntentPatterns.test("necesito reprogramar"), "reprogramar");
chequear('"cuando es mi cita?"', clinic.checkAppointmentIntentPatterns.test("cuando es mi cita?"), "consultar");
chequear('"quiero hablar con una persona"', clinic.humanHandoffIntentPatterns.test("quiero hablar con una persona"), "derivar");
chequear('"quiero hablar con la dra"', clinic.humanHandoffIntentPatterns.test("quiero hablar con la dra"), "derivar");
chequear('"puedo hablar con la enfermera?"', clinic.humanHandoffIntentPatterns.test("puedo hablar con la enfermera?"), "derivar");
chequear('"quiero comunicarme con la secretaria"', clinic.humanHandoffIntentPatterns.test("quiero comunicarme con la secretaria"), "derivar");
chequear('"necesito hablar con alguien"', clinic.humanHandoffIntentPatterns.test("necesito hablar con alguien"), "derivar");
chequear('"esto es un pésimo servicio"', clinic.humanHandoffIntentPatterns.test("esto es un pésimo servicio"), "derivar");

// Falsos positivos: NO deben disparar nada.
console.log("\nFALSOS POSITIVOS  (no deben disparar)");
for (const [frase, patron, nombre] of [
  ["no es nada grave", clinic.cancelIntentPatterns, "cancelar"],
  ["gracias, muy amable", clinic.humanHandoffIntentPatterns, "derivar"],
  ["para las 5 de la tarde", clinic.cancelIntentPatterns, "cancelar"],
  // Pedir ficha con un médico es un dato de la solicitud, no una derivación.
  ["quiero una ficha con la doctora Rosmery", clinic.humanHandoffIntentPatterns, "derivar"],
  ["necesito consulta con el dr Favio", clinic.humanHandoffIntentPatterns, "derivar"],
] as const) {
  const hit = patron.test(frase);
  chequear(`"${frase}"`, !hit, hit ? `✗ dispara ${nombre}` : "inerte");
}

// ── Tarifario ────────────────────────────────────────────────────────────────
console.log("\nTARIFARIO  (servicio = abre solicitud; emergencia = solo se informa)");
for (const [frase, esperaEmergencia] of [
  ["quiero hacerme un papanicolao", false],
  ["cuanto cuesta la eco de embarazo", false],
  ["precio de una cesarea", false],
  ["lavado de oido cuanto es", false],
  ["tuve un accidente de transito", true],
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
  const emergencia = s.category === "emergencia";
  chequear(`"${frase.slice(0, 42)}"`, emergencia === esperaEmergencia, `${s.name} — ${formatServicePrice(s)}${emergencia ? " [informa]" : " [solicitud]"}`);
}

// ── Precios de consulta por franja ───────────────────────────────────────────
// Franjas confirmadas el 2026-09-15: a las 19:00 rige la tarifa de después, y
// la madrugada se cobra como la noche del día anterior.
console.log("\nPRECIOS DE CONSULTA  (día 0=domingo … 6=sábado)");
const mg = findSpecialty("medicina-general")!;
const ped = findSpecialty("pediatria")!;
const gin = findSpecialty("ginecologia")!;
for (const [etiqueta, spec, dia, hora, esperado] of [
  ["Medicina General martes 18:59", mg, 2, "18:59", 60],
  ["Medicina General martes 19:00", mg, 2, "19:00", 80],
  ["Medicina General miércoles 03:00", mg, 3, "03:00", 80],
  ["Medicina General sábado 11:59", mg, 6, "11:59", 60],
  ["Medicina General sábado 12:00", mg, 6, "12:00", 80],
  ["Medicina General lunes 06:59", mg, 1, "06:59", 80],
  ["Medicina General lunes 07:00", mg, 1, "07:00", 60],
  ["Pediatría viernes 20:00", ped, 5, "20:00", 80],
  ["Pediatría sábado 10:00", ped, 6, "10:00", 120],
  ["Pediatría sábado 19:00", ped, 6, "19:00", 100],
  ["Pediatría domingo 02:00", ped, 0, "02:00", 100],
  ["Pediatría domingo 15:00", ped, 0, "15:00", 120],
  ["Ginecología jueves 21:00", gin, 4, "21:00", 80],
  ["Ginecología sábado 09:00", gin, 6, "09:00", 120],
] as const) {
  const precio = priceAt(spec, dia, hora);
  chequear(etiqueta, precio === esperado, `${precio} Bs (esperado ${esperado})`);
}

console.log(`\n${"─".repeat(72)}`);
console.log(fallos === 0 ? "✓ Sin fallos." : `${fallos} punto(s) a revisar.`);
