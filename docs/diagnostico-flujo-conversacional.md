# Diagnóstico del flujo conversacional — estado actual del código

**Fecha:** 2026-09-17 · **Repo:** `NyxM4x/whatsappAI` · **HEAD:** `223ea1d` (rama `main`, desplegado `cb48fcf`)

Descripción fiel del código tal como está hoy. No propone arquitectura ni cambios.
Los resultados de análisis que aparecen abajo son **ejecuciones reales** contra
`gpt-4o-mini`, no lectura de código.

---

## 1. Entrada del mensaje

**Archivo único de entrada:** `app/api/webhooks/clinica/route.ts` → `POST()` (línea 116).

Antes de llegar a cualquier decisión conversacional, el mensaje pasa por un pipeline
de infraestructura:

| Orden | Qué hace | Línea |
|---|---|---|
| 1 | Verifica firma `X-Hub-Signature-256` (se salta si falta `META_APP_SECRET`) | ~130 |
| 2 | Detecta **takeover humano** (recepcionista escribió desde WhatsApp Business) y pausa el bot | ~165 |
| 3 | Normaliza el payload de Kapso a `IncomingMessage[]` | ~205 |
| 4 | Modo test: si `TEST_PHONE` está seteada, ignora a todos los demás números | ~195 |
| 5 | Resuelve la clínica dueña del número (multi-tenant) | ~215 |
| 6 | Guarda contacto, conversación e inbound | 271 |
| 7 | Lock anti-duplicado (`kapso_response_locks`) | 292 |
| 8 | **Chequeo de pausa** → si está pausado, `watchWhilePaused()` y corta | 307 |
| 9 | `markRead` + indicador de escritura | 334 |
| 10 | **Debounce** de `MESSAGE_DEBOUNCE_MS` (6 s): duerme y cede el turno si llegó otro mensaje | 353 |
| 11 | Consolida en `newText` todo lo que el paciente escribió sin respuesta | 366 |

Recién en la línea ~420 empieza la parte conversacional.

Helpers que cierran cada turno:

- `send(replyText, {pauseAfter})` (409) → `sendAndPersist()`, que **revierte a chequear la pausa
  justo antes de enviar** (Barrera B).
- `ok(intent)` (426) → escribe la fila de auditoría en `clinic_webhook_audits` y devuelve 200.
  El `intent` es obligatorio: el compilador no deja salir del webhook sin declarar la rama.
- `escalate(kind, replyText, intent)` (440) → alarma en `clinic_leads` + limpia sesión +
  responde + pausa el bot 12 h.

---

## 2. Dónde se llama al modelo

Hay **dos llamadas distintas a OpenAI**, con propósitos separados:

### `analyzeTurn()` — `lib/clinic/leads.ts:216`

El extractor. `generateText` con `temperature: 0`, timeout 10 s, modelo
`OPENAI_MODEL ?? "gpt-4o-mini"`. Devuelve JSON parseado a mano.

Se le inyecta en el *user prompt*:

- fecha y hora actual en la zona de la clínica;
- el contexto del paso (`idle` / `collecting_lead` / `confirming_lead`) y qué campos faltan;
- los datos ya recopilados (`draft` serializado);
- **la lista completa de `CONSULTATION_SPECIALTIES`** (clave: nombre), 19 entradas;
- la lista de médicos activos desde `clinic_doctors`.

Si falla o el timeout vence → devuelve `null` y el flujo continúa sin análisis.

### `answerQuestion()` — `lib/clinic/leads.ts:269`

El Q&A libre. `temperature: 0.35`, timeout 15 s, con `buildClinicSystemPrompt(clinic)` y las
últimas 8 líneas del historial. **Devuelve un string y nada más**: no puede disparar acciones,
crear alarmas ni pausar el bot.

---

## 3. Estructura que devuelve el análisis

No hay zod ni `generateObject`. Es un tipo TypeScript + validación manual.

`lib/clinic/leads.ts:86`:

```ts
export type TurnAnalysis = {
  patientName: string | null;
  specialtyKey: string | null;
  doctorName: string | null;
  preferredTime: string | null;
  preferredDate: string | null;      // "YYYY-MM-DD"
  preferredHour: string | null;      // "HH:MM"
  visitType: VisitType | null;       // "nueva" | "reconsulta"
  paymentIntention: PaymentIntention | null;  // "qr" | "efectivo"
  unavailableRequest: string | null;
  needsHumanAction: boolean;
  wantsLead: boolean;
  wantsHuman: boolean;
  frustrated: boolean;
  confirms: boolean;
  wantsOut: boolean;
  isQuestion: boolean;
};
```

El contrato con el modelo está en `ANALYSIS_SYSTEM` (línea 105): una sola línea de JSON de
ejemplo seguida de ~17 reglas en prosa.

`sanitizeAnalysis(raw, text, services)` (línea 152) valida y **corrige** la salida del modelo.
No es un validador pasivo: aplica reglas de negocio deterministas (ver §6).

---

## 4. Qué significa cada campo hoy

### `wantsLead`
> *"true si quiere pedir ficha, cita, turno o consulta, o atenderse con un médico o una especialidad."*

**Pero no sale solo del modelo.** `sanitizeAnalysis:184` lo fuerza:

```ts
const wantsLead = raw?.wantsLead === true
  || Boolean((specialtyKey || unavailableRequest) && !isQuestion);
```

Es decir: nombrar una especialidad (o algo fuera de catálogo) **sin preguntar** lo vuelve `true`
aunque el modelo dijera `false`. Se agregó porque `"Para ginecología"` a secas devolvía `false` y
el mensaje no llegaba a abrir la solicitud.

### `isQuestion`
> *"true si hace una pregunta (precios, dirección, requisitos, etc.)."*

Sale directo del modelo, sin corrección. **Solo se usa dentro de `sanitizeAnalysis` para calcular
`wantsLead`, y en `continueLead` para decidir si responder una duda en medio de la recolección.
El router principal nunca lo consulta.**

### `patientName`
> *"nombre del PACIENTE que se va a atender, tal como lo escribió."*

Se limpia con `cleanText(raw, 80)` (línea 138): recorta espacios, descarta `"null"` literal y
trunca a 80 caracteres. **No valida que parezca un nombre.** Verificado en ejecución real:
`"hola tienen electrocardiograma? pa mi"` → `patientName: "pa mi"`.

### `unavailableRequest`
El nombre es heredado y ya no describe lo que significa. Hoy es **"lo que el paciente pidió y no
está en `CONSULTATION_SPECIALTIES`"** — un string libre. La regla del prompt es explícita en que
*no* es un rechazo:

> *"Esto NO es un rechazo: solo marca que hay que verificarlo con un asesor."*

Cubre en un mismo campo cosas de naturaleza distinta: una especialidad (`fisioterapia`), un examen
(`electrocardiograma`), un estudio (`radiografia de torax`), un análisis (`analisis de sangre`).
**Nada distingue cuál es cuál.**

### `specialtyKey`
Clave de `CONSULTATION_SPECIALTIES`. Resuelto en `sanitizeAnalysis:181` con esta precedencia:

```ts
const specialtyKey =
  fromText?.key                      // 1. matchSpecialtyText() sobre el TEXTO CRUDO
  ?? unavailableIsOurs?.key          // 2. lo que el modelo marcó como ausente pero sí tenemos
  ?? (unavailableRequest ? null : fromModel);  // 3. la del modelo (inferida de síntomas)
```

Al modelo solo se le cree cuando el código no puede resolverlo comparando strings — es decir,
para inferir especialidad a partir de un **síntoma**.

### `kind`
**No existe en `TurnAnalysis`.** Es un campo de `LeadDraft` (`lib/clinic/types.ts`) con dos valores
posibles, `"ficha" | "servicio"`, y **lo decide el router, no el análisis**:

- `route.ts:536` → `kind: "ficha"` **fijo** para todo lo no catalogado
- `route.ts:545` → `kind: "servicio"` cuando `matchService()` acertó
- `route.ts:553` → `kind: "ficha"` para el resto

---

## 5. Otros campos de intención y contexto

En `TurnAnalysis`: `needsHumanAction`, `wantsHuman`, `frustrated`, `confirms`, `wantsOut`,
`doctorName`, `paymentIntention`, `visitType`, `preferredTime/Date/Hour`.

Fuera del modelo, en `lib/clinic/config.ts`, hay **siete regex** que corren *antes* de la IA y
pueden cortar el turno por sí solas:

| Patrón | Línea | Efecto |
|---|---|---|
| `humanHandoffIntentPatterns` | 155 | Deriva a humano. Corta incluso una solicitud en curso |
| `locationRequestIntentPatterns` | 145 | Responde dirección + Maps, determinista |
| `cancelIntentPatterns` | 120 | Deriva como cancelación |
| `cancelMeansPayingPatterns` | 129 | Desactiva la anterior ("cancelar" = pagar en Bolivia) |
| `rescheduleIntentPatterns` | 131 | Deriva como reprogramación |
| `checkAppointmentIntentPatterns` | 134 | Deriva como consulta de cita |
| `qrRequestIntentPatterns` | 142 | Deriva como pago |
| `bookingIntentPatterns` | 116 | Abre ficha |

Y dos patrones más en `leads.ts`: `HUMAN_ACTION_PATTERN` (línea 149) y `GREETING_ONLY_PATTERN`
(en el webhook).

---

## 6. Dónde se comprueba el catálogo

Son **dos catálogos separados, con dos matchers distintos**:

### Especialidades — `lib/clinic/pricing.ts`
`CONSULTATION_SPECIALTIES` (línea 47): 19 entradas hardcodeadas con `key`, `name`, `price`,
`rules`, `reconsultaDays` y `aliases`.

`matchSpecialtyText(text)` (línea 144): normaliza (minúsculas, sin tildes, guiones→espacios),
compara contra clave, nombre y alias, y como último recurso contra la **raíz** del nombre
(`"ginecolog"` cubre `"ginecologia"` y `"ginecologo"`). Devuelve el match más largo.

### Servicios — `lib/clinic/services.ts`
`defaultServices` (línea 65): ecografías, procedimientos, enfermería, certificados, obstetricia,
emergencias. En producción se lee de `clinic_settings.services` (jsonb), no del `.ts`.

`matchService(text, services)` (línea 186): normaliza + unifica formas verbales
(`FORMAS_VERBALES`) y devuelve el match más largo.

### Dónde se usan

- `sanitizeAnalysis:158` → `matchSpecialtyText(text)` sobre el texto crudo
- `sanitizeAnalysis:165` → `matchSpecialtyText(unavailableRequest)` para descartar falsos positivos
- `sanitizeAnalysis:174` → `matchService(unavailableRequest, services)` idem
- `route.ts:543` → `matchService(newText, clinic.services)` sobre el texto completo

**Ningún catálogo cubre exámenes de gabinete** (electrocardiograma, radiografía, laboratorio
puntual). Por eso caen todos en `unavailableRequest`.

---

## 7. El router

Está **inline dentro de `POST()`**, líneas 447 a 566. No hay función de routing separada. Son 13
bloques `if` en secuencia, cada uno con `return`. El primero que matchea gana.

```
 1. Comprobantes y archivos          registerIncomingProof() — solo registra, no corta
 2. Emergencias                      desactivado salvo CLINIC_EMERGENCY_DETECTION=true
 3. humanHandoffIntentPatterns    → escalate("humano")          [regex]
 4. locationRequestIntentPatterns → dirección + Maps            [regex]
 5. proof                         → acuse de comprobante
 6. isLeadStep(session.step)      → analyzeTurn + continueLead   ◄── SOLICITUD EN CURSO
 7. !newText / GREETING_ONLY      → saludo
 8. cancel/reschedule/check/qr    → escalate(...)                [regex]
 9. analyzeTurn(...)              ◄── PRIMERA Y ÚNICA LLAMADA AL EXTRACTOR EN ESTE CAMINO
    ├ wantsHuman                  → escalate("humano")
    ├ unavailableRequest          → startLead(kind: "ficha")     ◄── INCONDICIONAL
    └ trackFailedAttempts
10. matchService(newText)         → startLead(kind: "servicio")
11. bookingIntentPatterns || wantsLead → startLead(kind: "ficha")
12. needsHumanAction              → escalate("accion")
13. answerQuestion()              → Q&A libre; si falla, escalate("humano")
```

**Observación estructural:** los pasos 3, 4, 8 (regex) corren **antes** del análisis del paso 9.
Un mensaje que matchea una regex nunca llega a ser analizado por el modelo.

### Condiciones exactas de cada resultado

| Resultado | Condición |
|---|---|
| **Responde información** | Paso 4 (ubicación, determinista) o paso 13 (Q&A libre, cajón de sastre) |
| **Empieza a recopilar** | Paso 9 (`unavailableRequest` ≠ null), paso 10 (`matchService` acertó), o paso 11 (`bookingIntentPatterns` o `wantsLead`) |
| **Crea la ficha en BD** | No en el primer turno. `persistLead()` (leads.ts:494) se llama desde `sendSummary()`, que solo corre cuando `missingFields()` devuelve vacío |
| **Deriva a un asesor** | Pasos 3, 8, 9 (`wantsHuman`/`fallidos`), 12 (`needsHumanAction`), 13 (si el modelo falla). Todos vía `escalate()` → alarma + pausa 12 h |
| **Pregunta nueva/reconsulta** | `needsVisitType()` (leads.ts:301) devuelve true |

### `needsVisitType()` — leads.ts:301

```ts
function needsVisitType(draft: LeadDraft): boolean {
  if (draft.kind !== "ficha") return false;
  const spec = findSpecialty(draft.specialtyKey);
  return spec ? Boolean(spec.reconsultaDays) : true;   // ← sin especialidad: true
}
```

`reconsultaDays` solo existe en medicina-general (7), pediatría (3) y ginecología (3). Las otras
16 especialidades no preguntan. **Pero cuando `specialtyKey` es null —que es siempre el caso de lo
no catalogado— el fallback es `true`.**

### Campos que se piden — `missingFields()`, leads.ts:309

```ts
if (draft.kind === "ficha" && !draft.specialtyKey && !draft.unmatchedRequestText) missing.push("specialty");
if (!draft.patientName)  missing.push("name");
if (!draft.preferredTime) missing.push("time");
if (needsVisitType(draft) && !draft.visitType) missing.push("visit");
```

---

## 8. Estado entre mensajes

**Tabla:** `clinic_booking_sessions`, PK `kapso_conversation_id`. Acceso en
`lib/clinic/data.ts:253` (`getBookingSession`) y `:297` (`saveBookingSession`).
TTL `BOOKING_SESSION_TTL_MINUTES ?? 120` (2 h): pasado ese tiempo se trata como `idle`.

Columnas: `step`, `draft` (jsonb), `held_doctor_id`, `held_slot_start`, `hold_expires_at`.

`step` puede ser `idle` | `collecting_lead` | `confirming_lead` (los pasos del agendamiento viejo
se normalizan a `idle` en `normalizeSession()`, route.ts:580).

`draft.lead` es un `LeadDraft` (`lib/clinic/types.ts:165`):

```ts
export type LeadDraft = {
  kind: "ficha" | "servicio";
  patientName?: string | null;
  specialtyKey?: string | null;
  unmatchedRequestText?: string | null;   // lo pedido fuera de catálogo
  doctorPreference?: string | null;
  preferredTime?: string | null;
  preferredDate?: string | null;
  preferredHour?: string | null;
  visitType?: VisitType | null;
  paymentIntention?: PaymentIntention | null;
  serviceName?: string | null;
  serviceQuote?: string | null;
  leadId?: string | null;
};
```

Más `draft.failedAttempts: string[]` (timestamps de frustración, ventana 24 h).

**Otro estado, en otras tablas:** `bot_pause_state` (por teléfono normalizado, no por
conversación), `kapso_messages` (historial que consume el Q&A), `clinic_leads` (las solicitudes),
`clinic_webhook_audits` (auditoría), `kapso_response_locks`.

---

## 9. Recorrido de los tres mensajes

Ejecuciones reales contra `gpt-4o-mini`, conversación en `idle`.

### A) `"¿Tienen electrocardiograma?"`

**Análisis:**
```
specialtyKey=null   unavailableRequest="electrocardiograma"
wantsLead=false     isQuestion=true     patientName=null
needsHumanAction=false   preferredTime=null   visitType=null
matchSpecialtyText → null    matchService → null    bookingIntentPatterns → false
```

**Rama:** paso 9, `if (analysis?.unavailableRequest)` — route.ts:535.

**Nota:** el análisis lo clasificó correctamente como pregunta (`isQuestion: true`,
`wantsLead: false`). **La condición del paso 9 no consulta ninguno de los dos campos.**

**Datos que intenta recopilar:** `startLead(kind: "ficha")` → `mergeAnalysis` deja
`unmatchedRequestText: "electrocardiograma"` → `missingFields()` devuelve `["name", "time", "visit"]`
(`specialty` queda satisfecha por `unmatchedRequestText`; `visit` entra porque `needsVisitType`
devuelve `true` al no haber `specialtyKey`).

**Respuesta generada:**
```
¡Con gusto le ayudo a pedir su ficha! 😊

Para pasarle su solicitud a un asesor necesito:

👤 El *nombre completo del paciente*
🗓️ El *día y la hora* que le quedarían cómodos
🔁 Si es *consulta nueva* o *reconsulta*

Puede responderme todo en un solo mensaje 😊
```

**Funciones:** `POST` → `analyzeTurn` → `sanitizeAnalysis` → `startLead` (535) →
`mergeAnalysis` (326) → `askOrSummarize` (528) → `missingFields` (309) → `needsVisitType` (301) →
`askMissing` (378).

---

### B) `"Quiero hacerme un electrocardiograma"`

**Análisis:**
```
specialtyKey=null   unavailableRequest="electrocardiograma"
wantsLead=true      isQuestion=false    patientName=null
matchService → null    bookingIntentPatterns → false
```

**Rama:** **la misma**, paso 9 (535). Nunca llega al paso 11.

**Respuesta generada: idéntica al caso A**, palabra por palabra.

Los dos mensajes tienen intenciones distintas (uno pregunta, el otro pide) y el análisis lo
detecta correctamente, pero **producen exactamente la misma salida** porque la rama que los
atiende ignora `wantsLead` e `isQuestion`.

---

### C) `"Quiero sacar ficha con cardiología"`

**Análisis:**
```
specialtyKey=cardiologia   unavailableRequest=null
wantsLead=true             isQuestion=false
matchSpecialtyText → cardiologia    bookingIntentPatterns → true
```

**Rama:** paso 11 (route.ts:551), `bookingIntentPatterns` ya da `true` por la palabra "ficha".

**Datos:** `missingFields()` → `["name", "time"]`. **No pregunta nueva/reconsulta**, porque
cardiología no tiene `reconsultaDays` en `CONSULTATION_SPECIALTIES`.

**Respuesta generada:**
```
¡Con gusto le ayudo a pedir su ficha! 😊

Para pasarle su solicitud a un asesor necesito:

👤 El *nombre completo del paciente*
🗓️ El *día y la hora* que le quedarían cómodos

Puede responderme todo en un solo mensaje 😊
```

**Observación:** cardiología está en el tarifario (150 Bs) pero **no tiene médicos cargados** en
`clinic_doctors` (solo medicina general, pediatría y ginecología tienen plantel). El bot abre la
solicitud igual; es el asesor quien resuelve. Es intencional según la decisión de negocio vigente
(el bot no propone médicos ni horarios).

---

## 10. ¿Hay capas separadas?

**No. Hay una capa de comprensión razonablemente definida y ninguna capa de decisión.**

### Lo que sí está separado

`analyzeTurn()` es una capa de comprensión identificable: entra texto, sale una estructura tipada.
Vive en su propio módulo y se puede probar aislada (`scripts/check-analisis.ts` hace exactamente
eso, 22 casos).

### Dónde se mezclan las responsabilidades

**1. `sanitizeAnalysis()` decide, no solo valida.**
Además de limpiar tipos, aplica reglas de negocio: fuerza `wantsLead` (línea 184), descarta
`unavailableRequest` contra dos catálogos (165, 174), establece precedencia de `specialtyKey`
(181) y añade `needsHumanAction` por regex (194). Comprensión y decisión conviven en la misma
función.

**2. El router no existe como pieza.**
Son 13 `if` inline dentro de `POST()`, mezclados con `await send(...)`, escritura de sesión y
auditoría. No hay un objeto "decisión" intermedio: cada rama decide **y** ejecuta **y** responde
en las mismas tres líneas. No se puede testear una decisión de ruteo sin ejecutar el webhook.

**3. Dos sistemas de comprensión compiten, y el determinista corre primero.**
Siete regex de `config.ts` (pasos 3, 4, 8) cortan el turno antes de que el modelo vea el mensaje.
El análisis del paso 9 nunca se entera de esos casos. Conviven dos vocabularios de intención —
el de las regex y el de `TurnAnalysis`— sin relación entre sí.

**4. El flujo de recolección está partido en dos lugares.**
`startLead`/`continueLead` (leads.ts) llevan la máquina de estados, pero **quién entra y con qué
`kind`** se decide en el webhook. `kind` es el dato que gobierna qué se pregunta
(`needsVisitType`) y cómo se le habla al paciente (`startLead:539`), y se fija en el router con un
literal.

**5. `isQuestion` está calculado y no se usa donde importa.**
El campo existe, el modelo lo llena bien, y el router principal nunca lo lee. La distinción entre
preguntar y pedir se pierde entre la capa que la detecta y la que actúa.

### Consecuencia observable

Los casos A y B de §9 son el síntoma: el sistema **entiende** la diferencia entre "¿tienen X?" y
"quiero X", la deja registrada en dos campos booleanos, y produce la misma respuesta para los dos
porque entre la comprensión y la acción no hay nada que consulte esos campos.
