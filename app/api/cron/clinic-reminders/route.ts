// ============================================================================
// Cron — Recordatorios de cita (día antes)
// ----------------------------------------------------------------------------
// Ruta: GET /api/cron/clinic-reminders
// Protegida por: Authorization: Bearer <CLINIC_REMIND_CRON_SECRET>
//
// Corre UNA vez al día (límite del plan gratuito de Vercel: los crons Hobby
// solo se disparan 1x/día). Por eso no usamos una ventana relativa de horas
// (23-25h desde "ahora"), sino que buscamos directamente las citas `confirmed`
// cuyo scheduled_start cae en el día calendario de MAÑANA (zona horaria de la
// clínica). Se recomienda agendar este cron temprano en la mañana (ver
// vercel.json) para cubrir todas las citas del día siguiente.
//
// Envía WhatsApp al paciente y marca reminder_sent = true para no duplicar.
// Si la ventana de servicio de WhatsApp (24h desde el último mensaje del
// cliente) está cerrada, el envío se salta (ver isWithinServiceWindow) hasta
// que existan plantillas aprobadas por Meta.
// ============================================================================

import { getKapsoClient } from "@/lib/engine/clients";
import { getErrorMessage } from "@/lib/engine/logging";
import { getDoctorById, listAllBusinessSlugs } from "@/lib/clinic/data";
import { getSupabaseClient } from "@/lib/engine/clients";
import { isWithinServiceWindow } from "@/lib/engine/data";
import { getClinicConfig } from "@/lib/clinic/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Envía recordatorios en serie a varios pacientes; evita timeout a mitad del batch.
export const maxDuration = 60;

function formatSlot(isoUtc: string, timezone: string): string {
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

// ─── Helpers de zona horaria (día calendario "mañana" en la zona de la clínica) ─

function tzOffsetMs(timeZone: string, date: Date): number {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(date.toLocaleString("en-US", { timeZone }));
  return local.getTime() - utc.getTime();
}

function zonedWallTimeToUtc(
  timeZone: string,
  year: number,
  month1to12: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guessUtc = Date.UTC(year, month1to12 - 1, day, hour, minute, 0);
  const offset = tzOffsetMs(timeZone, new Date(guessUtc));
  return new Date(guessUtc - offset);
}

function dateParts(timeZone: string, date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

export async function GET(request: Request) {
  // Vercel Cron solo agrega automáticamente "Authorization: Bearer <valor>"
  // cuando la env var se llama exactamente CRON_SECRET. Aceptamos esa (para la
  // invocación automática) y también CLINIC_REMIND_CRON_SECRET (para pruebas
  // manuales con curl), sin romper la que ya estuviera configurada.
  const auth = request.headers.get("Authorization");
  const validSecrets = [process.env.CRON_SECRET, process.env.CLINIC_REMIND_CRON_SECRET].filter(
    (s): s is string => Boolean(s),
  );
  if (!validSecrets.length || !validSecrets.some((s) => auth === `Bearer ${s}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = getSupabaseClient();
  const businesses = await listAllBusinessSlugs();

  const results = { sent: 0, failed: 0, skipped_window_closed: 0, clinics: 0 };

  for (const business of businesses) {
    const clinic = await getClinicConfig(business);
    results.clinics++;

    // Día calendario de "mañana" en la zona horaria de ESTA clínica → rango UTC.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { year, month, day } = dateParts(clinic.timezone, tomorrow);
    const windowStart = zonedWallTimeToUtc(clinic.timezone, year, month, day, 0, 0).toISOString();
    const windowEnd = zonedWallTimeToUtc(clinic.timezone, year, month, day, 23, 59).toISOString();

    const { data: appts, error } = await supabase
      .from("clinic_appointments")
      .select("*")
      .eq("business", clinic.slug)
      .eq("status", "confirmed")
      .eq("reminder_sent", false)
      .gte("scheduled_start", windowStart)
      .lte("scheduled_start", windowEnd);

    if (error) {
      console.error("clinic-reminders query failed", { business, error });
      continue;
    }

    const phoneNumberId = clinic.kapsoPhoneNumberId ?? process.env.KAPSO_PHONE_NUMBER_ID;
    if (!phoneNumberId) {
      console.warn("clinic-reminders: no phoneNumberId for business, skipping", { business });
      continue;
    }

    for (const appt of appts ?? []) {
      try {
        // WhatsApp solo permite texto libre dentro de la ventana de 24h desde el
        // último mensaje del cliente. Si la ventana está cerrada, saltamos el envío
        // (sin marcar reminder_sent) hasta tener plantillas aprobadas por Meta.
        const windowOpen = await isWithinServiceWindow(appt.contact_phone);
        if (!windowOpen) {
          results.skipped_window_closed++;
          continue;
        }

        const doctor = appt.doctor_id ? await getDoctorById(appt.doctor_id) : null;
        const friendlySlot = appt.scheduled_start ? formatSlot(appt.scheduled_start, clinic.timezone) : "su cita";

        const kapso = getKapsoClient();

        await kapso.messages.sendText({
          phoneNumberId,
          to: appt.contact_phone,
          body: [
            `📅 *Recordatorio de cita — ${clinic.clinicName}*`,
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
        console.error("clinic reminder send failed", { business, id: appt.id, error: getErrorMessage(err) });
        results.failed++;
      }
    }
  }

  console.log("clinic-reminders cron done", results);
  return Response.json({ ok: true, results });
}
