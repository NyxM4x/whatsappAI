// ============================================================================
// Integración Google Calendar (service account, server-to-server).
// ----------------------------------------------------------------------------
// - Autenticación con una cuenta de servicio cuyo JSON está en la env var
//   GOOGLE_SERVICE_ACCOUNT_JSON (el contenido completo del archivo .json).
// - Cada doctor tiene su google_calendar_id, compartido con el email de la
//   cuenta de servicio con permiso "Hacer cambios en los eventos".
// - getBusyIntervals: huecos OCUPADOS del calendario (FreeBusy API).
// - computeAvailableSlots: cruza el horario laboral del doctor con lo ocupado
//   y devuelve los huecos LIBRES.
// - createAppointmentEvent: crea el evento de la cita en el calendario.
// ============================================================================

import { google } from "googleapis";
import type { Doctor, TimeSlot, TimeBand, DoctorWorkSchedule } from "@/lib/clinic/types";

const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];

function getServiceAccountCredentials(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing client_email/private_key");
  }

  return {
    client_email: parsed.client_email,
    // Las env vars suelen guardar el salto de línea escapado como \n.
    private_key: String(parsed.private_key).replace(/\\n/g, "\n"),
  };
}

function getCalendarClient() {
  const creds = getServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: CALENDAR_SCOPES,
  });
  return google.calendar({ version: "v3", auth });
}

// Huecos OCUPADOS de un calendario entre timeMin y timeMax (ISO UTC).
export async function getBusyIntervals(
  calendarId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<TimeSlot[]> {
  const calendar = getCalendarClient();

  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      items: [{ id: calendarId }],
    },
  });

  const busy = data.calendars?.[calendarId]?.busy ?? [];
  return busy
    .filter((b): b is { start: string; end: string } => Boolean(b.start && b.end))
    .map((b) => ({ start: b.start, end: b.end }));
}

// --- Helpers de zona horaria (sin librerías externas) ----------------------

// Cuántos ms está adelantada la zona respecto a UTC en ese instante (maneja DST).
function tzOffsetMs(timeZone: string, date: Date): number {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(date.toLocaleString("en-US", { timeZone }));
  return local.getTime() - utc.getTime();
}

// Convierte una hora "de pared" (Y-M-D H:M en la zona del doctor) al instante UTC.
function zonedWallTimeToUtc(
  timeZone: string,
  year: number,
  month1to12: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guessUtc = Date.UTC(year, month1to12 - 1, day, hour, minute, 0);
  const offset = tzOffsetMs(timeZone, new Date(guessUtc));
  return new Date(guessUtc - offset);
}

// Componentes de fecha (año/mes/día/diaSemana) de un instante, en una zona dada.
function datetimePartsInZone(timeZone: string, date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday as string] ?? 0,
  };
}

function parseHHMM(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":").map((n) => Number(n));
  return { hour: h || 0, minute: m || 0 };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// --- Franjas del día -------------------------------------------------------

// A qué franja pertenece una hora de pared (0-23).
export function bandOfHour(hour: number): TimeBand {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

export const BAND_LABELS: Record<TimeBand, string> = {
  morning: "por la mañana",
  afternoon: "por la tarde",
  evening: "por la noche",
};

export function doctorWorksOnDate(doctor: Doctor, date: Date): boolean {
  const { weekday } = datetimePartsInZone(doctor.timezone || "America/La_Paz", date);
  if (doctor.workSchedules?.length) {
    const previousWeekday = (weekday + 6) % 7;
    return doctor.workSchedules.some((schedule) =>
      schedule.weekday === weekday || (schedule.endsNextDay && schedule.weekday === previousWeekday),
    );
  }
  return doctor.workDays.includes(weekday);
}

// ¿El doctor atiende en esa franja? Lee SOLO su fila (workHours, o
// workStart/workEnd como fallback) — cero llamadas a Google Calendar. Sirve
// para responder "¿quién atiende en la mañana?" sin consultar disponibilidad.
//
// Ojo: dice si el doctor TRABAJA en esa franja, no si tiene huecos libres.
// Para lo segundo hay que pasar por computeAvailableSlots con timeBand.
export function doctorWorksInTimeBand(doctor: Doctor, band: TimeBand): boolean {
  if (doctor.workSchedules?.length) {
    return doctor.workSchedules.some((schedule) => {
      const start = parseHHMM(schedule.startTime).hour;
      const end = parseHHMM(schedule.endTime).hour;
      return bandOfHour(start) === band || (schedule.endsNextDay && bandOfHour(0) === band) || bandOfHour(Math.max(start, end - 1)) === band;
    });
  }
  // Franja continua: basta con que algún slot entero caiga dentro de la banda.
  const { hour: startH, minute: startM } = parseHHMM(doctor.workStart);
  const { hour: endH, minute: endM } = parseHHMM(doctor.workEnd);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  for (let m = startMin; m + doctor.slotMinutes <= endMin; m += doctor.slotMinutes) {
    if (bandOfHour(Math.floor(m / 60)) === band) return true;
  }
  return false;
}

// Calcula los huecos LIBRES de un doctor: recorre cada día laborable desde
// `fromDate` hasta `daysAhead` días, genera los slots del día y descarta los
// que se solapan con lo ocupado o ya pasaron.
//
// Un doctor define su día mediante workStart/workEnd: la franja completa se
// divide en intervalos de slotMinutes. workHours se conserva por compatibilidad
// con filas antiguas, pero ya no decide la disponibilidad de la clínica.
//
// `excludeSlots`: slots ya reservados en BD (hold, awaiting_payment, payment_review,
// confirmed) que aún no tienen evento en Calendar, para no ofrecerlos.
//
// `timeBand`: si viene, descarta los slots fuera de esa franja (el paciente pidió
// "en la mañana"). Sin él, el comportamiento es idéntico al de siempre.
export function computeAvailableSlots(params: {
  doctor: Doctor;
  busy: TimeSlot[];
  excludeSlots?: TimeSlot[];
  fromDate?: Date;
  daysAhead?: number;
  maxSlots?: number;
  now?: Date;
  timeBand?: TimeBand | null;
}): TimeSlot[] {
  const { doctor } = params;
  const now = params.now ?? new Date();
  const fromDate = params.fromDate ?? now;
  const daysAhead = params.daysAhead ?? 14;
  const maxSlots = params.maxSlots ?? 20;
  const timeBand = params.timeBand ?? null;
  const tz = doctor.timezone || "America/La_Paz";

  const allBusy = [...(params.busy ?? []), ...(params.excludeSlots ?? [])];
  const busyMs = allBusy.map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const { hour: startH, minute: startM } = parseHHMM(doctor.workStart);
  const { hour: endH, minute: endM } = parseHHMM(doctor.workEnd);
  const stepMs = doctor.slotMinutes * 60 * 1000;
  const slots: TimeSlot[] = [];

  for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset++) {
    const cursor = new Date(fromDate.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const { year, month, day, weekday } = datetimePartsInZone(tz, cursor);

    if (!doctor.workSchedules?.length && !doctor.workDays.includes(weekday)) continue;

    // Inicios de slot del día, en orden cronológico. Se lleva la hora de pared
    // junto al instante UTC para poder filtrar por franja sin reconvertir.
    let dayStarts: Array<{ ms: number; hour: number }> = [];
    const schedules: DoctorWorkSchedule[] = doctor.workSchedules?.length
      ? doctor.workSchedules
      : [{ weekday, startTime: doctor.workStart, endTime: doctor.workEnd, endsNextDay: false }];
    const previousWeekday = (weekday + 6) % 7;
    const previousCursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    const nextCursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    const nextParts = datetimePartsInZone(tz, nextCursor);

    for (const schedule of schedules) {
      const start = parseHHMM(schedule.startTime);
      const end = parseHHMM(schedule.endTime);
      let rangeStart: number;
      let rangeEnd: number;
      let firstMinute: number;
      if (schedule.weekday === weekday) {
        rangeStart = zonedWallTimeToUtc(tz, year, month, day, start.hour, start.minute).getTime();
        const endDate = schedule.endsNextDay ? nextParts : { year, month, day };
        rangeEnd = zonedWallTimeToUtc(tz, endDate.year, endDate.month, endDate.day, end.hour, end.minute).getTime();
        firstMinute = start.hour * 60 + start.minute;
      } else if (schedule.weekday === previousWeekday && schedule.endsNextDay) {
        rangeStart = zonedWallTimeToUtc(tz, year, month, day, 0, 0).getTime();
        rangeEnd = zonedWallTimeToUtc(tz, year, month, day, end.hour, end.minute).getTime();
        firstMinute = 0;
      } else {
        continue;
      }
      for (let s = rangeStart, i = 0; s + stepMs <= rangeEnd; s += stepMs, i++) {
        const wallHour = Math.floor((firstMinute + i * doctor.slotMinutes) / 60) % 24;
        dayStarts.push({ ms: s, hour: wallHour });
      }
    }
    dayStarts.sort((a, b) => a.ms - b.ms);

    for (const { ms: slotStart, hour } of dayStarts) {
      const slotEnd = slotStart + stepMs;

      if (timeBand && bandOfHour(hour) !== timeBand) continue;

      // Descarta lo que ya pasó (con 1h de margen para coordinar).
      if (slotStart <= now.getTime() + 60 * 60 * 1000) continue;

      const isBusy = busyMs.some((b) => overlaps(slotStart, slotEnd, b.start, b.end));
      if (isBusy) continue;

      slots.push({
        start: new Date(slotStart).toISOString(),
        end: new Date(slotEnd).toISOString(),
      });

      if (slots.length >= maxSlots) return slots;
    }
  }

  return slots;
}

// Crea el evento de la cita en el calendario del doctor. Devuelve el event id.
export async function createAppointmentEvent(params: {
  calendarId: string;
  timezone: string;
  startIso: string;
  endIso: string;
  summary: string;
  description?: string;
}): Promise<string | null> {
  const calendar = getCalendarClient();

  const { data } = await calendar.events.insert({
    calendarId: params.calendarId,
    requestBody: {
      summary: params.summary,
      description: params.description,
      start: { dateTime: params.startIso, timeZone: params.timezone },
      end: { dateTime: params.endIso, timeZone: params.timezone },
    },
  });

  return data.id ?? null;
}

// Elimina un evento del calendario (al cancelar o reprogramar una cita).
export async function deleteAppointmentEvent(
  calendarId: string,
  eventId: string,
): Promise<void> {
  const calendar = getCalendarClient();
  try {
    await calendar.events.delete({ calendarId, eventId });
  } catch (err: any) {
    // 410 Gone = ya fue borrado; se ignora.
    if (err?.code !== 410) throw err;
  }
}
