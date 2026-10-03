-- ============================================================================
-- Motivo de alarma "emergencia"
-- ----------------------------------------------------------------------------
-- 2026-10-03: los signos graves (no respira, convulsiona, no reacciona…) se
-- registraban como "accion" y en el panel decían "Pide que se le avise o
-- confirme algo": la recepcionista no podía distinguirlos de un "me confirma".
-- Ahora tienen motivo propio, que el panel muestra primero y en rojo.
--
-- Si el código llega antes que esta migración, la alarma igual se crea como
-- "accion" con "🚨 EMERGENCIA" al inicio del mensaje (registerEscalation en
-- lib/clinic/leads.ts). Aplicarla quita ese respaldo.
-- ============================================================================

alter table public.clinic_leads
  drop constraint if exists clinic_leads_kind_check;

alter table public.clinic_leads
  add constraint clinic_leads_kind_check
  check (kind in (
    'ficha', 'servicio', 'humano', 'fallidos', 'cancelar', 'reprogramar',
    'consulta_cita', 'pago', 'no_disponible', 'accion', 'emergencia'
  ));
