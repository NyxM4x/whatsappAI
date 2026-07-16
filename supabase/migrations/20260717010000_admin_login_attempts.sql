-- ============================================================================
-- Rate limiting del login del panel interno (P1.8)
-- ----------------------------------------------------------------------------
-- Registra cada intento de login (éxito/fallo) por negocio+correo. Antes de
-- verificar credenciales, se cuentan los fallos recientes; si superan el
-- umbral, se rechaza sin siquiera comparar la contraseña (ver lib/admin/auth.ts).
-- ============================================================================

create table if not exists public.clinic_login_attempts (
  id         bigint generated always as identity primary key,
  business   text not null,
  email      text not null,
  success    boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists clinic_login_attempts_lookup_idx
on public.clinic_login_attempts (business, email, created_at desc);

-- Tabla nueva creada DESPUÉS de la migración que activó RLS en todas las tablas
-- existentes (20260716000000) — se activa acá explícitamente para no quedar afuera.
alter table public.clinic_login_attempts enable row level security;
