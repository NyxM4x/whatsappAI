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
import { updateAppointment, getAppointmentStatus, logAdminAudit } from "@/lib/clinic/data";
import { getClinicConfig } from "@/lib/clinic/config";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const clinic = await getClinicConfig();

  if (await isLoginRateLimited(clinic.slug, email)) {
    redirect("/admin/login?error=rate_limited");
  }

  const session = await verifyStaffCredentials(clinic.slug, email, password);
  await recordLoginAttempt(clinic.slug, email, Boolean(session));

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
  if (id) {
    const before = await getAppointmentStatus(id);
    await updateAppointment(id, { status: "canceled" });
    await logAdminAudit({
      business: staff.business,
      actorId: staff.staffId,
      actorName: staff.name,
      action: "appointment.cancel",
      entity: "appointment",
      entityId: id,
      before: { status: before },
      after: { status: "canceled" },
    });
  }
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
