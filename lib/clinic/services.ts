// ============================================================================
// CATÁLOGO DE SERVICIOS — tarifario cara al paciente
// ----------------------------------------------------------------------------
// Fuente de verdad: columna jsonb `services` de clinic_settings (migración
// 20260818000000). Este archivo tiene (a) el tipo, (b) la copia estática que
// usa el fallback de getClinicConfig() si Supabase falla, y (c) el matcher que
// detecta qué servicio menciona el paciente.
//
// Solo van ítems CARA AL PACIENTE. El tarifario original del cliente incluye
// costos internos (quirófano, honorarios de cirujano/ayudante, alquiler de
// consultorio) y el % que se lleva el médico: nada de eso entra acá, el bot no
// debe conocerlo ni poder citarlo.
//
// Las consultas por especialidad NO están acá: su precio depende del día y la
// hora y vive en lib/clinic/pricing.ts. Un servicio de este catálogo abre una
// solicitud de servicio (lib/clinic/leads.ts), salvo las emergencias, que solo
// se informan.
// ============================================================================

import { weekdayOfDate } from "@/lib/clinic/pricing";

export type ServiceCategory =
  | "emergencia"
  | "procedimiento"
  | "ecografia"
  | "enfermeria"
  | "certificado"
  | "obstetricia"
  | "internacion";

// Franja en que rige una promoción: 0=domingo … 6=sábado; "HH:MM", desde
// inclusive y hasta exclusive (igual que las tarifas de consulta).
export type PromoWindow = { weekdays: number[]; from: string; to: string };

// Promoción sobre un servicio. `price` del ítem se conserva como el precio
// regular: mientras la promo rige, el bot cotiza la promo y cuenta SU
// información (franja, requisitos) en lugar de la del servicio normal. Al
// vencer vuelve sola la de siempre: nadie tiene que acordarse de retirarla —
// la campaña del implante siguió cotizándose hasta que se borró a mano.
export type ServicePromo = {
  price: number;
  label: string;            // cómo se nombra al paciente ("promoción 50% de descuento")
  // Último día en que rige, "YYYY-MM-DD" en hora de la clínica. Cuenta el día
  // de la atención, no el del pedido: pedirla el 29 para el 2 no la alcanza.
  validUntil?: string;
  windows?: PromoWindow[];  // cuándo rige; sin franjas, a cualquier hora
  windowsText?: string;     // las franjas en palabras, para el paciente
  // Qué se cobra fuera de la franja, en feriado o con un médico que no entra
  // en la promo. Sin esto, fuera de la franja rige el precio regular.
  outside?: { price: number; label: string };
  // Preferencia de médico que saca de la promo (regex sin flags; se compara
  // sin distinguir mayúsculas), y cómo se le explica al paciente.
  outsideDoctorPattern?: string;
  outsideDoctorNote?: string;
  details?: string[];       // lo que se le cuenta al paciente al cotizar, una línea cada uno
  notes?: string[];         // solo para el Q&A: cómo responder las dudas de la campaña
  // Especialidad en cuyo resumen de ficha se menciona la promo en una línea.
  mentionWithSpecialty?: string;
};

export type ServiceItem = {
  name: string;
  price: number;      // precio base en Bs
  priceMax?: number;  // rangos del tarifario (ej. cesárea multigesta 3800/4200)
  promo?: ServicePromo;
  category: ServiceCategory;
  note?: string;      // "L-V", "Sáb/Dom", aclaraciones del tarifario
  aliases?: string[]; // cómo lo escribe la gente por WhatsApp
};

// Títulos de cada sección en el system prompt, en el orden en que se muestran.
export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  emergencia: "CONSULTAS DE EMERGENCIA",
  procedimiento: "PROCEDIMIENTOS",
  ecografia: "ECOGRAFÍAS",
  enfermeria: "ENFERMERÍA",
  certificado: "CERTIFICADOS",
  obstetricia: "PARTOS Y CESÁREAS",
  internacion: "INTERNACIÓN",
};

export const SERVICE_CATEGORY_ORDER: ServiceCategory[] = [
  "emergencia",
  "procedimiento",
  "ecografia",
  "enfermeria",
  "certificado",
  "obstetricia",
  "internacion",
];

export const defaultServices: ServiceItem[] = [
  // ── Consultas de emergencia (tarifario de la clínica) ─────────────────────
  // Se informan pero no abren una solicitud: la emergencia no espera a que un
  // asesor confirme un horario.
  { name: "Consulta de emergencia (medicina general)", price: 80, category: "emergencia", aliases: ["consulta de emergencia", "emergencia general"] },
  { name: "Consulta por accidente de tránsito", price: 150, category: "emergencia", aliases: ["transito", "accidente de transito", "certificado de transito", "examen de transito"] },
  { name: "Consulta ginecológica de emergencia a llamado", price: 200, category: "emergencia", aliases: ["ginecologia de emergencia", "emergencia ginecologica"] },
  { name: "Consulta de emergencia de cardiología", price: 200, category: "emergencia", aliases: ["emergencia cardiologica", "emergencia de cardiologia"] },
  { name: "Consulta de emergencia de cirugía", price: 250, category: "emergencia", aliases: ["emergencia de cirugia", "emergencia quirurgica"] },
  { name: "Consulta de emergencia de traumatología", price: 250, category: "emergencia", aliases: ["emergencia de traumatologia", "emergencia traumatologica"] },
  { name: "Consulta de emergencia de urología", price: 150, category: "emergencia", aliases: ["emergencia de urologia", "emergencia urologica"] },

  // ── Procedimientos ──────────────────────────────────────────────────────
  // Campaña de Facebook "PAPANICOLAO 50% DESCUENTO" (datos confirmados por la
  // clínica el 2026-09-21). Los 50 Bs cubren la toma y el análisis; leer el
  // resultado es una consulta de ginecología aparte, sin reconsulta gratis.
  //
  // Los alias con raíz ("papanicol") atrapan cómo lo escribe la gente:
  // papanicolau, papanicolao, papanicolado; los errores de tipeo que quedan
  // afuera ("papaniculau") los resuelve matchServiceTypo. Separado va con la
  // terminación completa: "papa nicol" suelto enganchaba "mi papá Nicolás". "Cuello
  // uterino" va solo con "examen/prueba/muestra" delante: suelto engancharía
  // "tengo cáncer de cuello uterino" y le mandaría la promo a quien no la pidió.
  {
    name: "Papanicolaou",
    price: 100,
    category: "procedimiento",
    aliases: [
      "papanicol", "papa nicolau", "papa nicolao", "papa nicolaou", "papanikol", "papinicol", "pananicol", "pap", "pap test", "citologia",
      "examen de cuello uterino", "examen del cuello uterino", "prueba de cuello uterino", "prueba del cuello uterino",
      "muestra de cuello uterino", "muestra del cuello uterino", "examen del cuello de la matriz", "examen de la matriz",
    ],
    promo: {
      price: 50,
      label: "promoción 50% de descuento",
      validUntil: "2026-09-30",
      windows: [
        { weekdays: [1, 2, 3, 4, 5], from: "08:00", to: "12:00" },
        { weekdays: [1, 2, 3, 4, 5], from: "14:00", to: "18:00" },
      ],
      windowsText: "de lunes a viernes de 8:00 a 12:00 y de 14:00 a 18:00",
      outside: { price: 200, label: "a llamado, como emergencia; incluye la toma y el análisis" },
      outsideDoctorPattern: "doctora|\\bdra\\b|mujer|medina|ginec[oó]loga",
      outsideDoctorNote: "con la ginecóloga (de lunes a viernes de 18:00 a 19:00) la promoción no aplica",
      details: [
        "🕗 *Lunes a viernes* de 8:00 a 12:00 y de 14:00 a 18:00. La promoción es solo de lunes a viernes: no aplica sábados, domingos ni feriados.",
        "🧪 Incluye la toma de muestra y el análisis en laboratorio. El resultado sale en 3 días.",
        "👨‍⚕️ No incluye la lectura del resultado: si desea que el ginecólogo se lo lea, es una consulta aparte de 80 Bs de lunes a viernes hasta las 18:00 (200 Bs desde las 18:00, fines de semana y feriados).",
        "✅ Para la toma: venga 7 días después de terminar su regla y sin sangrados, con al menos 2 días sin relaciones y al menos 3 días sin óvulos, cremas ni lavados vaginales.",
        "🪪 Traiga su carnet de identidad (o una foto del carnet).",
      ],
      notes: [
        "Fuera de la franja (de 12:00 a 14:00 o desde las 18:00), sábados, domingos y feriados —por ejemplo el 24 de septiembre, Día de Santa Cruz— el ginecólogo no está de turno: la toma es a llamado, como emergencia, 200 Bs, sin promoción (también incluye la toma y el análisis).",
        "La muestra la toman los ginecólogos de la clínica, que son varones. Si la paciente prefiere que la atienda una mujer, es con la ginecóloga, de lunes a viernes de 18:00 a 19:00, a llamado, y cuesta 200 Bs (sin promoción): decí siempre el monto y ese horario.",
        "El resultado sale en 3 días calendario y se le puede enviar por WhatsApp. Si pregunta si su resultado ya está, eso se lo confirma un asesor: no lo sabés.",
        "Leer el resultado siempre es una consulta de ginecología pagada: 80 Bs de lunes a viernes hasta las 18:00; 200 Bs desde las 18:00, fines de semana y feriados. Para esta lectura NO hay reconsulta gratis, aunque haya pasado por consulta.",
        "El PAP no es la prueba de VPH, ni la IVAA, ni la colposcopía, ni la biopsia: esos no entran en la promoción. Si los pide, tomale el pedido para que un asesor le confirme el precio.",
        "Dudas médicas (embarazo, edad, si le conviene, cada cuánto hacérselo, qué significa un resultado): no respondas con criterio propio. Decí con calidez que eso lo evalúa el ginecólogo en consulta.",
        "Contá los requisitos en positivo (\"venga 7 días después de terminar su regla\"), no como una lista de lo que no se hace.",
      ],
      mentionWithSpecialty: "ginecologia",
    },
  },
  { name: "Colocación de DIU", price: 150, category: "procedimiento", aliases: ["poner diu", "colocacion diu", "diu"] },
  { name: "Retiro de DIU", price: 100, category: "procedimiento", aliases: ["sacar diu", "sacar el diu", "quitar diu", "quitar el diu", "retirar el diu"] },
  // 480 Bs confirmado por el cliente el 2026-09-15 (terminó la campaña de 400).
  // Los alias NO incluyen genéricos ("anticonceptivo", "planificación
  // familiar"): engancharían preguntas sobre pastillas o inyectables, que la
  // clínica no ofrece, y abrirían una solicitud por nada.
  { name: "Colocación de implante subdérmico", price: 480, category: "procedimiento", aliases: ["poner implante", "implante anticonceptivo", "implante subdermico", "implante hormonal", "subdermico", "implante"] },
  { name: "Retiro de implante subdérmico", price: 100, category: "procedimiento", aliases: ["sacar implante", "sacar el implante", "quitar implante", "quitar el implante", "retirar el implante"] },
  { name: "Cirugía menor", price: 300, category: "procedimiento", aliases: ["cirugia pequeña", "operacion menor"] },
  { name: "Cirugía mediana", price: 600, category: "procedimiento", aliases: ["operacion mediana"] },
  { name: "Cirugía mayor", price: 800, category: "procedimiento", aliases: ["operacion mayor", "cirugia grande"] },

  // ── Ecografías ──────────────────────────────────────────────────────────
  { name: "Ecografía abdominal", price: 100, category: "ecografia", aliases: ["eco abdominal", "ecografia de abdomen", "eco de abdomen"] },
  { name: "Ecografía renal", price: 120, category: "ecografia", aliases: ["eco renal", "ecografia de riñon", "ecografia de riñones"] },
  { name: "Ecografía mamaria", price: 150, category: "ecografia", aliases: ["eco mamaria", "ecografia de mama", "ecografia de mamas", "ecografia de senos"] },
  { name: "Ecografía de partes blandas", price: 150, category: "ecografia", aliases: ["eco partes blandas"] },
  { name: "Ecografía prostática", price: 150, category: "ecografia", aliases: ["eco prostatica", "ecografia de prostata"] },
  { name: "Ecografía abdominal de emergencia", price: 200, category: "ecografia", aliases: ["eco abdominal de emergencia"] },
  { name: "Ecografía obstétrica", price: 100, category: "ecografia", aliases: ["eco obstetrica", "ecografia de embarazo", "eco de embarazo", "eco del bebe"] },
  { name: "Ecografía ginecológica", price: 100, category: "ecografia", aliases: ["eco ginecologica"] },
  { name: "Ecografía transvaginal", price: 150, category: "ecografia", aliases: ["eco transvaginal", "transvaginal"] },
  { name: "Ecografía transvaginal, ginecológica u obstétrica de emergencia", price: 200, category: "ecografia", aliases: ["eco de emergencia", "ecografia de emergencia"] },

  // ── Enfermería ──────────────────────────────────────────────────────────
  { name: "Absceso pequeño", price: 80, category: "enfermeria", aliases: ["drenaje de absceso pequeño", "abceso pequeño"] },
  { name: "Absceso mediano", price: 100, category: "enfermeria", aliases: ["abceso mediano"] },
  { name: "Absceso grande", price: 120, category: "enfermeria", aliases: ["abceso grande"] },
  // "encarnad" y "uñero" no se confunden con nada; "uña" sin la ñ es "una", que
  // aparece en cualquier frase, así que esa forma NO se acepta (ver needleForms).
  { name: "Retiro de uña", price: 80, category: "enfermeria", note: "lunes a viernes", aliases: ["sacar uña", "sacar la uña", "sacar las uñas", "quitar la uña", "uña encarnada", "retiro de uña encarnada", "encarnad", "uñero"] },
  { name: "Retiro de uña fin de semana", price: 100, category: "enfermeria", note: "sábado y domingo", aliases: ["retiro de uña sabado", "retiro de uña domingo"] },
  { name: "Extracción de cuerpo extraño pequeño", price: 80, category: "enfermeria", aliases: ["cuerpo extraño pequeño", "sacar cuerpo extraño"] },
  { name: "Extracción de cuerpo extraño grande", price: 150, category: "enfermeria", aliases: ["cuerpo extraño grande"] },
  { name: "Curación pequeña", price: 60, category: "enfermeria", aliases: ["curacion pequeña", "curacion chica"] },
  { name: "Curación mediana", price: 80, category: "enfermeria", aliases: ["curacion mediana"] },
  { name: "Curación grande", price: 100, category: "enfermeria", aliases: ["curacion grande"] },
  { name: "Sutura por punto (enfermería)", price: 15, category: "enfermeria", aliases: ["punto de sutura enfermeria", "sutura enfermeria"] },
  { name: "Sutura por punto (médico)", price: 20, category: "enfermeria", aliases: ["punto de sutura medico", "sutura medico", "sutura", "suturar"] },
  { name: "Lavado de oído", price: 80, category: "enfermeria", note: "lunes a viernes", aliases: ["lavado de oido", "limpieza de oido", "destapar oido", "destapar el oido", "lavar el oido", "lavar oido"] },
  { name: "Lavado de oído fin de semana", price: 100, category: "enfermeria", note: "sábado y domingo", aliases: ["lavado de oido sabado", "lavado de oido domingo"] },
  // Precio que dio la clínica por WhatsApp el 2026-10-03: 2 Bs por minuto. El
  // precio del ítem es el de una sesión de 10 minutos. "nebuliz"/"nebulis"
  // atrapan nebulización, nebulizar, nebulizaciones y la forma con s.
  { name: "Nebulización", price: 20, category: "enfermeria", note: "10 minutos; 2 Bs por minuto", aliases: ["nebuliz", "nebulis"] },
  // Los alias con artículo ("sacar los puntos") están a propósito: normalize()
  // unifica el verbo pero no borra artículos.
  { name: "Retiro de puntos (1 a 10 puntos)", price: 25, category: "enfermeria", aliases: ["sacar puntos", "sacar los puntos", "retiro de puntos", "quitar puntos", "quitar los puntos"] },
  { name: "Retiro de puntos (10 a 30 puntos)", price: 40, category: "enfermeria", aliases: ["retiro de muchos puntos"] },

  // ── Certificados ────────────────────────────────────────────────────────
  { name: "Certificado médico", price: 150, category: "certificado", aliases: ["certificado medico", "certificado"] },
  { name: "Certificado de seguro médico", price: 50, priceMax: 120, category: "certificado", aliases: ["seguro medico", "certificado de seguro"] },

  // ── Partos y cesáreas ───────────────────────────────────────────────────
  { name: "Parto normal", price: 2200, category: "obstetricia", aliases: ["parto"] },
  { name: "Parto multigesta", price: 2000, category: "obstetricia", aliases: ["parto multigesta"] },
  { name: "Cesárea programada", price: 4000, category: "obstetricia", aliases: ["cesarea programada", "cesarea", "cesaria"] },
  { name: "Cesárea de emergencia", price: 4200, category: "obstetricia", aliases: ["cesarea de emergencia", "cesaria de emergencia"] },
  { name: "Ligadura", price: 400, category: "obstetricia", aliases: ["ligadura de trompas", "ligarme"] },

  // ── Internación ─────────────────────────────────────────────────────────
  // Precio por día, confirmado por la clínica el 2026-10-08: el primer día
  // cuesta más y desde el segundo se cobra la tarifa diaria. Medicamentos y
  // laboratorio van aparte. Los alias nombran la sala a propósito: "internación"
  // a secas no elige ninguna y sigue al Q&A, que tiene las dos en el tarifario.
  {
    name: "Internación en sala común",
    price: 320,
    category: "internacion",
    note: "el primer día; desde el segundo día, 270 Bs por día. Medicamentos y laboratorio se cobran aparte",
    aliases: ["sala comun", "sala compartida", "sala general", "habitacion compartida", "cuarto compartido"],
  },
  {
    name: "Internación en sala privada",
    price: 750,
    category: "internacion",
    note: "el primer día; desde el segundo día, 700 Bs por día. Medicamentos y laboratorio se cobran aparte",
    aliases: ["sala privada", "sala personal", "sala individual", "habitacion privada", "cuarto privado", "habitacion individual"],
  },
];

// La promo del servicio si rige el día dado ("YYYY-MM-DD"), o null.
export function activePromo(service: ServiceItem, day: string): ServicePromo | null {
  const promo = service.promo;
  if (!promo) return null;
  if (promo.validUntil && day > promo.validUntil) return null;
  return promo;
}

function regularPrice(service: ServiceItem): string {
  return service.priceMax
    ? `${service.price} a ${service.priceMax} Bs`
    : `${service.price} Bs`;
}

function promoPrice(service: ServiceItem, promo: ServicePromo): string {
  return `${promo.price} Bs (${promo.label}, regular ${service.price} Bs)`;
}

// "2026-09-30" → "30/09"
function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}/${month}`;
}

// Precio legible: "100 Bs", "3800 a 4200 Bs", y con una promo que rige ese día
// "50 Bs (promoción 50% de descuento, regular 100 Bs)".
export function formatServicePrice(service: ServiceItem, day: string): string {
  const promo = activePromo(service, day);
  return promo ? promoPrice(service, promo) : regularPrice(service);
}

// Algunos servicios tienen precio de fin de semana como ítem aparte ("Retiro de
// uña" y "Retiro de uña fin de semana"). Para el día pedido se elige el que
// corresponde; un feriado se cobra como fin de semana.
const WEEKEND_SUFFIX = " fin de semana";

export function isWeekendVariant(service: ServiceItem): boolean {
  return service.name.endsWith(WEEKEND_SUFFIX);
}

export function serviceForDay(
  service: ServiceItem,
  services: ServiceItem[],
  date: string,
  holidays: readonly string[] = [],
): ServiceItem {
  const weekend = [0, 6].includes(weekdayOfDate(date)) || holidays.includes(date);
  const baseName = isWeekendVariant(service) ? service.name.slice(0, -WEEKEND_SUFFIX.length) : service.name;
  const wanted = weekend ? `${baseName}${WEEKEND_SUFFIX}` : baseName;
  return services.find((s) => s.name === wanted) ?? service;
}

export type ServiceQuoteInput = {
  today: string;                    // "YYYY-MM-DD" en hora de la clínica
  date?: string | null;             // el día que pidió el paciente
  hour?: string | null;             // "HH:MM"
  holidays?: readonly string[];     // fechas marcadas como feriado en el panel
  doctorPreference?: string | null;
};

// Sin hora, alcanza con que ese día tenga alguna franja.
function inWindows(windows: PromoWindow[], weekday: number, hour?: string | null): boolean {
  return windows.some((w) => w.weekdays.includes(weekday) && (!hour || (w.from <= hour && hour < w.to)));
}

// Cotización de un servicio para el resumen de la solicitud. Con promo mira el
// día y la hora que pidió el paciente: la promo tiene franja, y fuera de ella
// (o en feriado, o con un médico que no entra) rige otro precio. Sin día u hora
// exactos se da la regla completa, para que no se lleve un 50 que no le toca.
export function quoteService(service: ServiceItem, input: ServiceQuoteInput): string {
  const note = service.note ? ` (${service.note})` : "";
  const promo = activePromo(service, input.date ?? input.today);
  if (!promo) return regularPrice(service) + note;

  const inPromo = promoPrice(service, promo);
  const outside = promo.outside ? `${promo.outside.price} Bs (${promo.outside.label})` : regularPrice(service);

  const day = input.date ?? input.today;
  if (input.holidays?.includes(day)) {
    return `${outside}: ${day === input.today ? "hoy es feriado" : "ese día es feriado"} y la promoción no aplica`;
  }
  if (promo.outsideDoctorPattern && input.doctorPreference && new RegExp(promo.outsideDoctorPattern, "i").test(input.doctorPreference)) {
    return `${outside}: ${promo.outsideDoctorNote ?? "con el médico de su preferencia la promoción no aplica"}`;
  }
  if (!promo.windows?.length) return inPromo;
  if (input.date) {
    if (!inWindows(promo.windows, weekdayOfDate(input.date), input.hour)) {
      return `${outside}: la promoción no aplica ese día u horario`;
    }
    if (input.hour) return inPromo;
  }
  return `${inPromo} ${promo.windowsText ?? ""}; fuera de ese horario, ${outside}`;
}

// Primer mensaje cuando el paciente pregunta por (o pide) un servicio en
// promo: la información de la campaña reemplaza a la del servicio normal.
export function promoIntro(service: ServiceItem, promo: ServicePromo): string {
  const until = promo.validUntil ? `, hasta el ${shortDate(promo.validUntil)}` : "";
  return [
    `*${service.name}* con *${promo.label}: ${promo.price} Bs* (precio regular ${service.price} Bs)${until} 😊`,
    "",
    ...(promo.details ?? []),
  ].join("\n");
}

// Una línea para el resumen de una ficha de la especialidad que la promo
// nombra en mentionWithSpecialty (D9: se menciona, nunca reemplaza lo pedido).
export function promoMentions(services: ServiceItem[], specialtyKey: string | null | undefined, today: string): string[] {
  if (!specialtyKey) return [];
  return services.flatMap((service) => {
    const promo = activePromo(service, today);
    if (!promo || promo.mentionWithSpecialty !== specialtyKey) return [];
    const until = promo.validUntil ? `hasta el ${shortDate(promo.validUntil)}` : "ahora";
    const when = promo.windowsText ? `, ${promo.windowsText}` : "";
    return [`ℹ️ Además, ${until} tenemos *${service.name}* con ${promo.label}: *${promo.price} Bs*${when}. Si también lo desea, avíseselo al asesor 😊`];
  });
}

// Bloque del system prompt con las promos que rigen hoy. Va aparte del
// tarifario porque trae reglas propias (franja, requisitos, quién atiende) que
// mandan sobre las generales, y porque tiene que desaparecer solo al vencer.
export function buildCampaignsBlock(services: ServiceItem[], today: string): string {
  const blocks = services.flatMap((service) => {
    const promo = activePromo(service, today);
    if (!promo) return [];
    const until = promo.validUntil
      ? ` Rige hasta el ${shortDate(promo.validUntil)} inclusive y cuenta el día de la atención: si la pide para después de esa fecha, cotizá el precio regular.`
      : "";
    const when = promo.windowsText
      ? ` Solo ${promo.windowsText}.${promo.outside ? ` Fuera de esa franja: ${promo.outside.price} Bs (${promo.outside.label}), sin promoción.` : ""}`
      : "";
    return [
      `* ${service.name}: ${promoPrice(service, promo)}.${until}${when}`,
      ...(promo.details ?? []).map((line) => `  - ${line.replace(/\*/g, "")}`),
      ...(promo.notes ?? []).map((line) => `  - ${line}`),
    ];
  });
  if (!blocks.length) return "";
  return [
    "CAMPAÑAS VIGENTES (para estos servicios mandan sobre el tarifario y sobre la regla general de horarios y médicos: podés informar su horario y quién atiende porque es información de la campaña; el turno igual lo confirma un asesor):",
    ...blocks,
  ].join("\n");
}

// Los alias del catálogo están en infinitivo ("sacar puntos"), pero el paciente
// conjuga: "que me saquen puntos", "quiero sacarme los puntos", "sáquenme".
// Como el match es por substring, esas formas no daban en el blanco. Acá se
// llevan las familias verbales frecuentes a una forma única; se aplica a los
// DOS lados de la comparación, así que texto y alias convergen igual.
//
// Deliberadamente corto: solo los verbos con que se piden estos servicios. No
// pretende ser un lematizador — para lo que no cubra, el mensaje sigue al Q&A
// general, que ya tiene el tarifario completo en su prompt.
const FORMAS_VERBALES: [RegExp, string][] = [
  [/\bsaqu\w+|\bsacar\w*|\bsacame\b/g, "sacar"],
  [/\bquit\w+/g, "quitar"],
  [/\bretir\w+/g, "retirar"],
  [/\bpong\w+|\bponer\w*|\bponme\b/g, "poner"],
  [/\bcoloc\w+/g, "colocar"],
  [/\bhag\w+|\bhacer\w*|\bhaganme\b/g, "hacer"],
  [/\bdestap\w+/g, "destapar"],
  [/\blav\w+/g, "lavar"],
];

// Minúsculas + sin tildes + verbos unificados, para comparar "ecografía" con
// "ecografia" y "me saquen puntos" con "sacar puntos".
//
// La ñ NO es una tilde y se conserva. Quitarla convertía "uña" en "una": el
// alias "sacar uña" quedaba "sacar una" y enganchaba "sacar una consulta", "sacar
// una ficha para pediatría"… (caso real 2026-09-28: pidieron consulta con el
// pediatra y el bot cotizó un retiro de uña). NFD separa la ñ en n + tilde; se
// la vuelve a juntar antes de borrar los acentos.
function normalize(text: string): string {
  let out = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/n\u0303/g, "ñ")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  for (const [patron, forma] of FORMAS_VERBALES) out = out.replace(patron, forma);

  return out;
}

// Quien no tiene ñ en el teclado escribe "rinon" por "riñón": se acepta también
// la forma con n. Salvo cuando esa forma es otra palabra de todos los días —
// "uña" sin ñ es "una"—, porque ahí la variante engancharía cualquier frase.
const AMBIGUOUS_WITHOUT_ENIE = /(^| )unas?( |$)/;

function needleForms(needle: string): string[] {
  const base = normalize(needle);
  if (!base.includes("ñ")) return [base];
  const withoutEnie = base.replace(/ñ/g, "n");
  return AMBIGUOUS_WITHOUT_ENIE.test(withoutEnie) ? [base] : [base, withoutEnie];
}

// ¿El texto nombra este término? Siempre desde el comienzo de una palabra: por
// substring puro, "comparto" contenía "parto" y "departamento" también. Las muy
// cortas ("pap", "diu") se exigen además como palabra completa; las largas
// pueden seguir ("papanicol" atrapa "papanicolao").
const WORD_CHAR = "a-z0-9ñ";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTerm(haystack: string, term: string): boolean {
  const end = term.length <= 4 ? `(?![${WORD_CHAR}])` : "";
  return new RegExp(`(?<![${WORD_CHAR}])${escapeRegExp(term)}${end}`).test(haystack);
}

// ¿Qué servicio del catálogo menciona este mensaje? Compara el texto contra el
// nombre y los alias de cada ítem y devuelve el match MÁS LARGO, para que
// "ecografía transvaginal" gane sobre "ecografía" y "retiro de DIU" sobre
// "DIU". null si no se reconoce nada — ahí sigue el flujo normal.
export function matchService(text: string, services: ServiceItem[]): ServiceItem | null {
  const haystack = normalize(text);
  if (!haystack) return null;

  let best: ServiceItem | null = null;
  let bestLength = 0;

  for (const service of services) {
    const needles = [service.name, ...(service.aliases ?? [])].flatMap(needleForms);
    for (const candidate of needles) {
      if (candidate.length > bestLength && containsTerm(haystack, candidate)) {
        best = service;
        bestLength = candidate.length;
      }
    }
  }

  return best ?? matchServiceTypo(haystack, services);
}

// ─── Errores de tipeo ────────────────────────────────────────────────────────
// "papaniculau", "papnicolau", "papancolau": el PAP se escribe de mil formas y
// los alias no alcanzan. Caso real 2026-09-21, con la campaña al aire:
// "papaniculau" caía en "no está en nuestro catálogo" y la paciente nunca veía
// la promo. Solo se usa si no hubo ningún match exacto: se compara cada palabra
// del mensaje con los nombres y alias de UNA palabra, tolerando 2 errores.
//
// Los candados evitan que dos palabras distintas se confundan: solo palabras
// largas (con 2 errores, las cortas se vuelven cualquier cosa) y las 3
// primeras letras iguales ("sicologia" está a 2 errores de "citologia").
const TYPO_MIN_NEEDLE = 8;
const TYPO_MIN_WORD = 7;
const TYPO_MAX_DISTANCE = 2;
const TYPO_SAME_PREFIX = 3;

// Distancia de edición (Levenshtein). Corta apenas supera `max`: solo importa
// saber si está dentro del margen.
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

function matchServiceTypo(haystack: string, services: ServiceItem[]): ServiceItem | null {
  const words = haystack.split(new RegExp(`[^${WORD_CHAR}]+`)).filter((w) => w.length >= TYPO_MIN_WORD);
  if (!words.length) return null;

  let best: ServiceItem | null = null;
  let bestDistance = TYPO_MAX_DISTANCE + 1;
  for (const service of services) {
    for (const needle of [service.name, ...(service.aliases ?? [])]) {
      const candidate = normalize(needle);
      if (candidate.includes(" ") || candidate.length < TYPO_MIN_NEEDLE) continue;
      for (const word of words) {
        if (word.slice(0, TYPO_SAME_PREFIX) !== candidate.slice(0, TYPO_SAME_PREFIX)) continue;
        const distance = editDistance(word, candidate, TYPO_MAX_DISTANCE);
        if (distance < bestDistance) {
          best = service;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
}

// ─── Pedidos que HOY no están en ningún catálogo nuestro ─────────────────────
// Estudios de imagen, estudios funcionales y terapias que los pacientes piden
// por su nombre y que no figuran ni en defaultServices ni en las especialidades
// de consulta. NO es una lista de "lo que no hacemos" — es exactamente lo
// contrario: es la lista de lo que NO SABEMOS, para que el bot nunca improvise
// una respuesta sobre ella.
//
// Existe porque depender del criterio del modelo falló dos veces en producción:
// "electrocardiograma" (2026-09-17) y "radiografía de pie" (2026-09-18), las dos
// contestadas con una negación que la clínica tuvo que desmentir. Reconocer un
// nombre contra una lista cerrada es comparación de strings, no criterio.
//
// SIEMPRE se consulta después de matchService() y matchSpecialtyText(): si el
// término llega a cargarse al catálogo, esos ganan y esta lista deja de verlo
// sola, sin tener que editarla.
const OFF_CATALOG_TERMS = [
  // Imagen
  "radiografia", "radiografias", "rayos x", "rayosx", "placa radiografica", "placas radiograficas",
  "tomografia", "resonancia", "resonancia magnetica", "mamografia", "densitometria",
  // Estudios funcionales
  "electrocardiograma", "ecocardiograma", "electroencefalograma", "endoscopia",
  "colonoscopia", "espirometria", "holter", "audiometria", "prueba de esfuerzo",
  // Terapias y atenciones fuera del plantel cargado
  "fisioterapia", "fisioterapeuta", "kinesiologia", "kinesiologo", "rehabilitacion",
  "odontologia", "odontologo", "dentista", "oftalmologia", "oftalmologo", "optometria",
  "psicologia", "psicologo", "psiquiatria", "psiquiatra", "nutricion", "nutricionista",
  "fonoaudiologia", "terapia de lenguaje",
  // Estudios ginecológicos que NO son el PAP. Con la campaña del PAP en el
  // prompt, el modelo tiende a cotizarlos a 50 Bs: acá se toma el pedido y un
  // asesor confirma el precio.
  "vph", "virus del papiloma", "prueba del papiloma", "ivaa", "colposcopia",
  "biopsia de cervix", "biopsia de cuello uterino",
];

// Devuelve el término reconocido (normalizado, el match más largo) o null. El
// llamador lo usa solo como señal: el texto que se le guarda al asesor es el
// del paciente, no este.
export function matchOffCatalogRequest(text: string): string | null {
  const haystack = normalize(text);
  if (!haystack) return null;

  let best: string | null = null;
  for (const term of OFF_CATALOG_TERMS) {
    const candidate = normalize(term);
    if (containsTerm(haystack, candidate) && (!best || candidate.length > best.length)) best = candidate;
  }
  return best;
}

// "rx" va aparte: dos letras dentro de una lista por substring daría falsos
// positivos en cualquier palabra. Como palabra suelta sí es inequívoco.
export function mentionsOffCatalogRequest(text: string): boolean {
  return matchOffCatalogRequest(text) !== null || /(^|[^a-z0-9])rx([^a-z0-9]|$)/i.test(text);
}
