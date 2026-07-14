// Acceso a datos del rubro CLÍNICA. Reusa el cliente Supabase del motor.
// Igual que lib/engine/data.ts, todo el SQL de la clínica vive aquí para que
// migrar a otro Postgres luego sea reescribir un solo archivo.

import { getSupabaseClient } from "@/lib/engine/clients";
import type {
  Appointment,
  AppointmentStatus,
  BookingDraft,
  BookingHold,
  BookingSession,
  BookingStep,
  Doctor,
  Specialty,
  TimeSlot,
} from "@/lib/clinic/types";
import { ACTIVE_APPOINTMENT_STATUSES } from "@/lib/clinic/types";

// ─── Mappers ────────────────────────────────────────────────────────────────

function mapSpecialty(row: any): Specialty {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    slug: String(row.slug ?? ""),
    description: row.description ?? null,
    sortOrder: Number(row.sort_order ?? 0),
  };
}

function mapDoctor(row: any): Doctor {
  return {
    id: String(row.id),
    specialtyId: String(row.specialty_id),
    name: String(row.name ?? ""),
    googleCalendarId: row.google_calendar_id ?? null,
    consultationPrice: row.consultation_price != null ? Number(row.consultation_price) : null,
    slotMinutes: Number(row.slot_minutes ?? 30),
    workDays: Array.isArray(row.work_days) ? row.work_days.map((d: any) => Number(d)) : [1, 2, 3, 4, 5],
    workStart: String(row.work_start ?? "09:00").slice(0, 5),
    workEnd: String(row.work_end ?? "17:00").slice(0, 5),
    timezone: String(row.timezone ?? "America/La_Paz"),
  };
}

function mapAppointment(row: any): Appointment {
  return {
    id: String(row.id),
    business: String(row.business),
    conversationId: row.kapso_conversation_id ?? null,
    contactPhone: String(row.contact_phone),
    patientName: row.patient_name ?? null,
    patientCi: row.patient_ci ?? null,
    reason: row.reason ?? null,
    specialtyId: row.specialty_id ?? null,
    doctorId: row.doctor_id ?? null,
    scheduledStart: row.scheduled_start ?? null,
    scheduledEnd: row.scheduled_end ?? null,
    status: row.status as AppointmentStatus,
    paymentMethod: row.payment_method ?? null,
    paymentProofUrl: row.payment_proof_url ?? null,
    googleEventId: row.google_event_id ?? null,
    rescheduleCount: Number(row.reschedule_count ?? 0),
    notes: row.notes ?? null,
  };
}

// ─── Especialidades y doctores ───────────────────────────────────────────────

export async function getSpecialties(business: string): Promise<Specialty[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_specialties")
    .select("*")
    .eq("business", business)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getSpecialties failed", error);
    return [];
  }
  return (data ?? []).map(mapSpecialty);
}

export async function getSpecialtyById(id: string): Promise<Specialty | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_specialties")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;
  return mapSpecialty(data);
}

export async function getDoctorsBySpecialty(
  business: string,
  specialtyId: string,
): Promise<Doctor[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_doctors")
    .select("*")
    .eq("business", business)
    .eq("specialty_id", specialtyId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getDoctorsBySpecialty failed", error);
    return [];
  }
  return (data ?? []).map(mapDoctor);
}

export async function getDoctorById(id: string): Promise<Doctor | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_doctors")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("getDoctorById failed", error);
    return null;
  }
  return mapDoctor(data);
}

// ─── Sesión de reserva ───────────────────────────────────────────────────────

// TTL de la sesión de reserva: si el cliente abandona el flujo a medias y vuelve
// después de este tiempo, se arranca de cero en vez de reanudar un paso viejo
// (evita que un simple "hola" caiga en el paso de elegir horario abandonado).
const BOOKING_SESSION_TTL_MS = Number(process.env.BOOKING_SESSION_TTL_MINUTES ?? 120) * 60 * 1000;

export async function getBookingSession(
  conversationId: string,
): Promise<BookingSession> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_booking_sessions")
    .select("step, draft, held_doctor_id, held_slot_start, hold_expires_at, updated_at")
    .eq("kapso_conversation_id", conversationId)
    .maybeSingle();

  if (error) {
    console.error("getBookingSession failed", error);
  }

  const idleSession: BookingSession = {
    conversationId,
    step: "idle",
    draft: {},
    hold: { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null },
  };

  if (!data) return idleSession;

  const step = (data.step as BookingStep) ?? "idle";

  // Expirar sesión inactiva: si pasó el TTL desde la última actividad, tratarla
  // como idle para no reanudar un flujo que el cliente ya abandonó.
  if (step !== "idle" && data.updated_at) {
    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > BOOKING_SESSION_TTL_MS) return idleSession;
  }

  return {
    conversationId,
    step,
    draft: (data.draft as BookingDraft) ?? {},
    hold: {
      heldDoctorId: data.held_doctor_id ?? null,
      heldSlotStart: data.held_slot_start ?? null,
      holdExpiresAt: data.hold_expires_at ?? null,
    },
  };
}

export async function saveBookingSession(params: {
  conversationId: string;
  business: string;
  step: BookingStep;
  draft: BookingDraft;
  hold?: BookingHold;
}) {
  const supabase = getSupabaseClient();
  const hold = params.hold ?? { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null };

  const { error } = await supabase
    .from("clinic_booking_sessions")
    .upsert(
      {
        kapso_conversation_id: params.conversationId,
        business: params.business,
        step: params.step,
        draft: params.draft,
        held_doctor_id: hold.heldDoctorId,
        held_slot_start: hold.heldSlotStart,
        hold_expires_at: hold.holdExpiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "kapso_conversation_id" },
    );

  if (error) console.error("saveBookingSession failed", error);
}

export async function resetBookingSession(conversationId: string, business: string) {
  await saveBookingSession({
    conversationId,
    business,
    step: "idle",
    draft: {},
    hold: { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null },
  });
}

// ─── Hold (bloqueo temporal de slot) ─────────────────────────────────────────

// Escribe un hold de 30 minutos para el slot elegido en esta sesión.
export async function writeHold(params: {
  conversationId: string;
  business: string;
  step: BookingStep;
  draft: BookingDraft;
  doctorId: string;
  slotStart: string;
}): Promise<void> {
  const holdExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await saveBookingSession({
    conversationId: params.conversationId,
    business: params.business,
    step: params.step,
    draft: params.draft,
    hold: {
      heldDoctorId: params.doctorId,
      heldSlotStart: params.slotStart,
      holdExpiresAt,
    },
  });
}

// Limpia el hold (al cancelar, reprogramar o completar la reserva).
export async function clearHold(
  conversationId: string,
  business: string,
  step: BookingStep,
  draft: BookingDraft,
): Promise<void> {
  await saveBookingSession({
    conversationId,
    business,
    step,
    draft,
    hold: { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null },
  });
}

// Devuelve los slots con hold vigente (de OTRAS sesiones) para un doctor.
// Se usan para excluirlos del listado de disponibles.
export async function getActiveHoldsForDoctor(
  doctorId: string,
  excludeConversationId?: string,
): Promise<TimeSlot[]> {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  let query = supabase
    .from("clinic_booking_sessions")
    .select("held_slot_start, held_doctor_id")
    .eq("held_doctor_id", doctorId)
    .gt("hold_expires_at", now)
    .not("held_slot_start", "is", null);

  if (excludeConversationId) {
    query = query.neq("kapso_conversation_id", excludeConversationId);
  }

  const { data, error } = await query;
  if (error) {
    console.error("getActiveHoldsForDoctor failed", error);
    return [];
  }

  return (data ?? [])
    .filter((r) => r.held_slot_start)
    .map((r) => {
      const start = new Date(r.held_slot_start!);
      // Asumimos slots de 30 min; el tamaño exacto no importa para la exclusión.
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      return { start: start.toISOString(), end: end.toISOString() };
    });
}

// ─── Citas ───────────────────────────────────────────────────────────────────

export async function createAppointment(params: {
  business: string;
  conversationId?: string;
  contactPhone: string;
  patientName?: string;
  patientCi?: string;
  reason?: string;
  specialtyId?: string;
  doctorId?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  status?: AppointmentStatus;
  paymentMethod?: string;
}): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_appointments")
    .insert({
      business: params.business,
      kapso_conversation_id: params.conversationId,
      contact_phone: params.contactPhone,
      patient_name: params.patientName,
      patient_ci: params.patientCi,
      reason: params.reason,
      specialty_id: params.specialtyId,
      doctor_id: params.doctorId,
      scheduled_start: params.scheduledStart,
      scheduled_end: params.scheduledEnd,
      status: params.status ?? "draft",
      payment_method: params.paymentMethod,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("createAppointment failed", error);
    return null;
  }
  return data?.id ? String(data.id) : null;
}

export async function updateAppointment(
  id: string,
  patch: {
    status?: AppointmentStatus;
    paymentProofUrl?: string;
    googleEventId?: string;
    scheduledStart?: string;
    scheduledEnd?: string;
    patientName?: string;
    patientCi?: string;
    reason?: string;
    rescheduleCount?: number;
    doctorId?: string;
    notes?: string | null;
  },
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const dbPatch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.paymentProofUrl !== undefined) dbPatch.payment_proof_url = patch.paymentProofUrl;
  if (patch.googleEventId !== undefined) dbPatch.google_event_id = patch.googleEventId;
  if (patch.scheduledStart !== undefined) dbPatch.scheduled_start = patch.scheduledStart;
  if (patch.scheduledEnd !== undefined) dbPatch.scheduled_end = patch.scheduledEnd;
  if (patch.patientName !== undefined) dbPatch.patient_name = patch.patientName;
  if (patch.patientCi !== undefined) dbPatch.patient_ci = patch.patientCi;
  if (patch.reason !== undefined) dbPatch.reason = patch.reason;
  if (patch.rescheduleCount !== undefined) dbPatch.reschedule_count = patch.rescheduleCount;
  if (patch.doctorId !== undefined) dbPatch.doctor_id = patch.doctorId;
  if (patch.notes !== undefined) dbPatch.notes = patch.notes;

  const { error } = await supabase
    .from("clinic_appointments")
    .update(dbPatch)
    .eq("id", id);

  if (error) {
    console.error("updateAppointment failed", error);
    return false;
  }
  return true;
}

// ─── Panel interno (secretaria) ───────────────────────────────────────────────

export type AdminAppointmentFilter = "all" | "confirmed" | "pending" | "flagged" | "canceled";
export type AdminAppointmentRow = Appointment & { doctorName: string | null };

// Últimas 100 citas del negocio, con el nombre del doctor embebido en una sola
// consulta (evita N+1). "flagged" = citas con una nota pendiente de revisión
// (ver notes, escrita por handlePaymentProof cuando algo no cuadra).
export async function listAppointmentsForAdmin(
  business: string,
  filter: AdminAppointmentFilter = "all",
): Promise<AdminAppointmentRow[]> {
  const supabase = getSupabaseClient();
  let query = supabase
    .from("clinic_appointments")
    .select("*, doctor:clinic_doctors(name)")
    .eq("business", business)
    .order("scheduled_start", { ascending: false, nullsFirst: false })
    .limit(100);

  if (filter === "confirmed") query = query.eq("status", "confirmed");
  else if (filter === "pending") query = query.in("status", ["awaiting_payment", "payment_review"]);
  else if (filter === "canceled") query = query.eq("status", "canceled");
  else if (filter === "flagged") query = query.not("notes", "is", null);

  const { data, error } = await query;
  if (error) {
    console.error("listAppointmentsForAdmin failed", error);
    return [];
  }

  return (data ?? []).map((row: any) => ({
    ...mapAppointment(row),
    doctorName: row.doctor?.name ?? null,
  }));
}

// Devuelve la cita activa más reciente del paciente (por teléfono).
export async function findActiveAppointmentByPhone(
  business: string,
  phone: string,
): Promise<Appointment | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_appointments")
    .select("*")
    .eq("business", business)
    .eq("contact_phone", phone)
    .in("status", ACTIVE_APPOINTMENT_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("findActiveAppointmentByPhone failed", error);
    return null;
  }
  return data ? mapAppointment(data) : null;
}

// Devuelve las citas activas de un doctor en un rango (para excluir esos slots).
export async function getActiveAppointmentSlotsForDoctor(
  doctorId: string,
  fromIso: string,
  toIso: string,
): Promise<TimeSlot[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_appointments")
    .select("scheduled_start, scheduled_end")
    .eq("doctor_id", doctorId)
    .in("status", ACTIVE_APPOINTMENT_STATUSES)
    .gte("scheduled_start", fromIso)
    .lte("scheduled_start", toIso)
    .not("scheduled_start", "is", null);

  if (error) {
    console.error("getActiveAppointmentSlotsForDoctor failed", error);
    return [];
  }

  return (data ?? [])
    .filter((r) => r.scheduled_start && r.scheduled_end)
    .map((r) => ({ start: r.scheduled_start!, end: r.scheduled_end! }));
}

// Citas `confirmed` sin evento de Calendar (para el cron de confirmaciones).
export async function getConfirmedAppointmentsWithoutEvent(
  business: string,
): Promise<Appointment[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_appointments")
    .select("*")
    .eq("business", business)
    .eq("status", "confirmed")
    .is("google_event_id", null);

  if (error) {
    console.error("getConfirmedAppointmentsWithoutEvent failed", error);
    return [];
  }
  return (data ?? []).map(mapAppointment);
}

// Citas `canceled` que aún tienen evento en Calendar (para borrar el evento).
export async function getCanceledAppointmentsWithEvent(
  business: string,
): Promise<Appointment[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_appointments")
    .select("*")
    .eq("business", business)
    .eq("status", "canceled")
    .not("google_event_id", "is", null);

  if (error) {
    console.error("getCanceledAppointmentsWithEvent failed", error);
    return [];
  }
  return (data ?? []).map(mapAppointment);
}
