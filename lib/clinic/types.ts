// Tipos del rubro CLÍNICA (agendamiento de citas).

export type Specialty = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
};

export type Doctor = {
  id: string;
  specialtyId: string;
  name: string;
  googleCalendarId: string | null;
  consultationPrice: number | null;
  slotMinutes: number;
  workDays: number[]; // 0=domingo … 6=sábado
  workStart: string; // "HH:MM"
  workEnd: string; // "HH:MM"
  timezone: string; // IANA, ej "America/La_Paz"
};

export type TimeSlot = {
  start: string; // ISO UTC
  end: string; // ISO UTC
};

// Pasos de la máquina de reserva.
export type BookingStep =
  | "idle"
  | "choosing_specialty"
  | "choosing_doctor"
  | "choosing_slot"
  | "collecting_name"
  | "collecting_ci"
  | "collecting_reason"
  | "choosing_payment"
  | "awaiting_proof"
  | "done";

export type PaymentMethod = "qr" | "cash";

// Datos que se van acumulando durante la reserva (se guardan en
// clinic_booking_sessions.draft como JSON).
export type BookingDraft = {
  specialtyId?: string;
  specialtyName?: string;
  doctorId?: string;
  doctorName?: string;
  slotStart?: string; // ISO UTC
  slotEnd?: string; // ISO UTC
  patientName?: string;
  patientCi?: string;
  reason?: string;
  paymentMethod?: PaymentMethod;
  offeredSlots?: TimeSlot[];
  appointmentId?: string;
  reschedulingAppointmentId?: string;
};

// Estado del bloqueo temporal de 30 min sobre el slot elegido.
export type BookingHold = {
  heldDoctorId: string | null;
  heldSlotStart: string | null;
  holdExpiresAt: string | null;
};

export type BookingSession = {
  conversationId: string;
  step: BookingStep;
  draft: BookingDraft;
  hold: BookingHold;
};

export type AppointmentStatus =
  | "draft"
  | "hold"
  | "awaiting_payment"
  | "payment_review"
  | "confirmed"
  | "canceled";

// Estatutos que bloquean un slot (no se debe ofrecer a otro paciente).
export const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  "hold",
  "awaiting_payment",
  "payment_review",
  "confirmed",
];

export type Appointment = {
  id: string;
  business: string;
  conversationId: string | null;
  contactPhone: string;
  patientName: string | null;
  patientCi: string | null;
  reason: string | null;
  specialtyId: string | null;
  doctorId: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  status: AppointmentStatus;
  paymentMethod: string | null;
  paymentProofUrl: string | null;
  googleEventId: string | null;
  rescheduleCount: number;
};
