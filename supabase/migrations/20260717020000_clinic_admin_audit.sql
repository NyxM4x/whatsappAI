-- ============================================================================
-- Auditoría de acciones administrativas (P1.10)
-- ----------------------------------------------------------------------------
-- Registra quién hizo qué desde el panel interno, para trazabilidad. Empieza
-- con cancelar/confirmar citas manualmente (app/admin/actions.ts); pensada para
-- reusarse cuando se agreguen más acciones administrativas (config, doctores,
-- precios, QR).
-- ============================================================================

create table if not exists public.clinic_admin_audit (
  id         bigint generated always as identity primary key,
  business   text not null,
  actor_id   text not null,
  actor_name text,
  action     text not null,           -- ej. 'appointment.cancel', 'appointment.confirm'
  entity     text not null,           -- ej. 'appointment'
  entity_id  text not null,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);

create index if not exists clinic_admin_audit_lookup_idx
on public.clinic_admin_audit (business, entity, entity_id, created_at desc);

alter table public.clinic_admin_audit enable row level security;
