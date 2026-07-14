-- ============================================================================
-- Evitar doble reserva: un doctor no puede tener dos citas ACTIVAS en el mismo
-- horario exacto.
-- ----------------------------------------------------------------------------
-- Hasta ahora la única protección contra dos pacientes tomando el mismo slot
-- al mismo tiempo era el hold de 30 min + una re-verificación optimista con
-- timeout de 5s (ver lib/clinic/booking.ts, choosing_slot). Si dos personas
-- eligen el mismo horario casi al mismo instante, ambas podían pasar esa
-- verificación y terminar con dos citas para el mismo doctor/horario.
--
-- Este índice único a nivel de BD es la última línea de defensa: el segundo
-- INSERT falla directamente en la base de datos (error 23505), y
-- createAppointment() ya devuelve null ante cualquier error — el código de
-- booking.ts fue actualizado para detectar ese null y ofrecerle al cliente
-- horarios frescos en vez de mostrarle una confirmación falsa.
--
-- Los mismos estados que ya se consideran "activos" en el resto del sistema
-- (ver ACTIVE_APPOINTMENT_STATUSES en lib/clinic/types.ts): hold,
-- awaiting_payment, payment_review, confirmed. Una cita 'canceled' no cuenta,
-- así que reprogramar/cancelar y volver a reservar el mismo horario sigue
-- funcionando sin problema.
-- ============================================================================

create unique index if not exists clinic_appointments_doctor_slot_active_uidx
on public.clinic_appointments (doctor_id, scheduled_start)
where status in ('hold', 'awaiting_payment', 'payment_review', 'confirmed');
