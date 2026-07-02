// ============================================================================
// Máquina de estados del agendamiento — Clínica San Martín de Porres
// ----------------------------------------------------------------------------
// Flujo:
//   idle → choosing_specialty → choosing_doctor* → choosing_slot
//        → collecting_name → collecting_ci → collecting_reason
//        → choosing_payment → (qr) awaiting_proof | (cash) done
//
// * choosing_doctor se salta si la especialidad solo tiene un doctor activo.
//
// Bloqueo de 30 min (OBLIGATORIO MVP):
//   Al confirmar slot → re-verificar disponibilidad → escribir hold en BD
//   → pasar a collecting_name. Si el slot fue tomado → re-ofrecer.
//
// QR: la cita queda awaiting_payment; la secretaria confirma manualmente.
// Efectivo: se crea el evento en Google Calendar de inmediato.
// ============================================================================

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

import {
  getBusyIntervals,
  computeAvailableSlots,
  createAppointmentEvent,
  deleteAppointmentEvent,
} from "@/lib/clinic/googleCalendar";
import {
  getSpecialties,
  getDoctorsBySpecialty,
  getDoctorById,
  saveBookingSession,
  resetBookingSession,
  writeHold,
  getActiveHoldsForDoctor,
  getActiveAppointmentSlotsForDoctor,
  createAppointment,
  updateAppointment,
  findActiveAppointmentByPhone,
} from "@/lib/clinic/data";
import type {
  BookingSession,
  BookingDraft,
  BookingHold,
  TimeSlot,
  Doctor,
} from "@/lib/clinic/types";
import { clinic } from "@/lib/clinic/config";

// ─── Tipos de resultado ──────────────────────────────────────────────────────

export type BookingAction = "send_qr" | "none";

export type BookingResult = {
  reply: string;
  action: BookingAction;
  session: BookingSession;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatSlotLocal(isoUtc: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoUtc));
}

function parseNumberChoice(text: string): number | null {
  const clean = text.trim();
  const n = parseInt(clean, 10);
  if (!isNaN(n) && String(n) === clean) return n;
  const words: Record<string, number> = {
    uno: 1, "1ro": 1, primero: 1,
    dos: 2, "2do": 2, segundo: 2,
    tres: 3, "3ro": 3, tercero: 3,
    cuatro: 4, "4to": 4, cuarto: 4,
    cinco: 5, "5to": 5, quinto: 5,
  };
  return words[clean.toLowerCase()] ?? null;
}

// Usa OpenAI para resolver lenguaje natural a un índice de lista cuando
// parseNumberChoice no pudo hacerlo.
async function resolveChoiceWithAI(userText: string, options: string[]): Promise<number | null> {
  if (!options.length) return null;
  const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: "El usuario está eligiendo una opción de una lista. Responde SOLO con el número de la opción que mejor coincide con lo que escribió. Si no coincide con ninguna, responde 0.",
      prompt: `Lista:\n${list}\n\nEl usuario escribió: "${userText}"\n\n¿Con qué número coincide?`,
      temperature: 0,
    });
    const n = parseInt(text.trim(), 10);
    if (!isNaN(n) && n >= 1 && n <= options.length) return n;
    return null;
  } catch {
    return null;
  }
}

function emptyHold(): BookingHold {
  return { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null };
}

function reply(text: string, action: BookingAction, session: BookingSession): BookingResult {
  return { reply: text, action, session };
}

async function saveAndReturn(
  conversationId: string,
  business: string,
  step: BookingSession["step"],
  draft: BookingDraft,
  hold: BookingHold,
): Promise<BookingSession> {
  await saveBookingSession({ conversationId, business, step, draft, hold });
  return { conversationId, step, draft, hold };
}

async function resetAndReturn(conversationId: string, business: string): Promise<BookingSession> {
  await resetBookingSession(conversationId, business);
  return { conversationId, step: "idle", draft: {}, hold: emptyHold() };
}

// Slots libres para un doctor, excluyendo holds y citas activas en BD.
async function getAvailableSlots(doctor: Doctor, conversationId: string): Promise<TimeSlot[]> {
  if (!doctor.googleCalendarId) return [];

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const [busy, holds, activeAppts] = await Promise.all([
    getBusyIntervals(doctor.googleCalendarId, timeMin, timeMax),
    getActiveHoldsForDoctor(doctor.id, conversationId),
    getActiveAppointmentSlotsForDoctor(doctor.id, timeMin, timeMax),
  ]);

  return computeAvailableSlots({
    doctor,
    busy,
    excludeSlots: [...holds, ...activeAppts],
    fromDate: now,
    daysAhead: 14,
    maxSlots: 10,
  });
}

function slotsMessage(slots: TimeSlot[], tz: string): string {
  const lines = slots.map((s, i) => `  ${i + 1}. ${formatSlotLocal(s.start, tz)}`);
  return `Estos son los horarios disponibles:\n\n${lines.join("\n")}\n\n¿Cuál le viene bien?`;
}

// ─── Avanzar la máquina de pasos ─────────────────────────────────────────────

export async function advanceBooking(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  incomingText: string;
  session: BookingSession;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone, incomingText, session } = params;
  const text = incomingText.trim();
  let { step, draft, hold } = session;

  // ── idle / start ──────────────────────────────────────────────────────────
  if (step === "idle") {
    const specialties = await getSpecialties(business);
    if (!specialties.length) {
      return reply(
        "Lo sentimos, en este momento no hay especialidades disponibles. Contáctenos al +591 75681881.",
        "none",
        { conversationId, step: "idle", draft: {}, hold: emptyHold() },
      );
    }
    const lines = specialties.map((s, i) => `  ${i + 1}. ${s.name}`).join("\n");
    draft = {};
    const newSession = await saveAndReturn(conversationId, business, "choosing_specialty", draft, emptyHold());
    return reply(`Perfecto 😊 ¿Qué especialidad necesita?\n\n${lines}\n\n¿Cuál necesita?`, "none", newSession);
  }

  // ── choosing_specialty ────────────────────────────────────────────────────
  if (step === "choosing_specialty") {
    const specialties = await getSpecialties(business);
    const idx = parseNumberChoice(text) ?? await resolveChoiceWithAI(text, specialties.map(s => s.name));

    if (!idx || idx < 1 || idx > specialties.length) {
      const lines = specialties.map((s, i) => `  ${i + 1}. ${s.name}`).join("\n");
      return reply(`No entendí bien 😊 ¿Cuál de estas especialidades necesita?\n\n${lines}`, "none", session);
    }

    const specialty = specialties[idx - 1];
    draft = { ...draft, specialtyId: specialty.id, specialtyName: specialty.name };

    const doctors = await getDoctorsBySpecialty(business, specialty.id);
    if (!doctors.length) {
      const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
      return reply(`Lo sentimos, ${specialty.name} no tiene médicos disponibles. ¿Desea elegir otra especialidad?`, "none", newSession);
    }

    if (doctors.length === 1) {
      const doctor = doctors[0];
      draft = { ...draft, doctorId: doctor.id, doctorName: doctor.name };

      const slots = await getAvailableSlots(doctor, conversationId);
      if (!slots.length) {
        const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
        return reply(`No hay horarios disponibles para ${doctor.name} en los próximos días. ¿Puedo ayudarle en algo más?`, "none", newSession);
      }

      draft = { ...draft, offeredSlots: slots };
      const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
      return reply(`Atenderá *${doctor.name}*.\n\n${slotsMessage(slots, clinic.timezone)}`, "none", newSession);
    }

    const lines = doctors.map((d, i) => `  ${i + 1}. ${d.name}${d.consultationPrice ? ` — ${d.consultationPrice} Bs` : ""}`).join("\n");
    const newSession = await saveAndReturn(conversationId, business, "choosing_doctor", draft, emptyHold());
    return reply(`Médicos disponibles en ${specialty.name}:\n\n${lines}\n\n¿Con quién prefiere?`, "none", newSession);
  }

  // ── choosing_doctor ───────────────────────────────────────────────────────
  if (step === "choosing_doctor") {
    const doctors = draft.specialtyId ? await getDoctorsBySpecialty(business, draft.specialtyId) : [];
    const idx = parseNumberChoice(text) ?? await resolveChoiceWithAI(text, doctors.map(d => d.name));

    if (!idx || !doctors[idx - 1]) {
      const lines = doctors.map((d, i) => `  ${i + 1}. ${d.name}`).join("\n");
      return reply(`No entendí bien 😊 ¿Con cuál de estos médicos prefiere?\n\n${lines}`, "none", session);
    }

    const doctor = doctors[idx - 1];
    draft = { ...draft, doctorId: doctor.id, doctorName: doctor.name };

    const slots = await getAvailableSlots(doctor, conversationId);
    if (!slots.length) {
      const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
      return reply(`No hay horarios disponibles para ${doctor.name}. ¿Desea elegir otro médico?`, "none", newSession);
    }

    draft = { ...draft, offeredSlots: slots };
    const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
    return reply(slotsMessage(slots, clinic.timezone), "none", newSession);
  }

  // ── choosing_slot ─────────────────────────────────────────────────────────
  if (step === "choosing_slot") {
    const slots = draft.offeredSlots ?? [];
    const slotLabels = slots.map(s => formatSlotLocal(s.start, clinic.timezone));
    const idx = parseNumberChoice(text) ?? await resolveChoiceWithAI(text, slotLabels);

    if (!idx || !slots[idx - 1]) {
      return reply(`No entendí bien 😊 ¿Cuál de estos horarios le viene bien?\n\n${slotsMessage(slots, clinic.timezone)}`, "none", session);
    }

    const chosen = slots[idx - 1];

    if (!draft.doctorId) {
      return reply("Ocurrió un error al recuperar el médico. Comencemos de nuevo.", "none", await resetAndReturn(conversationId, business));
    }

    const doctor = await getDoctorById(draft.doctorId);
    if (!doctor || !doctor.googleCalendarId) {
      return reply("No pude verificar la disponibilidad. Intente de nuevo.", "none", await resetAndReturn(conversationId, business));
    }

    // Re-verificar disponibilidad justo antes de escribir el hold.
    const nowIso = new Date().toISOString();
    const [busyNow, holdsNow, activeAppts] = await Promise.all([
      getBusyIntervals(doctor.googleCalendarId, nowIso, chosen.end),
      getActiveHoldsForDoctor(doctor.id, conversationId),
      getActiveAppointmentSlotsForDoctor(doctor.id, nowIso, chosen.end),
    ]);

    const chosenStart = new Date(chosen.start).getTime();
    const chosenEnd = new Date(chosen.end).getTime();

    function slotOverlaps(b: TimeSlot) {
      return new Date(b.start).getTime() < chosenEnd && new Date(b.end).getTime() > chosenStart;
    }

    if (busyNow.some(slotOverlaps) || holdsNow.some(slotOverlaps) || activeAppts.some(slotOverlaps)) {
      const freshSlots = await getAvailableSlots(doctor, conversationId);
      if (!freshSlots.length) {
        const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
        return reply("Ese horario ya no está disponible y no quedan turnos libres. ¿Le puedo ayudar en otra cosa?", "none", newSession);
      }
      draft = { ...draft, offeredSlots: freshSlots };
      const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
      return reply(`Ese horario acaba de ser tomado 😔 Aquí los próximos disponibles:\n\n${slotsMessage(freshSlots, clinic.timezone)}`, "none", newSession);
    }

    // Slot libre → escribir hold de 30 minutos.
    draft = { ...draft, slotStart: chosen.start, slotEnd: chosen.end, offeredSlots: undefined };
    const newHold: BookingHold = {
      heldDoctorId: doctor.id,
      heldSlotStart: chosen.start,
      holdExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    await writeHold({
      conversationId,
      business,
      step: "collecting_name",
      draft,
      doctorId: doctor.id,
      slotStart: chosen.start,
    });

    const friendlySlot = formatSlotLocal(chosen.start, clinic.timezone);
    return reply(
      `¡Aparté su horario por 30 minutos! 🎉\n\n📅 *${friendlySlot}*\n👨‍⚕️ ${doctor.name}\n\nPara confirmar necesito algunos datos.\n\n¿Cuál es su *nombre completo*?`,
      "none",
      { conversationId, step: "collecting_name", draft, hold: newHold },
    );
  }

  // ── collecting_name ───────────────────────────────────────────────────────
  if (step === "collecting_name") {
    if (text.length < 3) return reply("Por favor ingrese su nombre completo.", "none", session);
    draft = { ...draft, patientName: text };
    const newSession = await saveAndReturn(conversationId, business, "collecting_ci", draft, hold);
    return reply("Gracias 😊 ¿Cuál es su *número de Carnet de Identidad* (CI)?", "none", newSession);
  }

  // ── collecting_ci ─────────────────────────────────────────────────────────
  if (step === "collecting_ci") {
    const ci = text.replace(/\s+/g, "");
    if (ci.length < 5) return reply("Por favor ingrese un número de CI válido.", "none", session);
    draft = { ...draft, patientCi: ci };
    const newSession = await saveAndReturn(conversationId, business, "collecting_reason", draft, hold);
    return reply("Anotado ✅ ¿Cuál es el *motivo de consulta*? (puede ser breve, ej: 'dolor de cabeza', 'control general')", "none", newSession);
  }

  // ── collecting_reason ─────────────────────────────────────────────────────
  if (step === "collecting_reason") {
    if (text.length < 3) return reply("Por favor indique brevemente el motivo de su consulta.", "none", session);
    draft = { ...draft, reason: text };
    const newSession = await saveAndReturn(conversationId, business, "choosing_payment", draft, hold);

    let price = 150;
    if (draft.doctorId) {
      const doc = await getDoctorById(draft.doctorId);
      price = doc?.consultationPrice ?? 150;
    }

    return reply(
      `Perfecto 😊 ¿Cómo prefiere pagar la consulta? (${price} Bs)\n\n  1. QR BNB\n  2. Efectivo\n\n(responda 1 o 2)`,
      "none",
      newSession,
    );
  }

  // ── choosing_payment ──────────────────────────────────────────────────────
  if (step === "choosing_payment") {
    const choice = parseNumberChoice(text);
    const lc = text.toLowerCase();
    let paymentMethod: "qr" | "cash" | null = null;

    if (choice === 1 || lc.includes("qr") || lc.includes("código") || lc.includes("transferencia")) {
      paymentMethod = "qr";
    } else if (choice === 2 || lc.includes("efectivo") || lc.includes("cash") || lc.includes("contado")) {
      paymentMethod = "cash";
    }

    if (!paymentMethod) {
      return reply("No entendí 😊 Responda *1* para QR BNB o *2* para Efectivo.", "none", session);
    }

    draft = { ...draft, paymentMethod };

    if (!draft.doctorId || !draft.slotStart || !draft.slotEnd || !draft.patientName) {
      return reply("Hubo un error al recuperar sus datos. Comencemos de nuevo.", "none", await resetAndReturn(conversationId, business));
    }

    const doctor = await getDoctorById(draft.doctorId);
    if (!doctor) {
      return reply("No pude recuperar los datos del médico. Intente de nuevo.", "none", await resetAndReturn(conversationId, business));
    }

    if (paymentMethod === "cash") {
      const appointmentId = await createAppointment({
        business,
        conversationId,
        contactPhone,
        patientName: draft.patientName,
        patientCi: draft.patientCi,
        reason: draft.reason,
        specialtyId: draft.specialtyId,
        doctorId: draft.doctorId,
        scheduledStart: draft.slotStart,
        scheduledEnd: draft.slotEnd,
        status: "confirmed",
        paymentMethod: "cash",
      });

      if (doctor.googleCalendarId) {
        try {
          const eventId = await createAppointmentEvent({
            calendarId: doctor.googleCalendarId,
            timezone: doctor.timezone,
            startIso: draft.slotStart,
            endIso: draft.slotEnd,
            summary: `Cita: ${draft.patientName}`,
            description: [
              `Paciente: ${draft.patientName}`,
              `CI: ${draft.patientCi ?? "—"}`,
              `Tel: ${contactPhone}`,
              `Especialidad: ${draft.specialtyName ?? "—"}`,
              `Motivo: ${draft.reason ?? "—"}`,
              `Pago: Efectivo`,
            ].join("\n"),
          });
          if (appointmentId && eventId) {
            await updateAppointment(appointmentId, { googleEventId: eventId });
          }
        } catch (err) {
          console.error("createAppointmentEvent (cash) failed", err);
        }
      }

      await resetBookingSession(conversationId, business);
      const friendlySlot = formatSlotLocal(draft.slotStart, clinic.timezone);
      return reply(
        `✅ *¡Cita confirmada!*\n\n📅 ${friendlySlot}\n👨‍⚕️ ${doctor.name}\n👤 ${draft.patientName}\n💊 ${draft.reason ?? "—"}\n💵 Pago en efectivo al llegar.\n\n📍 ${clinic.generalInfo.address}\n🗺️ ${clinic.generalInfo.mapsUrl}\n\n¡Hasta pronto! 😊`,
        "none",
        { conversationId, step: "done", draft: {}, hold: emptyHold() },
      );
    }

    // QR → awaiting_payment.
    const appointmentId = await createAppointment({
      business,
      conversationId,
      contactPhone,
      patientName: draft.patientName,
      patientCi: draft.patientCi,
      reason: draft.reason,
      specialtyId: draft.specialtyId,
      doctorId: draft.doctorId,
      scheduledStart: draft.slotStart,
      scheduledEnd: draft.slotEnd,
      status: "awaiting_payment",
      paymentMethod: "qr",
    });

    draft = { ...draft, appointmentId: appointmentId ?? undefined };
    const newSession = await saveAndReturn(conversationId, business, "awaiting_proof", draft, hold);
    const friendlySlot = formatSlotLocal(draft.slotStart, clinic.timezone);
    return reply(
      `Perfecto 😊 Le envío el QR para el pago.\n\n📅 *${friendlySlot}*\n👨‍⚕️ ${doctor.name}\n👤 ${draft.patientName}\n💊 ${draft.reason ?? "—"}\n\nUna vez realizado el pago, envíe el *comprobante* (foto o PDF) y lo validamos. ¡Gracias! 🙏`,
      "send_qr",
      newSession,
    );
  }

  // ── awaiting_proof (texto sin imagen) ─────────────────────────────────────
  if (step === "awaiting_proof") {
    return reply("Estamos esperando el *comprobante de pago* (imagen o PDF). Por favor envíelo para confirmar su cita 😊", "none", session);
  }

  return reply("Su cita ya está registrada. ¿Puedo ayudarle en algo más? 😊", "none", session);
}

// ─── Comprobante recibido (media entrante) ────────────────────────────────────

export async function handlePaymentProof(params: {
  conversationId: string;
  business: string;
  mediaUrl: string;
  session: BookingSession;
}): Promise<BookingResult> {
  const { conversationId, business, session, mediaUrl } = params;
  const { draft } = session;

  if (!draft.appointmentId) {
    const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
    return reply(clinic.replies.proofButNoBooking, "none", newSession);
  }

  // Guardar URL del comprobante primero (independientemente del resultado).
  await updateAppointment(draft.appointmentId, { paymentProofUrl: mediaUrl });

  // AUTO-VALIDACIÓN: desactivada hasta verificar flujos en producción.
  // Para activar: cambiar PAYMENT_AUTO_VALIDATE=true en las env vars.
  const autoValidateEnabled = process.env.PAYMENT_AUTO_VALIDATE === "true";

  // Obtener precio esperado del doctor.
  let expectedPrice: number | null = null;
  if (autoValidateEnabled && draft.doctorId) {
    const doctor = await getDoctorById(draft.doctorId);
    expectedPrice = doctor?.consultationPrice ?? null;
  }

  // Intentar validación automática con GPT-4o-mini vision.
  if (autoValidateEnabled && expectedPrice !== null) {
    try {
      // Descargar imagen con header de autenticación Kapso si está disponible.
      const imgRes = await fetch(mediaUrl, {
        headers: process.env.KAPSO_API_KEY ? { "X-API-Key": process.env.KAPSO_API_KEY } : {},
      });

      if (imgRes.ok) {
        const imgBuffer = await imgRes.arrayBuffer();
        const imgUint8 = new Uint8Array(imgBuffer);

        const { text: rawAmount } = await generateText({
          model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
          messages: [
            {
              role: "user",
              content: [
                { type: "image", image: imgUint8 },
                {
                  type: "text",
                  text: `Este es un comprobante de transferencia/pago QR boliviano. Extrae ÚNICAMENTE el monto total pagado en bolivianos (Bs). Responde solo con el número (ej: "150" o "85.50"). Si no puedes leerlo o no es un comprobante de pago, responde "N/A".`,
                },
              ],
            },
          ],
        });

        const cleaned = rawAmount.trim().replace(/[^0-9.]/g, "");
        const amount = parseFloat(cleaned);

        if (!isNaN(amount) && amount >= expectedPrice) {
          await updateAppointment(draft.appointmentId, { status: "confirmed" });
          const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
          return reply(
            `✅ ¡Pago verificado! Su cita quedó *confirmada* 😊\n\nLe esperamos en la Clínica San Martín de Porres. Cualquier consulta llámenos al +591 75681881. ¡Hasta pronto! 🙏`,
            "none",
            newSession,
          );
        }

        if (!isNaN(amount) && amount < expectedPrice) {
          await updateAppointment(draft.appointmentId, { status: "payment_review" });
          const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
          return reply(
            `Recibimos su comprobante, pero el monto detectado (*${amount} Bs*) no coincide con el precio de consulta (*${expectedPrice} Bs*) 🤔\n\nPor favor verifique el pago y reenvíe el comprobante correcto. Si tiene dudas llámenos al +591 75681881 😊`,
            "none",
            newSession,
          );
        }
      }
    } catch (err) {
      console.error("GPT vision payment validation failed", err);
    }
  }

  // Fallback: guardar en revisión y notificar al cliente.
  await updateAppointment(draft.appointmentId, { status: "payment_review" });
  const newSession = await saveAndReturn(conversationId, business, "idle", {}, emptyHold());
  return reply(clinic.replies.proofReceived, "none", newSession);
}

// ─── Cancelar cita activa ─────────────────────────────────────────────────────

export async function cancelActiveAppointment(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  session: BookingSession;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone } = params;

  // Resetear sesión PRIMERO para que la máquina no quede colgada.
  await resetBookingSession(conversationId, business);

  const appointment = await findActiveAppointmentByPhone(business, contactPhone);
  if (!appointment) {
    return reply(clinic.replies.noActiveAppointment, "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  await updateAppointment(appointment.id, { status: "canceled" });

  if (appointment.googleEventId && appointment.doctorId) {
    const doctor = await getDoctorById(appointment.doctorId);
    if (doctor?.googleCalendarId) {
      try {
        await deleteAppointmentEvent(doctor.googleCalendarId, appointment.googleEventId);
        await updateAppointment(appointment.id, { googleEventId: null as unknown as string });
      } catch (err) {
        console.error("deleteAppointmentEvent (cancel) failed", err);
      }
    }
  }

  const friendlySlot = appointment.scheduledStart
    ? formatSlotLocal(appointment.scheduledStart, clinic.timezone)
    : "su cita";

  return reply(
    `Su cita del *${friendlySlot}* ha sido cancelada ✅. Si desea agendar una nueva, escríbame cuando quiera 😊`,
    "none",
    { conversationId, step: "idle", draft: {}, hold: emptyHold() },
  );
}

// ─── Reprogramar cita activa ──────────────────────────────────────────────────

export async function rescheduleActiveAppointment(params: {
  conversationId: string;
  business: string;
  contactPhone: string;
  session: BookingSession;
}): Promise<BookingResult> {
  const { conversationId, business, contactPhone } = params;

  const appointment = await findActiveAppointmentByPhone(business, contactPhone);
  if (!appointment) {
    return reply(clinic.replies.noActiveAppointment, "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  if (appointment.rescheduleCount >= 1) {
    return reply(
      "Solo se permite una reprogramación por cita 😊 Si necesita cancelar y agendar una nueva, con gusto le ayudo.",
      "none",
      { conversationId, step: "idle", draft: {}, hold: emptyHold() },
    );
  }

  if (!appointment.doctorId) {
    return reply("No pude recuperar los datos de su cita. Contáctenos directamente.", "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  // Cancelar la cita anterior.
  await updateAppointment(appointment.id, { status: "canceled", rescheduleCount: appointment.rescheduleCount + 1 });

  if (appointment.googleEventId && appointment.doctorId) {
    const doctor = await getDoctorById(appointment.doctorId);
    if (doctor?.googleCalendarId) {
      try {
        await deleteAppointmentEvent(doctor.googleCalendarId, appointment.googleEventId);
        await updateAppointment(appointment.id, { googleEventId: null as unknown as string });
      } catch (err) {
        console.error("deleteAppointmentEvent (reschedule) failed", err);
      }
    }
  }

  const doctor = await getDoctorById(appointment.doctorId);
  if (!doctor) {
    await resetBookingSession(conversationId, business);
    return reply("No pude recuperar los datos del médico. Por favor inicie un nuevo agendamiento.", "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  const slots = await getAvailableSlots(doctor, conversationId);
  if (!slots.length) {
    await resetBookingSession(conversationId, business);
    return reply("No hay horarios disponibles para los próximos días. ¿Desea agendar con otra especialidad?", "none", { conversationId, step: "idle", draft: {}, hold: emptyHold() });
  }

  const draft: BookingDraft = {
    specialtyId: appointment.specialtyId ?? undefined,
    doctorId: appointment.doctorId,
    doctorName: doctor.name,
    offeredSlots: slots,
    reschedulingAppointmentId: appointment.id,
  };
  const newSession = await saveAndReturn(conversationId, business, "choosing_slot", draft, emptyHold());
  return reply(`Anulé su cita anterior 😊 Elija el nuevo horario:\n\n${slotsMessage(slots, clinic.timezone)}`, "none", newSession);
}
