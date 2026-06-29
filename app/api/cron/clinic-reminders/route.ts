// ============================================================================
// Cron — Recordatorios de cita 24h antes
// ----------------------------------------------------------------------------
// Ruta: GET /api/cron/clinic-reminders
// Protegida por: Authorization: Bearer <CLINIC_REMIND_CRON_SECRET>
//
// Busca citas `confirmed` cuyo scheduled_start esté entre 23h y 25h desde
// ahora y cuyo reminder_sent sea false, envía WhatsApp al paciente y marca
// reminder_sent = true para no duplicar.
// ============================================================================

import { getKapsoClient, getRequiredEnv } from "@/lib/engine/clients";
import { getErrorMessage } from "@/lib/engine/logging";
import { getDoctorById } from "@/lib/clinic/data";
import { getSupabaseClient } from "@/lib/engine/clients";
import { clinic } from "@/lib/clinic/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatSlot(isoUtc: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: clinic.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoUtc));
}

export async function GET(request: Request) {
  const secret = process.env.CLINIC_REMIND_CRON_SECRET;
  const auth = request.headers.get("Authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = getSupabaseClient();
  const now = Date.now();
  const windowStart = new Date(now + 23 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(now + 25 * 60 * 60 * 1000).toISOString();

  const { data: appts, error } = await supabase
    .from("clinic_appointments")
    .select("*")
    .eq("business", clinic.slug)
    .eq("status", "confirmed")
    .eq("reminder_sent", false)
    .gte("scheduled_start", windowStart)
    .lte("scheduled_start", windowEnd);

  if (error) {
    console.error("clinic-reminders query failed", error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const results = { sent: 0, failed: 0 };

  for (const appt of appts ?? []) {
    try {
      const doctor = appt.doctor_id ? await getDoctorById(appt.doctor_id) : null;
      const friendlySlot = appt.scheduled_start ? formatSlot(appt.scheduled_start) : "su cita";

      const kapso = getKapsoClient();
      const phoneNumberId = getRequiredEnv("KAPSO_PHONE_NUMBER_ID");

      await kapso.messages.sendText({
        phoneNumberId,
        to: appt.contact_phone,
        body: [
          `📅 *Recordatorio de cita — Clínica San Martín de Porres*`,
          ``,
          `Hola ${appt.patient_name ?? ""}! Le recordamos su cita de mañana:`,
          ``,
          `📅 ${friendlySlot}`,
          doctor ? `👨‍⚕️ ${doctor.name}` : "",
          `💊 ${appt.reason ?? "—"}`,
          ``,
          `📍 ${clinic.generalInfo.address}`,
          `🗺️ ${clinic.generalInfo.mapsUrl}`,
          ``,
          `Si necesita cancelar o reprogramar, escríbanos con anticipación 😊`,
        ].filter(Boolean).join("\n"),
      });

      await supabase
        .from("clinic_appointments")
        .update({ reminder_sent: true })
        .eq("id", appt.id);

      results.sent++;
    } catch (err) {
      console.error("clinic reminder send failed", { id: appt.id, error: getErrorMessage(err) });
      results.failed++;
    }
  }

  console.log("clinic-reminders cron done", results);
  return Response.json({ ok: true, results });
}
