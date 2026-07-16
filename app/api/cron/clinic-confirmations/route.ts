// ============================================================================
// Cron — Confirmaciones de citas clínica
// ----------------------------------------------------------------------------
// Ruta: GET /api/cron/clinic-confirmations
// Protegida por: Authorization: Bearer <CRON_SECRET> (o <CLINIC_CONFIRM_CRON_SECRET>)
//
// Flujo:
//   A) Citas `confirmed` sin google_event_id → crea evento en Calendar +
//      envía WhatsApp de confirmación al paciente + guarda google_event_id.
//   B) Citas `canceled` con google_event_id → borra evento en Calendar +
//      notifica al paciente si procede.
//
// La secretaria solo cambia el status en Supabase (de payment_review → confirmed
// o → canceled). Este cron hace el resto automáticamente.
// ============================================================================

import { getKapsoClient, getRequiredEnv } from "@/lib/engine/clients";
import { getErrorMessage } from "@/lib/engine/logging";
import {
  getConfirmedAppointmentsWithoutEvent,
  getCanceledAppointmentsWithEvent,
  getDoctorById,
  getSpecialtyById,
  updateAppointment,
} from "@/lib/clinic/data";
import {
  createAppointmentEvent,
  deleteAppointmentEvent,
} from "@/lib/clinic/googleCalendar";
import { clinic } from "@/lib/clinic/config";

// Puede procesar varias citas en serie (crear/borrar eventos + enviar WhatsApp),
// así que subimos el límite por defecto de Vercel para no cortar a mitad del batch.
export const runtime = "nodejs";
export const maxDuration = 60;

const BUSINESS = clinic.slug;

export async function GET(request: Request) {
  // ── Autenticación ─────────────────────────────────────────────────────────
  // Acepta CRON_SECRET (la misma que ya usa el cron de recordatorios) para no
  // requerir una env var aparte, y CLINIC_CONFIRM_CRON_SECRET si se prefiere
  // una dedicada.
  const authHeader = request.headers.get("Authorization");
  const validSecrets = [process.env.CRON_SECRET, process.env.CLINIC_CONFIRM_CRON_SECRET].filter(
    (s): s is string => Boolean(s),
  );
  if (!validSecrets.length || !validSecrets.some((s) => authHeader === `Bearer ${s}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const results = {
    confirmed: { processed: 0, failed: 0 },
    canceled: { processed: 0, failed: 0 },
  };

  // ── A) Confirmar citas: crear evento en Calendar + notificar ──────────────
  let confirmedAppts: Awaited<ReturnType<typeof getConfirmedAppointmentsWithoutEvent>>;

  try {
    confirmedAppts = await getConfirmedAppointmentsWithoutEvent(BUSINESS);
  } catch (err) {
    console.error("getConfirmedAppointmentsWithoutEvent failed", err);
    confirmedAppts = [];
  }

  for (const appt of confirmedAppts) {
    try {
      if (!appt.doctorId || !appt.scheduledStart || !appt.scheduledEnd) {
        console.warn("confirmed appointment missing required fields", { id: appt.id });
        results.confirmed.failed++;
        continue;
      }

      const doctor = await getDoctorById(appt.doctorId);
      if (!doctor?.googleCalendarId) {
        console.warn("doctor has no calendar id", { appointmentId: appt.id, doctorId: appt.doctorId });
        results.confirmed.failed++;
        continue;
      }

      const specialty = appt.specialtyId ? await getSpecialtyById(appt.specialtyId) : null;

      const eventId = await createAppointmentEvent({
        calendarId: doctor.googleCalendarId,
        timezone: doctor.timezone,
        startIso: appt.scheduledStart,
        endIso: appt.scheduledEnd,
        summary: `Cita: ${appt.patientName ?? "Paciente"} — ${doctor.name}`,
        description: [
          `Paciente: ${appt.patientName ?? "—"}`,
          `CI: ${appt.patientCi ?? "—"}`,
          `Tel: ${appt.contactPhone}`,
          `Especialidad: ${specialty?.name ?? "—"}`,
          `Motivo: ${appt.reason ?? "—"}`,
          `Pago: ${appt.paymentMethod === "qr" ? "QR BNB" : "Efectivo"}`,
        ].join("\n"),
      });

      if (eventId) {
        await updateAppointment(appt.id, { googleEventId: eventId });
      }

      // Notificar al paciente por WhatsApp.
      if (appt.contactPhone && appt.scheduledStart) {
        const friendlySlot = new Intl.DateTimeFormat("es-BO", {
          timeZone: clinic.timezone,
          weekday: "long",
          day: "numeric",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(appt.scheduledStart));

        try {
          const kapso = getKapsoClient();
          const phoneNumberId = getRequiredEnv("KAPSO_PHONE_NUMBER_ID");

          await kapso.messages.sendText({
            phoneNumberId,
            to: appt.contactPhone,
            body: [
              `✅ *¡Su cita ha sido confirmada!*`,
              ``,
              `📅 ${friendlySlot}`,
              `👨‍⚕️ ${doctor.name}`,
              `👤 ${appt.patientName ?? "—"}`,
              `💊 ${appt.reason ?? "—"}`,
              ``,
              `📍 ${clinic.generalInfo.address}`,
              `🗺️ ${clinic.generalInfo.mapsUrl}`,
              ``,
              `¡Le esperamos! 😊`,
            ].join("\n"),
          });
        } catch (sendErr) {
          console.error("kapso sendText (confirm notification) failed", {
            appointmentId: appt.id,
            error: getErrorMessage(sendErr),
          });
        }
      }

      results.confirmed.processed++;
    } catch (err) {
      console.error("processing confirmed appointment failed", {
        id: appt.id,
        error: getErrorMessage(err),
      });
      results.confirmed.failed++;
    }
  }

  // ── B) Canceladas con evento: borrar en Calendar ──────────────────────────
  let canceledAppts: Awaited<ReturnType<typeof getCanceledAppointmentsWithEvent>>;

  try {
    canceledAppts = await getCanceledAppointmentsWithEvent(BUSINESS);
  } catch (err) {
    console.error("getCanceledAppointmentsWithEvent failed", err);
    canceledAppts = [];
  }

  for (const appt of canceledAppts) {
    try {
      if (!appt.doctorId || !appt.googleEventId) {
        results.canceled.failed++;
        continue;
      }

      const doctor = await getDoctorById(appt.doctorId);
      if (!doctor?.googleCalendarId) {
        results.canceled.failed++;
        continue;
      }

      await deleteAppointmentEvent(doctor.googleCalendarId, appt.googleEventId);
      // Limpiar el event_id para que este cron no lo procese de nuevo.
      await updateAppointment(appt.id, { googleEventId: null as unknown as string });

      results.canceled.processed++;
    } catch (err) {
      console.error("processing canceled appointment (event delete) failed", {
        id: appt.id,
        error: getErrorMessage(err),
      });
      results.canceled.failed++;
    }
  }

  console.log("clinic-confirmations cron done", results);

  return Response.json({ ok: true, results });
}
