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
  workSchedules?: DoctorWorkSchedule[];
  workStart: string; // "HH:MM"
  workEnd: string; // "HH:MM"
  timezone: string; // IANA, ej "America/La_Paz"
};

export type DoctorWorkSchedule = {
  weekday: number;
  startTime: string;
  endTime: string;
  endsNextDay: boolean;
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
  | "done"
  // Flujo de solicitudes (lib/clinic/leads.ts): el bot junta los datos y un
  // asesor confirma por WhatsApp. Los pasos de arriba son del agendamiento
  // anterior y el webhook ya no los usa.
  | "collecting_lead"
  | "confirming_lead";

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
  lead?: LeadDraft;              // solicitud en curso (collecting_lead / confirming_lead)
  // Momentos (ISO) en que el paciente dijo que no se le está ayudando. Al llegar
  // a 3 dentro de la ventana, el bot deriva a una persona.
  failedAttempts?: string[];
};

// ─── Solicitudes de ficha / servicio (clinic_leads) ─────────────────────────

export type VisitType = "nueva" | "reconsulta";

// Por qué saltó la alarma en el panel.
export type LeadKind =
  | "ficha"         // consulta con datos completos
  | "servicio"      // ecografía, procedimiento, enfermería…
  | "humano"        // pidió hablar con una persona
  | "fallidos"      // 3 veces dijo que no se le ayuda
  | "cancelar"
  | "reprogramar"
  | "consulta_cita" // "¿cuándo es mi cita?"
  | "pago"          // pidió el QR o datos de pago
  | "no_disponible" // pidió algo que la clínica no ofrece (fisioterapia, odontología…)
  | "accion";       // pide una gestión: "avísele a la doctora", "ya llegué", "me confirma"

// Cómo dijo el paciente que va a pagar. Es un dato para el asesor: el bot nunca
// cobra ni manda el QR.
export type PaymentIntention = "qr" | "efectivo";

// Qué rama del webhook atendió el mensaje. Se guarda en clinic_webhook_audits
// para poder responder "¿por qué el bot contestó esto?" sin reconstruirlo a
// mano. Es un string cerrado a propósito: el compilador obliga a declarar la
// rama en cada salida del webhook, así no queda ninguna sin auditar.
export type AuditIntent =
  | "emergencia"
  | "handoff_humano"
  | "ubicacion"
  | "comprobante"
  | "solicitud_en_curso"
  | "bienvenida"
  | "saludo"
  | "cancelar"
  | "reprogramar"
  | "consulta_cita"
  | "pago"
  | "no_disponible"
  | "fallidos"
  | "servicio"
  | "ficha"
  | "accion"
  | "qa"
  | "qa_fallido";

export type LeadStatus = "pending" | "attended" | "withdrawn";

// Lo que el bot va juntando en la conversación (vive en BookingDraft.lead).
export type LeadDraft = {
  kind: "ficha" | "servicio";
  patientName?: string | null;
  specialtyKey?: string | null;     // clave de CONSULTATION_SPECIALTIES
  // Lo que el paciente pidió tal cual (especialidad, servicio o examen), cuando
  // NO está en CONSULTATION_SPECIALTIES ni en el catálogo de servicios. No
  // significa que la clínica no lo ofrezca: solo que no está cargado en
  // nuestro catálogo — el Excel de la clínica no siempre está completo. El bot
  // nunca afirma ni niega disponibilidad — junta el dato igual y el asesor
  // confirma.
  unmatchedRequestText?: string | null;
  doctorPreference?: string | null; // tal como lo escribió el paciente
  preferredTime?: string | null;    // "mañana a las 10"
  preferredDate?: string | null;    // YYYY-MM-DD, si se pudo resolver
  preferredHour?: string | null;    // HH:MM, si se pudo resolver
  visitType?: VisitType | null;
  paymentIntention?: PaymentIntention | null; // cómo dijo que va a pagar
  serviceName?: string | null;
  serviceQuote?: string | null;
  leadId?: string | null;           // fila en clinic_leads, una vez enviado el resumen
};

export type Lead = {
  id: string;
  business: string;
  conversationId: string | null;
  contactPhone: string;
  contactName: string | null;
  kind: LeadKind;
  status: LeadStatus;
  patientName: string | null;
  specialty: string | null;
  // true cuando `specialty` es texto libre que el paciente pidió y no está en
  // CONSULTATION_SPECIALTIES — no confirmado como ofrecido ni como rechazado.
  specialtyUnverified: boolean;
  doctorPreference: string | null;
  preferredTime: string | null;
  visitType: VisitType | null;
  paymentIntention: PaymentIntention | null;
  serviceName: string | null;
  priceQuote: string | null;
  summary: string | null;
  lastMessage: string | null;
  attendedByName: string | null;
  attendedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentProof = {
  id: string;
  business: string;
  conversationId: string | null;
  contactPhone: string;
  contactName: string | null;
  mediaUrl: string;
  mediaType: string | null;
  detectedAmount: number | null;
  aiNote: string | null;
  reviewed: boolean;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
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

// Minutos que se le reserva el horario a un paciente que eligió pago por QR
// mientras esperamos su comprobante. Pasado ese plazo la cita se cancela sola
// y el slot vuelve a ofrecerse (ver expireStalePaymentAppointments).
export const PAYMENT_WINDOW_MINUTES = 30;

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
