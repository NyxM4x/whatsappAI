-- ============================================================================
-- Idempotencia — claim atómico antes de crear el evento de Calendar
-- ----------------------------------------------------------------------------
-- Hueco real (P1.7 del plan de production-readiness): entre marcar una cita
-- 'confirmed' y guardar su google_event_id hay una ventana. Si el trigger de
-- confirmaciones (u otra invocación) corre justo en esa ventana, puede crear un
-- SEGUNDO evento en Calendar + mandar una SEGUNDA notificación al paciente.
--
-- event_claimed_at es un "lock" a nivel de fila: quien logre el UPDATE
-- condicional (WHERE event_claimed_at IS NULL) es el único que procede a crear
-- el evento. Un segundo intento concurrente no encuentra la fila (WHERE falla)
-- y se retira sin duplicar nada. Si la creación del evento falla, se libera el
-- claim (vuelve a null) para permitir un reintento posterior.
--
-- ROLLBACK: alter table public.clinic_appointments drop column if exists event_claimed_at;
-- ============================================================================

alter table public.clinic_appointments
  add column if not exists event_claimed_at timestamptz;
