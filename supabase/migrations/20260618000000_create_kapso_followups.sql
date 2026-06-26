-- Follow-up automático Reino del Bebé (Fase 0)
-- Tabla que registra UNICAMENTE los follow-ups reales (en dry-run no se inserta nada aquí).
-- UNIQUE(kapso_conversation_id) garantiza "máximo 1 follow-up real por conversación".

create table if not exists public.kapso_followups (
  id                    uuid primary key default gen_random_uuid(),
  kapso_conversation_id text not null unique,             -- máx 1 follow-up real por conversación
  contact_phone         text not null,
  trigger_inbound_at    timestamptz not null,             -- último inbound al momento de agendar
  scheduled_at          timestamptz not null,             -- trigger + random(6h..8h)
  status                text not null default 'pending',  -- pending|sent|skipped|canceled|failed
  skip_reason           text,                             -- reengaged|outside_24h|rejection
  attempts              integer not null default 0,       -- reintentos de envío (fallo transitorio)
  sent_at               timestamptz,
  error_message         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists kapso_followups_due_idx
  on public.kapso_followups (status, scheduled_at);

-- Detección de candidatos: último inbound por conversación dentro de la ventana de silencio
-- [p_min_silence_minutes, p_max_silence_minutes] y SIN fila previa en kapso_followups.
-- Parametrizado en minutos para soportar el override acelerado de pruebas.
create or replace function public.get_followup_candidates(
  p_min_silence_minutes integer default 300,   -- 5h: umbral < 6h (acota la "ventana móvil")
  p_max_silence_minutes integer default 1440,  -- 24h: ventana de servicio WhatsApp
  p_test_conversation_id text default null
)
returns table (
  kapso_conversation_id text,
  last_inbound_at        timestamptz,
  last_inbound_content   text,
  contact_phone          text
)
language sql
stable
as $$
  with last_inbound as (
    select distinct on (m.kapso_conversation_id)
           m.kapso_conversation_id,
           coalesce(m.message_timestamp, m.created_at) as last_inbound_at,
           m.content                                   as last_inbound_content,
           m.contact_phone
    from public.kapso_messages m
    where m.direction = 'inbound'
    order by m.kapso_conversation_id, coalesce(m.message_timestamp, m.created_at) desc
  )
  select li.kapso_conversation_id, li.last_inbound_at, li.last_inbound_content, li.contact_phone
  from last_inbound li
  left join public.kapso_followups f on f.kapso_conversation_id = li.kapso_conversation_id
  where f.id is null
    and li.last_inbound_at <= now() - make_interval(mins => p_min_silence_minutes)
    and li.last_inbound_at >= now() - make_interval(mins => p_max_silence_minutes)
    and (p_test_conversation_id is null or li.kapso_conversation_id = p_test_conversation_id);
$$;
