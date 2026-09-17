-- ============================================================================
-- Reset de una conversación de prueba
-- ----------------------------------------------------------------------------
-- Deja un número como si escribiera por PRIMERA VEZ: bot prendido, sin sesión
-- a medio recopilar, sin historial y sin alarma pendiente que se reutilice.
--
-- NO es una migración: vive fuera de supabase/migrations/ a propósito, para que
-- no se corra sola. Se pega a mano en el SQL Editor cuando hace falta.
--
-- BORRA los mensajes de ese número. Usar solo con teléfonos de prueba propios,
-- nunca con la conversación de un paciente real.
--
-- Cambiar el número en la primera línea del bloque (solo dígitos, sin + ni
-- espacios: así lo guarda bot_pause_state.contact_phone_normalized).
-- ============================================================================

-- ── PASO 1. Ver qué hay antes de tocar nada ─────────────────────────────────
-- Cambiar el número también acá.
with tel as (select '59175681881'::text as t)
select 'pausa (durable)' as que,
       contact_phone_normalized as ref,
       'bot_paused=' || bot_paused || ' · ' || coalesce(bot_paused_reason, '—') as detalle
from public.bot_pause_state, tel where contact_phone_normalized = tel.t
union all
select 'conversación', kapso_conversation_id, 'bot_paused=' || bot_paused
from public.kapso_conversations, tel
where regexp_replace(contact_phone, '\D', '', 'g') = tel.t
union all
select 'sesión del flujo', s.kapso_conversation_id, 'step=' || s.step
from public.clinic_booking_sessions s
join public.kapso_conversations c on c.kapso_conversation_id = s.kapso_conversation_id, tel
where regexp_replace(c.contact_phone, '\D', '', 'g') = tel.t
union all
select 'mensajes', 'histórico', count(*)::text
from public.kapso_messages, tel where regexp_replace(contact_phone, '\D', '', 'g') = tel.t
union all
select 'solicitudes pendientes', 'clinic_leads', count(*)::text
from public.clinic_leads, tel where regexp_replace(contact_phone, '\D', '', 'g') = tel.t
  and status = 'pending';

-- ── PASO 2. El reset ────────────────────────────────────────────────────────
do $$
declare
  telefono text := '59175681881';  -- ← EL NÚMERO, solo dígitos
  convs    text[];
begin
  select array_agg(kapso_conversation_id) into convs
  from public.kapso_conversations
  where regexp_replace(contact_phone, '\D', '', 'g') = telefono;

  -- a) Bot prendido. Va como insert…on conflict y no como update: si no existe
  --    la fila, getBootPauseState() cae a un fallback sobre kapso_conversations
  --    y el número podría seguir viéndose pausado. Con la fila en false, esa
  --    gana y la lectura corta ahí.
  insert into public.bot_pause_state (
    contact_phone_normalized, bot_paused, bot_resumed_at, bot_pause_expires_at,
    bot_paused_reason, bot_pause_mode, bot_pause_duration_minutes, updated_at
  ) values (
    telefono, false, now(), null, 'reset de prueba', 'manual', null, now()
  )
  on conflict (contact_phone_normalized) do update set
    bot_paused                 = false,
    bot_resumed_at             = now(),
    bot_pause_expires_at       = null,
    bot_paused_reason          = 'reset de prueba',
    bot_pause_mode             = 'manual',
    bot_pause_duration_minutes = null,
    updated_at                 = now();

  -- b) Mensajes: se borran por teléfono, no por conversación, para llevarse
  --    también los que quedaron sin conversación asociada.
  delete from public.kapso_messages
  where regexp_replace(contact_phone, '\D', '', 'g') = telefono;

  if convs is null then
    raise notice 'Bot prendido para %. No había conversación previa: nada más que limpiar.', telefono;
    return;
  end if;

  -- c) El fallback legacy, por si alguna lectura llega sin teléfono.
  update public.kapso_conversations
  set bot_paused = false, bot_resumed_at = now(), bot_pause_expires_at = null,
      bot_paused_reason = null, updated_at = now()
  where kapso_conversation_id = any(convs);

  -- d) Sesión del flujo. Es la más importante después de la pausa: con una
  --    sesión en collecting_lead, el próximo mensaje sigue esa rama en vez de
  --    entrar por el camino de un mensaje nuevo, y la prueba no mide lo que
  --    uno cree que mide.
  delete from public.clinic_booking_sessions where kapso_conversation_id = any(convs);

  -- e) Locks de respuesta, para que ningún mensaje quede marcado como ya
  --    atendido.
  delete from public.kapso_response_locks where kapso_conversation_id = any(convs);

  -- f) Solicitudes pendientes: sin esto, registerEscalation reutiliza la alarma
  --    existente durante 12 h (ESCALATION_DEDUPE_MS) y en el panel no aparece
  --    una nueva.
  update public.clinic_leads
  set status = 'withdrawn', updated_at = now()
  where kapso_conversation_id = any(convs) and status = 'pending';

  raise notice 'Reset OK para % (% conversación/es).', telefono, array_length(convs, 1);
end $$;

-- ── PASO 3. Confirmar que quedó prendido ────────────────────────────────────
select contact_phone_normalized, bot_paused, bot_paused_reason, bot_resumed_at
from public.bot_pause_state
where contact_phone_normalized = '59175681881';

-- ── Después de escribirle al bot, qué decidió ───────────────────────────────
-- select created_at, metadata->>'decision' as decision, contact_phone_masked
-- from public.system_logs
-- where created_at > now() - interval '15 minutes'
--   and event_type in ('ai_turn_decision', 'human_takeover')
-- order by created_at desc;
