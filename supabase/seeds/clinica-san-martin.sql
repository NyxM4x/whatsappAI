-- ============================================================================
-- SEED — Clínica San Martín de Porres (datos reales)
-- ----------------------------------------------------------------------------
-- Carga especialidades y doctores. Idempotente: las especialidades hacen upsert
-- por (business, slug); los doctores se recargan (delete + insert) para este
-- negocio. Correr en Supabase → SQL Editor DESPUÉS de las migraciones.
--
-- Roster (12 doctores). Cada uno con su google_calendar_id propio; el calendario
-- DEBE estar compartido con el email de la cuenta de servicio
-- (GOOGLE_SERVICE_ACCOUNT_JSON) con permiso "Hacer cambios en los eventos", o el
-- doctor no ofrecerá horarios (ver lib/clinic/booking.ts getAvailableSlots).
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
-- Desreferenciar citas que apuntan a doctores de esta clínica antes de borrarlos.
update public.clinic_appointments
set doctor_id = null
where business = 'clinica-san-martin';

delete from public.clinic_doctors where business = 'clinica-san-martin';

-- Insert único: cada fila se une a su especialidad por slug. slot_minutes = 30
-- y timezone = America/La_Paz para todos.
insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select
  'clinica-san-martin', s.id, d.name, d.price, 30,
  d.work_days::int[], d.work_start::time, d.work_end::time, 'America/La_Paz',
  d.calendar_id, d.sort_order
from (values
  -- MEDICINA GENERAL
  ('medicina-general', 'Dr. Maincra Ferrufino', 150, '{1,2,3,4,5}', '08:00', '13:00', '8b0d1ce76c70775f4356c899d8af21c1a0a069d83c5a6386c8378e6f170f13c8@group.calendar.google.com', 1),
  ('medicina-general', 'Dr. Eduardo Mendoza',   180, '{1,2,3,4,5}', '08:00', '14:00', '7c1bbbd4f82fbfd357574c2b8ff5c3fc9e5e1bf1442565593f0e96c668a79da6@group.calendar.google.com', 2),
  -- PEDIATRÍA
  ('pediatria',        'Dr. Jorge Villca',       160, '{1,2,3,4,5}', '09:00', '15:00', '969f1720b8d5b9f8e21e56d6fedde0fd515063d662baaac6b015a730f365ca55@group.calendar.google.com', 1),
  ('pediatria',        'Dra. Ana Condori',       160, '{1,2,3,4,5}', '15:00', '20:00', '8fd7449087cb50eac8c6aebf40b1217e37ec0190f8a16205cfa436520a13c27f@group.calendar.google.com', 2),
  -- DERMATOLOGÍA
  ('dermatologia',     'Dr. Roberto Choque',     200, '{1,2,3,4,5}', '10:00', '16:00', 'b16e91c58eb264ee87b51416ca3a4bf253c42da3342801968be5264e4abd0300@group.calendar.google.com', 1),
  -- GINECOLOGÍA
  ('ginecologia',      'Dra. Patricia Torrez',   190, '{1,2,3,4,5}', '11:00', '17:00', '33d3cb13056412dac5b0a525e06624b4acf2d288dd55e2ecae1a27911c9a7e1e@group.calendar.google.com', 1),
  ('ginecologia',      'Dra. Carmen Quispe',     190, '{1,2,3,4,5}', '12:00', '18:00', 'cebbe770e00f0b3c3b8c57b8d78982e2e8ebb42a0d45eecc4458740466ff169c@group.calendar.google.com', 2),
  -- CARDIOLOGÍA
  ('cardiologia',      'Dra. Juana Pérez',       150, '{1,2,3,4,5}', '13:00', '18:00', 'd2d2427ffebc8d628f4f98c16d46f89d6e27cc123ac8c261448a56b8d4392dd5@group.calendar.google.com', 1),
  ('cardiologia',      'Dra. Rosa Apaza',        250, '{1,2,3,4,5}', '08:00', '13:00', '5b493588f1b840706f2027d50e6747fd4f6d5a218215e6cbe6d5b9de1b3b7f1c@group.calendar.google.com', 2),
  ('cardiologia',      'Dr. Miguel Vargas',      150, '{1,2,3,4,5}', '14:00', '20:00', '6bd1101e309b98cdec3dfd8c19ba4a85f09bba025a132bee4d846da01d262857@group.calendar.google.com', 3),
  ('cardiologia',      'Dr. Luis Mamani',        240, '{1,2,3,4,5}', '08:00', '14:00', 'e068d37d576c8e614887e8a919a3e89d56b6f5cd4eb14ddf9211766593756de8@group.calendar.google.com', 4),
  -- TRAUMATOLOGÍA
  ('traumatologia',    'Dra. Mónica Flores',     220, '{1,2,3,4,5}', '08:30', '14:30', '5c2f5f10b136ba49f4d1ede73695968595da6314a2d5623bfe6a4dcc98f82ce8@group.calendar.google.com', 1)
) as d(specialty_slug, name, price, work_days, work_start, work_end, calendar_id, sort_order)
join public.clinic_specialties s
  on s.business = 'clinica-san-martin' and s.slug = d.specialty_slug;
