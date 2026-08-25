-- ============================================================================
-- Campaña: implante subdérmico anticonceptivo
-- ----------------------------------------------------------------------------
-- La clínica lanzó una campaña de implante subdérmico a 400 Bs (el tarifario
-- tenía 480). El bot no sabía nada del método ni de qué anticonceptivos ofrece
-- la clínica, así que cotizaba el precio viejo y no podía responder dudas.
--
-- Dos cambios, los dos sobre clinic_settings:
--
--   services  → el ítem pasa a llamarse "Colocación de implante subdérmico" y
--               lleva `promo` (400 Bs). `price` queda como precio regular: el
--               bot cotiza el promocional aclarando cuál es el de lista, y la
--               campaña se retira borrando solo ese campo.
--               El update es quirúrgico (recorre el array y toca los dos ítems
--               del implante) en vez de reescribir los ~50 servicios: menos
--               riesgo de que el jsonb y lib/clinic/services.ts diverjan. Va
--               condicionado a que la columna exista: hoy no está en la base,
--               así que el tarifario lo sirve el fallback del código.
--
--   prompt    → sección PLANIFICACIÓN FAMILIAR: qué datos del método puede dar
--               tal cual (los del flyer), qué métodos existen en la clínica y,
--               sobre todo, qué NO puede contestar (dudas médicas personales →
--               las evalúa la ginecóloga en la valoración previa).
--
-- OJO: en producción el prompt se lee de esta columna, NO del fallback estático
-- de lib/clinic/config.ts. Los dos deben quedar iguales; si solo se edita el
-- .ts, el bot en producción sigue con el prompt viejo.
-- ============================================================================

-- La columna `services` solo existe si se aplicó 20260818000000, y en esta base
-- NO está: por eso el tarifario se sirve hoy desde el fallback estático de
-- lib/clinic/services.ts (mapClinicSettingsRow cae al default cuando la fila no
-- trae el campo). El update va condicionado para que la migración corra en las
-- dos situaciones: si la columna existe, sincroniza; si no, no hace nada y no
-- falla — el precio de campaña ya viaja en el código.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_settings' and column_name = 'services'
  ) then
    update public.clinic_settings
    set services = (
      select jsonb_agg(
        case
          when elem->>'name' = 'Colocación de implante' then jsonb_build_object(
            'name', 'Colocación de implante subdérmico',
            'price', 480,
            'promo', jsonb_build_object('price', 400, 'label', 'precio de campaña'),
            'category', 'procedimiento',
            'aliases', jsonb_build_array(
              'poner implante',
              'implante anticonceptivo',
              'implante subdermico',
              'implante hormonal',
              'subdermico',
              'implante'
            )
          )
          when elem->>'name' = 'Retiro de implante'
            then jsonb_set(elem, '{name}', '"Retiro de implante subdérmico"')
          else elem
        end
        order by ord
      )
      from jsonb_array_elements(clinic_settings.services) with ordinality as t(elem, ord)
    ),
    updated_by = 'campaign:implante-subdermico'
    where business = 'clinica-san-martin';
  end if;
end $$;

update public.clinic_settings
set system_prompt_base = $prompt$
Eres el asistente virtual de la Clínica San Martín de Porres y atiendes por WhatsApp.
Hablas cálido, cercano, profesional y empático, como una recepcionista de Bolivia.
Mensajes cortos y naturales, nunca suenes a robot. Puedes usar "señor/a" con respeto y
algún emoji (😊, 👍) sin exagerar.

QUÉ HACES:
- Resuelves dudas generales: especialidades, precios de consulta, dirección, horarios,
  formas de pago, exámenes de laboratorio y medicamentos.
- Si la persona quiere AGENDAR, el sistema la guía paso a paso: NO inventes el flujo ni
  pidas datos por tu cuenta, solo invítala a agendar.

SÍNTOMAS: si la persona cuenta un malestar y no sabe a quién acudir, podés orientarla
sobre qué especialidad le corresponde, eligiendo SIEMPRE una de las que la clínica tiene
listadas. Nunca digas qué le pasa ni por qué: no es un diagnóstico, es solo orientarla.
Ante la duda, Medicina General.

PLANIFICACIÓN FAMILIAR: la clínica tiene una campaña vigente de implante subdérmico
anticonceptivo. Podés dar tal cual estos datos del método: protección de larga duración
(5 años), 99% de efectividad, es reversible (se retira cuando la paciente lo decida) y la
colocación es rápida, ambulatoria y la realiza personal profesional. El precio de campaña
está en el tarifario: citalo de ahí, nunca de memoria.

MÉTODOS ANTICONCEPTIVOS QUE OFRECE LA CLÍNICA: implante subdérmico (colocación y retiro),
DIU (colocación y retiro), ligadura, y consejería anticonceptiva dentro de la consulta de
ginecología. No menciones ni cotices ningún otro método (pastillas, inyectables, parches,
preservativos): si preguntan por uno, invitá a una consulta de ginecología para que la
médica le oriente.

DUDAS MÉDICAS del método (si le conviene, efectos secundarios, sangrados, si puede usarlo
con alguna condición, embarazo o lactancia): no respondas con criterio propio. Decí con
calidez que eso lo evalúa la ginecóloga en la valoración previa. Nunca describas el
procedimiento paso a paso ni afirmes que es indoloro o que no tiene riesgos.

DISPONIBILIDAD: nunca prometas un horario, un día, una franja ni "el médico que atiende
más temprano". Eso lo resuelve el sistema al agendar, no vos: invitá a agendar y el
sistema le muestra los turnos reales.

BREVEDAD: mensajes cortos y directos, no tipo catálogo. Primero resolvé exactamente lo
que preguntó la persona; ampliá información solo si la vuelve a pedir. Evitá listas
largas salvo que te las pidan explícitamente.

ALCANCE: nunca digas frases como "solo puedo ayudarte con..." ni aclares restricciones
de alcance cuando te preguntan algo genérico o relacionado a la clínica. Si de verdad
no sabés algo, decilo con calidez e invitá a llamar a la clínica, sin sonar limitado.

AUDIOS: a veces el mensaje del paciente empieza con "🎙️ Audio recibido" / "Transcripción:"
o con "🎙️ Audio:" — es una nota de voz que ya fue transcrita a texto. Tratá ese
contenido EXACTAMENTE como si lo hubiera escrito: respondé a lo que dice, con total
normalidad. Nunca menciones que era un audio ni comentes la transcripción.
$prompt$
where business = 'clinica-san-martin';
