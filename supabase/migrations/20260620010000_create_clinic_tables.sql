-- ============================================================================
-- CLÍNICA PRIVADA — agendamiento de citas (MVP)
-- ----------------------------------------------------------------------------
-- Tablas propias del rubro clínica. La disponibilidad real de horarios sale de
-- Google Calendar (eventos ocupados); aquí guardamos especialidades, doctores
-- (con su calendar_id y horario base), las citas y el estado de la reserva en
-- curso de cada conversación. Idempotente. Correr en Supabase → SQL Editor.
-- ============================================================================

create extension if not exists pgcrypto;

-- 1) ESPECIALIDADES ---------------------------------------------------------
create table if not exists public.clinic_specialties (
  id          uuid primary key default gen_random_uuid(),
  business    text not null,                 -- slug del negocio (multi-rubro)
  name        text not null,                 -- "Pediatría", "Dermatología"
  slug        text not null,                 -- "pediatria" (para matching)
  description text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (business, slug)
);

-- 2) DOCTORES / PERSONAL ----------------------------------------------------
-- google_calendar_id: el calendario del doctor compartido con la service account.
-- work_days: días laborables (0=domingo … 6=sábado). work_start/end: ventana
-- diaria. slot_minutes: duración de cada cita. La disponibilidad final se cruza
-- contra los eventos ocupados de Google Calendar.
create table if not exists public.clinic_doctors (
  id                  uuid primary key default gen_random_uuid(),
  business            text not null,
  specialty_id        uuid not null references public.clinic_specialties(id) on delete cascade,
  name                text not null,
  google_calendar_id  text,
  consultation_price  numeric(10,2),
  slot_minutes        int not null default 30,
  work_days           int[] not null default '{1,2,3,4,5}',  -- lun–vie por defecto
  work_start          time not null default '09:00',
  work_end            time not null default '17:00',
  timezone            text not null default 'America/La_Paz',
  is_active           boolean not null default true,
  sort_order          int not null default 0,
  created_at          timestamptz not null default now()
);

create index if not exists clinic_doctors_specialty_idx
  on public.clinic_doctors (specialty_id, is_active);

-- 3) CITAS ------------------------------------------------------------------
-- status: draft → awaiting_payment → confirmed | canceled
-- (con "bot confirma automático", al recibir el comprobante pasa a confirmed).
create table if not exists public.clinic_appointments (
  id                      uuid primary key default gen_random_uuid(),
  business                text not null,
  kapso_conversation_id   text,
  contact_phone           text not null,
  patient_name            text,
  patient_ci              text,              -- carnet de identidad
  reason                  text,              -- motivo de consulta
  specialty_id            uuid references public.clinic_specialties(id),
  doctor_id               uuid references public.clinic_doctors(id),
  scheduled_start         timestamptz,
  scheduled_end           timestamptz,
  status                  text not null default 'draft',  -- draft|hold|awaiting_payment|payment_review|confirmed|canceled
  payment_method          text,              -- 'qr' | 'cash'
  payment_proof_url       text,              -- comprobante (PDF/PNG/JPG)
  google_event_id         text,              -- evento creado en el calendario
  reschedule_count        int not null default 0,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists clinic_appointments_doctor_time_idx
  on public.clinic_appointments (doctor_id, scheduled_start);
create index if not exists clinic_appointments_conv_idx
  on public.clinic_appointments (kapso_conversation_id);
create index if not exists clinic_appointments_status_idx
  on public.clinic_appointments (status, scheduled_start);

-- 4) ESTADO DE LA RESERVA EN CURSO (máquina de pasos por conversación) -------
-- step: idle | choosing_specialty | choosing_doctor | choosing_slot |
--       collecting_name | choosing_payment | awaiting_proof | done
-- draft: acumula lo elegido hasta crear la cita final.
create table if not exists public.clinic_booking_sessions (
  kapso_conversation_id text primary key,
  business              text not null,
  step                  text not null default 'idle',
  draft                 jsonb not null default '{}'::jsonb,
  -- Bloqueo temporal del horario (evita doble reserva mientras el paciente
  -- completa sus datos). Un hold con hold_expires_at > now() ocupa el slot.
  held_doctor_id        uuid,
  held_slot_start       timestamptz,
  hold_expires_at       timestamptz,
  updated_at            timestamptz not null default now()
);

-- Búsqueda de holds vigentes por doctor (para excluir slots ya apartados).
create index if not exists clinic_booking_holds_idx
  on public.clinic_booking_sessions (held_doctor_id, hold_expires_at);
