-- ── Motivo de cancelación de una cita ───────────────────────────────────────
-- Cuando la recepcionista cancela una cita desde el panel, escribe un motivo en
-- texto libre que (a) se guarda aquí para el registro y (b) se incluye en el
-- WhatsApp de aviso que se le manda al paciente. Ver cancelAppointmentAction
-- (app/admin/actions.ts).
alter table public.clinic_appointments
  add column if not exists cancel_reason text;
