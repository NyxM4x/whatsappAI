# Informe de falencias — agente de WhatsApp, Clínica San Martín de Porres

**Fecha:** 2026-09-16 · **Repo:** `NyxM4x/whatsappAI` · **Rama:** `main` (HEAD `77bc02b`)
**Destinatario:** modelo colaborador (Gemini) que debe proponer cómo cerrar estos trabajos.

Este documento es autocontenido: incluye el contexto del sistema, el estado real del código,
una conversación de producción que falló, el diagnóstico línea por línea y las preguntas
concretas que necesitamos resolver.

> **Estado al 2026-09-16, después de las dos tandas de correcciones.**
> El diagnóstico de las secciones 1 a 5 se conserva tal como se escribió, para que se
> entienda de dónde salió cada arreglo. Lo resuelto está en la sección 7 al final.
> **Las nueve falencias tienen arreglo en la rama.** Falta la verificación contra el
> modelo (`npm run check:analisis`, necesita `OPENAI_API_KEY`) y aplicar las migraciones.
>
> **Ninguna migración fue aplicada todavía.** El repositorio no tiene acceso a Supabase:
> lo que hay es código y SQL escritos, nada corrido contra la base.

---

## 1. Qué es el sistema

Bot de WhatsApp (Next.js App Router + Supabase + OpenAI vía Vercel AI SDK, proveedor Kapso
para WhatsApp Cloud API) para una clínica en Bolivia. Entrada única:
`app/api/webhooks/clinica/route.ts`.

Piezas relevantes:

| Archivo | Rol |
|---|---|
| `app/api/webhooks/clinica/route.ts` | Webhook: orquesta debounce, takeover humano, intenciones, respuesta |
| `lib/clinic/booking.ts` (1953 líneas) | Flujo **viejo**: agenda citas reales contra Google Calendar |
| `lib/clinic/leads.ts` (542 líneas) | Flujo **nuevo** (2026-09-15): el bot NO agenda, recopila una "solicitud de ficha" y deja alarma en el panel |
| `lib/clinic/pricing.ts` | Tarifario de consultas por especialidad/día/hora + reconsulta + feriado |
| `lib/clinic/services.ts` | Catálogo de servicios (ecografías, procedimientos, enfermería…) + matcher por alias |
| `lib/clinic/config.ts` | System prompt + regex de intención. En producción el prompt se lee de `clinic_settings`, no del `.ts` |
| `supabase/seeds/clinica-san-martin.sql`, `supabase/migrations/20260824000000_*.sql` | Especialidades y plantel médico |

---

## 2. HALLAZGO BLOQUEANTE: el trabajo del 2026-09-15 no está desplegado

Todo el flujo nuevo está **en el working tree, sin commitear**:

```
?? lib/clinic/leads.ts
?? lib/clinic/pricing.ts
?? lib/clinic/payments.ts
?? app/admin/LeadsBoard.tsx
?? app/api/admin/leads/
?? supabase/migrations/20260915000000_solicitudes_ficha_pagos_feriado.sql
?? supabase/migrations/20260915010000_prompt_tarifario_solicitudes.sql
 M app/api/webhooks/clinica/route.ts   (657 líneas cambiadas)
 M lib/clinic/{config,data,services,types}.ts, app/admin/*, scripts/*
```

Verificación directa:

- `git show HEAD:app/api/webhooks/clinica/route.ts` → importa `advanceBooking` de `lib/clinic/booking.ts`.
- El webhook local ya **no importa nada de `booking.ts`**.

**Consecuencia:** producción corre el flujo viejo de agendamiento. La conversación fallida de
la sección 4 fue generada por `booking.ts`, no por el código nuevo. Además, las dos migraciones
del 2026-09-15 (que reescriben `system_prompt_base` y `services` en `clinic_settings`) **no
están aplicadas**, así que el prompt vivo en Supabase sigue siendo el viejo aunque se
desplegara el código.

Esto tiene que resolverse antes que cualquier otra cosa: hoy estamos depurando dos sistemas
distintos a la vez.

---

## 3. Especialidades cargadas — hay TRES listas que no coinciden

Esta desalineación es, en sí misma, una de las causas raíz.

### 3.1. Lista A — Base de datos (`clinic_specialties`), la que usa el flujo en producción

Definida en `supabase/seeds/clinica-san-martin.sql` y corregida por
`supabase/migrations/20260824000000_real_doctors_and_work_hours.sql`:

| Especialidad | Estado | Médicos |
|---|---|---|
| Medicina General | activa | 5 |
| Pediatría | activa | 2 |
| Ginecología | activa | 2 |
| Cardiología | **inactiva** (`is_active = false`) | 0 |
| Traumatología | **inactiva** (`is_active = false`) | 0 |
| Dermatología | **borrada** | — |

Plantel real (9 médicos, todos con `work_hours` puntuales, no franjas continuas):

- **Medicina General — 60 Bs base:** Dra. Linsey Angela Diaz Sanchez, Dr. Luis Jaime Rivera
  Porcel, Dr. Octavio Salinas Gallegos, Dr. Einar Heredia, Dra. Nohelia Pariente Delgadillo
- **Pediatría — 80 Bs base:** Dra. Rosmery Medina, Dr. Miguel Edgar Daguino Delgadillo
- **Ginecología — 80 Bs base:** Dr. Favio Tola Choque, Dra. Yabdiga Medina Merida

### 3.2. Lista B — `CONSULTATION_SPECIALTIES` en `lib/clinic/pricing.ts`, la que usa el flujo nuevo

**20 especialidades** hardcodeadas, tomadas del tarifario del sistema de la clínica:

Medicina General (60), Pediatría (80), Ginecología (80), Cardiología (150), Cirugía General
(150), Cirugía Pediátrica (150), Cirugía Plástica (350), Coloproctología (150), Diabetología
(200), Endocrinología (250), Gastroenterología (170), Medicina Interna (370), Nefrología
(350), Neumología (350), Neurología (320), Psicología (250), Reumatología (200),
Traumatología (250), Urología (150).

Solo las tres primeras tienen reglas de precio por franja horaria y `reconsultaDays`
(Medicina General 7 días, Pediatría 3, Ginecología 3). **Las otras 17 tienen precio pero
cero médicos cargados en la BD.**

### 3.3. Lista C — La que el paciente ve

En el flujo viejo, `booking.ts:924` le muestra las 3 activas de la BD.
En el flujo nuevo no se muestra lista: se pregunta en texto abierto (`leads.ts`, `askMissing`).

### 3.4. **Fisioterapia no existe en ninguna de las tres listas.** Ese es el origen del caso de abajo.

---

## 4. La conversación que falló (producción, flujo `booking.ts`)

```
14:40  PACIENTE  Buenas tardes doctora
14:40  PACIENTE  Para fisioterapia
14:41  BOT       Perfecto 😊 ¿Qué especialidad necesita?
                   1. Medicina General
                   2. Pediatría
                   3. Ginecología
                 ¿Cuál necesita?
14:41  BOT       Por lo que me cuenta le corresponde Medicina General 😊
                 (si prefiere otra especialidad, dígamelo)
                 Médicos disponibles en Medicina General:
                   1. Dra. Linsey Angela Diaz Sanchez
                   2. Dr. Luis Jaime Rivera Porcel
                   3. Dr. Octavio Salinas Gallegos
                   4. Dr. Einar Heredia
                   5. Dra. Nohelia Pariente Delgadillo
                 ¿Con quién prefiere? Si le da igual, dígame "cualquiera"…
14:41  ?         Ok señora
14:42  ?         Va cancelar por QR / O llegando / Me confirma
14:42  ?         Llegando doctora por favor
14:42  BOT       Ok
16:33  ?         Por favor doctora me lo dice a la licen para las 5:10 llegó
16:33  BOT       Ok
       ?         Señora
```

Resultado: **ninguna ficha registrada, ningún dato del paciente capturado, ninguna alarma en
el panel.** El paciente pidió fisioterapia (que la clínica no ofrece), se le ofreció Medicina
General sin decirle nunca que fisioterapia no existe, y la conversación murió en dos "Ok".

*Nota de honestidad:* el pegado de WhatsApp no distingue de forma inequívoca quién emite cada
mensaje entre 14:41 y el final; los mensajes marcados `?` podrían ser del paciente o de una
persona de la clínica. Las dos respuestas "Ok" sí son del bot. Para cerrar esto hace falta
leer `messages` y `system_events` en Supabase para esa conversación.

---

## 5. Diagnóstico — falencias concretas

### F1 · El extractor de especialidad está obligado a elegir siempre (causa raíz del caso)

`lib/clinic/booking.ts:505` (flujo viejo), prompt de `extractBookingPrefs`:

> "Si solo describe un SÍNTOMA o malestar, elegí la especialidad más apropiada de la lista;
> **si ninguna encaja con claridad, elegí Medicina General.**"

Y el mismo criterio se repite en el flujo nuevo, `lib/clinic/leads.ts` (`ANALYSIS_SYSTEM`):

> "Si solo describe un síntoma, elegí la especialidad más apropiada de la lista y **ante la
> duda medicina-general**."

Y en el system prompt (`lib/clinic/config.ts:186` y en las migraciones de prompt):

> "eligiendo SIEMPRE una de las que la clínica tiene listadas… **Ante la duda, Medicina General.**"

**No existe ninguna rama para "el paciente nombró una especialidad que NO ofrecemos".** El
modelo solo puede devolver un índice/clave de la lista o `null`; "fisioterapia" no es un
síntoma, es una especialidad ausente, y el fallback la convierte silenciosamente en Medicina
General. `booking.ts:947` entonces dice *"Por lo que me cuenta le corresponde Medicina
General"* — una frase que además es falsa: el paciente no "contó" nada, nombró un servicio.

**Lo que debería pasar:** "Fisioterapia no la tenemos en la clínica 🙏" + derivación a asesor,
o la alternativa real si existe. Nunca sustituir en silencio.

### F2 · El bot ofrece un menú de especialidades sin que el paciente lo pida

`booking.ts:924` dispara la lista de 3 especialidades cuando `extractBookingPrefs` devuelve
`null`. Con un paciente que ya dijo "para fisioterapia", listarle Medicina General / Pediatría
/ Ginecología es ruido: no responde a lo que preguntó y no le dice que lo suyo no está.

En el flujo nuevo el síntoma cambia pero no desaparece: `missingFields()` en `leads.ts` pediría
`specialty` y el bot repreguntaría *"¿Para qué especialidad es la consulta?"* a alguien que
acaba de decir la especialidad. Bucle frustrante.

### F3 · 17 especialidades cotizables sin un solo médico

`CONSULTATION_SPECIALTIES` (Lista B) incluye Neurología a 320 Bs, Medicina Interna a 370 Bs,
etc. `analyzeTurn` recibe esa lista completa como universo válido. Si un paciente pide
neurología, el bot abrirá una ficha y cotizará 320 Bs por una consulta que ningún médico
cargado puede atender. No hay marca de "se atiende a llamado / no disponible por WhatsApp".

### F4 · El médico de preferencia no se valida contra el plantel

En `leads.ts`, `ANALYSIS_SYSTEM` define `doctorName` como *"el médico que pide el paciente,
tal como lo escribió"*, y `mergeAnalysis` lo guarda tal cual en `doctorPreference`. Además
`missingFields()` acepta `doctorPreference` **en lugar de** `specialtyKey`. Un paciente que
pide "con el Dr. Pérez" (inexistente) completa la ficha sin especialidad y sin que nadie
detecte el error, y el resumen se envía con un médico que no trabaja ahí. Se le pasa la lista
real de médicos al prompt, pero no hay validación determinista posterior.

### F5 · El Q&A general es la salida por defecto y responde "Ok"

Paso 12 de `app/api/webhooks/clinica/route.ts`: todo lo que no matchee servicio, ficha ni
regex cae en `answerQuestion()` con `temperature: 0.35` y sin ninguna obligación de acción.
Mensajes que claramente piden una acción humana — *"Me confirma"*, *"me lo dice a la licen
para las 5:10"* — se responden con "Ok": el bot simula haber hecho algo que no hizo, no deja
alarma en el panel y el paciente queda esperando a nadie.

Falta una regla: si el mensaje pide una confirmación, un aviso a una persona o una gestión, y
no hay solicitud en curso → derivar con alarma, nunca contestar con un monosílabo de cortesía.

### F6 · Confusión de rol: el paciente le habla al bot como si fuera la recepcionista

"Buenas tardes **doctora**", "Ok **señora**", "Por favor **doctora** me lo dice a la licen".
El paciente nunca supo que hablaba con un asistente automático. El saludo institucional
("Buenas, somos la Clínica San Martín de Porres…") no aclara que es un asistente virtual, y
`humanHandoffIntentPatterns` (`config.ts`) exige un verbo explícito (*"hablar con…"*), así que
un tratamiento como "doctora" no deriva. Correcto para no sobre-derivar, pero entonces falta
lo otro: presentarse como asistente al inicio.

### F7 · Menciones de pago sin manejo real

"Va cancelar por QR" / "O llegando" son una elección de forma de pago. En el flujo nuevo,
`qrRequestIntentPatterns` (`\bqr\b`) sí derivaría a asesor — bien. Pero en producción hoy eso
no ocurre así, y en ningún flujo se registra "el paciente pagará en efectivo al llegar" como
dato de la ficha.

### F8 · Sin trazabilidad para auditar conversaciones

No hay forma de responder "¿por qué el bot dijo esto?" sin reconstruirlo a mano. No se persiste
la rama del webhook que se tomó ni la salida cruda de `analyzeTurn` / `extractBookingPrefs`.
Para el trabajo que viene —revisar conversaciones no fructíferas— esto es indispensable.

### F9 · Pendiente heredado: pediatría cobra de menos los fines de semana

Documentado al pie de `supabase/migrations/20260824000000_real_doctors_and_work_hours.sql`:
`clinic_doctors.consultation_price` es un monto único (80 Bs) pero el tarifario cobra 120 Bs
sábado y domingo. `pricing.ts` **sí** resuelve esto con reglas por franja — otra razón para
desplegar el flujo nuevo, pero hay que confirmar que `booking.ts` deje de ser la fuente de
precios.

---

## 6. Lo que necesitamos de vos

En orden de prioridad:

1. **Despliegue.** ¿Cómo cortamos este trabajo sin romper producción? El diff pendiente son
   ~1.300 líneas + 4 archivos nuevos + 2 migraciones. ¿Un solo commit, o separar
   migraciones / backend / panel? ¿Qué verificaciones mínimas antes de mergear, dado que hay
   pacientes reales escribiendo ahora mismo?

2. **Especialidad no disponible (F1).** Diseño concreto: ¿un campo nuevo en el JSON de
   `analyzeTurn` (p. ej. `requestedUnavailableSpecialty: string|null`) + una rama determinista
   en el webhook? ¿O una lista explícita de "lo que la clínica NO hace" (fisioterapia,
   odontología, oftalmología, laboratorio propio…) para que el modelo la reconozca? Interesa
   la redacción exacta de las reglas del prompt, porque el fallback "ante la duda Medicina
   General" está en cuatro lugares y hay que cambiarlo sin romper el triaje por síntomas, que
   sí queremos conservar.

3. **Universo de especialidades (F3).** ¿Cómo separamos "cotizable" de "agendable por
   WhatsApp"? Propuesta a evaluar: un flag `bookableByWhatsapp` en `ConsultationSpecialty`, y
   que `analyzeTurn` reciba solo las agendables, dejando el resto para responder precio +
   derivar.

4. **Red de seguridad conversacional (F5).** Criterio para decidir cuándo el Q&A libre no es
   respuesta aceptable. ¿Clasificador de "el mensaje pide una acción"? ¿Lista de patrones?
   ¿Regla en el prompt de que nunca conteste con acuse de recibo vacío?

5. **Trazabilidad (F8).** Esquema mínimo para poder auditar conversaciones: qué guardar por
   turno y en qué tabla, sin inflar el costo.

Si necesitás ver código, todo está en el repo y las referencias de este documento apuntan al
archivo y la línea exactos.

---

## 7. Lo ya corregido (rama `feat/leads-recoleccion`)

### Decisión de negocio que cambió el diagnóstico

**El bot nunca propone médicos ni horarios.** Solo reúne los datos; el asesor humano propone
médico y confirma horario cuando revisa la solicitud en el panel. Esto **cierra F3**: las 17
especialidades sin plantel dejan de ser un problema, porque el bot cotiza y recolecta, y es
una persona quien resuelve con qué médico. La lista única que alimenta al bot es la Lista B
(`CONSULTATION_SPECIALTIES`, 20 ítems).

### F1 — Especialidad no disponible · resuelto

- `TurnAnalysis` gana `unavailableRequest: string | null`. La regla del prompt es explícita:
  el fallback a `medicina-general` vale **solo para síntomas**, nunca para una especialidad
  que el paciente nombró.
- La garantía no se deja en manos del modelo: `sanitizeAnalysis()` fuerza
  `specialtyKey = null` cuando `unavailableRequest` trae valor. Si el modelo devolviera las
  dos cosas, gana la honestidad.
- Rama nueva en el webhook, **antes** de servicio y ficha: responde
  *"No contamos con [X] en la clínica"* + alarma `no_disponible` + pausa.
- El prompt de `clinic_settings` incorpora la sección "LO QUE LA CLÍNICA NO OFRECE".

### F4 — Médico como dato, no como reemplazo · resuelto

`missingFields()` ahora exige `specialtyKey` **siempre** para una ficha. Antes bastaba con
nombrar un médico (`!specialtyKey && !doctorPreference`) y la solicitud se cerraba sin
especialidad, con un nombre que nadie validaba contra el plantel. El médico se sigue
guardando en `doctor_preference` como dato adicional para el asesor.

### F5 — Red de seguridad conversacional · resuelto

`needsHumanAction: boolean` detecta gestiones y hechos físicos ("dígale a la licenciada",
"ya llegué", "me confirma", "pago llegando"). La rama va **después** de servicio y ficha
—para no robarle mensajes a la recolección, ej. "quiero una ficha, me confirma"— y **antes**
del Q&A, que es donde estaba el agujero: deriva con alarma `accion` en vez de contestar "Ok".

Esto **no** se implementó como regla de prompt, a diferencia de lo propuesto: `answerQuestion()`
solo devuelve un string y no puede disparar `registerEscalation()` ni la pausa. Una regla de
prompt habría cambiado "Ok" por *"le aviso a la doctora"*, que es peor: una promesa falsa.

### F6 — Identidad · resuelto

`CLINIC_WELCOME_MESSAGE` pasa a *"soy el asistente virtual de la Clínica San Martín de
Porres"*, y el prompt gana una sección "QUIÉN ERES" que le prohíbe hacerse pasar por la
doctora o prometer gestiones.

### Extra: robustez de `analyzeTurn`

`getActiveDoctorsWithSpecialty()` se llamaba fuera del `try`, así que un fallo de Supabase
hacía lanzar a `analyzeTurn` (→ 500 y reintento de Kapso) en vez de degradar. Ahora la lista
de médicos es contexto opcional con `.catch()`. Importa justamente porque quedarse sin
`analyzeTurn` devuelve al paciente al Q&A libre, que es el agujero recién tapado.

### Verificación

- `npm run typecheck` → limpio.
- `npm run check:intenciones` → sin fallos (regex, tarifario y franjas de precio; no usa OpenAI).
- `npm run check:analisis` → **script nuevo**, reproduce los mensajes reales de la conversación
  fallida contra `analyzeTurn`. Necesita `OPENAI_API_KEY` en `.env.local`, así que **todavía no
  se corrió**. Incluye el invariante: si un caso devuelve `unavailableRequest` y `specialtyKey`
  a la vez, falla con "¡SUSTITUCIÓN SILENCIOSA!".

### Migraciones — orden de aplicación

| Orden | Migración | Cuándo |
|---|---|---|
| 1 | `20260915000000` | Segura ya: solo `create table` e `add column` |
| 2 | `20260915010000` | **Junto con el deploy**: reescribe `system_prompt_base` y `services`, que el código viejo lee |
| 3 | `20260916000000` | Junto con el deploy: amplía el CHECK de `kind` y actualiza prompt y saludo |

## 8. Segunda tanda: F2, F7, F8, F9

### F7 — Forma de pago · resuelto

`paymentIntention: "qr" | "efectivo" | null` en `TurnAnalysis` y en `LeadDraft`, columna
`payment_intention` en `clinic_leads`, línea en el resumen del paciente y fila en el panel.
El bot sigue sin cobrar y sin mandar el QR: es un dato para el asesor.

Hubo que desambiguar contra `needsHumanAction`, que en la primera tanda incluía "va a pagar
al llegar": eso habría derivado en vez de guardar el dato. Ahora `needsHumanAction` cubre
"ya pagó" (un hecho consumado que alguien debe verificar) y `paymentIntention` cubre la
intención. Si el paciente solo dice cómo va a pagar, no se deriva.

### F8 — Trazabilidad · resuelto, con dos desvíos de lo propuesto

Tabla `clinic_webhook_audits` (`business`, `contact_phone`, `intent`, `step`, `analysis`
jsonb, `created_at`), con índices por conversación y por intent, RLS activo y una consulta
de retención sugerida a 90 días en la propia migración.

**Desvío 1 — sin `waitUntil`, con `await`.** La premisa de "no ralentizar la respuesta a
WhatsApp" no aplica a este webhook: ya duerme `DEBOUNCE_MS` (6 s) dentro de la invocación a
propósito, y espera a OpenAI hasta 15 s más, con `maxDuration = 30`. Un insert de
milisegundos no cambia nada, y `await` garantiza el guardado y permite manejar el error.
`@vercel/functions` ni siquiera está instalado: se evitó una dependencia nueva para resolver
un problema que acá no existe. (El diagnóstico sobre la promesa flotante sí era correcto —
por eso tampoco se usó esa.)

**Desvío 2 — el compilador obliga a auditar.** En vez de agregar el insert "justo antes del
return", que en este webhook son **diez** puntos de salida distintos y sería cuestión de
tiempo que alguien agregue el once sin auditar, el helper `ok()` pasa a recibir un
`AuditIntent` obligatorio. Olvidarse de auditar una rama nueva ahora es un error de
compilación, no un agujero silencioso.

### F2 — Repreguntar lo ya dicho · cubierto, pendiente de verificar

Con `missingFields()` consumiendo lo que trae `analyzeTurn`, un "Para ginecología" no debería
repreguntar la especialidad. Pero eso depende de que el modelo devuelva `wantsLead: true`:
si no, el mensaje ni siquiera llega a abrir la solicitud. En vez de darlo por hecho, se
agregaron casos a `check:analisis` que lo comprueban.

### F9 — Pediatría fin de semana

Se resuelve al desplegar: `pricing.ts` ya tiene las reglas por franja y día.

### Migraciones — orden final

| Orden | Migración | Cuándo |
|---|---|---|
| 1 | `20260915000000` | Segura ya — solo `create table` / `add column` |
| 2 | `20260915010000` | **Junto con el deploy** — reescribe `system_prompt_base` y `services` |
| 3 | `20260916000000` | Junto con el deploy — kinds de alarma, prompt, saludo |
| 4 | `20260916010000` | Junto con el deploy — `payment_intention` y `clinic_webhook_audits` |

---

## 9. La prueba contra el modelo · 19/19 en verde

`npm run check:analisis` corrió por primera vez el 2026-09-17. **Falló 6 de 19 casos** y
encontró dos defectos que ninguna revisión de código había visto.

### F10 · El arreglo de F1 rompía el flujo principal

`"necesito un ginecologo"` → `unavailableRequest: "ginecologo"`. **El bot creía que la clínica
no ofrece ginecología.** La regla nueva le había creado un sesgo al modelo: puesto a buscar
cosas fuera de la lista, empezó a encontrarlas donde no las había. Y como la regla dura fuerza
`specialtyKey = null` cuando hay `unavailableRequest`, el falso positivo se llevaba puesta la
especialidad. Habría derivado a un asesor a todo el que pidiera un ginecólogo.

En la misma línea, `"Para ginecología"` y `"pediatria por favor"` devolvían **todo null** —
F2 no "se arreglaba solo": sin `wantsLead`, esos mensajes ni siquiera llegaban a abrir la
solicitud.

**Arreglo — reconocer la especialidad deja de ser criterio del modelo.** Se agregó `aliases`
a `ConsultationSpecialty` (las 19 con las formas que usa la gente: "ginecólogo", "pediatra",
"traumatólogo", "clínico"…) y `matchSpecialtyText()` en `pricing.ts`, que compara contra
clave, nombre, alias y la raíz del nombre ("ginecolog" cubre "ginecologia" y "ginecologo").
En `sanitizeAnalysis()`:

1. si lo que el modelo marcó como no disponible **es una de las nuestras**, se descarta el
   falso positivo y se usa esa especialidad;
2. la especialidad nombrada en el texto **manda sobre la del modelo** — es un hecho, no una
   inferencia. Al modelo se le cree solo para lo que no se puede resolver comparando strings:
   los síntomas;
3. si nombró una especialidad nuestra y no está preguntando, `wantsLead` pasa a true.

También se agregó `HUMAN_ACTION_PATTERN`, porque `"Me confirma"` a secas el modelo lo daba
por `false` — y es exactamente uno de los mensajes que murieron en la conversación real.

### F11 · En Bolivia "cancelar" significa pagar

El caso que quedó rojo al final destapó un bug que **ya estaba en producción**:

```
cancelIntentPatterns: /\bcancelar|anular|cancela mi/i
```

El paciente del 2026-09-15 escribió **"Va cancelar por QR"** y **"O llegando"**. Estaba
diciendo cómo iba a **pagar**. Ese patrón lo lee como que quiere **anular su cita** y lo
deriva como cancelación.

**Arreglo:** `cancelMeansPayingPatterns` desactiva la derivación solo cuando el sentido de
pago es explícito (hay un medio o un momento de pago al lado: "cancelar por QR", "cancelo al
llegar", "cancelo en efectivo"). Un `"quiero cancelar"` pelado sigue siendo cancelación, que
ante la duda es lo seguro. `check:intenciones` cubre los dos sentidos.

### Un caso de prueba estaba mal escrito

`"voy a cancelar llegando nomas"` esperaba `needsHumanAction: true`. Era la misma confusión:
no es una gestión, es la forma de pago. El modelo entendió el boliviano mejor que la
expectativa. Corregido a `payment: "efectivo"`.

### Resultado

```
✓ Sin fallos.   (19/19)
```

`npm run typecheck` y `npm run check:intenciones` también en verde.
