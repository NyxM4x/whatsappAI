// ============================================================================
// Simulación de conversaciones contra advanceBooking.
// ----------------------------------------------------------------------------
// Llama al flujo de reserva como lo haría el webhook, pero SIN enviar nada por
// WhatsApp: advanceBooking solo devuelve el texto de la respuesta.
//
// Necesita OPENAI_API_KEY (interpreta respuestas ambiguas). Los pasos desde
// choosing_slot en adelante necesitan además GOOGLE_SERVICE_ACCOUNT_JSON.
//
//   npx tsx scripts/check-flujo.ts
// ============================================================================

import { readFileSync } from "node:fs";
import { advanceBooking, cancelActiveAppointment } from "../lib/clinic/booking";
import { getClinicConfig } from "../lib/clinic/config";
import { getBookingSession, resetBookingSession } from "../lib/clinic/data";
import type { BookingSession } from "../lib/clinic/types";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const clinic = await getClinicConfig();
const TELEFONO = "59100000000"; // número inexistente: nada sale de acá
const usadas: string[] = [];

function corta(texto: string, max = 150): string {
  const plano = texto.replace(/\s+/g, " ").trim();
  return plano.length > max ? plano.slice(0, max) + "…" : plano;
}

let fallos = 0;

async function conversacion(
  titulo: string,
  turnos: string[],
  opts: { debeContener?: string[] } = {},
) {
  const conversationId = `test-flujo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  usadas.push(conversationId);

  console.log(`\n${"═".repeat(76)}`);
  console.log(titulo);
  console.log("═".repeat(76));

  let session: BookingSession = await getBookingSession(conversationId);
  const todo: string[] = [];

  for (const texto of turnos) {
    console.log(`\n  paciente │ ${texto}`);
    try {
      const r = await advanceBooking({
        conversationId,
        business: clinic.slug,
        contactPhone: TELEFONO,
        incomingText: texto,
        session,
        clinic,
      });
      session = r.session;
      todo.push(r.reply);
      console.log(`  bot      │ ${corta(r.reply)}`);
      console.log(`           └─ paso: ${session.step}${r.action !== "none" ? ` · acción: ${r.action}` : ""}`);
    } catch (err: any) {
      console.log(`  bot      │ ✗ ERROR: ${err?.message ?? err}`);
      fallos++;
      break;
    }
  }

  // Aserciones sobre lo que respondió el bot en toda la conversación.
  for (const esperado of opts.debeContener ?? []) {
    const ok = todo.join("\n").includes(esperado);
    if (!ok) fallos++;
    console.log(`\n  ${ok ? "✓" : "✗"} la respuesta ${ok ? "incluye" : "NO incluye"} "${esperado}"`);
  }
}

// ── 1. El caso real que falló ayer ───────────────────────────────────────────
// Paciente 59164***43, 17:12. Escribió "Pediatría" dos veces y el bot repitió
// la lista; solo avanzó cuando puso "2". Ese día OpenAI estaba caído.
await conversacion(
  "CASO REAL DE AYER — el paciente escribe la especialidad en palabras",
  ["Quería reservar ficha?", "Pediatría quería saber si hacen laboratorio?", "Pediatría"],
);

// ── 2. Elegir por número ─────────────────────────────────────────────────────
await conversacion("Elegir especialidad por número", ["quiero agendar una cita", "2"]);

// ── 3. Pedir un médico por nombre ────────────────────────────────────────────
// "Y el doctor daguino" fue otra frase real que el bot ignoró.
await conversacion(
  "Pedir médico por nombre",
  ["necesito una cita con pediatría", "2", "con el doctor daguino"],
);

// ── 4. Salirse del flujo ─────────────────────────────────────────────────────
await conversacion("Abandonar el flujo a mitad", ["quiero una cita", "medicina general", "mejor no, gracias"]);

// ── 5. Pregunta suelta dentro del flujo ──────────────────────────────────────
// Antes inventaba: "está ubicada en el corazón de la ciudad". Ahora replyInContext
// recibe el system prompt completo de la clínica, así que debe dar la calle real.
await conversacion(
  "Pregunta fuera de contexto sin perder el paso",
  ["quiero agendar", "dónde están ubicados?", "y a qué teléfono los llamo?"],
  { debeContener: ["Moscú", "773 85 200"] },
);

// ── 6. Cancelación: pide confirmación y respeta el "no" ──────────────────────
// Antes cancelaba de una, sin preguntar: "quería cancelar… mejor no" ya había
// borrado la cita y su evento de Calendar.
{
  const conversationId = `test-flujo-${Date.now()}-cancel`;
  usadas.push(conversationId);
  console.log(`\n${"═".repeat(76)}`);
  console.log("Cancelar sin cita activa (no debe romperse)");
  console.log("═".repeat(76));

  const r = await cancelActiveAppointment({
    conversationId,
    business: clinic.slug,
    contactPhone: TELEFONO,
    session: await getBookingSession(conversationId),
    clinic,
  });
  console.log(`\n  paciente │ quiero cancelar mi cita`);
  console.log(`  bot      │ ${corta(r.reply)}`);
  console.log(`           └─ paso: ${r.session.step}`);

  const ok = r.session.step === "idle";
  if (!ok) fallos++;
  console.log(`\n  ${ok ? "✓" : "✗"} sin cita activa vuelve a idle, no queda colgado en confirming_cancel`);
}

// ── Limpieza ─────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(76)}`);
for (const id of usadas) await resetBookingSession(id, clinic.slug);
console.log(`Limpieza: ${usadas.length} sesiones de prueba borradas.`);
console.log(fallos === 0 ? "✓ Sin fallos." : `✗ ${fallos} fallo(s).`);
