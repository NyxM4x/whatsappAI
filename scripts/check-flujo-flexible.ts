// ============================================================================
// Verificación de la navegación no lineal del agendamiento.
// ----------------------------------------------------------------------------
// Comprueba las tres capacidades nuevas sin tocar WhatsApp ni Google Calendar:
//
//   1. extractBookingPrefs — triaje por síntoma, franja y urgencia (llama a
//      OpenAI de verdad, igual que prompt-check.ts).
//   2. detectBandQuestion / ANY_DOCTOR_PATTERN — los reconocedores baratos.
//   3. doctorWorksInTimeBand — qué médicos reales atienden en cada franja.
//   4. computeAvailableSlots con timeBand — que el filtro de franja NO ofrezca
//      horas fuera de las work_hours del médico (la invariante que cuida
//      check-horarios.ts).
//
//   npx tsx scripts/check-flujo-flexible.ts
// ============================================================================

import { readFileSync } from "node:fs";
import {
  computeAvailableSlots,
  doctorWorksInTimeBand,
  bandOfHour,
} from "../lib/clinic/googleCalendar";
import {
  extractBookingPrefs,
  detectBandQuestion,
  ANY_DOCTOR_PATTERN,
} from "../lib/clinic/booking";
import type { Doctor, Specialty, TimeBand } from "../lib/clinic/types";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const headers = { apikey: key, Authorization: `Bearer ${key}` };

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// ─── Datos reales ────────────────────────────────────────────────────────────

const [docsRes, specsRes] = await Promise.all([
  fetch(`${url}/rest/v1/clinic_doctors?select=*&is_active=eq.true&order=sort_order`, { headers }),
  fetch(`${url}/rest/v1/clinic_specialties?select=*&is_active=eq.true&order=sort_order`, { headers }),
]);

// Mismo mapeo que lib/clinic/data.ts:mapDoctor
const doctors: Doctor[] = ((await docsRes.json()) as any[]).map((row) => ({
  id: String(row.id),
  specialtyId: String(row.specialty_id),
  name: String(row.name ?? ""),
  googleCalendarId: row.google_calendar_id ?? null,
  consultationPrice: row.consultation_price != null ? Number(row.consultation_price) : null,
  slotMinutes: Number(row.slot_minutes ?? 30),
  workDays: Array.isArray(row.work_days) ? row.work_days.map(Number) : [1, 2, 3, 4, 5],
  workHours:
    Array.isArray(row.work_hours) && row.work_hours.length
      ? row.work_hours.map((h: any) => String(h).slice(0, 5))
      : null,
  workStart: String(row.work_start ?? "09:00").slice(0, 5),
  workEnd: String(row.work_end ?? "17:00").slice(0, 5),
  timezone: String(row.timezone ?? "America/La_Paz"),
}));

const specialties: Specialty[] = ((await specsRes.json()) as any[]).map((row) => ({
  id: String(row.id),
  name: String(row.name),
  slug: String(row.slug),
  description: row.description ?? null,
  sortOrder: Number(row.sort_order ?? 0),
}));

const specName = (id: string | null | undefined) =>
  specialties.find((s) => s.id === id)?.name ?? "(ninguna)";

console.log(`\nPlantel: ${doctors.length} médicos activos, ${specialties.length} especialidades\n`);

// ─── 1. Reconocedores baratos (sin red) ─────────────────────────────────────

console.log("1) detectBandQuestion / ANY_DOCTOR_PATTERN");

const bandCases: Array<[string, TimeBand | null]> = [
  ["¿quién atiende en la mañana?", "morning"],
  ["prefiero por la tarde", "afternoon"],
  ["algo por la noche", "evening"],
  ["quiero para mañana", null], // "mañana" = el día, NO la franja
  ["el doctor 2", null],
];
for (const [text, expected] of bandCases) {
  const got = detectBandQuestion(text);
  check(got === expected, `"${text}" → ${got ?? "null"}`, got === expected ? "" : `esperaba ${expected ?? "null"}`);
}

const anyCases: Array<[string, boolean]> = [
  ["cualquiera", true],
  ["el que sea, lo antes posible", true],
  ["me da igual", true],
  ["con la doctora Rodríguez", false],
  ["el 1", false],
];
for (const [text, expected] of anyCases) {
  const got = ANY_DOCTOR_PATTERN.test(text);
  check(got === expected, `"${text}" → anyDoctor=${got}`);
}

// ─── 2. Franjas del plantel real ────────────────────────────────────────────

console.log("\n2) doctorWorksInTimeBand sobre el plantel real");

for (const band of ["morning", "afternoon", "evening"] as TimeBand[]) {
  const who = doctors.filter((d) => doctorWorksInTimeBand(d, band));
  console.log(`  ${band}: ${who.length ? who.map((d) => d.name).join(", ") : "(nadie)"}`);
}

// Coherencia: si atiende en una franja, computeAvailableSlots con esa franja
// debe devolverle turnos (calendario vacío); si no, debe devolver cero.
console.log("\n3) computeAvailableSlots(timeBand) coherente con el horario del médico");

for (const doctor of doctors) {
  for (const band of ["morning", "afternoon", "evening"] as TimeBand[]) {
    const slots = computeAvailableSlots({
      doctor,
      busy: [],
      daysAhead: 13,
      maxSlots: 50,
      timeBand: band,
    });
    const works = doctorWorksInTimeBand(doctor, band);
    check(
      works === slots.length > 0,
      `${doctor.name} / ${band}: trabaja=${works}, turnos=${slots.length}`,
    );

    // Ningún turno fuera de la franja, y ninguno fuera de sus work_hours.
    const hhmm = new Intl.DateTimeFormat("es-BO", {
      timeZone: doctor.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const outOfBand = slots.filter((s) => bandOfHour(Number(hhmm.format(new Date(s.start)).slice(0, 2))) !== band);
    if (outOfBand.length) {
      check(false, `${doctor.name} / ${band}: ${outOfBand.length} turnos fuera de la franja`);
    }
    if (doctor.workHours?.length) {
      const allowed = new Set(doctor.workHours);
      const outOfHours = slots.filter((s) => !allowed.has(hhmm.format(new Date(s.start))));
      if (outOfHours.length) {
        check(false, `${doctor.name} / ${band}: ${outOfHours.length} turnos fuera de work_hours`);
      }
    }
  }
}

// ─── 3. Extractor con OpenAI (las frases del brief) ─────────────────────────

console.log("\n4) extractBookingPrefs (llamadas reales a OpenAI)");

type Expect = { specialtySlug?: string | null; timeBand?: TimeBand | null; anyDoctor?: boolean };
const cases: Array<[string, Expect]> = [
  ["me duele la barriga, ¿qué especialidad necesito?", { specialtySlug: "medicina-general" }],
  ["quiero pediatría el jueves por la tarde", { timeBand: "afternoon", anyDoctor: false }],
  ["necesito una cita lo más pronto posible, con quien sea", { anyDoctor: true }],
  ["¿quién atiende en la mañana?", { timeBand: "morning" }],
  // Regresión: sin pistas, el flujo lineal de siempre.
  ["quiero una cita", { specialtySlug: null, timeBand: null, anyDoctor: false }],
  // Regresión: pregunta general → no debe inventar una especialidad.
  ["¿dónde están ubicados?", { specialtySlug: null }],
];

for (const [text, expected] of cases) {
  const prefs = await extractBookingPrefs(text, specialties);
  const slug = prefs.specialtyId
    ? specialties.find((s) => s.id === prefs.specialtyId)?.slug ?? null
    : null;

  console.log(`\n  "${text}"`);
  console.log(`    → especialidad=${specName(prefs.specialtyId)} franja=${prefs.timeBand ?? "—"} anyDoctor=${prefs.anyDoctor}`);

  if (expected.specialtySlug !== undefined) {
    check(slug === expected.specialtySlug, `especialidad = ${expected.specialtySlug ?? "null"}`, `dio ${slug ?? "null"}`);
  }
  if (expected.timeBand !== undefined) {
    check(prefs.timeBand === expected.timeBand, `franja = ${expected.timeBand ?? "null"}`, `dio ${prefs.timeBand ?? "null"}`);
  }
  if (expected.anyDoctor !== undefined) {
    check(prefs.anyDoctor === expected.anyDoctor, `anyDoctor = ${expected.anyDoctor}`, `dio ${prefs.anyDoctor}`);
  }
}

console.log(failures ? `\n❌ ${failures} verificaciones fallaron\n` : "\n✅ Todo en orden\n");
process.exit(failures ? 1 : 0);
