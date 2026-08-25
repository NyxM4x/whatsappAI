// ============================================================================
// Verificación de horarios — qué turnos ofrece realmente cada médico.
// ----------------------------------------------------------------------------
// Lee clinic_doctors igual que el bot y corre computeAvailableSlots con el
// calendario vacío, para ver los horarios que se le ofrecerían al paciente.
// Sirve para confirmar que los médicos con work_hours ofrecen SOLO sus horas
// puntuales y ninguna intermedia.
//
//   npx tsx scripts/check-horarios.ts
// ============================================================================

import { readFileSync } from "node:fs";
import { computeAvailableSlots } from "../lib/clinic/googleCalendar";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const [docsRes, specsRes] = await Promise.all([
  fetch(`${url}/rest/v1/clinic_doctors?select=*&order=sort_order`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }),
  fetch(`${url}/rest/v1/clinic_specialties?select=id,slug`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }),
]);

const rows = (await docsRes.json()) as any[];
const specs = new Map((((await specsRes.json()) as any[]) ?? []).map((s) => [s.id, s.slug]));

// Mismo mapeo que lib/clinic/data.ts:mapDoctor
function mapDoctor(row: any) {
  return {
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
  };
}

const hhmm = new Intl.DateTimeFormat("es-BO", {
  timeZone: "America/La_Paz",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

let problemas = 0;

for (const row of rows) {
  const doctor = mapDoctor(row);
  const slots = computeAvailableSlots({ doctor, busy: [], daysAhead: 1, maxSlots: 60 });

  // Horas distintas ofrecidas (a lo largo de los 2 días mirados).
  const ofrecidas = [...new Set(slots.map((s) => hhmm.format(new Date(s.start))))].sort();
  const cargadas = doctor.workHours ?? [];
  const sobran = doctor.workHours ? ofrecidas.filter((h) => !cargadas.includes(h)) : [];

  console.log(`\n${doctor.name}  ·  ${specs.get(doctor.specialtyId)}  ·  ${doctor.consultationPrice} Bs`);
  console.log(`  cargadas: ${cargadas.length ? cargadas.join(" ") : `(rango ${doctor.workStart}-${doctor.workEnd})`}`);
  console.log(`  ofrece:   ${ofrecidas.join(" ") || "(ninguna)"}`);

  if (sobran.length) {
    console.log(`  ✗ OFRECE HORAS QUE NO ATIENDE: ${sobran.join(" ")}`);
    problemas++;
  } else if (doctor.workHours) {
    console.log(`  ✓ solo sus horas`);
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(problemas === 0 ? "✓ Todos los médicos ofrecen únicamente sus horas cargadas." : `✗ ${problemas} médico(s) con horarios incorrectos.`);
