-- ============================================================================
-- Human takeover — IDENTIDAD DURABLE POR TELÉFONO
-- ----------------------------------------------------------------------------
-- PROBLEMA QUE CORRIGE
-- El `conversation.id` de Kapso no es estable: el mismo paciente aparece con
-- ids distintos cuando la conversación se cierra y se reabre. La pausa del bot
-- se ESCRIBÍA buscando por `contact_phone` y se LEÍA por `kapso_conversation_id`,
-- así que:
--   * al cambiar el conversation.id, el bot "perdía" la pausa y volvía a
--     responder por encima de la persona;
--   * `contact_phone` NO es UNIQUE (solo índice), de modo que con dos filas para
--     el mismo teléfono el lookup con `.maybeSingle()` devolvía PGRST116 y el
--     webhook respondía 500, descartando la pausa entera.
--
-- ESTRATEGIA (NO DESTRUCTIVA)
-- No se agrega UNIQUE sobre `contact_phone` ni se borra ninguna fila: un
-- teléfono tiene legítimamente muchas conversaciones a lo largo del tiempo, y
-- `kapso_conversation_id` está referenciado como texto por kapso_messages,
-- kapso_response_locks, bot_control_events, system_logs y las tablas de la
-- clínica. Consolidar/borrar esas filas rompería historial.
--
-- En su lugar se separa la RESPONSABILIDAD:
--   * public.kapso_conversations  → sigue siendo metadata técnica por conversación
--     (intacta; se le agrega solo una columna GENERADA para poder agrupar).
--   * public.bot_pause_state      → NUEVA. Una sola fila por teléfono normalizado
--     (PRIMARY KEY). Es la identidad durable y la única fuente de verdad de la
--     pausa.
--
-- La consolidación de duplicados se hace al poblar bot_pause_state: por cada
-- teléfono se elige UNA fila ganadora de forma determinista (ver ORDER BY) y su
-- estado de pausa se preserva. Nada se borra ni se sobrescribe en las tablas
-- originales.
--
-- Idempotente. Correr: Supabase → SQL Editor → Run.
--
-- ROLLBACK:
--   drop table if exists public.bot_pause_state;
--   drop index if exists public.bot_control_pause_identity_wamid_uidx;
--   alter table public.bot_control_events drop column if exists contact_phone_normalized;
--   alter table public.kapso_conversations drop column if exists contact_phone_normalized;
--   drop function if exists public.normalize_phone(text);
-- ============================================================================

-- 1) NORMALIZACIÓN CANÓNICA ---------------------------------------------------
-- Conservadora a propósito: elimina SOLO diferencias de formato ("+", espacios,
-- guiones, paréntesis, puntos). No infiere código de país ni recorta dígitos.
-- Debe coincidir EXACTAMENTE con normalizePhone() en lib/engine/phone.ts.
create or replace function public.normalize_phone(raw text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select nullif(regexp_replace(raw, '[^0-9]', '', 'g'), '')
$$;

comment on function public.normalize_phone(text) is
  'Identidad telefónica canónica: solo dígitos. Espejo de lib/engine/phone.ts.';

-- 2) DIAGNÓSTICO: cuántas identidades venían duplicadas ------------------------
-- Informativo. Deja constancia en los logs de cuántos teléfonos tenían más de
-- una conversación (que es exactamente el caso que rompía la pausa).
do $$
declare
  dup_phones int;
  dup_rows int;
begin
  select count(*), coalesce(sum(n), 0)
    into dup_phones, dup_rows
  from (
    select public.normalize_phone(contact_phone) as identity, count(*) as n
    from public.kapso_conversations
    where public.normalize_phone(contact_phone) is not null
    group by 1
    having count(*) > 1
  ) d;

  raise notice 'human_takeover_durable_identity: % teléfonos con conversaciones duplicadas (% filas). No se borra ninguna.',
    coalesce(dup_phones, 0), coalesce(dup_rows, 0);
end $$;

-- 3) COLUMNA GENERADA EN kapso_conversations ----------------------------------
-- Generada (no escribible) para que ningún camino de código pueda olvidarse de
-- mantenerla en sincronía con contact_phone.
alter table public.kapso_conversations
  add column if not exists contact_phone_normalized text
  generated always as (public.normalize_phone(contact_phone)) stored;

create index if not exists idx_kapso_conversations_phone_normalized
on public.kapso_conversations (contact_phone_normalized);

-- 4) TABLA DE IDENTIDAD DURABLE ----------------------------------------------
create table if not exists public.bot_pause_state (
  contact_phone_normalized text primary key,
  -- Última representación cruda vista (solo para diagnóstico/legibilidad).
  contact_phone text,
  bot_paused boolean not null default false,
  bot_paused_at timestamptz,
  bot_resumed_at timestamptz,
  -- NULL = pausa indefinida (manual). No la vence el auto-resume.
  bot_pause_expires_at timestamptz,
  bot_paused_reason text,
  -- 'auto' (takeover/handoff, con TTL) | 'manual' (panel, indefinida)
  bot_pause_mode text,
  bot_pause_duration_minutes int,
  -- Referencias técnicas, nunca claves de búsqueda.
  last_kapso_conversation_id text,
  last_provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.bot_pause_state is
  'Fuente de verdad de la pausa del bot, una fila por teléfono normalizado. kapso_conversation_id es metadata, no clave.';

create index if not exists idx_bot_pause_state_active
on public.bot_pause_state (bot_paused, bot_pause_expires_at)
where bot_paused;

-- 5) CONSOLIDACIÓN DE DUPLICADOS ---------------------------------------------
-- Una fila ganadora por teléfono. Prioridad (de más fuerte a más débil):
--   1. pausa manual activa   (indefinida, decisión humana explícita)
--   2. cualquier pausa activa
--   3. vencimiento más lejano (NULL = indefinido = el más fuerte)
--   4. pausa más reciente
--   5. fila actualizada más recientemente
-- Si el resultado de la consolidación fuese ambiguo, gana SIEMPRE el estado más
-- restrictivo (más pausado): preferimos que el bot calle de más a que hable por
-- encima de una persona.
--
-- `on conflict do nothing` hace esto re-ejecutable sin pisar el estado que la
-- aplicación ya haya escrito después.
insert into public.bot_pause_state (
  contact_phone_normalized,
  contact_phone,
  bot_paused,
  bot_paused_at,
  bot_resumed_at,
  bot_pause_expires_at,
  bot_paused_reason,
  bot_pause_mode,
  bot_pause_duration_minutes,
  last_kapso_conversation_id,
  created_at,
  updated_at
)
select distinct on (c.contact_phone_normalized)
  c.contact_phone_normalized,
  c.contact_phone,
  coalesce(c.bot_paused, false),
  c.bot_paused_at,
  c.bot_resumed_at,
  c.bot_pause_expires_at,
  c.bot_paused_reason,
  c.bot_pause_mode,
  c.bot_pause_duration_minutes,
  c.kapso_conversation_id,
  now(),
  now()
from public.kapso_conversations c
where c.contact_phone_normalized is not null
order by
  c.contact_phone_normalized,
  (coalesce(c.bot_paused, false) and c.bot_pause_mode = 'manual') desc,
  coalesce(c.bot_paused, false) desc,
  (coalesce(c.bot_paused, false) and c.bot_pause_expires_at is null) desc,
  c.bot_pause_expires_at desc nulls last,
  c.bot_paused_at desc nulls last,
  c.updated_at desc nulls last
on conflict (contact_phone_normalized) do nothing;

-- 6) IDEMPOTENCIA POR WAMID, ALINEADA CON LA CONSULTA -------------------------
-- El índice previo era (kapso_conversation_id, action, provider_message_id): con
-- la identidad durable movida al teléfono, el mismo WAMID bajo dos conversation
-- ids distintos habría podido pausar dos veces. El índice nuevo indexa
-- exactamente las tres columnas por las que filtra la aplicación.
-- El índice viejo se CONSERVA (no estorba y sigue cubriendo filas históricas).
-- AUTOSUFICIENCIA: `provider_message_id` y la nulabilidad de
-- `bot_pause_duration_minutes` las introdujo 20260827000000_human_takeover_idempotency.sql,
-- que comparte timestamp con 20260827000000_precio_consulta_por_horario.sql y por
-- eso puede no haberse aplicado nunca. Se re-declaran acá de forma idempotente
-- para que ESTA migración no dependa de aquélla:
--   * sin provider_message_id, el índice de más abajo abortaría;
--   * con bot_pause_duration_minutes NOT NULL, el espejo de una pausa manual
--     (duración indefinida = NULL) fallaría con 23502.
alter table public.bot_control_events
  add column if not exists provider_message_id text;

alter table public.kapso_conversations
  alter column bot_pause_duration_minutes drop not null;

alter table public.bot_control_events
  add column if not exists contact_phone_normalized text;

create unique index if not exists bot_control_pause_identity_wamid_uidx
on public.bot_control_events (contact_phone_normalized, action, provider_message_id)
where action = 'pause'
  and provider_message_id is not null
  and contact_phone_normalized is not null;

create index if not exists idx_bot_control_events_phone_normalized
on public.bot_control_events (contact_phone_normalized, created_at desc);

-- Nota: las filas históricas de bot_control_events solo guardan el teléfono
-- ENMASCARADO, así que su contact_phone_normalized queda NULL y no es
-- recuperable. Es intencional: no se inventa dato. El índice parcial las excluye
-- y el dedupe nuevo aplica desde este punto en adelante.

-- 7) RLS ----------------------------------------------------------------------
-- Misma postura que 20260716000000: RLS activo y sin políticas → acceso solo con
-- la service role key (que salta RLS por diseño).
alter table public.bot_pause_state enable row level security;
