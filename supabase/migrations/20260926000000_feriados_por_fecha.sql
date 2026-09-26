-- ============================================================================
-- Feriados por fecha, marcados con anticipación desde el panel
-- ----------------------------------------------------------------------------
-- Antes: clinic_settings.holiday_date guardaba UN día y solo se podía marcar
-- "hoy", el mismo día; en feriado el bot no cotizaba y derivaba el precio al
-- asesor.
--
-- Ahora: holiday_dates guarda una lista de fechas que la secretaria marca desde
-- la ventana "Feriados" del panel, también por adelantado. En esos días el bot
-- cobra la tarifa de DOMINGO (pedido de la clínica, 2026-09-26).
--
-- holiday_date queda sin uso (el código la lee solo si holiday_dates no
-- existe todavía). Se copia su valor para no perder un feriado ya marcado.
-- ============================================================================

alter table public.clinic_settings
  add column if not exists holiday_dates date[] not null default '{}';

update public.clinic_settings
  set holiday_dates = array[holiday_date]
  where holiday_date is not null
    and holiday_date >= (now() at time zone coalesce(timezone, 'America/La_Paz'))::date
    and cardinality(holiday_dates) = 0;

comment on column public.clinic_settings.holiday_dates is
  'Fechas marcadas como feriado desde el panel. En esos días el bot cobra la tarifa de domingo.';

comment on column public.clinic_settings.holiday_date is
  'OBSOLETA desde 2026-09-26: reemplazada por holiday_dates.';
