// ============================================================================
// FECHAS QUE DICE EL PACIENTE — resueltas por código, sin modelo
// ----------------------------------------------------------------------------
// Caso real 2026-09-25 (viernes): el paciente escribió "a qué hora atiende hoy
// sábado" y el resumen le confirmó "Horario que prefiere: hoy sábado". El
// modelo tenía la fecha correcta en el prompt, pero copió lo que decía el
// paciente sin contrastarlo.
//
// Pasar de "hoy", "mañana", "el lunes" o "20 de septiembre" a una fecha es
// aritmética de calendario, no criterio: se resuelve acá. Y cuando el paciente
// junta un día relativo con un día de la semana que no le corresponde ("hoy
// sábado" un viernes), no se adivina cuál de los dos quiso decir: se le
// pregunta.
// ============================================================================

import { weekdayOfDate } from "@/lib/clinic/pricing";

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// Minúsculas y sin tildes. La ñ también pierde la tilde ("mañana" → "manana"),
// así que los patrones de abajo aceptan las dos formas.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\bsetiembre\b/g, "septiembre")
    .replace(/\s+/g, " ");
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ─── Qué dijo ────────────────────────────────────────────────────────────────

type Relative = { word: string; offset: number };

// "mañana" es el día siguiente SALVO que hable de la franja: "en la mañana",
// "por la mañana", "de la mañana", "a la mañana", "mañana temprano" sí es el
// día. "pasado mañana" va antes para que no lo atrape "mañana".
function findRelative(text: string): Relative | null {
  if (/\bpasado\s+ma[nñ]ana\b/.test(text)) return { word: "pasado mañana", offset: 2 };
  if (/\bhoy\b|\bahora\b|\bahorita\b|\besta\s+(?:ma[nñ]ana|tarde|noche)\b/.test(text)) return { word: "hoy", offset: 0 };
  const morning = /\b(?:en|por|de|a|esta|la)\s+(?:la\s+)?ma[nñ]ana\b/g;
  const withoutMorning = text.replace(morning, " ");
  if (/\bma[nñ]ana\b/.test(withoutMorning)) return { word: "mañana", offset: 1 };
  return null;
}

// Los días sin tilde, como quedan después de normalize().
const WEEKDAY_PATTERNS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

function findWeekday(text: string): number | null {
  const found = new Set<number>();
  WEEKDAY_PATTERNS.forEach((name, index) => {
    if (new RegExp(`\\b${name}\\b`).test(text)) found.add(index);
  });
  // Dos días distintos ("el lunes o el martes") no dan UN día: que lo lea el
  // asesor tal como lo escribió.
  return found.size === 1 ? [...found][0] : null;
}

// "20 de septiembre", "el 20", "20/09". Devuelve día y mes (mes null si solo
// dijo el número). Con guion no: "de 10-12" es una franja horaria.
function findDayOfMonth(text: string): { day: number; month: number | null; year: number | null } | null {
  const numeric = text.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{4}))?\b/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = numeric[3] ? Number(numeric[3]) : null;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return { day, month, year };
  }
  const named = text.match(new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${MONTHS.join("|")})(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`));
  if (named) return { day: Number(named[1]), month: MONTHS.indexOf(named[2]) + 1, year: named[3] ? Number(named[3]) : null };
  // "el 20", "para el 5", "el sábado 27": solo con artículo o día de la semana
  // delante, para no confundir "a las 10".
  const bare = text.match(/\b(?:el|del|para el|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(\d{1,2})\b(?!\s*(?::|hs?\b|horas?\b|de la (?:manana|tarde|noche)))/);
  if (bare) {
    const day = Number(bare[1]);
    if (day >= 1 && day <= 31) return { day, month: null, year: null };
  }
  return null;
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoOf(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// El próximo día del mes que coincide: si ya pasó este mes (o este año), el
// siguiente. Nadie pide ficha para una fecha pasada.
function nextDayOfMonth(today: string, day: number, month: number | null, explicitYear: number | null): string | null {
  const [year, currentMonth] = today.split("-").map(Number);
  if (month) {
    if (explicitYear !== null) {
      return isValidDate(explicitYear, month, day) ? isoOf(explicitYear, month, day) : null;
    }
    for (const y of [year, year + 1]) {
      if (!isValidDate(y, month, day)) continue;
      const iso = isoOf(y, month, day);
      if (iso >= today) return iso;
    }
    return null;
  }
  for (let i = 0; i < 3; i++) {
    const m = ((currentMonth - 1 + i) % 12) + 1;
    const y = year + Math.floor((currentMonth - 1 + i) / 12);
    if (!isValidDate(y, m, day)) continue;
    const iso = isoOf(y, m, day);
    if (iso >= today) return iso;
  }
  return null;
}

export type DateMention =
  | { kind: "none" }
  // Un día claro, calculado por código.
  | { kind: "date"; date: string }
  // Una fecha explícita que ya pasó: no se mueve al año siguiente sin permiso.
  // `date` es esa fecha tal cual la dijo ("YYYY-MM-DD", en el pasado).
  | { kind: "past"; said: string; date: string }
  // Dijo dos cosas que no calzan ("hoy sábado" un viernes): no se elige por él.
  | { kind: "conflict"; said: string; relativeDate: string; weekdayDate: string };

// Lee el día que menciona el texto. `today` es "YYYY-MM-DD" en hora de la
// clínica.
export function readDateMention(rawText: string, today: string): DateMention {
  const text = normalize(rawText);
  const relative = findRelative(text);
  const weekday = findWeekday(text);
  const dayOfMonth = findDayOfMonth(text);

  const relativeDate = relative ? addDays(today, relative.offset) : null;
  // "el sábado" es el próximo sábado; dicho un sábado, es hoy.
  const weekdayDate = weekday === null ? null : addDays(today, (weekday - weekdayOfDate(today) + 7) % 7);
  const monthDate = dayOfMonth ? nextDayOfMonth(today, dayOfMonth.day, dayOfMonth.month, dayOfMonth.year) : null;

  // Dos días que no calzan son un error del paciente solo si los dijo JUNTOS
  // ("hoy sábado", "mañana que es domingo", "el sábado 27"). Separados, uno
  // suele ser muletilla ("ahora quiero ficha para el sábado"): no se adivina
  // cuál vale y queda lo que entendió el modelo.
  if (relative && relativeDate && weekday !== null && weekdayOfDate(relativeDate) !== weekday) {
    const together = new RegExp(`\\b(?:hoy|ma[nñ]ana)\\s*,?\\s*(?:es\\s+|que\\s+es\\s+|seria\\s+)?${WEEKDAY_PATTERNS[weekday]}\\b`).test(text);
    if (!together) return { kind: "none" };
    return { kind: "conflict", said: `${relative.word} ${WEEKDAYS[weekday]}`, relativeDate, weekdayDate: weekdayDate! };
  }
  if (!relative && dayOfMonth?.month) {
    const [currentYear] = today.split("-").map(Number);
    const statedDate = isoOf(dayOfMonth.year ?? currentYear, dayOfMonth.month, dayOfMonth.day);
    if (isValidDate(dayOfMonth.year ?? currentYear, dayOfMonth.month, dayOfMonth.day) && statedDate < today) {
      const yearSuffix = dayOfMonth.year ? ` de ${dayOfMonth.year}` : "";
      return { kind: "past", said: `${dayOfMonth.day} de ${MONTHS[dayOfMonth.month - 1]}${yearSuffix}`, date: statedDate };
    }
  }
  if (monthDate && weekday !== null && weekdayOfDate(monthDate) !== weekday) {
    const together = new RegExp(`\\b${WEEKDAY_PATTERNS[weekday]}\\s+\\d{1,2}\\b`).test(text);
    if (!together) return { kind: "none" };
    return { kind: "conflict", said: `${WEEKDAYS[weekday]} ${dayOfMonth!.day}`, relativeDate: monthDate, weekdayDate: weekdayDate! };
  }

  const date = relativeDate ?? monthDate ?? weekdayDate;
  return date ? { kind: "date", date } : { kind: "none" };
}

// ─── Cómo se lo decimos ──────────────────────────────────────────────────────

// "viernes 25 de septiembre"
export function longDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${WEEKDAYS[weekdayOfDate(isoDate)]} ${day} de ${MONTHS[month - 1]}`;
}

// "sábado 26/09"
export function shortDayLabel(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${WEEKDAYS[weekdayOfDate(isoDate)]} ${day}/${month}`;
}

// "hoy viernes 25/09", "mañana sábado 26/09", "lunes 28/09"
export function dayLabel(isoDate: string, today: string): string {
  const base = shortDayLabel(isoDate);
  if (isoDate === today) return `hoy ${base}`;
  if (isoDate === addDays(today, 1)) return `mañana ${base}`;
  return base;
}

// La pregunta que se le hace ante un día que no calza. Siempre dice primero
// qué día es hoy: es lo que el paciente tenía mal.
export function dateConflictQuestion(mention: Extract<DateMention, { kind: "conflict" | "past" }>, today: string): string {
  if (mention.kind === "past") return `La fecha que indicó (*${mention.said}*) ya pasó. ¿Qué fecha quería indicar?`;
  const options = [...new Set([mention.relativeDate, mention.weekdayDate])]
    .sort()
    .map((date) => `*${dayLabel(date, today)}*`)
    .join(" o ");
  return `Una aclaración: hoy es *${longDate(today)}* 😊 ¿Su solicitud es para ${options}?`;
}

// Los próximos días con su fecha, para que el modelo no tenga que calcularlos:
// "sábado 26/09, domingo 27/09, …".
export function upcomingDays(today: string, count = 7): string {
  return Array.from({ length: count }, (_, i) => dayLabel(addDays(today, i + 1), today)).join(", ");
}
