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
  // Compatibilidad con datos antiguos. La disponibilidad actual usa siempre
  // la franja continua workStart–workEnd dividida por slotMinutes.
  workHours: string[] | null;
  workStart: string; // "HH:MM"
  workEnd: string; // "HH:MM"
  timezone: string; // IANA, ej "America/La_Paz"
};

export type TimeSlot = {
  start: string; // ISO UTC
  end: string; // ISO UTC
};

// Slot que además sabe de qué médico es. Se usa cuando ofrecemos horarios de
// TODA una especialidad ("lo antes posible, con quien sea") y el paciente
// todavía no eligió doctor: es el slot elegido el que determina el médico.
export type SlotWithDoctor = TimeSlot & { doctorId: string; doctorName: string };

// Franja del día. Los cortes (12:00 / 18:00) encajan con las work_hours reales
// del plantel ({07:00, 12:00, 14:00, 17:00, 19:00}).
export type TimeBand = "morning" | "afternoon" | "evening";

// Lo que el paciente pidió en lenguaje natural al arrancar la reserva, ya
// estructurado. Permite saltarse pasos del flujo en vez de preguntar lo que
// ya nos dijo. Todo es opcional: sin preferencias, el flujo es el de siempre.
export type BookingPrefs = {
  specialtyId?: string | null; // mencionada explícitamente o inferida de un síntoma
  timeBand?: TimeBand | null;
  anyDoctor?: boolean; // "con quien sea" / "lo antes posible"
};

// Pasos de la máquina de reserva.
export type BookingStep =
  | "idle"
  | "choosing_specialty"
  | "choosing_doctor"
  | "choosing_slot"
  // Como choosing_slot, pero los horarios ofrecidos son de VARIOS médicos de la
  // especialidad: el paciente dijo "con quien sea" y elige por hora, no por doctor.
  | "choosing_slot_any"
  | "collecting_name"
  | "collecting_ci"
  | "collecting_reason"
  | "choosing_payment"
  | "awaiting_proof"
  // Servicio del tarifario que no se agenda por WhatsApp (implante, ecografías,
  // cirugías…): se le pregunta al paciente qué horario le acomoda y con esa
  // respuesta se deriva a un asesor. No pasa por advanceBooking.
  | "awaiting_service_time"
  // Cancelar borra la cita y su evento sin vuelta atrás, así que se pide un sí
  // explícito antes. "quería cancelar… bueno, mejor no" no debe destruir nada.
  | "confirming_cancel"
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
  offeredSlotsAny?: SlotWithDoctor[]; // horarios de varios médicos (choosing_slot_any)
  prefs?: BookingPrefs;
  appointmentId?: string;
  reschedulingAppointmentId?: string;
  cancelingAppointmentId?: string; // cita pendiente de confirmar cancelación
  paymentProofUrl?: string;
  serviceName?: string;  // servicio no agendable en curso (awaiting_service_time)
  serviceQuote?: string; // su precio ya formateado, para repetirlo al confirmar
  rescheduleConfirmed?: boolean; // true si la cita original ya estaba `confirmed`
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
  notes: string | null;
};
