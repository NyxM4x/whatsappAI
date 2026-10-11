-- ============================================================================
-- Tarifario del 2026-10-11 (CSMDP-RptServicio 11 de OCTUBRE)
-- ----------------------------------------------------------------------------
-- La clínica mandó la lista de precios nueva de su sistema. Esta migración deja
-- clinic_settings igual que el código (lib/clinic/services.ts y config.ts):
--
--   services → (a) precio nuevo en los ítems que ya estaban; (b) abscesos y
--              curaciones pasan de un ítem por tamaño a dos, enfermería y
--              médico, porque el tarifario los cobra distinto; (c) entran los
--              servicios que no tenían precio: rayos X, fisioterapia,
--              ecografía axilar y de tiroides, retiro de más de 30 puntos,
--              inyectables, control de presión, venoclisis, retiro de sonda y
--              de yeso.
--   labs     → hemograma 72, glucosa 25, prueba de embarazo 60, orina 30.
--   system_prompt_base → radiografía y fisioterapia dejan de ser ejemplos de
--              "no está en tus listas": ahora tienen precio.
--
-- Los precios de CONSULTA por especialidad no están acá: viven en
-- lib/clinic/pricing.ts y van con el deploy.
--
-- No pisa alias ni promos de producción: de cada ítem existente solo cambia
-- price y note. Se puede correr más de una vez.
-- ============================================================================

do $$
declare
  -- Ítems que siguen: solo lo que cambió.
  patches jsonb := $json${
  "Consulta por accidente de tránsito": {"price":170},
  "Consulta ginecológica de emergencia a llamado": {"price":250},
  "Consulta de emergencia de cardiología": {"price":250},
  "Consulta de emergencia de cirugía": {"price":290},
  "Consulta de emergencia de traumatología": {"price":370},
  "Consulta de emergencia de urología": {"price":330},
  "Papanicolaou": {"price":120},
  "Colocación de DIU": {"price":170},
  "Retiro de DIU": {"price":120},
  "Retiro de implante subdérmico": {"price":120},
  "Ecografía abdominal": {"price":120},
  "Ecografía renal": {"price":140},
  "Ecografía de partes blandas": {"price":170},
  "Ecografía prostática": {"price":170},
  "Ecografía abdominal de emergencia": {"price":250},
  "Ecografía obstétrica": {"price":120},
  "Ecografía ginecológica": {"price":120},
  "Ecografía transvaginal": {"price":170},
  "Ecografía transvaginal, ginecológica u obstétrica de emergencia": {"price":250},
  "Retiro de uña": {"note":"lunes a viernes; con médico, 90 Bs"},
  "Retiro de uña fin de semana": {"price":120},
  "Extracción de cuerpo extraño pequeño": {"price":90},
  "Extracción de cuerpo extraño grande": {"price":120},
  "Sutura por punto (médico)": {"price":25},
  "Lavado de oído": {"price":100},
  "Lavado de oído fin de semana": {"price":120},
  "Retiro de puntos (1 a 10 puntos)": {"price":30},
  "Retiro de puntos (10 a 30 puntos)": {"price":50},
  "Certificado médico": {"price":170}
}$json$::jsonb;

  -- Ítems que se parten en dos (enfermería / médico), en el lugar del anterior.
  replacements jsonb := $json${
  "Absceso pequeño": [
    {"name":"Absceso pequeño (enfermería)","price":25,"category":"enfermeria","aliases":["absceso pequeño enfermeria","abceso pequeño enfermeria","absceso pequeño con enfermera","abceso pequeño con enfermera"]},
    {"name":"Absceso pequeño (médico)","price":50,"category":"enfermeria","note":"con enfermería, 25 Bs","aliases":["absceso pequeño","abceso pequeño","drenaje de absceso pequeño"]}
  ],
  "Absceso mediano": [
    {"name":"Absceso mediano (enfermería)","price":40,"category":"enfermeria","aliases":["absceso mediano enfermeria","abceso mediano enfermeria","absceso mediano con enfermera","abceso mediano con enfermera"]},
    {"name":"Absceso mediano (médico)","price":70,"category":"enfermeria","note":"con enfermería, 40 Bs","aliases":["absceso mediano","abceso mediano"]}
  ],
  "Absceso grande": [
    {"name":"Absceso grande (enfermería)","price":70,"category":"enfermeria","aliases":["absceso grande enfermeria","abceso grande enfermeria","absceso grande con enfermera","abceso grande con enfermera"]},
    {"name":"Absceso grande (médico)","price":140,"category":"enfermeria","note":"con enfermería, 70 Bs","aliases":["absceso grande","abceso grande"]}
  ],
  "Curación pequeña": [
    {"name":"Curación pequeña (enfermería)","price":35,"category":"enfermeria","aliases":["curacion pequeña enfermeria","curacion chica enfermeria","curacion pequeña con enfermera"]},
    {"name":"Curación pequeña (médico)","price":70,"category":"enfermeria","note":"con enfermería, 35 Bs","aliases":["curacion pequeña","curacion chica"]}
  ],
  "Curación mediana": [
    {"name":"Curación mediana (enfermería)","price":50,"category":"enfermeria","aliases":["curacion mediana enfermeria","curacion mediana con enfermera"]},
    {"name":"Curación mediana (médico)","price":120,"category":"enfermeria","note":"con enfermería, 50 Bs","aliases":["curacion mediana"]}
  ],
  "Curación grande": [
    {"name":"Curación grande (enfermería)","price":70,"category":"enfermeria","aliases":["curacion grande enfermeria","curacion grande con enfermera"]},
    {"name":"Curación grande (médico)","price":170,"category":"enfermeria","note":"con enfermería, 70 Bs","aliases":["curacion grande"]}
  ]
}$json$::jsonb;

  -- Ítems nuevos: se agregan solo si no existen todavía.
  added jsonb := $json$[
  {"name":"Rayos X con placa","price":230,"category":"procedimiento","note":"lunes a viernes","aliases":["rayos x","rayosx","radiografia","radiografias","placa radiografica","placas radiograficas","placa de rayos","rx"]},
  {"name":"Rayos X con placa fin de semana","price":280,"category":"procedimiento","note":"sábado, domingo, feriado o de emergencia","aliases":["rayos x de emergencia","radiografia de emergencia"]},
  {"name":"Sesión de fisioterapia","price":170,"category":"procedimiento","aliases":["sesion de fisioterapia","fisioterapia","fisioterapeuta"]},
  {"name":"Ecografía axilar","price":150,"category":"ecografia","aliases":["eco axilar","ecografia de axila","ecografia de axilas","eco de axila"]},
  {"name":"Ecografía de tiroides","price":150,"category":"ecografia","aliases":["eco de tiroides","ecografia tiroidea","eco tiroidea","ecografia de la tiroides"]},
  {"name":"Absceso pequeño (enfermería)","price":25,"category":"enfermeria","aliases":["absceso pequeño enfermeria","abceso pequeño enfermeria","absceso pequeño con enfermera","abceso pequeño con enfermera"]},
  {"name":"Absceso pequeño (médico)","price":50,"category":"enfermeria","note":"con enfermería, 25 Bs","aliases":["absceso pequeño","abceso pequeño","drenaje de absceso pequeño"]},
  {"name":"Absceso mediano (enfermería)","price":40,"category":"enfermeria","aliases":["absceso mediano enfermeria","abceso mediano enfermeria","absceso mediano con enfermera","abceso mediano con enfermera"]},
  {"name":"Absceso mediano (médico)","price":70,"category":"enfermeria","note":"con enfermería, 40 Bs","aliases":["absceso mediano","abceso mediano"]},
  {"name":"Absceso grande (enfermería)","price":70,"category":"enfermeria","aliases":["absceso grande enfermeria","abceso grande enfermeria","absceso grande con enfermera","abceso grande con enfermera"]},
  {"name":"Absceso grande (médico)","price":140,"category":"enfermeria","note":"con enfermería, 70 Bs","aliases":["absceso grande","abceso grande"]},
  {"name":"Curación pequeña (enfermería)","price":35,"category":"enfermeria","aliases":["curacion pequeña enfermeria","curacion chica enfermeria","curacion pequeña con enfermera"]},
  {"name":"Curación pequeña (médico)","price":70,"category":"enfermeria","note":"con enfermería, 35 Bs","aliases":["curacion pequeña","curacion chica"]},
  {"name":"Curación mediana (enfermería)","price":50,"category":"enfermeria","aliases":["curacion mediana enfermeria","curacion mediana con enfermera"]},
  {"name":"Curación mediana (médico)","price":120,"category":"enfermeria","note":"con enfermería, 50 Bs","aliases":["curacion mediana"]},
  {"name":"Curación grande (enfermería)","price":70,"category":"enfermeria","aliases":["curacion grande enfermeria","curacion grande con enfermera"]},
  {"name":"Curación grande (médico)","price":170,"category":"enfermeria","note":"con enfermería, 70 Bs","aliases":["curacion grande"]},
  {"name":"Retiro de puntos (más de 30 puntos)","price":60,"category":"enfermeria","aliases":["retiro de mas de 30 puntos","sacar mas de 30 puntos"]},
  {"name":"Inyectable intramuscular","price":15,"category":"enfermeria","note":"aplicación, de 7:00 a 18:00; de 18:00 a 23:00, 10 Bs; noche, domingo y feriado, 20 Bs","aliases":["inyeccion intramuscular","intramuscular","poner inyeccion","poner una inyeccion","poner inyectable","poner un inyectable","colocar inyeccion","colocar una inyeccion","colocar inyectable","colocar un inyectable","aplicar inyeccion","aplicar una inyeccion","aplicar inyectable","aplicar un inyectable","aplicacion de inyeccion","aplicacion de inyectable"]},
  {"name":"Inyectable endovenoso","price":12,"category":"enfermeria","note":"aplicación, de 7:00 a 18:00; de 18:00 a 23:00, 15 Bs; noche, domingo y feriado, 25 Bs","aliases":["inyeccion endovenosa","endovenoso","endovenosa","inyeccion intravenosa","inyectable intravenoso","intravenosa","intravenoso"]},
  {"name":"Inyectable subcutáneo","price":15,"category":"enfermeria","note":"aplicación; de noche (19:00 a 7:00), 20 Bs","aliases":["inyeccion subcutanea","subcutaneo","subcutanea"]},
  {"name":"Control de presión","price":10,"category":"enfermeria","aliases":["control de presion","control de la presion","controlar la presion","controlen la presion","tomar la presion","tomarme la presion","tomen la presion","tome la presion","medir la presion","medirme la presion","midan la presion","mida la presion","toma de presion"]},
  {"name":"Venoclisis","price":50,"priceMax":70,"category":"enfermeria","note":"ambulatoria 50 Bs, simple 70 Bs","aliases":["venoclisis","poner suero","poner un suero","poner el suero","colocar suero","colocar un suero","colocar el suero"]},
  {"name":"Retiro de sonda vesical","price":90,"category":"enfermeria","aliases":["retiro de sonda","sacar sonda","sacar la sonda","quitar sonda","quitar la sonda","retirar sonda","retirar la sonda"]},
  {"name":"Retiro de yeso","price":250,"category":"enfermeria","aliases":["sacar yeso","sacar el yeso","quitar yeso","quitar el yeso","retirar yeso","retirar el yeso"]}
]$json$::jsonb;

  lab_prices jsonb := $json${"Hemograma Completo": 72, "Glucosa": 25, "Prueba de Embarazo": 60, "Examen General de Orina": 30}$json$::jsonb;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_settings' and column_name = 'services'
  ) then
    update public.clinic_settings cs
    set services = (
          select jsonb_agg(x.item order by x.ord, x.sub)
          from (
            select t.ord, r.sub, r.item
            from jsonb_array_elements(cs.services) with ordinality as t(elem, ord)
            cross join lateral (
              select s.sub, s.item
              from jsonb_array_elements(replacements -> (t.elem->>'name')) with ordinality as s(item, sub)
              where replacements ? (t.elem->>'name')
                and not cs.services @> jsonb_build_array(jsonb_build_object('name', s.item->>'name'))
              union all
              select 1::bigint, t.elem || coalesce(patches -> (t.elem->>'name'), '{}'::jsonb)
              where not replacements ? (t.elem->>'name')
            ) r
            union all
            select 100000 + n.ord, 1::bigint, n.item
            from jsonb_array_elements(added) with ordinality as n(item, ord)
            where not cs.services @> jsonb_build_array(jsonb_build_object('name', n.item->>'name'))
              -- los que ya entran arriba, en el lugar del ítem que reemplazan
              and not exists (
                select 1
                from jsonb_array_elements(cs.services) as e(elem)
                where replacements ? (e.elem->>'name')
                  and (replacements -> (e.elem->>'name')) @> jsonb_build_array(jsonb_build_object('name', n.item->>'name'))
              )
          ) x
        ),
        labs = case
          when jsonb_typeof(cs.labs) = 'array' and jsonb_array_length(cs.labs) > 0 then (
            select jsonb_agg(
              case when lab_prices ? (l.elem->>'name')
                then l.elem || jsonb_build_object('price', lab_prices -> (l.elem->>'name'))
                else l.elem
              end
              order by l.ord
            )
            from jsonb_array_elements(cs.labs) with ordinality as l(elem, ord)
          )
          else cs.labs
        end,
        system_prompt_base = replace(replace(replace(cs.system_prompt_base,
          '(fisioterapia, odontología, oftalmología', '(odontología, oftalmología'),
          'electrocardiograma, radiografía, tomografía, resonancia', 'electrocardiograma, tomografía, resonancia'),
          'la radiografía de pie', 'la tomografía de tórax'),
        updated_by = 'feat:tarifario-2026-10-11'
    where cs.business = 'clinica-san-martin'
      and jsonb_typeof(cs.services) = 'array'
      and jsonb_array_length(cs.services) > 0;
  end if;
end $$;
