-- ============================================================================
-- SEED — Clínica San Martín de Porres (datos reales)
-- ----------------------------------------------------------------------------
-- Carga especialidades y doctores. Idempotente: las especialidades hacen upsert
-- por (business, slug); los doctores se recargan (delete + insert) para este
-- negocio. Correr en Supabase → SQL Editor DESPUÉS de las migraciones.
-- ============================================================================

-- 1) ESPECIALIDADES ---------------------------------------------------------
insert into public.clinic_specialties (business, name, slug, sort_order) values
  ('clinica-san-martin', 'Medicina General', 'medicina-general', 1),
  ('clinica-san-martin', 'Pediatría',        'pediatria',        2),
  ('clinica-san-martin', 'Dermatología',     'dermatologia',     3),
  ('clinica-san-martin', 'Ginecología',      'ginecologia',      4),
  ('clinica-san-martin', 'Cardiología',      'cardiologia',      5),
  ('clinica-san-martin', 'Traumatología',    'traumatologia',    6)
on conflict (business, slug)
  do update set name = excluded.name, sort_order = excluded.sort_order, is_active = true;

-- 2) DOCTORES (recarga limpia para este negocio) ----------------------------
delete from public.clinic_doctors where business = 'clinica-san-martin';

insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dr. Maincra Ferrufino', 150, 30,
       '{1,2,3,4,5}', '07:00', '13:00', 'America/La_Paz',
       '8b0d1ce76c70775f4356c899d8af21c1a0a069d83c5a6386c8378e6f170f13c8@group.calendar.google.com', 1
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'medicina-general';

insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dra. Juana Pérez', 150, 30,
       '{1,2,3,4,5}', '13:00', '18:00', 'America/La_Paz',
       'd2d2427ffebc8d628f4f98c16d46f89d6e27cc123ac8c261448a56b8d4392dd5@group.calendar.google.com', 1
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'cardiologia';

-- NOTA: hay 6 especialidades pero solo 2 doctores cargados. Las otras 4
-- (Pediatría, Dermatología, Ginecología, Traumatología) aún no tienen doctor:
-- el bot las mostrará pero dirá que no hay disponibilidad hasta que cargues uno.
