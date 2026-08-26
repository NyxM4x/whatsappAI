import assert from "node:assert/strict";
import { computeAvailableSlots } from "../lib/clinic/googleCalendar";
import type { Doctor } from "../lib/clinic/types";

const base: Omit<Doctor, "name" | "workSchedules"> = {
  id: "doctor",
  specialtyId: "general",
  googleCalendarId: "calendar",
  consultationPrice: 60,
  slotMinutes: 30,
  workDays: [],
  workHours: null,
  workStart: "00:00",
  workEnd: "23:59",
  timezone: "America/La_Paz",
};

const doctor = (name: string, workSchedules: Doctor["workSchedules"]): Doctor => ({
  ...base,
  name,
  workSchedules,
});

const now = new Date("2026-08-26T19:00:00.000Z"); // 15:00 in Bolivia
const slotsFor = (d: Doctor) => computeAvailableSlots({ doctor: d, busy: [], fromDate: now, daysAhead: 0, now, maxSlots: 20 });
const localHours = (d: Doctor) => slotsFor(d).map((slot) => new Intl.DateTimeFormat("en-GB", {
  timeZone: d.timezone,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date(slot.start)));

const salinas = doctor("Dr. Octavio Salinas Gallegos", [
  { weekday: 3, startTime: "07:00", endTime: "07:00", endsNextDay: true },
  { weekday: 6, startTime: "14:00", endTime: "07:00", endsNextDay: true },
]);
const rivera = doctor("Dr. Luis Jaime Rivera Porcel", [
  { weekday: 2, startTime: "07:00", endTime: "07:00", endsNextDay: true },
  { weekday: 4, startTime: "07:00", endTime: "19:00", endsNextDay: false },
]);

assert.ok(localHours(salinas).includes("17:00"));
assert.equal(localHours(rivera).length, 0);
console.log("doctor daily schedule tests passed");
