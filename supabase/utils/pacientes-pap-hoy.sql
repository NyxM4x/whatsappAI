-- ============================================================================
-- Pacientes que escribieron por el PAP el día que salió la campaña (21/09)
-- ----------------------------------------------------------------------------
-- Solo lectura. Correr en el SQL Editor de Supabase.
--
-- Hasta que se despliegue la campaña, el bot cotizaba el PAP a 100 Bs: la
-- columna el_bot_le_dijo_100 marca a quién hay que volver a escribirle con la
-- promo de 50 Bs. Para otro día, cambiar la fecha en los dos lugares.
-- ============================================================================

with pap as (
  select m.contact_phone,
         min(coalesce(m.message_timestamp, m.created_at)) as primer_mensaje,
         string_agg(distinct left(m.content, 120), ' | ') as lo_que_escribio
  from public.kapso_messages m
  where m.role = 'user'
    and (coalesce(m.message_timestamp, m.created_at) at time zone 'America/La_Paz')::date = date '2026-09-21'
    and m.content ~* '(papanic|papa ?nicol|papanikol|papinicol|\mpap\M|citolog|cuello uterino)'
  group by m.contact_phone
)
select p.contact_phone                                 as telefono,
       c.name                                          as nombre,
       to_char(p.primer_mensaje at time zone 'America/La_Paz', 'HH24:MI') as hora_bolivia,
       p.lo_que_escribio,
       exists (
         select 1 from public.kapso_messages b
         where b.contact_phone = p.contact_phone
           and b.role = 'assistant'
           and (coalesce(b.message_timestamp, b.created_at) at time zone 'America/La_Paz')::date = date '2026-09-21'
           and b.content ~* '100 ?Bs'
       )                                               as el_bot_le_dijo_100
from pap p
left join public.kapso_contacts c on c.phone = p.contact_phone
order by p.primer_mensaje;
