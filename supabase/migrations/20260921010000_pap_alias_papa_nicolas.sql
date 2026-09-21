-- ============================================================================
-- PAP: el alias "papa nicol" enganchaba "mi papá Nicolás"
-- ----------------------------------------------------------------------------
-- 20260921000000 cargó "papa nicol" como alias del Papanicolaou para atrapar
-- "papa nicolau". Pero el match es por substring y "mi papa nicolas esta
-- enfermo" lo contiene: el bot le habría mandado la promo del PAP. Se reemplaza
-- por las terminaciones completas. Los errores de tipeo que quedan afuera
-- ("papaniculau", "papnicolau") los resuelve el código (matchServiceTypo en
-- lib/clinic/services.ts), sin tocar esta columna.
--
-- Solo cambia los alias del ítem; el resto (la promo) queda como está. La
-- lista es la misma de lib/clinic/services.ts.
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_settings' and column_name = 'services'
  ) then
    update public.clinic_settings
    set services = (
          select jsonb_agg(
            case when elem->>'name' = 'Papanicolaou'
              then jsonb_set(elem, '{aliases}', $aliases$["papanicol","papa nicolau","papa nicolao","papa nicolaou","papanikol","papinicol","pananicol","pap","pap test","citologia","examen de cuello uterino","examen del cuello uterino","prueba de cuello uterino","prueba del cuello uterino","muestra de cuello uterino","muestra del cuello uterino","examen del cuello de la matriz","examen de la matriz"]$aliases$::jsonb)
              else elem
            end
            order by ord
          )
          from jsonb_array_elements(clinic_settings.services) with ordinality as t(elem, ord)
        ),
        updated_by = 'fix:pap-alias-papa-nicolas'
    where business = 'clinica-san-martin'
      and jsonb_typeof(services) = 'array'
      and services @> '[{"name": "Papanicolaou"}]'::jsonb;
  end if;
end $$;
