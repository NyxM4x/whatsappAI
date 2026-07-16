-- ============================================================================
-- Seguridad — Habilitar Row Level Security (RLS) en TODAS las tablas public
-- ----------------------------------------------------------------------------
-- Los datos son médicos/personales (nombre, CI, teléfono, motivo de consulta) y
-- hay password_hash en clinic_staff. Hoy la única protección es que el código
-- usa siempre la SERVICE ROLE KEY del lado servidor. RLS agrega defensa en
-- profundidad: si alguna vez se filtra/usa la anon key, no puede leer ni escribir
-- nada, porque no hay políticas para anon/authenticated.
--
-- IMPORTANTE: la service role key **salta RLS por diseño**, así que el bot, los
-- crons y el panel (que usan esa key) siguen funcionando exactamente igual. NO se
-- crean políticas a propósito: acceso solo vía service role.
--
-- Idempotente y aplica a todas las tablas presentes y futuras del schema public.
--
-- ROLLBACK (si algo dejara de leer inesperadamente, correr en el SQL Editor):
--   do $$ declare r record; begin
--     for r in select tablename from pg_tables where schemaname='public' loop
--       execute format('alter table public.%I disable row level security', r.tablename);
--     end loop; end $$;
-- ============================================================================

do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;
