-- ============================================================================
-- WEBHOOK — Disparar /api/cron/clinic-confirmations al confirmar/cancelar
-- ----------------------------------------------------------------------------
-- Reemplaza la necesidad de un cron: en vez de esperar una corrida periódica,
-- cuando la secretaria cambia el status de una cita a 'confirmed' o 'canceled'
-- en Supabase, este trigger llama INMEDIATAMENTE al endpoint que crea/borra el
-- evento de Google Calendar y notifica al paciente por WhatsApp.
--
-- Usa la extensión pg_net (con la que Supabase implementa sus "Database
-- Webhooks" por debajo), así queda versionado como código en vez de un paso
-- manual en el dashboard.
--
-- ⚠️ ANTES DE CORRER: reemplazar los dos placeholders más abajo:
--   - <TU_URL_DE_DEPLOY>      → ej. https://whatsapp-ai-chi.vercel.app
--   - <CLINIC_CONFIRM_CRON_SECRET> → el mismo valor que la env var en Vercel
--
-- El endpoint es idempotente: siempre re-escanea todas las citas confirmed sin
-- evento y canceled con evento, así que llamarlo de más (o que dos triggers se
-- disparen casi juntos) no duplica nada.
-- ============================================================================

create extension if not exists pg_net;

create or replace function public.notify_clinic_confirmation()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.business = 'clinica-san-martin'
     and new.status is distinct from old.status
     and new.status in ('confirmed', 'canceled') then
    perform net.http_get(
      url := '<TU_URL_DE_DEPLOY>/api/cron/clinic-confirmations',
      headers := jsonb_build_object(
        'Authorization', 'Bearer <CLINIC_CONFIRM_CRON_SECRET>'
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists clinic_appointments_confirm_webhook on public.clinic_appointments;

create trigger clinic_appointments_confirm_webhook
after update on public.clinic_appointments
for each row
execute function public.notify_clinic_confirmation();
