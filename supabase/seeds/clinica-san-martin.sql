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
-- Desreferenciar citas que apuntan a doctores de esta clínica antes de borrarlos.
update public.clinic_appointments
set doctor_id = null
where business = 'clinica-san-martin';

delete from public.clinic_doctors where business = 'clinica-san-martin';

-- MEDICINA GENERAL ----------------------------------------------------------
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
select 'clinica-san-martin', s.id, 'Dra. Carmen Quispe', 150, 30,
       '{1,2,3,4,5}', '13:00', '19:00', 'America/La_Paz',
       null, 2
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'medicina-general';

-- PEDIATRÍA -----------------------------------------------------------------
insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dra. Ana Condori', 160, 30,
       '{1,2,3,4,5}', '08:00', '13:00', 'America/La_Paz',
       null, 1
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'pediatria';

insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dr. Luis Mamani', 160, 30,
       '{1,2,3,4,6}', '14:00', '19:00', 'America/La_Paz',
       null, 2
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'pediatria';

-- DERMATOLOGÍA --------------------------------------------------------------
insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dra. Patricia Torrez', 180, 30,
       '{1,2,3,4,5}', '08:00', '13:00', 'America/La_Paz',
       null, 1
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'dermatologia';

insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dr. Miguel Vargas', 180, 30,
       '{2,3,4,5,6}', '14:00', '19:00', 'America/La_Paz',
       null, 2
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'dermatologia';

-- GINECOLOGÍA ---------------------------------------------------------------
insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dra. Rosa Apaza', 200, 30,
       '{1,2,3,4,5}', '08:00', '13:00', 'America/La_Paz',
       null, 1
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'ginecologia';

insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dra. Mónica Flores', 200, 30,
       '{1,3,4,5,6}', '14:00', '19:00', 'America/La_Paz',
       null, 2
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'ginecologia';

-- CARDIOLOGÍA ---------------------------------------------------------------
insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dra. Juana Pérez', 150, 30,
       '{1,2,3,4,5}', '13:00', '18:00', 'America/La_Paz',
       'd2d2427ffebc8d628f4f98c16d46f89d6e27cc123ac8c261448a56b8d4392dd5@group.calendar.google.com', 1
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'cardiologia';

insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dr. Roberto Choque', 150, 30,
       '{1,2,3,4,5}', '07:00', '13:00', 'America/La_Paz',
       null, 2
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'cardiologia';

-- TRAUMATOLOGÍA -------------------------------------------------------------
insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dr. Jorge Villca', 170, 30,
       '{1,2,3,4,5}', '08:00', '13:00', 'America/La_Paz',
       null, 1
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'traumatologia';

insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes,
   work_days, work_start, work_end, timezone, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dr. Eduardo Mendoza', 170, 30,
       '{1,2,4,5,6}', '14:00', '19:00', 'America/La_Paz',
       null, 2
from public.clinic_specialties s
where s.business = 'clinica-san-martin' and s.slug = 'traumatologia';
