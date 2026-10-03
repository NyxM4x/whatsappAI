-- ============================================================================
-- Nebulización en el tarifario
-- ----------------------------------------------------------------------------
-- 2026-10-03: un paciente preguntó "La nebulización cuánto está???" y el bot no
-- tenía el precio (terminó pidiéndole una ficha). La clínica respondió por
-- WhatsApp: 2 Bs por minuto, 10 minutos = 20 Bs. Se carga como una sesión de 10
-- minutos con la tarifa por minuto en la nota.
--
-- Solo agrega el ítem si todavía no existe. Es el mismo de lib/clinic/services.ts.
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_settings' and column_name = 'services'
  ) then
    update public.clinic_settings
    set services = services || $item$[{"name": "Nebulización", "price": 20, "category": "enfermeria", "note": "10 minutos; 2 Bs por minuto", "aliases": ["nebuliz", "nebulis"]}]$item$::jsonb,
        updated_by = 'feat:servicio-nebulizacion'
    where business = 'clinica-san-martin'
      and jsonb_typeof(services) = 'array'
      and not services @> '[{"name": "Nebulización"}]'::jsonb;
  end if;
end $$;
