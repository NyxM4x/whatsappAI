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

export type ServiceCategory =
  | "emergencia"
  | "procedimiento"
  | "ecografia"
  | "enfermeria"
  | "certificado"
  | "obstetricia";

// Precio de campaña vigente. `price` se conserva como el precio regular: el bot
// cotiza el promocional y aclara cuál es el de lista, para que la rebaja se lea
// como tal y para poder retirar la campaña borrando solo este campo.
export type ServicePromo = {
  price: number;
  label: string; // cómo se nombra la campaña al paciente ("precio de campaña")
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
};

export const SERVICE_CATEGORY_ORDER: ServiceCategory[] = [
  "emergencia",
  "procedimiento",
  "ecografia",
  "enfermeria",
  "certificado",
  "obstetricia",
];

export const defaultServices: ServiceItem[] = [
  // ── Consultas de emergencia (tarifario de la clínica) ─────────────────────
  // Se informan pero no abren una solicitud: la emergencia no espera a que un
  // asesor confirme un horario.
  { name: "Consulta de emergencia (medicina general)", price: 80, category: "emergencia", aliases: ["consulta de emergencia", "emergencia general"] },
  { name: "Consulta por accidente de tránsito", price: 150, category: "emergencia", aliases: ["transito", "accidente de transito", "certificado de transito", "examen de transito"] },
  { name: "Consulta ginecológica de emergencia a llamado", price: 200, category: "emergencia", aliases: ["ginecologia de emergencia", "emergencia ginecologica"] },
  { name: "Consulta de emergencia de cardiología", price: 150, category: "emergencia", aliases: ["emergencia cardiologica", "emergencia de cardiologia"] },
  { name: "Consulta de emergencia de cirugía", price: 250, category: "emergencia", aliases: ["emergencia de cirugia", "emergencia quirurgica"] },
  { name: "Consulta de emergencia de traumatología", price: 250, category: "emergencia", aliases: ["emergencia de traumatologia", "emergencia traumatologica"] },
  { name: "Consulta de emergencia de urología", price: 150, category: "emergencia", aliases: ["emergencia de urologia", "emergencia urologica"] },

  // ── Procedimientos ──────────────────────────────────────────────────────
  { name: "Papanicolaou", price: 100, category: "procedimiento", aliases: ["papanicolau", "papanicolao", "pap", "citologia"] },
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
  { name: "Retiro de uña", price: 80, category: "enfermeria", note: "lunes a viernes", aliases: ["sacar uña", "uña encarnada", "retiro de uña encarnada"] },
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
  // Los alias con artículo ("sacar los puntos") están a propósito: normalize()
  // unifica el verbo pero no borra artículos — hacerlo rompería "retiro de uña",
  // que al quitarle la tilde de la ñ queda como "retiro de una".
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
];

// Precio legible: "100 Bs", "3800 a 4200 Bs", y con campaña vigente
// "400 Bs (precio de campaña, regular 480 Bs)".
export function formatServicePrice(service: ServiceItem): string {
  if (service.promo) {
    return `${service.promo.price} Bs (${service.promo.label}, regular ${service.price} Bs)`;
  }
  return service.priceMax
    ? `${service.price} a ${service.priceMax} Bs`
    : `${service.price} Bs`;
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
function normalize(text: string): string {
  let out = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  for (const [patron, forma] of FORMAS_VERBALES) out = out.replace(patron, forma);

  return out;
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
    const needles = [service.name, ...(service.aliases ?? [])];
    for (const needle of needles) {
      const candidate = normalize(needle);
      // Muy cortas ("pap", "diu") darían falsos positivos dentro de otra
      // palabra, así que esas se exigen como palabra completa.
      const matches =
        candidate.length <= 4
          ? new RegExp(`(^|[^a-z0-9])${candidate}([^a-z0-9]|$)`).test(haystack)
          : haystack.includes(candidate);

      if (matches && candidate.length > bestLength) {
        best = service;
        bestLength = candidate.length;
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
    const matches =
      candidate.length <= 4
        ? new RegExp(`(^|[^a-z0-9])${candidate}([^a-z0-9]|$)`).test(haystack)
        : haystack.includes(candidate);
    if (matches && (!best || candidate.length > best.length)) best = candidate;
  }
  return best;
}

// "rx" va aparte: dos letras dentro de una lista por substring daría falsos
// positivos en cualquier palabra. Como palabra suelta sí es inequívoco.
export function mentionsOffCatalogRequest(text: string): boolean {
  return matchOffCatalogRequest(text) !== null || /(^|[^a-z0-9])rx([^a-z0-9]|$)/i.test(text);
}
