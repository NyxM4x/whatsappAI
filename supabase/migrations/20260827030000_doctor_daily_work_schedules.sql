-- Horarios reales por medico y dia. weekday: 0 domingo ... 6 sabado.
create table if not exists public.clinic_doctor_work_hours (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.clinic_doctors(id) on delete cascade,
  weekday int not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  ends_next_day boolean not null default false,
  created_at timestamptz not null default now(),
  check (ends_next_day or end_time > start_time)
);

create unique index if not exists clinic_doctor_work_hours_unique
on public.clinic_doctor_work_hours (doctor_id, weekday, start_time, end_time, ends_next_day);
create index if not exists clinic_doctor_work_hours_lookup
on public.clinic_doctor_work_hours (doctor_id, weekday);
alter table public.clinic_doctor_work_hours enable row level security;

delete from public.clinic_doctor_work_hours
where doctor_id in (select id from public.clinic_doctors where business = 'clinica-san-martin');

insert into public.clinic_doctor_work_hours (doctor_id, weekday, start_time, end_time, ends_next_day)
select d.id, x.weekday, x.start_time::time, x.end_time::time, x.ends_next_day
from public.clinic_doctors d
cross join lateral (values
  (1, '07:00', '19:00', false), (5, '07:00', '07:00', true)
) x(weekday, start_time, end_time, ends_next_day)
where d.business = 'clinica-san-martin' and d.name = 'Dra. Linsey Angela Diaz Sanchez'
union all
select d.id, x.weekday, x.start_time::time, x.end_time::time, x.ends_next_day
from public.clinic_doctors d
cross join lateral (values
  (2, '07:00', '07:00', true), (4, '07:00', '19:00', false), (6, '07:00', '14:00', false)
) x(weekday, start_time, end_time, ends_next_day)
where d.business = 'clinica-san-martin' and d.name = 'Dr. Luis Jaime Rivera Porcel'
union all
select d.id, x.weekday, x.start_time::time, x.end_time::time, x.ends_next_day
from public.clinic_doctors d
cross join lateral (values
  (3, '07:00', '07:00', true), (6, '14:00', '07:00', true)
) x(weekday, start_time, end_time, ends_next_day)
where d.business = 'clinica-san-martin' and d.name = 'Dr. Octavio Salinas Gallegos'
union all
select d.id, x.weekday, x.start_time::time, x.end_time::time, x.ends_next_day
from public.clinic_doctors d
cross join lateral (values
  (1, '19:00', '07:00', true), (4, '19:00', '07:00', true)
) x(weekday, start_time, end_time, ends_next_day)
where d.business = 'clinica-san-martin' and d.name = 'Dra. Nohelia Pariente Delgadillo'
union all
select d.id, 0, '07:00'::time, '07:00'::time, true
from public.clinic_doctors d
where d.business = 'clinica-san-martin' and d.name = 'Dr. Einar Heredia'
union all
select d.id, x.weekday, x.start_time::time, x.end_time::time, x.ends_next_day
from public.clinic_doctors d
cross join lateral (values
  (1, '10:00', '12:00', false), (2, '10:00', '12:00', false),
  (3, '10:00', '12:00', false), (4, '10:00', '12:00', false),
  (5, '10:00', '12:00', false), (0, '10:00', '12:00', false)
) x(weekday, start_time, end_time, ends_next_day)
where d.business = 'clinica-san-martin' and d.name = 'Dra. Rosmery Medina'
union all
select d.id, x.weekday, x.start_time::time, x.end_time::time, x.ends_next_day
from public.clinic_doctors d
cross join lateral (values
  (1, '17:00', '19:00', false), (2, '17:00', '19:00', false),
  (3, '17:00', '19:00', false), (4, '17:00', '19:00', false),
  (5, '17:00', '19:00', false), (6, '10:00', '12:00', false),
  (6, '17:00', '19:00', false), (0, '10:00', '12:00', false),
  (0, '17:00', '19:00', false)
) x(weekday, start_time, end_time, ends_next_day)
where d.business = 'clinica-san-martin' and d.name = 'Dr. Miguel Edgar Daguino Delgadillo'
union all
select d.id, x.weekday, x.start_time::time, x.end_time::time, x.ends_next_day
from public.clinic_doctors d
cross join lateral (values
  (4, '07:00', '19:00', false), (5, '07:00', '14:00', false)
) x(weekday, start_time, end_time, ends_next_day)
where d.business = 'clinica-san-martin' and d.name = 'Dr. Favio Tola Choque'
union all
select d.id, x.weekday, x.start_time::time, x.end_time::time, x.ends_next_day
from public.clinic_doctors d
cross join lateral (values
  (1, '17:00', '19:00', false), (3, '17:00', '19:00', false),
  (4, '17:00', '19:00', false), (5, '17:00', '19:00', false)
) x(weekday, start_time, end_time, ends_next_day)
where d.business = 'clinica-san-martin' and d.name = 'Dra. Yabdiga Medina Merida';
