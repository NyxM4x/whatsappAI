-- ============================================================================
-- Campaña PAP "PAPANICOLAO 50% DESCUENTO" + ginecología a llamado + dirección
-- ----------------------------------------------------------------------------
-- Datos confirmados por la clínica el 2026-09-21 (la campaña de Facebook salió
-- ese día):
--
--   services → el ítem Papanicolaou lleva `promo`: 50 Bs (regular 100) hasta
--              el 30/09, solo de lunes a viernes de 8 a 12 y de 14 a 18. Fuera
--              de esa franja, en fin de semana, en feriado o con la ginecóloga
--              (lunes a viernes de 18 a 19): 200 Bs a llamado. Los dos precios
--              incluyen toma y análisis; leer el resultado es una consulta
--              aparte (80 hasta las 18:00 / 200 después), sin reconsulta gratis.
--              La promo vence SOLA: el código deja de aplicarla el 1/10 sin
--              tocar esta columna (validUntil). No hace falta otra migración
--              para retirarla.
--              El JSON es el mismo ítem de lib/clinic/services.ts, generado
--              desde el código: si se edita uno, hay que editar el otro.
--
--   dirección → la de la respuesta rápida de la clínica, y un solo link de
--              Google Maps (el mensaje de emergencias tenía otro, más viejo).
--
--   médicos  → alta del Dr. Eric Irusta Ribera (ginecología, lunes a miércoles
--              8-12 y 14-17) y horario de la Dra. Yabdiga Medina Merida
--              (lunes a viernes de 18 a 19, a llamado). El bot no ofrece
--              médicos: la lista sirve para reconocer el nombre cuando el
--              paciente lo pide.
--
-- El precio de la consulta de ginecología desde las 18:00, en fin de semana y
-- en feriado (200 Bs)
-- y el bloque de campañas del prompt viven en el código (lib/clinic/pricing.ts
-- y buildClinicSystemPrompt): van con el deploy, no con esta migración.
-- ============================================================================

-- ── 1. Tarifario: el PAP con su promo ───────────────────────────────────────
-- Condicionado a que exista la columna, igual que 20260826000000: si no está,
-- el tarifario lo sirve el fallback del código, que ya trae la promo. Con la
-- columna vacía también manda el fallback, así que no se toca.
do $$
declare
  pap jsonb := $pap$
{
  "name": "Papanicolaou",
  "price": 100,
  "category": "procedimiento",
  "aliases": [
    "papanicol",
    "papa nicol",
    "papanikol",
    "papinicol",
    "pananicol",
    "pap",
    "pap test",
    "citologia",
    "examen de cuello uterino",
    "examen del cuello uterino",
    "prueba de cuello uterino",
    "prueba del cuello uterino",
    "muestra de cuello uterino",
    "muestra del cuello uterino",
    "examen del cuello de la matriz",
    "examen de la matriz"
  ],
  "promo": {
    "price": 50,
    "label": "promoción 50% de descuento",
    "validUntil": "2026-09-30",
    "windows": [
      {
        "weekdays": [
          1,
          2,
          3,
          4,
          5
        ],
        "from": "08:00",
        "to": "12:00"
      },
      {
        "weekdays": [
          1,
          2,
          3,
          4,
          5
        ],
        "from": "14:00",
        "to": "18:00"
      }
    ],
    "windowsText": "de lunes a viernes de 8:00 a 12:00 y de 14:00 a 18:00",
    "outside": {
      "price": 200,
      "label": "a llamado, como emergencia; incluye la toma y el análisis"
    },
    "outsideDoctorPattern": "doctora|\\bdra\\b|mujer|medina|ginec[oó]loga",
    "outsideDoctorNote": "con la ginecóloga (de lunes a viernes de 18:00 a 19:00) la promoción no aplica",
    "details": [
      "🕗 *Lunes a viernes* de 8:00 a 12:00 y de 14:00 a 18:00. La promoción es solo de lunes a viernes: no aplica sábados, domingos ni feriados.",
      "🧪 Incluye la toma de muestra y el análisis en laboratorio. El resultado sale en 3 días.",
      "👨‍⚕️ No incluye la lectura del resultado: si desea que el ginecólogo se lo lea, es una consulta aparte de 80 Bs de lunes a viernes hasta las 18:00 (200 Bs desde las 18:00, fines de semana y feriados).",
      "✅ Para la toma: venga 7 días después de terminar su regla y sin sangrados, con al menos 2 días sin relaciones y al menos 3 días sin óvulos, cremas ni lavados vaginales.",
      "🪪 Traiga su carnet de identidad (o una foto del carnet)."
    ],
    "notes": [
      "Fuera de la franja (de 12:00 a 14:00 o desde las 18:00), sábados, domingos y feriados —por ejemplo el 24 de septiembre, Día de Santa Cruz— el ginecólogo no está de turno: la toma es a llamado, como emergencia, 200 Bs, sin promoción (también incluye la toma y el análisis).",
      "La muestra la toman los ginecólogos de la clínica, que son varones. Si la paciente prefiere que la atienda una mujer, es con la ginecóloga, de lunes a viernes de 18:00 a 19:00, a llamado, y cuesta 200 Bs (sin promoción): decí siempre el monto y ese horario.",
      "El resultado sale en 3 días calendario y se le puede enviar por WhatsApp. Si pregunta si su resultado ya está, eso se lo confirma un asesor: no lo sabés.",
      "Leer el resultado siempre es una consulta de ginecología pagada: 80 Bs de lunes a viernes hasta las 18:00; 200 Bs desde las 18:00, fines de semana y feriados. Para esta lectura NO hay reconsulta gratis, aunque haya pasado por consulta.",
      "El PAP no es la prueba de VPH, ni la IVAA, ni la colposcopía, ni la biopsia: esos no entran en la promoción. Si los pide, tomale el pedido para que un asesor le confirme el precio.",
      "Dudas médicas (embarazo, edad, si le conviene, cada cuánto hacérselo, qué significa un resultado): no respondas con criterio propio. Decí con calidez que eso lo evalúa el ginecólogo en consulta.",
      "Contá los requisitos en positivo (\"venga 7 días después de terminar su regla\"), no como una lista de lo que no se hace."
    ],
    "mentionWithSpecialty": "ginecologia"
  }
}
$pap$::jsonb;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_settings' and column_name = 'services'
  ) then
    update public.clinic_settings
    set services = case
          when services @> '[{"name": "Papanicolaou"}]'::jsonb then (
            select jsonb_agg(case when elem->>'name' = 'Papanicolaou' then pap else elem end order by ord)
            from jsonb_array_elements(clinic_settings.services) with ordinality as t(elem, ord)
          )
          else services || jsonb_build_array(pap)
        end,
        updated_by = 'campaign:pap-septiembre'
    where business = 'clinica-san-martin'
      and jsonb_typeof(services) = 'array'
      and jsonb_array_length(services) > 0;
  end if;
end $$;

-- ── 2. Dirección y un solo link de Google Maps ──────────────────────────────
-- replace() y no un texto nuevo para emergency_response: conserva lo que la
-- clínica haya ajustado en ese mensaje y cambia solo la dirección y el link.
update public.clinic_settings
set address = 'Av. Moscú n°4480, diagonal al mercado La Cuchilla, Santa Cruz',
    maps_url = 'https://maps.app.goo.gl/cZcqhWE9LGhWifvo7?g_st=ic',
    emergency_response = replace(
      replace(emergency_response, 'https://maps.app.goo.gl/RcMqdE3z8NX1ZULG6', 'https://maps.app.goo.gl/cZcqhWE9LGhWifvo7?g_st=ic'),
      'Av. Moscú, a una cuadra del Mercado La Cuchilla',
      'Av. Moscú n°4480, diagonal al mercado La Cuchilla, Santa Cruz'
    ),
    updated_by = 'campaign:pap-septiembre'
where business = 'clinica-san-martin';

-- ── 3. Dr. Eric Irusta Ribera (ginecología) ─────────────────────────────────
insert into public.clinic_doctors
  (business, specialty_id, name, consultation_price, slot_minutes, work_days, work_hours, work_start, work_end, google_calendar_id, sort_order)
select 'clinica-san-martin', s.id, 'Dr. Eric Irusta Ribera', 80, 30, '{1,2,3}', null, '08:00'::time, '17:00'::time, null, 3
from public.clinic_specialties s
where s.business = 'clinica-san-martin'
  and s.slug = 'ginecologia'
  and not exists (
    select 1 from public.clinic_doctors d
    where d.business = 'clinica-san-martin' and d.name = 'Dr. Eric Irusta Ribera'
  );

insert into public.clinic_doctor_work_hours (doctor_id, weekday, start_time, end_time, ends_next_day)
select d.id, x.weekday, x.start_time::time, x.end_time::time, false
from public.clinic_doctors d
cross join lateral (values
  (1, '08:00', '12:00'), (1, '14:00', '17:00'),
  (2, '08:00', '12:00'), (2, '14:00', '17:00'),
  (3, '08:00', '12:00'), (3, '14:00', '17:00')
) x(weekday, start_time, end_time)
where d.business = 'clinica-san-martin' and d.name = 'Dr. Eric Irusta Ribera'
on conflict do nothing;

-- ── 4. Dra. Yabdiga Medina Merida: lunes a viernes de 18:00 a 19:00 ─────────
-- La clínica la tenía cargada de 17 a 19 en días sueltos. Es la opción para
-- quien prefiere que la atienda una mujer: a llamado, 200 Bs.
delete from public.clinic_doctor_work_hours
where doctor_id in (
  select id from public.clinic_doctors
  where business = 'clinica-san-martin' and name = 'Dra. Yabdiga Medina Merida'
);

insert into public.clinic_doctor_work_hours (doctor_id, weekday, start_time, end_time, ends_next_day)
select d.id, x.weekday, '18:00'::time, '19:00'::time, false
from public.clinic_doctors d
cross join lateral (values (1), (2), (3), (4), (5)) x(weekday)
where d.business = 'clinica-san-martin' and d.name = 'Dra. Yabdiga Medina Merida'
on conflict do nothing;
