-- ============================================================================
-- Plantel real de la clínica + horas puntuales de atención
-- ----------------------------------------------------------------------------
-- Hasta ahora clinic_doctors tenía los 12 médicos del seed de demostración
-- (Dr. Jorge Villca, Dra. Ana Condori…): nombres, precios y especialidades
-- inventados que el bot llegó a ofrecerle a pacientes reales. Se reemplazan por
-- el plantel oficial: 5 de medicina general, 2 de pediatría y 2 de ginecología.
--
-- CAMBIO DE MODELO — work_hours:
-- Estos médicos NO atienden de corrido: pasan consulta en bloques sueltos
-- (07:00, 12:00, 14:00, 17:00, 19:00). El cálculo de turnos partía siempre de
-- una franja continua workStart→workEnd troceada en slots, así que cargarlos
-- como rango 07:00–19:00 habría ofrecido turnos a las 07:30, 08:00, 08:30… con
-- el médico ausente. work_hours guarda las horas exactas y computeAvailableSlots
-- genera un turno por cada una. Los médicos sin work_hours siguen usando el
-- rango de siempre.
--
-- Calendarios: se reutilizan los de los médicos ficticios — son calendarios
-- reales de Google sobre los que la service account ya tiene permisos, así que
-- el bot puede agendar de inmediato. Conviene renombrarlos en Google Calendar
-- para que digan el médico correcto.
-- ============================================================================

alter table public.clinic_doctors
  add column if not exists work_hours time[];

comment on column public.clinic_doctors.work_hours is
  'Horas puntuales de atención. Con valores, manda sobre work_start/work_end: un turno por hora listada. NULL = franja continua.';

-- ── Limpieza del seed de demostración ───────────────────────────────────────
-- Las 8 citas existentes son pruebas internas (todas del mismo número, jul–ago
-- 2026, ya pasadas). Se borran antes que los médicos por la FK.
delete from public.clinic_appointments where business = 'clinica-san-martin';
delete from public.clinic_doctors      where business = 'clinica-san-martin';

-- ── Especialidades ──────────────────────────────────────────────────────────
-- Solo quedan activas las tres que se agendan por WhatsApp. Dermatología no
-- figura en el tarifario ni en el plantel: se elimina. Cardiología y
-- traumatología sí existen, pero se atienden "a llamado" y no tienen horario
-- que ofrecer — se desactivan hasta que exista el flujo de derivación a asesor.
delete from public.clinic_specialties
where business = 'clinica-san-martin' and slug = 'dermatologia';

update public.clinic_specialties
set is_active = false
where business = 'clinica-san-martin' and slug in ('cardiologia', 'traumatologia');

update public.clinic_specialties
set is_active = true, sort_order = case slug
      when 'medicina-general' then 1
      when 'pediatria'        then 2
      when 'ginecologia'      then 3
    end
where business = 'clinica-san-martin' and slug in ('medicina-general', 'pediatria', 'ginecologia');

-- ── Plantel real ────────────────────────────────────────────────────────────
-- Todos atienden los 7 días (work_days 0=domingo … 6=sábado) en turnos de 30'.
-- work_start/work_end quedan cubriendo el rango de sus horas solo por
-- consistencia; el cálculo real usa work_hours.
insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes, work_days, work_hours, work_start, work_end, google_calendar_id, sort_order)
select
  'clinica-san-martin', s.id, d.name, d.price, 30, '{0,1,2,3,4,5,6}', d.hours, d.w_start, d.w_end, d.calendar_id, d.sort_order
from (values
  -- Medicina General — 60 Bs
  ('medicina-general', 'Dra. Linsey Angela Diaz Sanchez',      60, '{07:00,10:00,12:00,14:00,19:00}'::time[], '07:00'::time, '19:30'::time, '7c1bbbd4f82fbfd357574c2b8ff5c3fc9e5e1bf1442565593f0e96c668a79da6@group.calendar.google.com', 1),
  ('medicina-general', 'Dr. Luis Jaime Rivera Porcel',         60, '{07:00,12:00,14:00,17:00,19:00}'::time[], '07:00'::time, '19:30'::time, '8b0d1ce76c70775f4356c899d8af21c1a0a069d83c5a6386c8378e6f170f13c8@group.calendar.google.com', 2),
  ('medicina-general', 'Dr. Octavio Salinas Gallegos',         60, '{07:00,12:00,14:00,17:00,19:00}'::time[], '07:00'::time, '19:30'::time, 'd2d2427ffebc8d628f4f98c16d46f89d6e27cc123ac8c261448a56b8d4392dd5@group.calendar.google.com', 3),
  ('medicina-general', 'Dr. Einar Heredia',                    60, '{07:00,12:00,14:00,17:00,19:00}'::time[], '07:00'::time, '19:30'::time, '6bd1101e309b98cdec3dfd8c19ba4a85f09bba025a132bee4d846da01d262857@group.calendar.google.com', 4),
  ('medicina-general', 'Dra. Nohelia Pariente Delgadillo',     60, '{07:00,19:00}'::time[],                   '07:00'::time, '19:30'::time, 'e068d37d576c8e614887e8a919a3e89d56b6f5cd4eb14ddf9211766593756de8@group.calendar.google.com', 5),
  -- Pediatría — 80 Bs (ver nota sobre recargos al pie)
  ('pediatria',        'Dra. Rosmery Medina',                  80, '{10:00}'::time[],                         '10:00'::time, '10:30'::time, '8fd7449087cb50eac8c6aebf40b1217e37ec0190f8a16205cfa436520a13c27f@group.calendar.google.com', 1),
  ('pediatria',        'Dr. Miguel Edgar Daguino Delgadillo',  80, '{10:00,17:00,19:00}'::time[],             '10:00'::time, '19:30'::time, '969f1720b8d5b9f8e21e56d6fedde0fd515063d662baaac6b015a730f365ca55@group.calendar.google.com', 2),
  -- Ginecología — 80 Bs
  ('ginecologia',      'Dr. Favio Tola Choque',                80, '{07:00,10:00,12:00,14:00,19:00}'::time[], '07:00'::time, '19:30'::time, '33d3cb13056412dac5b0a525e06624b4acf2d288dd55e2ecae1a27911c9a7e1e@group.calendar.google.com', 1),
  ('ginecologia',      'Dra. Yabdiga Medina Merida',           80, '{17:00}'::time[],                         '17:00'::time, '17:30'::time, 'cebbe770e00f0b3c3b8c57b8d78982e2e8ebb42a0d45eecc4458740466ff169c@group.calendar.google.com', 2)
) as d(specialty_slug, name, price, hours, w_start, w_end, calendar_id, sort_order)
join public.clinic_specialties s
  on s.business = 'clinica-san-martin' and s.slug = d.specialty_slug;

-- ── Horario público de la clínica ───────────────────────────────────────────
update public.clinic_settings
set hours = 'Todos los días, 7:00 a 20:00 · Emergencias las 24 horas',
    updated_by = 'seed:plantel-real'
where business = 'clinica-san-martin';

-- ============================================================================
-- PENDIENTE — recargos de pediatría
-- ----------------------------------------------------------------------------
-- consultation_price es un único monto por médico, pero el tarifario cobra
-- pediatría a 80 Bs normal, 100 Bs en tarde/noche/feriado y 120 Bs sábado y
-- domingo. Como estos médicos atienden los 7 días, el bot va a cobrar 80 Bs
-- también un domingo, cuando corresponden 120. Queda cargado a 80 Bs; para
-- resolverlo hace falta un precio por franja horaria y día, no una constante.
-- ============================================================================
