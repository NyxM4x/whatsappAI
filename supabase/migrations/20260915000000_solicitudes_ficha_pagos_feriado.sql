-- ============================================================================
-- Solicitudes de ficha, comprobantes de pago y feriado del día
-- ----------------------------------------------------------------------------
-- Desde 2026-09-15 el bot deja de agendar: el plantel no cumple los horarios
-- cargados, así que el bot solo recopila la solicitud y un asesor confirma por
-- WhatsApp. Tres piezas nuevas:
--
--   clinic_leads          → una fila por solicitud que necesita a una persona
--                           (ficha, servicio, pidió hablar con alguien, 3
--                           intentos fallidos, cancelar, reprogramar, pago). El
--                           panel hace sonar una alarma mientras haya filas en
--                           'pending', y cada una se calla con su botón
--                           "Atender" (queda registrado quién y cuándo).
--
--   clinic_payment_proofs → comprobantes (imagen/PDF) que llegan por WhatsApp,
--                           con el monto que leyó la IA, para revisarlos desde
--                           el panel. kapso_message_id único: el reintento de
--                           un webhook no duplica el comprobante.
--
--   clinic_settings.holiday_date → la enfermera marca "hoy es feriado" en el
--                           panel. Se guarda la fecha (no un booleano), así se
--                           apaga sola al cambiar el día sin ningún cron.
--
-- RLS igual que el resto del proyecto (20260716000000): activo y sin policies,
-- solo la service role key accede.
-- ============================================================================

-- ── A. Solicitudes ──────────────────────────────────────────────────────────
create table if not exists public.clinic_leads (
  id                    uuid primary key default gen_random_uuid(),
  business              text not null,
  kapso_conversation_id text,
  contact_phone         text not null,
  contact_name          text,
  kind                  text not null
      check (kind in ('ficha', 'servicio', 'humano', 'fallidos', 'cancelar', 'reprogramar', 'consulta_cita', 'pago')),
  status                text not null default 'pending'
      check (status in ('pending', 'attended', 'withdrawn')),
  patient_name          text,
  specialty             text,
  doctor_preference     text,
  preferred_time        text,
  visit_type            text check (visit_type in ('nueva', 'reconsulta')),
  service_name          text,
  price_quote           text,
  summary               text,
  last_message          text,
  attended_by_id        text,
  attended_by_name      text,
  attended_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.clinic_leads is
  'Solicitudes que un asesor debe atender por WhatsApp. status=pending hace sonar la alarma del panel.';

create index if not exists clinic_leads_status_idx
  on public.clinic_leads (business, status, created_at desc);
create index if not exists clinic_leads_phone_kind_idx
  on public.clinic_leads (business, contact_phone, kind, created_at desc);

alter table public.clinic_leads enable row level security;

-- ── B. Comprobantes de pago ─────────────────────────────────────────────────
create table if not exists public.clinic_payment_proofs (
  id                    uuid primary key default gen_random_uuid(),
  business              text not null,
  kapso_conversation_id text,
  kapso_message_id      text,
  contact_phone         text not null,
  contact_name          text,
  media_url             text not null,
  media_type            text,
  detected_amount       numeric(10,2),
  ai_note               text,
  reviewed              boolean not null default false,
  reviewed_by_name      text,
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now()
);

-- Único con NULLs distintos (default de Postgres): solo deduplica cuando hay id.
create unique index if not exists clinic_payment_proofs_message_uidx
  on public.clinic_payment_proofs (kapso_message_id);
create index if not exists clinic_payment_proofs_business_idx
  on public.clinic_payment_proofs (business, created_at desc);

alter table public.clinic_payment_proofs enable row level security;

-- ── C. Feriado del día ──────────────────────────────────────────────────────
alter table public.clinic_settings
  add column if not exists holiday_date date;

comment on column public.clinic_settings.holiday_date is
  'Fecha marcada como feriado desde el panel. Si coincide con hoy (timezone de la clínica), el bot no cotiza precios.';
