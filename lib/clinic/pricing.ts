// ============================================================================
// TARIFAS DE CONSULTA — por especialidad, día y hora
// ----------------------------------------------------------------------------
// El bot ya no agenda (ver lib/clinic/leads.ts): recopila la solicitud y le
// informa al paciente cuánto cuesta la consulta en el horario que pidió. Por
// eso el precio es por ESPECIALIDAD y no por médico (clinic_doctor_price_rules
// queda solo para el flujo de agenda anterior).
//
// Fuente: tarifario del sistema de la clínica (CSMDP-RptServicio.xls) aplicado
// sobre las franjas que confirmó el cliente el 2026-09-15:
//   - En la hora de corte rige la tarifa de DESPUÉS (a las 19:00 ya es noche).
//   - La noche va de 19:00 a 07:00: de 00:00 a 07:00 se cobra la tarifa
//     nocturna del día anterior.
//   - Feriados: no se cotizan. La enfermera marca el día en el panel
//     (clinic_settings.holiday_date) y el bot solo avisa que los precios cambian.
// Donde el Excel no trae tarifa se conserva la que ya cobraba el sistema
// (pediatría L-V noche y sábado de día, ginecología fin de semana).
//
// Reconsulta: gratis dentro de N días calendario desde la consulta, SOLO en las
// especialidades con reconsultaDays. En las demás el bot no la menciona.
// ============================================================================

export type PriceRule = {
  weekdays: number[]; // 0=domingo … 6=sábado
  from: string;       // "HH:MM", inclusive
  to: string;         // "HH:MM", exclusive ("24:00" = fin del día)
  price: number;
};

export type ConsultationSpecialty = {
  key: string;            // igual que clinic_specialties.slug cuando existe
  name: string;           // cómo se le nombra al paciente
  price: number;          // precio base: el único si no hay reglas por franja
  rules?: PriceRule[];
  scheduleNote?: string;  // franjas en texto, para el prompt y el resumen
  reconsultaDays?: number;
  // Cómo la nombra la gente por WhatsApp. Sirve para reconocer la especialidad
  // sin depender del criterio del modelo: ver matchSpecialtyText(). No hace
  // falta listar el nombre ni la clave, que ya se comparan solos.
  aliases?: string[];
};

const MON_FRI = [1, 2, 3, 4, 5];
const NIGHT_STARTS_AT = "19:00";
const NIGHT_ENDS_AT = "07:00";

export const CONSULTATION_SPECIALTIES: ConsultationSpecialty[] = [
  {
    key: "medicina-general",
    name: "Medicina General",
    price: 60,
    rules: [
      { weekdays: MON_FRI, from: "07:00", to: "19:00", price: 60 },
      { weekdays: MON_FRI, from: "19:00", to: "24:00", price: 80 },
      { weekdays: [6], from: "07:00", to: "12:00", price: 60 },
      { weekdays: [6], from: "12:00", to: "24:00", price: 80 },
      { weekdays: [0], from: "07:00", to: "24:00", price: 80 },
    ],
    scheduleNote:
      "60 Bs de lunes a viernes de 7:00 a 19:00 y sábado de 7:00 a 12:00; 80 Bs de noche (19:00 a 7:00), sábado desde las 12:00 y domingo",
    reconsultaDays: 7,
    aliases: ["medico general", "medica general", "general", "medicina", "clinico", "medico clinico", "consulta general"],
  },
  {
    key: "pediatria",
    name: "Pediatría",
    price: 80,
    rules: [
      { weekdays: MON_FRI, from: "07:00", to: "24:00", price: 80 },
      { weekdays: [6], from: "07:00", to: "19:00", price: 120 },
      { weekdays: [6], from: "19:00", to: "24:00", price: 100 },
      { weekdays: [0], from: "07:00", to: "24:00", price: 120 },
    ],
    scheduleNote: "80 Bs de lunes a viernes; sábado 120 Bs hasta las 19:00 y 100 Bs desde las 19:00; domingo 120 Bs",
    reconsultaDays: 3,
    aliases: ["pediatra", "pediatr", "medico de niños", "doctor de niños", "para mi bebe", "para mi niño", "para mi niña"],
  },
  {
    key: "ginecologia",
    name: "Ginecología",
    price: 80,
    rules: [
      { weekdays: MON_FRI, from: "07:00", to: "24:00", price: 80 },
      { weekdays: [0, 6], from: "07:00", to: "24:00", price: 120 },
    ],
    scheduleNote: "80 Bs de lunes a viernes; sábado y domingo 120 Bs",
    reconsultaDays: 3,
    aliases: ["ginecologo", "ginecologa", "ginecolog", "gineco", "obstetra", "obstetricia"],
  },
  // Especialidades con precio en el tarifario de la clínica: precio único.
  { key: "cardiologia", name: "Cardiología", price: 150, aliases: ["cardiologo", "cardiologa", "cardiolog", "del corazon"] },
  { key: "cirugia-general", name: "Cirugía General", price: 150, aliases: ["cirujano", "cirujano general", "cirugia"] },
  { key: "cirugia-pediatrica", name: "Cirugía Pediátrica", price: 150, aliases: ["cirujano pediatra", "cirugia de niños"] },
  { key: "cirugia-plastica", name: "Cirugía Plástica", price: 350, aliases: ["cirujano plastico", "cirugia estetica"] },
  { key: "coloproctologia", name: "Coloproctología", price: 150, aliases: ["coloproctologo", "proctologo", "proctologia"] },
  { key: "diabetologia", name: "Diabetología", price: 200, aliases: ["diabetologo", "diabetes", "para la diabetes"] },
  { key: "endocrinologia", name: "Endocrinología", price: 250, aliases: ["endocrinologo", "endocrinologa", "endocrinolog", "tiroides"] },
  { key: "gastroenterologia", name: "Gastroenterología", price: 170, aliases: ["gastroenterologo", "gastro", "gastroenterolog"] },
  { key: "medicina-interna", name: "Medicina Interna", price: 370, aliases: ["internista", "medico internista"] },
  { key: "nefrologia", name: "Nefrología", price: 350, aliases: ["nefrologo", "nefrolog", "del riñon", "de los riñones"] },
  { key: "neumologia", name: "Neumología", price: 350, aliases: ["neumologo", "neumolog", "del pulmon", "de los pulmones"] },
  { key: "neurologia", name: "Neurología", price: 320, aliases: ["neurologo", "neurologa", "neurolog"] },
  { key: "psicologia", name: "Psicología", price: 250, aliases: ["psicologo", "psicologa", "psicolog", "terapia psicologica"] },
  { key: "reumatologia", name: "Reumatología", price: 200, aliases: ["reumatologo", "reumatolog", "reuma"] },
  { key: "traumatologia", name: "Traumatología", price: 250, aliases: ["traumatologo", "traumatolog", "traumato", "ortopedia", "ortopedista", "de huesos"] },
  { key: "urologia", name: "Urología", price: 150, aliases: ["urologo", "urolog", "urologa"] },
];

const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export function findSpecialty(key?: string | null): ConsultationSpecialty | null {
  if (!key) return null;
  return CONSULTATION_SPECIALTIES.find((s) => s.key === key) ?? null;
}

// ─── Reconocer la especialidad en un texto ───────────────────────────────────

// Minúsculas, sin tildes, guiones por espacios: "Ginecología" y "ginecologia"
// y "medicina-general" y "medicina general" tienen que converger.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// La raíz que comparten las formas de una misma especialidad: "ginecologia" y
// "ginecologo" comparten "ginecolog"; "pediatria" y "pediatra", "pediatr".
function stem(word: string): string {
  return word.replace(/(ia|ía|ica|o|a)$/, "");
}

// ¿Qué especialidad de la lista nombra este texto? Compara contra la clave, el
// nombre y los alias, y como último recurso contra la raíz de la primera
// palabra del nombre.
//
// Existe porque el modelo no es de fiar para esto: con la regla de "pedí algo
// que no ofrecemos" encima, llegó a marcar "necesito un ginecologo" como
// especialidad ausente. Reconocer un nombre contra una lista cerrada es
// comparación de strings, no criterio: se hace acá y no se le pregunta a nadie.
export function matchSpecialtyText(text?: string | null): ConsultationSpecialty | null {
  if (!text) return null;
  const haystack = normalize(text);
  if (!haystack) return null;

  let best: ConsultationSpecialty | null = null;
  let bestLength = 0;

  for (const spec of CONSULTATION_SPECIALTIES) {
    const needles = [spec.name, spec.key, ...(spec.aliases ?? [])].map(normalize);
    // La raíz del nombre ("ginecolog" de "ginecologia") atrapa las formas que
    // no están listadas como alias.
    const root = stem(normalize(spec.name).split(" ")[0]);
    if (root.length >= 6) needles.push(root);

    for (const needle of needles) {
      // Las muy cortas ("gastro", "reuma") se exigen como palabra suelta; el
      // resto puede ir dentro de la frase ("necesito un ginecologo").
      const hit =
        needle.length <= 6
          ? new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack)
          : haystack.includes(needle);
      if (hit && needle.length > bestLength) {
        best = spec;
        bestLength = needle.length;
      }
    }
  }

  return best;
}

// ─── Fechas en la zona de la clínica ─────────────────────────────────────────

// "YYYY-MM-DD" del instante en la timezone dada (en-CA formatea así).
export function localDateISO(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Día de la semana de una fecha de calendario "YYYY-MM-DD" (mediodía UTC para
// que ningún corrimiento de zona la mueva de día).
export function weekdayOfDate(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

export function localNow(timezone: string, now: Date = new Date()) {
  const date = localDateISO(now, timezone);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now).replace(/^24:/, "00:");
  const weekday = weekdayOfDate(date);
  return { date, hhmm, weekday, dayName: DAY_NAMES[weekday] };
}

export function isHolidayToday(holidayDate: string | null | undefined, timezone: string, now: Date = new Date()): boolean {
  return Boolean(holidayDate) && holidayDate === localDateISO(now, timezone);
}

// ─── Cálculo de precio ───────────────────────────────────────────────────────

function formatHour(hhmm: string): string {
  return hhmm.replace(/^0(\d)/, "$1");
}

export function priceAt(spec: ConsultationSpecialty, weekday: number, hhmm: string): number {
  if (!spec.rules?.length) return spec.price;
  let day = weekday;
  let time = hhmm;
  // La madrugada pertenece a la noche que empezó el día anterior.
  if (time < NIGHT_ENDS_AT) {
    day = (weekday + 6) % 7;
    time = "23:59";
  }
  const rule = spec.rules.find((r) => r.weekdays.includes(day) && r.from <= time && time < r.to);
  return rule?.price ?? spec.price;
}

// Tramos de precio de un día, fusionando los contiguos con el mismo monto:
// "60 Bs de 7:00 a 19:00 · 80 Bs desde las 19:00".
export function describeDayPrices(spec: ConsultationSpecialty, weekday: number): string {
  const rules = (spec.rules ?? [])
    .filter((r) => r.weekdays.includes(weekday))
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!rules.length) return `${spec.price} Bs`;

  const merged: { from: string; to: string; price: number }[] = [];
  for (const r of rules) {
    const last = merged[merged.length - 1];
    if (last && last.price === r.price && last.to === r.from) last.to = r.to;
    else merged.push({ from: r.from, to: r.to, price: r.price });
  }
  if (merged.length === 1) return `${merged[0].price} Bs`;

  return merged
    .map((m, i) =>
      i === merged.length - 1
        ? `${m.price} Bs desde las ${formatHour(m.from)}`
        : `${m.price} Bs de ${formatHour(m.from)} a ${formatHour(m.to)}`,
    )
    .join(" · ");
}

export type ConsultationQuote = {
  kind: "holiday" | "exact" | "day" | "general";
  text: string;
  price?: number;
};

// Cotización para el resumen de la solicitud:
//   feriado hoy (y pide hoy o no se sabe el día) → no hay precio
//   día + hora → precio exacto · solo día → tramos de ese día · nada → franjas generales
export function quoteConsultation(params: {
  spec: ConsultationSpecialty;
  date?: string | null;
  hour?: string | null;
  holidayDate?: string | null;
  timezone: string;
  now?: Date;
}): ConsultationQuote {
  const { spec, date, hour, holidayDate, timezone } = params;
  const today = localDateISO(params.now ?? new Date(), timezone);

  if (holidayDate && holidayDate === today && (!date || date === today)) {
    return { kind: "holiday", text: "Hoy es *feriado* y los precios de la consulta cambian: el asesor le confirma el monto." };
  }
  if (date && hour) {
    const price = priceAt(spec, weekdayOfDate(date), hour);
    return { kind: "exact", price, text: `${price} Bs` };
  }
  if (date) {
    const weekday = weekdayOfDate(date);
    return { kind: "day", text: `${describeDayPrices(spec, weekday)} (${DAY_NAMES[weekday]})` };
  }
  return { kind: "general", text: spec.scheduleNote ?? `${spec.price} Bs` };
}

// Bloque del system prompt con precios de consulta, reconsulta y feriado.
export function buildConsultationPricingBlock(holidayToday: boolean): string {
  const withReconsulta = CONSULTATION_SPECIALTIES.filter((s) => s.reconsultaDays);
  const lines = [
    `PRECIOS DE CONSULTA POR ESPECIALIDAD (cítalos tal cual; a las ${NIGHT_STARTS_AT} en punto ya rige la tarifa de noche, que dura hasta las ${NIGHT_ENDS_AT} del día siguiente):`,
    ...CONSULTATION_SPECIALTIES.map((s) => `- ${s.name}: ${s.scheduleNote ?? `${s.price} Bs`}`),
    "",
    `RECONSULTA: es gratis dentro de los días calendario siguientes a la consulta, contando desde el día de la consulta: ${withReconsulta
      .map((s) => `${s.name} ${s.reconsultaDays} días`)
      .join(", ")}. Solo si preguntan qué pasa fuera de ese plazo, decí que se cobra como consulta nueva. En las demás especialidades no menciones la reconsulta.`,
  ];
  if (holidayToday) {
    lines.push(
      "",
      "HOY ES FERIADO: los precios cambian. No des ningún precio para hoy (ni de consultas ni de servicios): decí que hoy es feriado, que los precios cambian y que un asesor le confirma el monto.",
    );
  }
  return lines.join("\n");
}
