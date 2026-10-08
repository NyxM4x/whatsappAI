-- ============================================================================
-- Cardiología de emergencia a 200 Bs + internación en sala común y privada
-- ----------------------------------------------------------------------------
-- Datos confirmados por la clínica el 2026-10-08:
--
--   emergencia → "Consulta de emergencia de cardiología" pasa de 150 a 200 Bs.
--
--   internación → precio por día; el primero cuesta más. Medicamentos y
--              laboratorio se cobran aparte.
--                sala común:   320 Bs el primer día, 270 Bs desde el segundo
--                sala privada: 750 Bs el primer día, 700 Bs desde el segundo
--              Los ítems son los mismos de lib/clinic/services.ts: si se edita
--              uno, hay que editar el otro.
--
-- La consulta de cardiología (170 Bs, antes 150) vive en el código
-- (lib/clinic/pricing.ts): va con el deploy, no con esta migración.
--
-- Condicionado a que exista la columna, igual que 20260921000000: si no está,
-- o está vacía, el tarifario lo sirve el fallback del código, que ya trae todo.
-- ============================================================================

do $$
declare
  internacion jsonb := $items$
[
  {
    "name": "Internación en sala común",
    "price": 320,
    "category": "internacion",
    "note": "el primer día; desde el segundo día, 270 Bs por día. Medicamentos y laboratorio se cobran aparte",
    "aliases": ["sala comun", "sala compartida", "sala general", "habitacion compartida", "cuarto compartido"]
  },
  {
    "name": "Internación en sala privada",
    "price": 750,
    "category": "internacion",
    "note": "el primer día; desde el segundo día, 700 Bs por día. Medicamentos y laboratorio se cobran aparte",
    "aliases": ["sala privada", "sala personal", "sala individual", "habitacion privada", "cuarto privado", "habitacion individual"]
  }
]
$items$::jsonb;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_settings' and column_name = 'services'
  ) then
    -- Se quitan las salas si ya estaban (correr la migración dos veces no las
    -- duplica) y se agregan al final con los precios de hoy.
    update public.clinic_settings
    set services = (
          select coalesce(jsonb_agg(
            case when elem->>'name' = 'Consulta de emergencia de cardiología'
              then jsonb_set(elem, '{price}', '200'::jsonb)
              else elem
            end
            order by ord
          ), '[]'::jsonb)
          from jsonb_array_elements(clinic_settings.services) with ordinality as t(elem, ord)
          where elem->>'name' not in ('Internación en sala común', 'Internación en sala privada')
        ) || internacion,
        updated_by = 'tarifario:cardiologia-internacion'
    where business = 'clinica-san-martin'
      and jsonb_typeof(services) = 'array'
      and jsonb_array_length(services) > 0;
  end if;
end $$;
