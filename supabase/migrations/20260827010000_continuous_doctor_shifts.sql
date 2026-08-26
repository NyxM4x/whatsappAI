-- La clínica interpreta cada bloque work_start-work_end como un turno completo.
-- Los slots reales se generan cada slot_minutes (30 minutos en el plantel actual).
-- work_hours queda NULL para que las horas antiguas puntuales no limiten el turno.
update public.clinic_doctors
set work_hours = null
where business = 'clinica-san-martin';

comment on column public.clinic_doctors.work_hours is
  'Compatibilidad histórica. La disponibilidad usa work_start/work_end en intervalos de slot_minutes.';