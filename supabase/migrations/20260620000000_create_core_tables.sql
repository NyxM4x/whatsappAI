-- ============================================================================
-- ESQUEMA BASE del bot de WhatsApp (Kapso + Vercel + Supabase)
-- ----------------------------------------------------------------------------
-- Esquema AUTORITATIVO de las 7 tablas core (provisto por el dueño del proyecto;
-- es el que la app espera realmente). Idempotente (create ... if not exists) y
-- convive con la migración de followups. Correr: Supabase → SQL Editor → Run.
-- ============================================================================

create extension if not exists pgcrypto;

-- 1) CONTACTOS --------------------------------------------------------------
create table if not exists public.kapso_contacts (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2) CONVERSACIONES (incluye estado de pausa del bot) -----------------------
create table if not exists public.kapso_conversations (
  id uuid primary key default gen_random_uuid(),
  kapso_conversation_id text unique not null,
  contact_phone text not null,
  status text default 'active',
  bot_enabled boolean default true,
  bot_paused boolean not null default false,
  bot_paused_at timestamptz,
  bot_resumed_at timestamptz,
  bot_pause_expires_at timestamptz,
  bot_paused_reason text,
  bot_pause_mode text,
  bot_pause_duration_minutes int not null default 1440,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 3) MENSAJES (inbound + outbound + marcadores internos) --------------------
create table if not exists public.kapso_messages (
  id uuid primary key default gen_random_uuid(),
  kapso_message_id text unique,
  kapso_conversation_id text,
  contact_phone text not null,
  direction text not null,
  role text not null,
  content text not null,
  raw_payload jsonb,
  message_timestamp timestamptz,
  batch_index int,
  created_at timestamptz default now()
);

-- 4) IMÁGENES DEL CATÁLOGO (por negocio + intent) ---------------------------
-- intent = `${producto}_${grupo}` (ej: combo_nina, panales_nino).
-- Aquí se siembran las imágenes de CADA rubro con su slug en `business`.
create table if not exists public.kapso_media_assets (
  id uuid primary key default gen_random_uuid(),
  business text not null,
  title text not null,
  media_type text default 'image',
  url text not null,
  intent text,
  tags text[],
  is_active boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- 5) LOCKS ANTI-DUPLICADO DE RESPUESTA --------------------------------------
create table if not exists public.kapso_response_locks (
  id uuid primary key default gen_random_uuid(),
  kapso_conversation_id text not null,
  last_kapso_message_id text not null unique,
  batch_size int,
  status text not null default 'processing',
  response_text text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 6) LOGS DEL SISTEMA + alertas --------------------------------------------
create table if not exists public.system_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  level text not null default 'info'
    check (level in ('info', 'warning', 'error', 'critical')),
  event_type text not null,
  source text not null default 'kapso-vercel',
  business text default 'reino-del-bebe',
  client_id text,
  kapso_conversation_id text,
  kapso_message_id text,
  contact_phone_masked text,
  status_code int,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  is_alerted boolean not null default false,
  resolved_at timestamptz
);

-- 7) EVENTOS DE CONTROL DEL BOT (pausar/reanudar manual) --------------------
create table if not exists public.bot_control_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kapso_conversation_id text,
  contact_phone_masked text,
  action text not null,
  actor_source text,
  actor_email text,
  reason text,
  expires_at timestamptz,
  metadata jsonb default '{}'::jsonb
);

-- ÍNDICES -------------------------------------------------------------------
create index if not exists idx_kapso_messages_conversation_created
on public.kapso_messages (kapso_conversation_id, created_at);

create index if not exists idx_kapso_conversations_contact_phone
on public.kapso_conversations (contact_phone);

create unique index if not exists kapso_messages_kapso_message_id_uidx
on public.kapso_messages (kapso_message_id)
where kapso_message_id is not null;

create unique index if not exists kapso_response_locks_last_message_uidx
on public.kapso_response_locks (last_kapso_message_id);

create index if not exists system_logs_created_at_idx
on public.system_logs (created_at desc);

create index if not exists system_logs_level_idx
on public.system_logs (level);

create index if not exists system_logs_event_type_idx
on public.system_logs (event_type);

create index if not exists system_logs_conversation_idx
on public.system_logs (kapso_conversation_id);

create index if not exists system_logs_unresolved_errors_idx
on public.system_logs (level, created_at desc)
where level in ('error', 'critical') and resolved_at is null;
