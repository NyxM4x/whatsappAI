// ============================================================================
// Verificación de analyzeTurn contra mensajes reales de pacientes.
// ----------------------------------------------------------------------------
// SÍ necesita OpenAI (OPENAI_API_KEY en .env.local): llama al modelo una vez por
// caso. Supabase es opcional — sin él se usa la config estática y la lista de
// médicos queda vacía.
//
// Los casos salen de conversaciones que no terminaron en nada. El de
// fisioterapia es el que motivó todo esto: el bot le ofreció Medicina General y
// cinco médicos que el paciente nunca mencionó.
//
//   npx tsx scripts/check-analisis.ts
// ============================================================================

import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY (ponela en .env.local). Este script llama al modelo.");
  process.exit(1);
}

const { getClinicConfig } = await import("../lib/clinic/config");
const { analyzeTurn } = await import("../lib/clinic/leads");
const { findSpecialty } = await import("../lib/clinic/pricing");
const { decideAction } = await import("../lib/clinic/routing");

type Expectation = {
  text: string;
  // Qué esperamos del análisis. Solo se comprueba lo que se declara.
  unavailable?: boolean;      // pidió algo que no ofrecemos
  needsAction?: boolean;      // pide una gestión humana
  specialtyKey?: string | null;
  wantsLead?: boolean;
  payment?: "qr" | "efectivo" | null;
  patientName?: string | null;
  isQuestion?: boolean;
  // Qué debe DECIDIR el ruteo con ese análisis real. Encadena las dos capas:
  // así se verifica el recorrido entero (mensaje → comprensión → decisión) sin
  // levantar el webhook. wantsLead ya no se verifica acá: dejó de ser una
  // conclusión del análisis y pasó a ser una decisión de routing.ts.
  action?: string;
};

const CASES: Expectation[] = [
  // ── El caso que rompió: especialidad fuera de nuestro catálogo ────────────
  // Desde 2026-09-17 esto YA NO se rechaza ("no contamos con X"): no sabemos
  // si la clínica la ofrece o no, solo que no está cargada acá. Se recopila
  // igual (wantsLead: true en los pedidos directos) y un asesor confirma.
  { text: "Para fisioterapia", unavailable: true, specialtyKey: null, action: "startLead" },
  { text: "buenas, hacen odontologia?", unavailable: true, specialtyKey: null },
  { text: "necesito un oftalmologo para mi mama", unavailable: true, specialtyKey: null, action: "startLead" },
  { text: "quiero una ficha para rehabilitacion de rodilla", unavailable: true, specialtyKey: null, action: "startLead" },

  // ── Caso real 2026-09-17: el mismo problema pero con un SERVICIO, no una
  // especialidad. El bot dijo "no contamos con electrocardiograma" y la
  // clínica sí lo ofrece (170 Bs con consulta) — la recepcionista tuvo que
  // corregirlo en vivo. unavailableRequest cubre especialidad Y servicio/
  // examen por igual; acá solo importa que NO se rechace.
  { text: "cuanto está el electrocardiograma", unavailable: true, specialtyKey: null },
  { text: "hacen electrocardiograma?", unavailable: true, specialtyKey: null },

  // ── Caso real 2026-09-18: radiografía ────────────────────────────────────
  // Volvió a pasar, esta vez con "Por favor el precio de la Radiografía / Para
  // pie". El análisis dejó el mensaje limpio, cayó en el Q&A general y el
  // modelo contestó "No tengo Radiografía para pie dentro de los servicios que
  // tengo registrados". Desde este caso, mentionsOffCatalogRequest() marca
  // unavailableRequest por código aunque el modelo no lo haga: no depende de
  // que el modelo tenga criterio.
  { text: "Por favor el precio de la Radiografía", unavailable: true, specialtyKey: null },
  { text: "radiografia de pie cuanto sale", unavailable: true, specialtyKey: null },
  { text: "necesito una tomografia, cuanto cuesta?", unavailable: true, specialtyKey: null },

  // ── Gestiones que solo hace una persona (antes contestaba "Ok") ───────────
  { text: "Por favor doctora me lo dice a la licen para las 5:10 llegó", needsAction: true },
  { text: "Me confirma", needsAction: true },
  { text: "ya llegué a la clínica, avise por favor", needsAction: true },
  // En Bolivia "cancelar" es PAGAR, no anular. Este caso estaba mal escrito de
  // mi parte: no es una gestión, es la forma de pago. El modelo lo entendió
  // mejor que la expectativa.
  { text: "voy a cancelar llegando nomas", needsAction: false, payment: "efectivo" },

  // ── Lo que SÍ debe seguir funcionando: no sobre-derivar ───────────────────
  { text: "quiero una ficha para pediatria mañana a las 10", unavailable: false, needsAction: false, specialtyKey: "pediatria", action: "startLead" },
  { text: "me duele mucho la barriga desde ayer", unavailable: false, specialtyKey: "medicina-general" },
  { text: "necesito un ginecologo", unavailable: false, specialtyKey: "ginecologia", action: "startLead" },
  { text: "cuanto cuesta la consulta de neurologia?", unavailable: false, specialtyKey: "neurologia", action: "qa" },
  // Servicio real del catálogo (defaultServices): nunca debe quedar marcado
  // como unavailableRequest — matchService() en sanitizeAnalysis es la red que
  // descarta ese falso positivo, igual que matchSpecialtyText para especialidades.
  { text: "cuanto cuesta el papanicolau?", unavailable: false },
  { text: "a que hora abren?", unavailable: false, needsAction: false, action: "qa" },

  // ── F2: la especialidad dicha en el primer mensaje no se repregunta ───────
  // Para que no repregunte, wantsLead tiene que salir en true: si no, el
  // mensaje ni siquiera llega a abrir la solicitud.
  { text: "Para ginecología", specialtyKey: "ginecologia", action: "startLead" },
  { text: "pediatria por favor", specialtyKey: "pediatria", action: "startLead" },

  // ── Nombre: "pa mi" NO es un nombre ───────────────────────────────
  // Contestan PARA QUIÉN es, no cómo se llama. Iba al panel como nombre.
  { text: "hola tienen electrocardiograma? pa mi", patientName: null },
  { text: "quiero ficha para pediatria, es para mi hijo", patientName: null, specialtyKey: "pediatria" },
  { text: "Quiero sacar ficha con cardiología, soy Juan Pérez", patientName: "Juan Pérez", specialtyKey: "cardiologia" },

  // ── Preguntar vs pedir: el ruteo necesita estos dos campos bien ────────
  { text: "¿Tienen electrocardiograma?", unavailable: true, isQuestion: true, action: "offerLead" },
  { text: "Quiero hacerme un electrocardiograma", unavailable: true, action: "startLead" },

  // ── F7: forma de pago como dato, sin derivar por eso ──────────────────────
  { text: "voy a pagar por QR", payment: "qr" },
  { text: "pago llegando nomas", payment: "efectivo", needsAction: false },
  { text: "quiero ficha para medicina general, pago en efectivo al llegar", payment: "efectivo", specialtyKey: "medicina-general", action: "startLead" },
  { text: "mañana a las 9 me viene bien", payment: null },
];

const clinic = await getClinicConfig();
const ctx = {
  clinic,
  conversationId: "check-analisis",
  contactPhone: "+59100000000",
  contactName: null,
  step: "idle" as const,
  draft: null,
};

let failures = 0;

console.log("\nANÁLISIS DE MENSAJES  (modelo: " + (process.env.OPENAI_MODEL ?? "gpt-4o-mini") + ")\n");

for (const c of CASES) {
  const a = await analyzeTurn({ ...ctx, text: c.text });

  if (!a) {
    console.log(`  ✗ "${c.text}"\n      el análisis devolvió null`);
    failures++;
    continue;
  }

  const problems: string[] = [];
  if (c.unavailable !== undefined) {
    const got = Boolean(a.unavailableRequest);
    if (got !== c.unavailable) {
      problems.push(`unavailableRequest=${a.unavailableRequest ?? "null"} (esperado ${c.unavailable ? "con valor" : "null"})`);
    }
  }
  if (c.needsAction !== undefined && a.needsHumanAction !== c.needsAction) {
    problems.push(`needsHumanAction=${a.needsHumanAction} (esperado ${c.needsAction})`);
  }
  if (c.specialtyKey !== undefined && a.specialtyKey !== c.specialtyKey) {
    problems.push(`specialtyKey=${a.specialtyKey ?? "null"} (esperado ${c.specialtyKey ?? "null"})`);
  }
  if (c.wantsLead !== undefined && a.wantsLead !== c.wantsLead) {
    problems.push(`wantsLead=${a.wantsLead} (esperado ${c.wantsLead})`);
  }
  if (c.payment !== undefined && a.paymentIntention !== c.payment) {
    problems.push(`paymentIntention=${a.paymentIntention ?? "null"} (esperado ${c.payment ?? "null"})`);
  }
  if (c.patientName !== undefined && a.patientName !== c.patientName) {
    problems.push(`patientName=${JSON.stringify(a.patientName)} (esperado ${JSON.stringify(c.patientName)})`);
  }
  if (c.isQuestion !== undefined && a.isQuestion !== c.isQuestion) {
    problems.push(`isQuestion=${a.isQuestion} (esperado ${c.isQuestion})`);
  }
  // Encadenado: el análisis REAL entra al ruteo REAL.
  let decided: string | null = null;
  if (c.action !== undefined) {
    const action = decideAction({
      clinic, text: c.text, analysis: a, step: "idle",
      proof: null, emergencyDetectionEnabled: false, greetingOnly: false,
    });
    decided = action.type + ("kind" in action && action.kind ? `:${action.kind}` : "");
    if (action.type !== c.action) problems.push(`action=${decided} (esperado ${c.action})`);
  }

  // Invariante del arreglo: nunca las dos cosas a la vez. Si esto falla, el bot
  // volvió a poder sustituir en silencio una especialidad que no tenemos.
  if (a.unavailableRequest && a.specialtyKey) {
    problems.push(`¡SUSTITUCIÓN SILENCIOSA! pidió "${a.unavailableRequest}" y devolvió ${a.specialtyKey}`);
  }

  const resumen = [
    a.unavailableRequest ? `fuera-de-catalogo:"${a.unavailableRequest}"` : null,
    a.needsHumanAction ? "gestión" : null,
    a.specialtyKey ? findSpecialty(a.specialtyKey)?.name ?? a.specialtyKey : null,
    a.wantsLead ? "quiere-ficha" : null,
    a.paymentIntention ? `paga:${a.paymentIntention}` : null,
    decided ? `→ ${decided}` : null,
  ].filter(Boolean).join(" · ") || "—";

  if (problems.length) {
    failures++;
    console.log(`  ✗ "${c.text}"`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    console.log(`  ✓ "${c.text}"`.padEnd(66) + resumen);
  }
}

console.log("\n" + "─".repeat(72));
console.log(failures ? `✗ ${failures} caso(s) con fallos.` : "✓ Sin fallos.");
process.exit(failures ? 1 : 0);
