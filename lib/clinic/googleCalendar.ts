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
import type { Doctor, TimeSlot } from "@/lib/clinic/types";

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

// Calcula los huecos LIBRES de un doctor: recorre cada día laborable desde
// `fromDate` hasta `daysAhead` días, genera slots de slotMinutes dentro de su
// horario y descarta los que se solapan con lo ocupado o ya pasaron.
// `excludeSlots`: slots ya reservados en BD (hold, awaiting_payment, payment_review,
// confirmed) que aún no tienen evento en Calendar, para no ofrecerlos.
export function computeAvailableSlots(params: {
  doctor: Doctor;
  busy: TimeSlot[];
  excludeSlots?: TimeSlot[];
  fromDate?: Date;
  daysAhead?: number;
  maxSlots?: number;
  now?: Date;
}): TimeSlot[] {
  const { doctor } = params;
  const now = params.now ?? new Date();
  const fromDate = params.fromDate ?? now;
  const daysAhead = params.daysAhead ?? 14;
  const maxSlots = params.maxSlots ?? 20;
  const tz = doctor.timezone || "America/La_Paz";

  const allBusy = [...(params.busy ?? []), ...(params.excludeSlots ?? [])];
  const busyMs = allBusy.map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const { hour: startH, minute: startM } = parseHHMM(doctor.workStart);
  const { hour: endH, minute: endM } = parseHHMM(doctor.workEnd);

  const slots: TimeSlot[] = [];

  for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset++) {
    const cursor = new Date(fromDate.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const { year, month, day, weekday } = datetimePartsInZone(tz, cursor);

    if (!doctor.workDays.includes(weekday)) continue;

    const dayStart = zonedWallTimeToUtc(tz, year, month, day, startH, startM).getTime();
    const dayEnd = zonedWallTimeToUtc(tz, year, month, day, endH, endM).getTime();
    const stepMs = doctor.slotMinutes * 60 * 1000;

    for (let slotStart = dayStart; slotStart + stepMs <= dayEnd; slotStart += stepMs) {
      const slotEnd = slotStart + stepMs;

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
