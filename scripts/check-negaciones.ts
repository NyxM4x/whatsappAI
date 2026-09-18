// ============================================================================
// El bot no puede negar un servicio. Esta es la prueba de que no puede.
// ----------------------------------------------------------------------------
// NO llama a OpenAI: es determinístico y corre en segundos. Prueba las dos
// redes que impiden una negación, que es lo único que no puede fallar:
//
//   1. qaAnswerIsUnsafe(): descarta la respuesta del Q&A si niega algo, si se
//      escuda en los catálogos internos o si promete una gestión que el bot no
//      hace. Es lo que habría frenado el caso real del 2026-09-18.
//   2. mentionsOffCatalogRequest(): reconoce por código (no por criterio del
//      modelo) lo que no está en ningún catálogo nuestro, para que el mensaje
//      vaya a recopilar datos y no al Q&A libre.
//
// La segunda mitad de cada bloque es igual de importante: las respuestas y los
// mensajes que NO deben activarse. Una red que ataja de más manda al asesor
// conversaciones que el bot resolvía solo.
//
//   npx tsx scripts/check-negaciones.ts
// ============================================================================

import { qaAnswerIsUnsafe } from "../lib/clinic/leads";
import { unlistedAnswer } from "../lib/clinic/routing";
import { defaultServices, matchService, mentionsOffCatalogRequest } from "../lib/clinic/services";

let failures = 0;

function check(name: string, actual: boolean, expected: boolean) {
  if (actual === expected) return;
  failures++;
  console.log(`❌ ${name}\n   esperaba ${expected}, obtuvo ${actual}`);
}

// ─── 1. Respuestas que NUNCA deben llegar al paciente ────────────────────────

// La de verdad, palabra por palabra, del 2026-09-18.
const CASO_REAL =
  "No tengo Radiografía para pie dentro de los servicios que tengo registrados 🙏 " +
  "Eso no quiere decir que no lo hagan: mi lista puede estar incompleta.\n\n" +
  "¿Quiere que le consulte con el equipo de la clínica para que le confirmen si lo realizan y el precio?";

const DEBEN_VETARSE = [
  CASO_REAL,
  "No contamos con fisioterapia en la clínica 🙏",
  "Lamentablemente no ofrecemos odontología por el momento.",
  "No realizamos tomografías, pero le puedo ayudar con otra cosa 😊",
  "Ese examen no figura en nuestro tarifario.",
  "No aparece en mi catálogo de servicios.",
  "La radiografía no está disponible en este momento.",
  "No lo tengo registrado, pero mi lista puede estar incompleta.",
  "Le consulto con el equipo y le aviso el precio 😊",
  "¿Quiere que le pregunte al equipo de la clínica?",
  "Déjeme verificar con la clínica y le confirmo.",
];

for (const reply of DEBEN_VETARSE) {
  check(`veta: "${reply.slice(0, 60)}…"`, qaAnswerIsUnsafe(reply), true);
}

// ─── 2. Respuestas legítimas que deben pasar ─────────────────────────────────
// Si alguna de estas se veta, el bot deja de resolver cosas que sí sabe y
// empieza a derivar de más.

const DEBEN_PASAR = [
  "La consulta de pediatría cuesta 70 Bs en horario normal 😊",
  "Atendemos de lunes a sábado de 08:00 a 20:00. Los domingos no atendemos.",
  "Estamos en la Av. Moscú, a una cuadra del Mercado La Cuchilla 😊",
  "El horario y el médico se los confirma un asesor de la clínica por aquí mismo 🙏",
  "Con gusto le ayudo con la radiografía de pie 😊 El precio se lo confirma un asesor. " +
    "¿Me dice el nombre completo del paciente y qué día y hora le quedarían cómodos?",
  "La ecografía abdominal cuesta 100 Bs 😊 ¿Desea que le tomemos sus datos?",
  "Para la consulta recuerde traer su carnet de identidad 🙏",
  "El implante subdérmico protege 5 años y tiene 99% de efectividad 😊",
];

for (const reply of DEBEN_PASAR) {
  check(`pasa: "${reply.slice(0, 60)}…"`, qaAnswerIsUnsafe(reply), false);
}

// ─── 2b. El texto fijo con el que respondemos lo no catalogado ───────────────
// Esta es la parte que de verdad fallaba: la negación del 2026-09-18 no salió
// del modelo, estaba escrita a mano en routing.ts. El veto solo mira lo que
// genera el LLM, así que sin este bloque nada impedía volver a escribirla.

for (const pedido of ["Radiografía para pie", "electrocardiograma", "fisioterapia", "tomografía"]) {
  const texto = unlistedAnswer(pedido);
  check(`unlistedAnswer("${pedido}") no niega`, qaAnswerIsUnsafe(texto), false);
  check(`unlistedAnswer("${pedido}") repite el pedido`, texto.includes(pedido), true);
  // Si no pide los datos, el paciente queda esperando y nadie recopila nada.
  check(`unlistedAnswer("${pedido}") pide los datos`, /nombre completo/i.test(texto) && /d[ií]a y hora/i.test(texto), true);
}

// ─── 3. Pedidos que el código reconoce como fuera de catálogo ────────────────
// No son "cosas que no hacemos": son cosas que NO SABEMOS, y por eso no pueden
// terminar en el Q&A libre.

const FUERA_DE_CATALOGO = [
  "Por favor el precio de la Radiografía",
  "radiografia de pie cuanto sale",
  "necesitan orden para los rayos x?",
  "cuanto está el electrocardiograma",
  "hacen tomografia computarizada?",
  "quiero una resonancia magnetica de rodilla",
  "atienden fisioterapia?",
  "buenas, hacen odontologia?",
  "necesito un oftalmologo para mi mama",
];

for (const text of FUERA_DE_CATALOGO) {
  check(`fuera de catálogo: "${text}"`, mentionsOffCatalogRequest(text), true);
}

// ─── 4. Lo que SÍ está en el tarifario no se toca ────────────────────────────
// matchService() se evalúa antes que la lista de fuera de catálogo, así que
// estos siguen cotizándose con su precio real. Acá se comprueba lo que importa:
// que el catálogo los reconozca.

const EN_CATALOGO = [
  "cuanto cuesta la ecografia abdominal",
  "precio del papanicolau",
  "quiero que me saquen los puntos",
  "cuanto sale el lavado de oido",
  "colocacion de implante subdermico precio",
];

for (const text of EN_CATALOGO) {
  check(`en catálogo: "${text}"`, matchService(text, defaultServices) !== null, true);
}

// Mensajes cotidianos que no deben activar nada.
for (const text of ["a que hora abren?", "donde quedan?", "quiero una ficha para pediatria", "gracias!"]) {
  check(`no activa fuera de catálogo: "${text}"`, mentionsOffCatalogRequest(text), false);
}

console.log(failures === 0 ? "\n✅ Todo bien: el bot no puede negar un servicio." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
