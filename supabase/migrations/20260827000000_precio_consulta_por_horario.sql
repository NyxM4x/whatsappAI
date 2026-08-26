-- ============================================================================
-- Precio de consulta por médico, día y horario
-- ----------------------------------------------------------------------------
-- consultation_price era un único monto fijo por médico. El cliente confirmó
-- las tarifas reales, que varían por día y hora:
--
--   Medicina general: 60 Bs (L-V 07:00-19:00, sáb 07:00-12:00), 80 Bs el resto
--                      de la semana (L-V noche, sáb tarde/noche, domingo todo
--                      el día).
--   Pediatría/Ginecología: 80 Bs L-V 07:00-19:00, 120 Bs sábado y domingo.
--
-- Se pidió una tabla NORMALIZADA POR MÉDICO (no por especialidad): hoy todos
-- los médicos de una especialidad cobran igual, pero la tabla queda lista para
-- que un médico individual tenga su propio precio por franja sin reestructurar
-- nada. Una fila por día concreto (no rangos "L-V"), para que el cálculo sea
-- un filtro simple por weekday + hora, sin parsear rangos.
--
-- consultation_price NO se borra: sigue como respaldo en getPriceForDoctorSlot
-- (lib/clinic/data.ts) si algún médico nuevo no tiene reglas cargadas todavía.
--
-- RLS igual que el resto del proyecto (20260716000000): sin policies, solo la
-- service role key accede.
-- ============================================================================

create table public.clinic_doctor_price_rules (
  id          uuid primary key default gen_random_uuid(),
  doctor_id   uuid not null references public.clinic_doctors(id) on delete cascade,
  weekday     int  not null check (weekday between 0 and 6), -- 0=domingo … 6=sábado, igual que clinic_doctors.work_days
  start_time  time not null,
  end_time    time not null check (end_time > start_time),
  price       numeric(10,2) not null,
  created_at  timestamptz not null default now()
);

create index on public.clinic_doctor_price_rules (doctor_id, weekday);
alter table public.clinic_doctor_price_rules enable row level security;

-- ── Medicina general: 60 Bs diurno, 80 Bs el resto ──────────────────────────
-- L-V se expande en 5 filas idénticas (una por weekday 1-5) para no meter
-- rangos en el modelo; sábado y domingo van aparte.
insert into public.clinic_doctor_price_rules (doctor_id, weekday, start_time, end_time, price)
select d.id, wd.weekday, '07:00', '19:00', 60
from public.clinic_doctors d
join public.clinic_specialties s on s.id = d.specialty_id
cross join (values (1), (2), (3), (4), (5)) as wd(weekday)
where d.business = 'clinica-san-martin' and s.slug = 'medicina-general';

insert into public.clinic_doctor_price_rules (doctor_id, weekday, start_time, end_time, price)
select d.id, wd.weekday, '19:00', '24:00', 80
from public.clinic_doctors d
join public.clinic_specialties s on s.id = d.specialty_id
cross join (values (1), (2), (3), (4), (5)) as wd(weekday)
where d.business = 'clinica-san-martin' and s.slug = 'medicina-general';

insert into public.clinic_doctor_price_rules (doctor_id, weekday, start_time, end_time, price)
select d.id, 6, '07:00', '12:00', 60
from public.clinic_doctors d
join public.clinic_specialties s on s.id = d.specialty_id
where d.business = 'clinica-san-martin' and s.slug = 'medicina-general';

insert into public.clinic_doctor_price_rules (doctor_id, weekday, start_time, end_time, price)
select d.id, 6, '12:00', '24:00', 80
from public.clinic_doctors d
join public.clinic_specialties s on s.id = d.specialty_id
where d.business = 'clinica-san-martin' and s.slug = 'medicina-general';

insert into public.clinic_doctor_price_rules (doctor_id, weekday, start_time, end_time, price)
select d.id, 0, '00:00', '24:00', 80
from public.clinic_doctors d
join public.clinic_specialties s on s.id = d.specialty_id
where d.business = 'clinica-san-martin' and s.slug = 'medicina-general';

-- ── Pediatría y Ginecología: 80 Bs L-V diurno, 120 Bs fin de semana ─────────
insert into public.clinic_doctor_price_rules (doctor_id, weekday, start_time, end_time, price)
select d.id, wd.weekday, '07:00', '19:00', 80
from public.clinic_doctors d
join public.clinic_specialties s on s.id = d.specialty_id
cross join (values (1), (2), (3), (4), (5)) as wd(weekday)
where d.business = 'clinica-san-martin' and s.slug in ('pediatria', 'ginecologia');

insert into public.clinic_doctor_price_rules (doctor_id, weekday, start_time, end_time, price)
select d.id, wd.weekday, '00:00', '24:00', 120
from public.clinic_doctors d
join public.clinic_specialties s on s.id = d.specialty_id
cross join (values (0), (6)) as wd(weekday)
where d.business = 'clinica-san-martin' and s.slug in ('pediatria', 'ginecologia');
