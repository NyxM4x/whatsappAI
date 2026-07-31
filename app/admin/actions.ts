"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  ADMIN_COOKIE_NAME,
  createSessionToken,
  isLoginRateLimited,
  recordLoginAttempt,
  requireStaff,
  verifyStaffCredentials,
} from "@/lib/admin/auth";
import { updateAppointment, getAppointmentStatus, getAppointmentById, logAdminAudit } from "@/lib/clinic/data";
import { getClinicConfig } from "@/lib/clinic/config";
import { getKapsoClient } from "@/lib/engine/clients";
import { isWithinServiceWindow } from "@/lib/engine/data";
import { getErrorMessage } from "@/lib/engine/logging";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Formato amigable de fecha/hora de la cita en la zona de la clínica (mismo
// estilo que el recordatorio del cron clinic-reminders).
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

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  if (await isLoginRateLimited(email)) {
    redirect("/admin/login?error=rate_limited");
  }

  const session = await verifyStaffCredentials(email, password);
  await recordLoginAttempt(email, Boolean(session));

  if (!session) {
    // Delay constante ante fallo: dificulta el fuerza-bruta aunque alguien
    // evada el conteo (ej. probando muchos correos distintos).
    await sleep(400);
    redirect("/admin/login?error=1");
  }

  const token = createSessionToken(session);
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12, // 12h, igual al TTL del token
  });
  redirect("/admin");
}

export async function logoutAction() {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_COOKIE_NAME);
  redirect("/admin/login");
}

// El trigger de Supabase (clinic_appointments_confirm_webhook) detecta este
// cambio de status y automáticamente borra el evento del calendario del
// doctor + no hace falta duplicar esa lógica acá.
export async function cancelAppointmentAction(formData: FormData) {
  const staff = await requireStaff();
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!id) {
    revalidatePath("/admin");
    return;
  }

  const before = await getAppointmentById(id);
  // Solo se cancela una cita de la clínica del staff logueado.
  if (!before || before.business !== staff.business) {
    revalidatePath("/admin");
    return;
  }

  await updateAppointment(id, {
    status: "canceled",
    cancelReason: reason || null,
  });

  // Avisar al paciente por WhatsApp. La cancelación ocurre normalmente ~1h
  // después de que el paciente eligió pago QR, así que estamos dentro de la
  // ventana de 24h y basta con texto libre. Si la ventana está cerrada o el
  // envío falla, NO rompemos la cancelación: dejamos una nota en la cita para
  // que la recepcionista contacte al paciente manualmente (la fila se resalta
  // sola en el panel cuando appt.notes existe).
  try {
    const clinic = await getClinicConfig(staff.business);
    const phoneNumberId = clinic.kapsoPhoneNumberId ?? process.env.KAPSO_PHONE_NUMBER_ID;
    const windowOpen = await isWithinServiceWindow(before.contactPhone);

    if (phoneNumberId && windowOpen) {
      const friendlySlot = before.scheduledStart
        ? formatSlot(before.scheduledStart, clinic.timezone)
        : "su cita";
      const kapso = getKapsoClient();
      await kapso.messages.sendText({
        phoneNumberId,
        to: before.contactPhone,
        body: [
          `❌ *Cita cancelada — ${clinic.clinicName}*`,
          ``,
          `Hola ${before.patientName ?? ""}, le informamos que su cita (${friendlySlot}) fue cancelada.`,
          ``,
          `Motivo: ${reason || "no especificado"}`,
          ``,
          `Lamentamos el inconveniente 🙏 Si desea reagendar, escríbanos por aquí y con gusto le ayudamos.`,
        ].filter(Boolean).join("\n"),
      });
    } else {
      await updateAppointment(id, {
        notes: "⚠️ Cancelada, pero no se pudo avisar al paciente por WhatsApp (ventana cerrada) — contactar manualmente",
      });
    }
  } catch (err) {
    console.error("cancel notify patient failed", { id, error: getErrorMessage(err) });
    await updateAppointment(id, {
      notes: "⚠️ Cancelada, pero falló el aviso por WhatsApp al paciente — contactar manualmente",
    });
  }

  await logAdminAudit({
    business: staff.business,
    actorId: staff.staffId,
    actorName: staff.name,
    action: "appointment.cancel",
    entity: "appointment",
    entityId: id,
    before: { status: before.status },
    after: { status: "canceled", reason: reason || null },
  });

  revalidatePath("/admin");
}

// Confirmación manual para el caso raro en que la auto-confirmación de un
// pago QR falló dos veces (ver handlePaymentProof) y quedó marcada con nota.
// Igual que arriba: el trigger crea el evento y avisa al paciente por
// WhatsApp automáticamente al ver status='confirmed'.
export async function confirmAppointmentAction(formData: FormData) {
  const staff = await requireStaff();
  const id = String(formData.get("id") ?? "");
  if (id) {
    const before = await getAppointmentStatus(id);
    await updateAppointment(id, { status: "confirmed", notes: null });
    await logAdminAudit({
      business: staff.business,
      actorId: staff.staffId,
      actorName: staff.name,
      action: "appointment.confirm",
      entity: "appointment",
      entityId: id,
      before: { status: before },
      after: { status: "confirmed" },
    });
  }
  revalidatePath("/admin");
}

// Edición de los datos del paciente en una cita (nombre, CI, motivo) desde el
// panel — para corregir un dato mal tomado por el bot sin entrar a la BD. No
// toca el estado ni la agenda; solo campos informativos.
export async function updateAppointmentDetailsAction(formData: FormData) {
  const staff = await requireStaff();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const before = await getAppointmentById(id);
  // Solo se edita una cita que pertenezca a la clínica del staff logueado.
  if (!before || before.business !== staff.business) return;

  // Un campo vacío se interpreta como "no cambiar" (updateAppointment ignora los
  // `undefined`), para no borrar un dato por accidente al guardar el formulario.
  const norm = (v: FormDataEntryValue | null): string | undefined => {
    const s = String(v ?? "").trim();
    return s.length ? s : undefined;
  };
  const patch = {
    patientName: norm(formData.get("patientName")),
    patientCi: norm(formData.get("patientCi")),
    reason: norm(formData.get("reason")),
  };

  await updateAppointment(id, patch);

  await logAdminAudit({
    business: staff.business,
    actorId: staff.staffId,
    actorName: staff.name,
    action: "appointment.edit",
    entity: "appointment",
    entityId: id,
    before: { patientName: before.patientName, patientCi: before.patientCi, reason: before.reason },
    after: {
      patientName: patch.patientName ?? before.patientName,
      patientCi: patch.patientCi ?? before.patientCi,
      reason: patch.reason ?? before.reason,
    },
  });

  revalidatePath("/admin");
}
