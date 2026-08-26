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
  DoctorWorkSchedule,
  Specialty,
  TimeSlot,
} from "@/lib/clinic/types";
import { ACTIVE_APPOINTMENT_STATUSES, PAYMENT_WINDOW_MINUTES } from "@/lib/clinic/types";

// Multi-tenant (P2): todas las clínicas dadas de alta, para que los crons
// (recordatorios, confirmaciones) procesen a cada una en vez de una sola fija.
export async function listAllBusinessSlugs(): Promise<string[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("clinic_settings").select("business");
  if (error) {
    console.error("listAllBusinessSlugs failed", error);
    return [];
  }
  return (data ?? []).map((r) => String(r.business));
}

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
    // Postgres devuelve time[] como ["07:00:00", …]; el resto del código usa "HH:MM".
    workHours: Array.isArray(row.work_hours) && row.work_hours.length
      ? row.work_hours.map((h: any) => String(h).slice(0, 5))
      : null,
    workSchedules: Array.isArray(row.work_schedules)
      ? row.work_schedules.map((s: any): DoctorWorkSchedule => ({
          weekday: Number(s.weekday),
          startTime: String(s.start_time).slice(0, 5),
          endTime: String(s.end_time).slice(0, 5),
          endsNextDay: Boolean(s.ends_next_day),
        }))
      : [],
    workStart: String(row.work_start ?? "09:00").slice(0, 5),
    workEnd: String(row.work_end ?? "17:00").slice(0, 5),
    timezone: String(row.timezone ?? "America/La_Paz"),
  };
}

async function addDoctorSchedules(doctors: Doctor[]): Promise<Doctor[]> {
  if (!doctors.length) return doctors;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_doctor_work_hours")
    .select("doctor_id, weekday, start_time, end_time, ends_next_day")
    .in("doctor_id", doctors.map((d) => d.id));
  if (error) {
    console.error("getDoctorWorkSchedules failed", error);
    return doctors;
  }
  const grouped = new Map<string, DoctorWorkSchedule[]>();
  for (const row of data ?? []) {
    const list = grouped.get(String(row.doctor_id)) ?? [];
    list.push({
      weekday: Number(row.weekday),
      startTime: String(row.start_time).slice(0, 5),
      endTime: String(row.end_time).slice(0, 5),
      endsNextDay: Boolean(row.ends_next_day),
    });
    grouped.set(String(row.doctor_id), list);
  }
  return doctors.map((doctor) => ({ ...doctor, workSchedules: grouped.get(doctor.id) ?? [] }));
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
  return addDoctorSchedules((data ?? []).map(mapDoctor));
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
  return (await addDoctorSchedules([mapDoctor(data)]))[0];
}

// Día de la semana (0=domingo…6=sábado, igual criterio que clinic_doctors.work_days)
// y hora "HH:MM" de un instante UTC, en la timezone del médico. Mismo mecanismo
// que formatSlotLocal en booking.ts, pero con locale en-US para poder mapear el
// nombre corto del día a un índice sin depender de la traducción de es-BO.
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localWeekdayAndTime(isoUtc: string, timezone: string): { weekday: number; hhmmss: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(isoUtc));

  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;

  const weekday = WEEKDAY_INDEX[map.weekday] ?? 0;
  // hour12:false puede devolver "24" para medianoche en algunos motores JS.
  const hour = map.hour === "24" ? "00" : map.hour.padStart(2, "0");
  return { weekday, hhmmss: `${hour}:${map.minute}:00` };
}

// Precio real de una consulta: depende del médico, el día y la hora del turno
// (ver clinic_doctor_price_rules — reemplaza el monto fijo por médico que tenía
// consultation_price). Si el médico no tiene reglas cargadas para ese día/hora,
// cae a consultation_price como respaldo; solo devuelve null si tampoco existe
// eso, para nunca inventarle un precio al paciente.
export async function getPriceForDoctorSlot(
  doctorId: string,
  slotStartIso: string,
  timezone: string,
): Promise<number | null> {
  const { weekday, hhmmss } = localWeekdayAndTime(slotStartIso, timezone);
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("clinic_doctor_price_rules")
    .select("start_time, end_time, price")
    .eq("doctor_id", doctorId)
    .eq("weekday", weekday);

  if (error) {
    console.error("getPriceForDoctorSlot: query failed, falling back to consultation_price", error);
  } else if (data) {
    // Límite superior exclusivo: un turno justo a las 19:00 cae en la franja
    // [19:00, 24:00), es decir en la tarifa alta.
    const match = data.find((r: any) => r.start_time <= hhmmss && hhmmss < r.end_time);
    if (match) return Number(match.price);
  }

  const doctor = await getDoctorById(doctorId);
  return doctor?.consultationPrice ?? null;
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
    cancelReason?: string | null;
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
  if (patch.cancelReason !== undefined) dbPatch.cancel_reason = patch.cancelReason;

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

// ─── Idempotencia: claim atómico antes de crear el evento de Calendar ────────
// Evita que dos procesos concurrentes (ej. handlePaymentProof y el trigger de
// confirmaciones) creen dos eventos/notificaciones para la misma cita. Ver
// migración 20260717000000_appointment_event_claim.sql.

// Intenta "reservar" la creación del evento para esta cita. Devuelve true solo
// si ESTA llamada ganó el claim (nadie más lo tiene y no hay evento todavía).
export async function claimAppointmentForEventCreation(id: string): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_appointments")
    .update({ event_claimed_at: new Date().toISOString() })
    .eq("id", id)
    .is("google_event_id", null)
    .is("event_claimed_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("claimAppointmentForEventCreation failed", error);
    return false;
  }
  return Boolean(data);
}

// Libera el claim si la creación del evento falló, para permitir reintentar
// más tarde (otro mensaje del paciente, el panel, o el cron de confirmaciones).
export async function releaseAppointmentEventClaim(id: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("clinic_appointments")
    .update({ event_claimed_at: null })
    .eq("id", id);

  if (error) console.error("releaseAppointmentEventClaim failed", error);
}

// Lectura completa de una cita por id (para el before/after de la edición
// desde el panel). null si no existe.
export async function getAppointmentById(id: string): Promise<Appointment | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_appointments")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("getAppointmentById failed", error);
    return null;
  }
  return mapAppointment(data);
}

// Lectura mínima para auditoría (before/after de una acción administrativa).
export async function getAppointmentStatus(id: string): Promise<AppointmentStatus | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_appointments")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data.status as AppointmentStatus;
}

// ─── Auditoría de acciones administrativas (P1.10) ───────────────────────────

export async function logAdminAudit(params: {
  business: string;
  actorId: string;
  actorName?: string | null;
  action: string;
  entity: string;
  entityId: string;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
}): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("clinic_admin_audit").insert({
    business: params.business,
    actor_id: params.actorId,
    actor_name: params.actorName ?? null,
    action: params.action,
    entity: params.entity,
    entity_id: params.entityId,
    before: params.before ?? null,
    after: params.after ?? null,
  });
  if (error) console.error("logAdminAudit failed", error);
}

// ─── Panel interno (secretaria) ───────────────────────────────────────────────

export type AdminAppointmentFilter = "all" | "confirmed" | "pending" | "flagged" | "canceled";
export type AdminAppointmentRow = Appointment & { doctorName: string | null };

// Citas del negocio con el nombre del doctor embebido en una sola consulta
// (evita N+1), paginadas y con búsqueda opcional. "flagged" = citas con una
// nota pendiente de revisión (ver notes, escrita por handlePaymentProof cuando
// algo no cuadra). Devuelve también el total (`count: exact`) para paginar.
export const ADMIN_PAGE_SIZE = 25;

export async function listAppointmentsForAdmin(
  business: string,
  opts: {
    filter?: AdminAppointmentFilter;
    search?: string;
    page?: number;
  } = {},
): Promise<{ rows: AdminAppointmentRow[]; total: number }> {
  const supabase = getSupabaseClient();
  const filter = opts.filter ?? "all";
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * ADMIN_PAGE_SIZE;
  const to = from + ADMIN_PAGE_SIZE - 1;

  let query = supabase
    .from("clinic_appointments")
    .select("*, doctor:clinic_doctors(name)", { count: "exact" })
    .eq("business", business)
    .order("scheduled_start", { ascending: false, nullsFirst: false })
    .range(from, to);

  if (filter === "confirmed") query = query.eq("status", "confirmed");
  else if (filter === "pending") query = query.in("status", ["awaiting_payment", "payment_review"]);
  else if (filter === "canceled") query = query.eq("status", "canceled");
  else if (filter === "flagged") query = query.not("notes", "is", null);

  const search = opts.search?.trim();
  if (search) {
    // Coincidencia parcial (case-insensitive) por nombre, teléfono o CI. El
    // patrón se escapa para que %, _ o , del input no rompan el filtro `.or`.
    const term = search.replace(/[%_,()]/g, " ").trim();
    if (term) {
      const like = `%${term}%`;
      query = query.or(
        `patient_name.ilike.${like},contact_phone.ilike.${like},patient_ci.ilike.${like}`,
      );
    }
  }

  const { data, error, count } = await query;
  if (error) {
    console.error("listAppointmentsForAdmin failed", error);
    return { rows: [], total: 0 };
  }

  return {
    rows: (data ?? []).map((row: any) => ({
      ...mapAppointment(row),
      doctorName: row.doctor?.name ?? null,
    })),
    total: count ?? 0,
  };
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

// Libera las reservas de pago QR vencidas: citas que siguen en
// `awaiting_payment` (nunca llegó un comprobante válido) pasados
// PAYMENT_WINDOW_MINUTES desde su última actividad. Mientras están en ese
// estado bloquean el slot (ACTIVE_APPOINTMENT_STATUSES), así que sin esto un
// paciente que elige QR y no paga deja el horario muerto para siempre.
//
// Se llama de forma perezosa en cada mensaje entrante del webhook: el plan
// Hobby de Vercel solo permite un cron diario, y esperar hasta el día
// siguiente para devolver un cupo no sirve. Devuelve las citas liberadas para
// poder avisar al paciente.
//
// Las que están en `payment_review` NO se tocan: ya mandaron comprobante y hay
// una persona revisándolo, el horario les sigue reservado.
export async function expireStalePaymentAppointments(
  business: string,
  windowMinutes: number = PAYMENT_WINDOW_MINUTES,
): Promise<Appointment[]> {
  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  const { data, error } = await supabase
    .from("clinic_appointments")
    .update({
      status: "canceled",
      cancel_reason: "pago_no_recibido",
      notes: `⏱️ Reserva liberada automáticamente: no llegó el comprobante dentro de los ${windowMinutes} min.`,
      updated_at: new Date().toISOString(),
    })
    .eq("business", business)
    .eq("status", "awaiting_payment")
    .lt("updated_at", cutoff)
    .select("*");

  if (error) {
    console.error("expireStalePaymentAppointments failed", error);
    return [];
  }
  return (data ?? []).map(mapAppointment);
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
