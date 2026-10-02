// ============================================================================
// Campañas — la promo del PAP cotiza bien y se apaga sola.
// ----------------------------------------------------------------------------
// NO llama a OpenAI: es determinístico. Prueba, con fechas fijas, que:
//
//   1. el precio depende del día y la hora de la toma (franja L-V 8-12 y 14-18;
//      fuera de ella, fin de semana, feriado o con doctora: 200 a llamado);
//   2. al pasar el 30/09 vuelve solo el precio regular, sin tocar nada;
//   3. el mensaje de apertura dice lo que la clínica pidió y no se veta;
//   4. el PAP se reconoce como lo escribe la gente, y lo que NO es el PAP
//      (VPH, colposcopía, "cáncer de cuello uterino") no se le parece;
//   5. ginecología cobra 200 en fin de semana y en feriado;
//   6. un feriado se cobra con la tarifa de domingo (consultas y servicios).
//
//   npx tsx scripts/check-campanas.ts
// ============================================================================

import { qaAnswerIsUnsafe } from "../lib/clinic/leads";
import { getClinicConfig } from "../lib/clinic/config";
import { findSpecialty, quoteConsultation } from "../lib/clinic/pricing";
import {
  activePromo,
  buildCampaignsBlock,
  defaultServices,
  formatServicePrice,
  matchService,
  promoIntro,
  promoMentions,
  quoteService,
  serviceForDay,
} from "../lib/clinic/services";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  →  ${detail}` : ""}`);
}

const pap = defaultServices.find((s) => s.name === "Papanicolaou")!;
const HOY = "2026-09-21"; // lunes, primer día de la campaña en Facebook

// ─── 1. Precio según el día y la hora ────────────────────────────────────────
console.log("\nPRECIO DEL PAP SEGÚN DÍA Y HORA\n");

const PROMO = "50 Bs (promoción 50% de descuento, regular 100 Bs)";
const CASOS: [string, Parameters<typeof quoteService>[1], (q: string) => boolean][] = [
  ["martes 09:00 → promo", { today: HOY, date: "2026-09-22", hour: "09:00" }, (q) => q === PROMO],
  ["martes 08:00 (abre) → promo", { today: HOY, date: "2026-09-22", hour: "08:00" }, (q) => q === PROMO],
  ["martes 07:59 → a llamado", { today: HOY, date: "2026-09-22", hour: "07:59" }, (q) => q.startsWith("200 Bs")],
  ["martes 12:30 (mediodía) → a llamado", { today: HOY, date: "2026-09-22", hour: "12:30" }, (q) => q.startsWith("200 Bs")],
  ["martes 14:00 → promo", { today: HOY, date: "2026-09-22", hour: "14:00" }, (q) => q === PROMO],
  ["martes 17:59 → promo", { today: HOY, date: "2026-09-22", hour: "17:59" }, (q) => q === PROMO],
  ["martes 18:00 → a llamado", { today: HOY, date: "2026-09-22", hour: "18:00" }, (q) => q.startsWith("200 Bs")],
  ["sábado 10:00 → a llamado", { today: HOY, date: "2026-09-26", hour: "10:00" }, (q) => q.startsWith("200 Bs")],
  ["domingo sin hora → a llamado", { today: HOY, date: "2026-09-27" }, (q) => q.startsWith("200 Bs")],
  ["martes sin hora → la regla completa", { today: HOY, date: "2026-09-22" }, (q) => q.includes("50 Bs") && q.includes("fuera de ese horario, 200 Bs")],
  ["sin día → la regla completa", { today: HOY }, (q) => q.includes("de lunes a viernes de 8:00 a 12:00") && q.includes("200 Bs")],
  ["feriado marcado hoy → a llamado", { today: HOY, holidays: [HOY] }, (q) => q.startsWith("200 Bs") && q.includes("hoy es feriado")],
  ["feriado hoy pero pide para mañana → promo", { today: HOY, date: "2026-09-22", hour: "09:00", holidays: [HOY] }, (q) => q === PROMO],
  ["pide un martes marcado como feriado → a llamado", { today: HOY, date: "2026-09-22", hour: "09:00", holidays: ["2026-09-22"] }, (q) => q.startsWith("200 Bs") && q.includes("ese día es feriado")],
  ["prefiere doctora → a llamado", { today: HOY, date: "2026-09-22", hour: "09:00", doctorPreference: "doctora (mujer)" }, (q) => q.startsWith("200 Bs")],
  ["pide a la Dra. Medina → a llamado, de 18 a 19", { today: HOY, date: "2026-09-22", hour: "18:00", doctorPreference: "Dra. Medina" }, (q) => q.startsWith("200 Bs") && q.includes("18:00 a 19:00")],
  ["a llamado incluye toma y análisis", { today: HOY, date: "2026-09-26", hour: "10:00" }, (q) => q.includes("incluye la toma y el análisis")],
  ["pide al Dr. Irusta → promo", { today: HOY, date: "2026-09-22", hour: "09:00", doctorPreference: "Dr. Eric Irusta" }, (q) => q === PROMO],
  ["30/09 09:00 (último día) → promo", { today: HOY, date: "2026-09-30", hour: "09:00" }, (q) => q === PROMO],
  ["1/10 09:00 (la pidió en septiembre) → regular", { today: HOY, date: "2026-10-01", hour: "09:00" }, (q) => q === "100 Bs"],
];

for (const [nombre, input, ok] of CASOS) {
  const quote = quoteService(pap, input);
  check(nombre, ok(quote), quote);
}

// ─── 2. Se apaga sola ────────────────────────────────────────────────────────
console.log("\nLA PROMO VENCE SOLA\n");

check("rige el 30/09", activePromo(pap, "2026-09-30") !== null);
check("no rige el 1/10", activePromo(pap, "2026-10-01") === null);
check("tarifario del 30/09 cotiza 50", formatServicePrice(pap, "2026-09-30") === PROMO, formatServicePrice(pap, "2026-09-30"));
check("tarifario del 1/10 vuelve a 100", formatServicePrice(pap, "2026-10-01") === "100 Bs", formatServicePrice(pap, "2026-10-01"));
check("hoy (1/10) sin día pedido → regular", quoteService(pap, { today: "2026-10-01" }) === "100 Bs");
check("bloque de campañas presente en septiembre", buildCampaignsBlock(defaultServices, HOY).includes("Papanicolaou"));
check("bloque de campañas vacío en octubre", buildCampaignsBlock(defaultServices, "2026-10-01") === "");
check("mención en la ficha de ginecología", promoMentions(defaultServices, "ginecologia", HOY).length === 1);
check("sin mención en la ficha de pediatría", promoMentions(defaultServices, "pediatria", HOY).length === 0);
check("sin mención en ginecología en octubre", promoMentions(defaultServices, "ginecologia", "2026-10-01").length === 0);

// ─── 3. Lo que se le dice al paciente ────────────────────────────────────────
console.log("\nMENSAJE DE APERTURA\n");

const intro = promoIntro(pap, pap.promo!);
for (const [nombre, patron] of [
  ["precio de promo y regular", /50 Bs\*? \(precio regular 100 Bs\)/],
  ["fecha de fin", /hasta el 30\/09/],
  ["franja", /8:00 a 12:00 y de 14:00 a 18:00/],
  ["solo lunes a viernes, sin feriados", /no aplica s[aá]bados, domingos ni feriados/],
  ["incluye toma y análisis", /toma de muestra y el an[aá]lisis/],
  ["no incluye la lectura", /No incluye la lectura del resultado/],
  ["lectura 80 hasta las 18 / 200 después", /80 Bs de lunes a viernes hasta las 18:00 \(200 Bs desde las 18:00/],
  ["7 días después de la regla", /7 d[ií]as despu[eé]s de terminar su regla/],
  ["2 días sin relaciones", /2 d[ií]as sin relaciones/],
  ["3 días sin óvulos, cremas ni lavados", /3 d[ií]as sin [oó]vulos, cremas ni lavados/],
  ["carnet", /carnet/],
] as const) {
  check(nombre, patron.test(intro));
}
check("el mensaje no se vetaría como negación", !qaAnswerIsUnsafe(intro));

const bloque = buildCampaignsBlock(defaultServices, HOY);
check("el prompt dice que con doctora es 200", /mujer[^.]*200 Bs/.test(bloque));
check("el prompt dice que no hay reconsulta para la lectura", /NO hay reconsulta gratis/.test(bloque));
check("el prompt separa el PAP del VPH", /VPH/.test(bloque));

// El prompt real (el de getClinicConfig) lleva el bloque mientras la promo rige.
const clinic = await getClinicConfig();
const { buildClinicSystemPrompt } = await import("../lib/clinic/config");
const { localDateISO } = await import("../lib/clinic/pricing");
const rige = localDateISO(new Date(), clinic.timezone) <= (pap.promo!.validUntil ?? "9999-12-31");
check(
  `el prompt de hoy ${rige ? "lleva" : "ya no lleva"} la campaña`,
  buildClinicSystemPrompt(clinic).includes("CAMPAÑAS VIGENTES") === rige,
);

// ─── 4. Cómo lo escribe la gente ─────────────────────────────────────────────
console.log("\nRECONOCER EL PAP\n");

const ES_PAP = [
  "PAPANICOLAO 50% DESCUENTO",
  "quiero el pap",
  "cuanto cuesta el papanicolaou",
  "papanicolau precio",
  "quiero hacerme el papa nicolau",
  "cuanto sale el papanicolado",
  "papanikolau",
  "info del pap test",
  "citologia vaginal",
  "cuanto cuesta el examen del cuello uterino",
  // Errores de tipeo que ningún alias cubre (caso real 2026-09-21: con la
  // campaña al aire, "papaniculau" caía en "no está en nuestro catálogo").
  "papaniculau",
  "cuanto el papaniculao",
  "papancolau precio",
  "papnicolau",
  "info papanicolaw",
];
for (const text of ES_PAP) {
  const got = matchService(text, defaultServices)?.name ?? null;
  check(`"${text}" → Papanicolaou`, got === "Papanicolaou", got ?? "nada");
}

const NO_ES_PAP = [
  "cuanto cuesta la prueba de VPH",
  "quiero una colposcopia",
  "tengo cancer de cuello uterino, que hago",
  "mi papa esta enfermo",
  "chequeo ginecologico",
  "tengo papiloma",
  // Palabras a 2 errores de un alias: la tolerancia a tipeos no puede
  // confundirlas ("sicologia" está a 2 de "citologia").
  "necesito sicologia para mi hijo",
  "virologia",
  "mi papa nicolas esta enfermo",
  "le tengo panico a las agujas",
];
for (const text of NO_ES_PAP) {
  const got = matchService(text, defaultServices)?.name ?? null;
  check(`"${text}" → no es el PAP`, got !== "Papanicolaou", got ?? "nada");
}

// ─── 5. "¿Ya está mi resultado?" ─────────────────────────────────────────────
console.log("\n¿PREGUNTA POR SU RESULTADO?\n");

for (const [text, esperado] of [
  ["ya está mi resultado?", true],
  ["buenas, ya salió el resultado del pap?", true],
  ["me pueden mandar mis resultados", true],
  ["el resultado de mi papanicolaou", true],
  // Al resultado le dicen "los laboratorios" (caso real 2026-09-28).
  ["quería saber si ya salió los laboratorios de Danna", true],
  ["ya salieron mis análisis?", true],
  ["quiero hacerme mis análisis", false],
  ["en cuantos dias sale el resultado?", false],
  ["cuanto cuesta el pap?", false],
] as const) {
  check(`"${text}" → ${esperado ? "asesor" : "no"}`, clinic.resultInquiryPatterns.test(text) === esperado);
}

// ─── 6. Ginecología: fin de semana y feriado a llamado ───────────────────────
console.log("\nCONSULTA DE GINECOLOGÍA\n");

const gin = findSpecialty("ginecologia")!;
const feriado = quoteConsultation({ spec: gin, date: HOY, hour: "10:00", holidays: [HOY] });
check("feriado marcado → 200 a llamado", feriado.kind === "exact" && feriado.price === 200, feriado.text);
const sabado = quoteConsultation({ spec: gin, date: "2026-09-26", hour: "10:00" });
check("sábado 10:00 → 200", sabado.price === 200, sabado.text);
const martes = quoteConsultation({ spec: gin, date: "2026-09-22", hour: "10:00" });
check("martes 10:00 → 80", martes.price === 80, martes.text);
const martesNoche = quoteConsultation({ spec: gin, date: "2026-09-22", hour: "18:30" });
check("martes 18:30 → 200 (a llamado)", martesNoche.price === 200, martesNoche.text);

// ─── 7. Feriado = tarifa de domingo ──────────────────────────────────────────
console.log("\nFERIADO CON TARIFA DE DOMINGO\n");

const ped = findSpecialty("pediatria")!;
const general = findSpecialty("medicina-general")!;
const pediatriaFeriado = quoteConsultation({ spec: ped, date: HOY, hour: "10:00", holidays: [HOY] });
check("pediatría lunes feriado 10:00 → 120 (domingo)", pediatriaFeriado.price === 120, pediatriaFeriado.text);
const pediatriaLunes = quoteConsultation({ spec: ped, date: HOY, hour: "10:00" });
check("pediatría lunes normal 10:00 → 80", pediatriaLunes.price === 80, pediatriaLunes.text);
const generalFeriado = quoteConsultation({ spec: general, date: HOY, hour: "10:00", holidays: [HOY] });
check("medicina general feriado 10:00 → 80 (domingo)", generalFeriado.price === 80, generalFeriado.text);
const madrugada = quoteConsultation({ spec: ped, date: "2026-09-22", hour: "03:00", holidays: [HOY] });
check("madrugada después del feriado → 120 (noche del feriado)", madrugada.price === 120, madrugada.text);
const diaFeriado = quoteConsultation({ spec: ped, date: HOY, holidays: [HOY] });
check("solo el día, feriado → tramos de domingo", diaFeriado.kind === "day" && diaFeriado.text.includes("120 Bs") && diaFeriado.text.includes("feriado"), diaFeriado.text);

const unaLv = defaultServices.find((s) => s.name === "Retiro de uña")!;
check("retiro de uña un sábado → fin de semana", serviceForDay(unaLv, defaultServices, "2026-09-26").price === 100);
check("retiro de uña un lunes feriado → fin de semana", serviceForDay(unaLv, defaultServices, HOY, [HOY]).price === 100);
check("retiro de uña un lunes normal → lunes a viernes", serviceForDay(unaLv, defaultServices, HOY).price === 80);
const unaFinde = defaultServices.find((s) => s.name === "Retiro de uña fin de semana")!;
check("pidió la de fin de semana para un martes → lunes a viernes", serviceForDay(unaFinde, defaultServices, "2026-09-22").price === 80);

console.log(failures === 0 ? "\n✅ Campañas en orden." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
