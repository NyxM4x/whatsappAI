  -- ============================================================================
  -- Retiro de uña: alias que no dependen de "una"
  -- ----------------------------------------------------------------------------
  -- Caso real 2026-09-28: "quiero saber si ya están los resultados… así poder
  -- sacar una consulta con el doctor dagiino" se cotizó como "Retiro de uña". El
  -- código quitaba la tilde de la ñ al normalizar, así que el alias "sacar uña"
  -- quedaba "sacar una" y enganchaba cualquier "sacar una ficha/consulta". Eso se
  -- corrige en lib/clinic/services.ts (la ñ se conserva y "uña" ya no se compara
  -- como "una"), sin tocar esta columna.
  --
  -- Acá solo se suman las formas que sí son inequívocas: "encarnad" (encarnada,
  -- encarnado), "uñero" y los verbos con artículo ("sacar la uña"). La lista es
  -- la misma de lib/clinic/services.ts.
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
              case when elem->>'name' = 'Retiro de uña'
                then jsonb_set(elem, '{aliases}', $aliases$["sacar uña","sacar la uña","sacar las uñas","quitar la uña","uña encarnada","retiro de uña encarnada","encarnad","uñero"]$aliases$::jsonb)
                else elem
              end
              order by ord
            )
            from jsonb_array_elements(clinic_settings.services) with ordinality as t(elem, ord)
          ),
          updated_by = 'fix:alias-retiro-de-una'
      where business = 'clinica-san-martin'
        and jsonb_typeof(services) = 'array'
        and services @> '[{"name": "Retiro de uña"}]'::jsonb;
    end if;
  end $$;
