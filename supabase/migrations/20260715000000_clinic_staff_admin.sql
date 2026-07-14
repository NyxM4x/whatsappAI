-- ============================================================================
-- Panel interno (/admin) — usuarios de la secretaria
-- ----------------------------------------------------------------------------
-- Tabla de personal con login por usuario/contraseña. Las contraseñas se
-- guardan hasheadas con pgcrypto (bcrypt, algoritmo 'bf'), compatible con la
-- librería bcryptjs que usa el código de Node para verificarlas — no hace
-- falta ningún script aparte para generar el hash, se hace acá mismo con SQL.
--
-- ⚠️ ANTES DE CORRER: reemplazar:
--   - <EMAIL_DE_LA_SECRETARIA>       → el correo con el que va a iniciar sesión
--   - <CONTRASEÑA_TEMPORAL>          → una contraseña temporal (avisale que la
--                                       cambie; ver el UPDATE de ejemplo abajo)
--
-- Para agregar más personal más adelante, repetir el INSERT con otro email.
-- Para cambiar una contraseña:
--   update public.clinic_staff
--   set password_hash = crypt('nueva-contraseña', gen_salt('bf'))
--   where business = 'clinica-san-martin' and email = 'el-correo@ejemplo.com';
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.clinic_staff (
  id            uuid primary key default gen_random_uuid(),
  business      text not null,
  name          text not null,
  email         text not null,
  password_hash text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (business, email)
);

insert into public.clinic_staff (business, name, email, password_hash)
values (
  'clinica-san-martin',
  'Secretaria',
  '<EMAIL_DE_LA_SECRETARIA>',
  crypt('<CONTRASEÑA_TEMPORAL>', gen_salt('bf'))
)
on conflict (business, email) do nothing;
