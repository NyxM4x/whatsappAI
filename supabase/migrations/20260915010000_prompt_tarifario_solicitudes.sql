-- ============================================================================
-- Prompt y tarifario para el flujo de solicitudes (el bot ya no agenda)
-- ----------------------------------------------------------------------------
-- Generado desde lib/clinic/config.ts y lib/clinic/services.ts: en producción
-- el prompt y el tarifario se leen de clinic_settings, NO del fallback del
-- código. Si solo se edita el .ts, el bot sigue con el texto viejo.
--
-- Cambios que lleva (2026-09-15):
--   prompt   → el bot no ofrece horarios ni médicos (los confirma un asesor),
--              no envía el QR, y el implante deja de cotizarse como campaña.
--              Los precios de consulta, la reconsulta y el feriado se inyectan
--              al vuelo desde lib/clinic/pricing.ts (no viven en esta columna).
--   services → sin consultas (pasan a pricing.ts), consultas de emergencia del
--              tarifario de la clínica, implante 480 Bs, cesárea programada
--              4000 Bs y de emergencia 4200 Bs.
--
-- La columna services solo existe si se aplicó 20260818000000: el update va
-- condicionado (igual que 20260826000000) para que corra en las dos situaciones.
-- ============================================================================

update public.clinic_settings
set system_prompt_base = $prompt$
Eres el asistente virtual de la Clínica San Martín de Porres y atiendes por WhatsApp.
Hablas cálido, cercano, profesional y empático, como una recepcionista de Bolivia.
Mensajes cortos y naturales, nunca suenes a robot. Puedes usar "señor/a" con respeto y
algún emoji (😊, 👍) sin exagerar.

QUÉ HACES:
- Resuelves dudas generales: especialidades, precios de consultas y servicios, dirección,
  formas de pago, exámenes de laboratorio y medicamentos.
- Si la persona quiere una FICHA (consulta) o un servicio, el sistema le pide los datos y
  un asesor de la clínica le confirma el horario y el médico por este mismo chat. NO pidas
  datos por tu cuenta ni inventes ese proceso: solo invitala a pedir su ficha.

HORARIOS Y MÉDICOS: nunca ofrezcas ni confirmes un horario, un día, una franja, un médico
ni si un médico atiende o está disponible. Eso lo confirma siempre un asesor de la clínica.

PAGOS: nunca envíes ni prometas el QR de pago. Los datos de pago los da el asesor después
de confirmar la ficha o el servicio.

SALUDO Y CONTEXTO:
- Usa el saludo "Buenas, somos la Clínica San Martín de Porres. Un gusto, ¿en qué puedo
  ayudarte hoy? 😊"
  únicamente cuando la persona saluda sin pedir nada concreto o cuando su mensaje no
  especifica qué servicio, información o ayuda necesita.
- Si la persona saluda y también explica directamente lo que necesita (por ejemplo,
  "hola, necesito una cita", "buenos días, ¿cuánto cuesta la consulta?" o "hola,
  ¿dónde están ubicados?"), responde directamente a esa solicitud sin repetir el saludo
  institucional ni agregar una introducción innecesaria.

SÍNTOMAS: si la persona cuenta un malestar y no sabe a quién acudir, podés orientarla
sobre qué especialidad le corresponde, eligiendo SIEMPRE una de las que la clínica tiene
listadas. Nunca digas qué le pasa ni por qué: no es un diagnóstico, es solo orientarla.
Ante la duda, Medicina General.

PLANIFICACIÓN FAMILIAR: la clínica coloca el implante subdérmico anticonceptivo. Podés dar
tal cual estos datos del método: protección de larga duración (5 años), 99% de efectividad,
es reversible (se retira cuando la paciente lo decida) y la colocación es rápida,
ambulatoria y la realiza personal profesional. El precio está en el tarifario: citalo de
ahí, nunca de memoria.

MÉTODOS ANTICONCEPTIVOS QUE OFRECE LA CLÍNICA: implante subdérmico (colocación y retiro),
DIU (colocación y retiro), ligadura, y consejería anticonceptiva dentro de la consulta de
ginecología. No menciones ni cotices ningún otro método (pastillas, inyectables, parches,
preservativos): si preguntan por uno, invitá a una consulta de ginecología para que la
médica le oriente.

DUDAS MÉDICAS del método (si le conviene, efectos secundarios, sangrados, si puede usarlo
con alguna condición, embarazo o lactancia): no respondas con criterio propio. Decí con
calidez que eso lo evalúa la ginecóloga en la valoración previa. Nunca describas el
procedimiento paso a paso ni afirmes que es indoloro o que no tiene riesgos.

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
$prompt$,
    updated_by = 'seed:solicitudes-ficha'
where business = 'clinica-san-martin';

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_settings' and column_name = 'services'
  ) then
    update public.clinic_settings
    set services = $services$[
  {"name":"Consulta de emergencia (medicina general)","price":80,"category":"emergencia","aliases":["consulta de emergencia","emergencia general"]},
  {"name":"Consulta por accidente de tránsito","price":150,"category":"emergencia","aliases":["transito","accidente de transito","certificado de transito","examen de transito"]},
  {"name":"Consulta ginecológica de emergencia a llamado","price":200,"category":"emergencia","aliases":["ginecologia de emergencia","emergencia ginecologica"]},
  {"name":"Consulta de emergencia de cardiología","price":150,"category":"emergencia","aliases":["emergencia cardiologica","emergencia de cardiologia"]},
  {"name":"Consulta de emergencia de cirugía","price":250,"category":"emergencia","aliases":["emergencia de cirugia","emergencia quirurgica"]},
  {"name":"Consulta de emergencia de traumatología","price":250,"category":"emergencia","aliases":["emergencia de traumatologia","emergencia traumatologica"]},
  {"name":"Consulta de emergencia de urología","price":150,"category":"emergencia","aliases":["emergencia de urologia","emergencia urologica"]},
  {"name":"Papanicolaou","price":100,"category":"procedimiento","aliases":["papanicolau","papanicolao","pap","citologia"]},
  {"name":"Colocación de DIU","price":150,"category":"procedimiento","aliases":["poner diu","colocacion diu","diu"]},
  {"name":"Retiro de DIU","price":100,"category":"procedimiento","aliases":["sacar diu","sacar el diu","quitar diu","quitar el diu","retirar el diu"]},
  {"name":"Colocación de implante subdérmico","price":480,"category":"procedimiento","aliases":["poner implante","implante anticonceptivo","implante subdermico","implante hormonal","subdermico","implante"]},
  {"name":"Retiro de implante subdérmico","price":100,"category":"procedimiento","aliases":["sacar implante","sacar el implante","quitar implante","quitar el implante","retirar el implante"]},
  {"name":"Cirugía menor","price":300,"category":"procedimiento","aliases":["cirugia pequeña","operacion menor"]},
  {"name":"Cirugía mediana","price":600,"category":"procedimiento","aliases":["operacion mediana"]},
  {"name":"Cirugía mayor","price":800,"category":"procedimiento","aliases":["operacion mayor","cirugia grande"]},
  {"name":"Ecografía abdominal","price":100,"category":"ecografia","aliases":["eco abdominal","ecografia de abdomen","eco de abdomen"]},
  {"name":"Ecografía renal","price":120,"category":"ecografia","aliases":["eco renal","ecografia de riñon","ecografia de riñones"]},
  {"name":"Ecografía mamaria","price":150,"category":"ecografia","aliases":["eco mamaria","ecografia de mama","ecografia de mamas","ecografia de senos"]},
  {"name":"Ecografía de partes blandas","price":150,"category":"ecografia","aliases":["eco partes blandas"]},
  {"name":"Ecografía prostática","price":150,"category":"ecografia","aliases":["eco prostatica","ecografia de prostata"]},
  {"name":"Ecografía abdominal de emergencia","price":200,"category":"ecografia","aliases":["eco abdominal de emergencia"]},
  {"name":"Ecografía obstétrica","price":100,"category":"ecografia","aliases":["eco obstetrica","ecografia de embarazo","eco de embarazo","eco del bebe"]},
  {"name":"Ecografía ginecológica","price":100,"category":"ecografia","aliases":["eco ginecologica"]},
  {"name":"Ecografía transvaginal","price":150,"category":"ecografia","aliases":["eco transvaginal","transvaginal"]},
  {"name":"Ecografía transvaginal, ginecológica u obstétrica de emergencia","price":200,"category":"ecografia","aliases":["eco de emergencia","ecografia de emergencia"]},
  {"name":"Absceso pequeño","price":80,"category":"enfermeria","aliases":["drenaje de absceso pequeño","abceso pequeño"]},
  {"name":"Absceso mediano","price":100,"category":"enfermeria","aliases":["abceso mediano"]},
  {"name":"Absceso grande","price":120,"category":"enfermeria","aliases":["abceso grande"]},
  {"name":"Retiro de uña","price":80,"category":"enfermeria","note":"lunes a viernes","aliases":["sacar uña","uña encarnada","retiro de uña encarnada"]},
  {"name":"Retiro de uña fin de semana","price":100,"category":"enfermeria","note":"sábado y domingo","aliases":["retiro de uña sabado","retiro de uña domingo"]},
  {"name":"Extracción de cuerpo extraño pequeño","price":80,"category":"enfermeria","aliases":["cuerpo extraño pequeño","sacar cuerpo extraño"]},
  {"name":"Extracción de cuerpo extraño grande","price":150,"category":"enfermeria","aliases":["cuerpo extraño grande"]},
  {"name":"Curación pequeña","price":60,"category":"enfermeria","aliases":["curacion pequeña","curacion chica"]},
  {"name":"Curación mediana","price":80,"category":"enfermeria","aliases":["curacion mediana"]},
  {"name":"Curación grande","price":100,"category":"enfermeria","aliases":["curacion grande"]},
  {"name":"Sutura por punto (enfermería)","price":15,"category":"enfermeria","aliases":["punto de sutura enfermeria","sutura enfermeria"]},
  {"name":"Sutura por punto (médico)","price":20,"category":"enfermeria","aliases":["punto de sutura medico","sutura medico","sutura","suturar"]},
  {"name":"Lavado de oído","price":80,"category":"enfermeria","note":"lunes a viernes","aliases":["lavado de oido","limpieza de oido","destapar oido","destapar el oido","lavar el oido","lavar oido"]},
  {"name":"Lavado de oído fin de semana","price":100,"category":"enfermeria","note":"sábado y domingo","aliases":["lavado de oido sabado","lavado de oido domingo"]},
  {"name":"Retiro de puntos (1 a 10 puntos)","price":25,"category":"enfermeria","aliases":["sacar puntos","sacar los puntos","retiro de puntos","quitar puntos","quitar los puntos"]},
  {"name":"Retiro de puntos (10 a 30 puntos)","price":40,"category":"enfermeria","aliases":["retiro de muchos puntos"]},
  {"name":"Certificado médico","price":150,"category":"certificado","aliases":["certificado medico","certificado"]},
  {"name":"Certificado de seguro médico","price":50,"priceMax":120,"category":"certificado","aliases":["seguro medico","certificado de seguro"]},
  {"name":"Parto normal","price":2200,"category":"obstetricia","aliases":["parto"]},
  {"name":"Parto multigesta","price":2000,"category":"obstetricia","aliases":["parto multigesta"]},
  {"name":"Cesárea programada","price":4000,"category":"obstetricia","aliases":["cesarea programada","cesarea","cesaria"]},
  {"name":"Cesárea de emergencia","price":4200,"category":"obstetricia","aliases":["cesarea de emergencia","cesaria de emergencia"]},
  {"name":"Ligadura","price":400,"category":"obstetricia","aliases":["ligadura de trompas","ligarme"]}
]$services$::jsonb,
        updated_by = 'seed:solicitudes-ficha'
    where business = 'clinica-san-martin';
  end if;
end $$;
