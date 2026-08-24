# Estructura del proyecto — Bot de citas por WhatsApp (SaaS clínicas)

> Documento de contexto para asistentes de IA. Describe **qué hay en cada archivo**,
> cómo fluye la información y qué convenciones seguimos. Generado a partir del código real.

---

## 1. Qué es el proyecto

Bot de WhatsApp **multi-tenant** para clínicas: atiende pacientes, responde preguntas
(especialidades, precios, labs, medicamentos) y **agenda citas de punta a punta**
(elegir especialidad → doctor → horario → datos → pago → confirmación + evento en
Google Calendar). Incluye un **panel interno** (`/admin`) para la secretaría y
**crons** de recordatorio/confirmación.

Cliente inicial y slug por defecto: `clinica-san-martin`
(`DEFAULT_BUSINESS_SLUG` en [lib/clinic/config.ts:28](lib/clinic/config.ts#L28)).

### Stack

| Pieza | Tecnología |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript |
| Hosting / crons | Vercel (`vercel.json`) |
| WhatsApp | Kapso (`@kapso/whatsapp-cloud-api`) sobre WhatsApp Cloud API |
| Base de datos | Supabase (Postgres + RLS), acceso con service role |
| IA | Vercel AI SDK (`ai`) + `@ai-sdk/openai` (`OPENAI_MODEL`, default `gpt-4o-mini`) |
| Calendario | `googleapis` con service account |
| Auth panel | Cookie de sesión firmada (HMAC) + `bcryptjs` |

### Scripts (`package.json`)

```
npm run dev            # next dev
npm run build          # next build
npm run start          # next start
npm run typecheck      # tsc --noEmit   ← lo corremos siempre antes de commitear
npm run prompt:check   # tsx scripts/prompt-check.ts (guardrail anti-alucinación)
```

No hay suite de tests unitarios: la verificación es `typecheck` + `prompt:check` + prueba manual.

---

## 2. Árbol de directorios

48 archivos versionados.

```
whatsappAI/
├── app/                                  # Next.js App Router
│   ├── layout.tsx
│   ├── globals.css
│   ├── admin/                            # Panel interno de la secretaría
│   │   ├── page.tsx
│   │   ├── actions.ts                    # server actions
│   │   └── login/page.tsx
│   └── api/
│       ├── webhooks/clinica/route.ts     # ★ entrada principal de WhatsApp
│       ├── cron/
│       │   ├── clinic-reminders/route.ts
│       │   └── clinic-confirmations/route.ts
│       ├── bot-control/{pause,resume,status}/route.ts
│       ├── admin/proof/route.ts
│       └── health/route.ts
├── lib/
│   ├── clinic/                           # Dominio: agendamiento
│   │   ├── booking.ts                    # ★ máquina de estados
│   │   ├── data.ts                       # acceso a BD del dominio
│   │   ├── config.ts                     # ★ getClinicConfig() + prompt
│   │   ├── googleCalendar.ts
│   │   └── types.ts
│   ├── engine/                           # Capa genérica de mensajería (reusable)
│   │   ├── messages.ts
│   │   ├── data.ts
│   │   ├── clients.ts
│   │   ├── logging.ts
│   │   └── types.ts
│   └── admin/auth.ts
├── supabase/
│   ├── migrations/                       # 12 migraciones con timestamp
│   ├── seeds/clinica-san-martin.sql
│   └── image_qr/
├── scripts/prompt-check.ts
├── public/qr-bnb.jpg
├── .claude/settings.json
├── .env.example
├── vercel.json
├── tsconfig.json
└── package.json
```

**Alias de imports:** `@/*` → raíz del proyecto (`tsconfig.json`). Siempre `@/lib/...`, nunca rutas relativas largas.

---

## 3. Archivo por archivo

### 3.1 `app/api/` — endpoints

| Archivo | Líneas | Responsabilidad |
|---|---:|---|
| [app/api/webhooks/clinica/route.ts](app/api/webhooks/clinica/route.ts) | 511 | **Orquestador principal.** `GET` verifica el webhook (fail-closed si no hay `KAPSO_VERIFY_TOKEN`); `POST` valida firma `X-Hub-Signature-256` con `META_APP_SECRET`, normaliza el evento, aplica debounce (`MESSAGE_DEBOUNCE_MS`, default 6000 ms), guarda inbound, toma el reply lock y decide: emergencia → comprobante → sesión activa → cancelar/reagendar → iniciar reserva → Q&A con OpenAI. `runtime = "nodejs"`, `maxDuration = 30`. |
| [app/api/cron/clinic-reminders/route.ts](app/api/cron/clinic-reminders/route.ts) | 174 | Recordatorios diarios de citas. Único cron declarado en `vercel.json` (`0 12 * * *`). Protegido por `CRON_SECRET` (o `CLINIC_REMIND_CRON_SECRET`). |
| [app/api/cron/clinic-confirmations/route.ts](app/api/cron/clinic-confirmations/route.ts) | 227 | Reconcilia citas confirmadas sin evento en Calendar y citas canceladas cuyo evento sigue vivo. Protegido por `CRON_SECRET` / `CLINIC_CONFIRM_CRON_SECRET`. |
| [app/api/bot-control/pause/route.ts](app/api/bot-control/pause/route.ts) | 122 | Pausa el bot (handoff humano). Requiere `BOT_CONTROL_SECRET`. |
| [app/api/bot-control/resume/route.ts](app/api/bot-control/resume/route.ts) | 94 | Reanuda el bot. |
| [app/api/bot-control/status/route.ts](app/api/bot-control/status/route.ts) | 95 | Estado de pausa actual. |
| [app/api/admin/proof/route.ts](app/api/admin/proof/route.ts) | 86 | Sirve el comprobante de pago al panel (requiere sesión de staff). |
| [app/api/health/route.ts](app/api/health/route.ts) | 151 | Health check: env vars requeridas, Supabase y Kapso. |

### 3.2 `app/admin/` — panel de la secretaría

| Archivo | Líneas | Responsabilidad |
|---|---:|---|
| [app/admin/page.tsx](app/admin/page.tsx) | 247 | Server component. Lista citas con filtros (`all / confirmed / pending / flagged / canceled`), búsqueda, paginación (`ADMIN_PAGE_SIZE = 25`) y edición inline. |
| [app/admin/actions.ts](app/admin/actions.ts) | 217 | Server actions: `loginAction`, `logoutAction`, `cancelAppointmentAction` (con motivo), `confirmAppointmentAction`, `updateAppointmentDetailsAction`. Cada mutación deja auditoría. |
| [app/admin/login/page.tsx](app/admin/login/page.tsx) | 38 | Formulario de login. |
| [app/layout.tsx](app/layout.tsx) / [app/globals.css](app/globals.css) | 14 / 347 | Layout raíz y estilos globales (CSS plano, sin Tailwind). |

### 3.3 `lib/clinic/` — dominio de agendamiento

| Archivo | Líneas | Responsabilidad |
|---|---:|---|
| [lib/clinic/booking.ts](lib/clinic/booking.ts) | 1250 | **Máquina de estados.** `advanceBooking()` recorre `idle → choosing_specialty → choosing_doctor* → choosing_slot → collecting_name → collecting_ci → collecting_reason → choosing_payment → awaiting_proof \| done` (*se salta si la especialidad tiene un solo doctor activo). Bloqueo de slot de 30 min (hold) con re-verificación de disponibilidad. `handlePaymentProof()` confirma al recibir comprobante (modelo de confianza). `checkActiveAppointment()`, `cancelActiveAppointment()`, `rescheduleActiveAppointment()` — al reagendar una cita ya `confirmed` no se vuelve a cobrar ni a pedir datos. |
| [lib/clinic/config.ts](lib/clinic/config.ts) | 276 | **Única puerta de entrada a la config de clínica.** `getClinicConfig(business)` lee `clinic_settings` con caché corta en memoria y fallback estático si la fila no existe o Supabase falla. `getBusinessByPhoneNumberId()` resuelve el tenant por número de WhatsApp. `buildClinicSystemPrompt()` arma el system prompt del Q&A. `invalidateClinicConfigCache()`. |
| [lib/clinic/data.ts](lib/clinic/data.ts) | 640 | Todo el SQL del dominio: especialidades, doctores, sesiones de reserva, holds, `createAppointment` / `updateAppointment`, `claimAppointmentForEventCreation` / `releaseAppointmentEventClaim` (idempotencia del evento de Calendar), auditoría admin, listados del panel, consultas de reconciliación. |
| [lib/clinic/googleCalendar.ts](lib/clinic/googleCalendar.ts) | 225 | `getBusyIntervals()`, `computeAvailableSlots()`, `createAppointmentEvent()`, `deleteAppointmentEvent()` con service account (`GOOGLE_SERVICE_ACCOUNT_JSON`). |
| [lib/clinic/types.ts](lib/clinic/types.ts) | 112 | `Specialty`, `Doctor`, `TimeSlot`, `BookingStep`, `PaymentMethod`, `BookingDraft`, `BookingHold`, `BookingSession`, `AppointmentStatus`, `ACTIVE_APPOINTMENT_STATUSES`, `Appointment`. |

### 3.4 `lib/engine/` — capa genérica de mensajería

Independiente del dominio clínica; pensada para reutilizarse en otros verticales.

| Archivo | Líneas | Responsabilidad |
|---|---:|---|
| [lib/engine/data.ts](lib/engine/data.ts) | 725 | Contactos y conversaciones, inbound/outbound, **reply locks** (`acquireReplyLock` / `markReplyLockSent`), `isLatestInboundMessage`, `getUnansweredInboundText`, ventana de servicio de 24 h, pausa del bot (`getBotPauseState`, `pauseBotForHumanHandoff`, `resumeBotIfPauseExpired`), historial reciente y estado de media enviada. |
| [lib/engine/messages.ts](lib/engine/messages.ts) | 270 | `normalizeIncomingMessages()`: payload de Kapso → `IncomingMessage` (texto, imagen, documento, audio). |
| [lib/engine/clients.ts](lib/engine/clients.ts) | 22 | `getRequiredEnv()`, `getKapsoClient()`, `getSupabaseClient()` (singletons). |
| [lib/engine/logging.ts](lib/engine/logging.ts) | 120 | `maskPhone()`, `getErrorMessage()`, `logSystemEvent()` (`info \| warning \| error \| critical`) + alerta opcional a Slack. |
| [lib/engine/types.ts](lib/engine/types.ts) | 92 | Tipos compartidos del motor (`HistoryMessage`, `MediaAsset`, `BusinessConfig`, etc.). |

### 3.5 `lib/admin/auth.ts` (145)

Sesión de staff: `createSessionToken` / `verifySessionToken` (HMAC con `ADMIN_SESSION_SECRET`),
`verifyStaffCredentials` (bcrypt), rate limit de login (`isLoginRateLimited`, `recordLoginAttempt`),
`getStaffSession()` y `requireStaff()` para proteger páginas y endpoints. Cookie: `clinic_admin_session`.

### 3.6 `supabase/`

Migraciones en orden cronológico (nombre = timestamp, se aplican en orden):

```
20260618000000_create_kapso_followups.sql
20260620000000_create_core_tables.sql                        # contactos, conversaciones, mensajes
20260620010000_create_clinic_tables.sql                      # especialidades, doctores, citas, sesiones
20260706000000_clinic_confirmations_webhook.sql
20260714000000_clinic_appointments_no_double_booking.sql     # constraint anti doble reserva
20260715000000_clinic_staff_admin.sql
20260716000000_enable_rls_all_tables.sql                     # RLS en todas las tablas
20260717000000_appointment_event_claim.sql                   # claim para crear evento una sola vez
20260717010000_admin_login_attempts.sql
20260717020000_clinic_admin_audit.sql
20260718000000_clinic_settings_multitenant.sql               # clinic_settings (1 fila por clínica)
20260730000000_appointment_cancel_reason.sql
```

`supabase/seeds/clinica-san-martin.sql` — datos iniciales del primer tenant.

### 3.7 Otros

- [scripts/prompt-check.ts](scripts/prompt-check.ts) (150) — guardrail anti-alucinación: llama a OpenAI de verdad y verifica que el bot no invente precios, doctores, horarios ni servicios fuera de la config. Correr a mano tras tocar el prompt o la temperatura.
- [vercel.json](vercel.json) — cron de recordatorios.
- [.env.example](.env.example) — todas las variables documentadas con su porqué (nunca commitear valores).
- `.claude/settings.json`, `tsconfig.json`, `public/qr-bnb.jpg` (QR de pago).

---

## 4. Flujos clave

**A. Mensaje entrante → cita creada**

```
WhatsApp → Kapso → POST /api/webhooks/clinica
  verificar firma → normalizeIncomingMessages() → filtro TEST_PHONE
  → saveContactAndConversation() → saveInboundMessage() → debounce
  → acquireReplyLock() → getBotPauseState()
  → getClinicConfig(business)   (business vía getBusinessByPhoneNumberId)
  → getBookingSession()
     ├─ sesión activa           → advanceBooking()
     ├─ intención cancelar/reag → cancelActiveAppointment / rescheduleActiveAppointment
     ├─ intención agendar       → advanceBooking(step=idle)
     └─ resto                   → generateText() con buildClinicSystemPrompt()
  → enviar respuesta (+ QR si action="send_qr") → saveOutboundMessage() → markReplyLockSent()
```

Dentro de `advanceBooking`, al elegir horario: `getBusyIntervals()` + holds + citas activas →
`computeAvailableSlots()` → `writeHold()` (30 min). Al confirmar: `createAppointment()` y,
si el pago es en efectivo, `createAppointmentEvent()` de inmediato.

**B. Comprobante de pago** — con `step = awaiting_proof` y llega imagen/documento →
`handlePaymentProof()` confirma la cita y crea el evento (protegido por
`claimAppointmentForEventCreation()` para no duplicarlo).

**C. Panel** — la secretaría confirma, cancela (con motivo) o edita datos; toda mutación
pasa por `requireStaff()` y queda en `logAdminAudit()`.

**D. Crons** — recordatorios diarios y reconciliación de eventos de Calendar.

---

## 5. Convenciones de trabajo

1. **Multi-tenant siempre.** Toda consulta lleva `business` (slug). Nunca hardcodear la clínica; usar `DEFAULT_BUSINESS_SLUG` solo como fallback.
2. **`getClinicConfig()` es la única fuente de config de clínica.** Ningún otro módulo lee `clinic_settings` ni datos de identidad directamente.
3. **Separación de capas:** `lib/engine/*` es genérico (mensajería), `lib/clinic/*` es del dominio. El dominio puede importar del engine, nunca al revés.
4. **Todo el SQL vive en `lib/**/data.ts`.** Rutas, acciones y componentes no llaman a Supabase directamente.
5. **Migraciones**: archivo nuevo con timestamp `YYYYMMDDHHMMSS_descripcion.sql`; nunca editar una ya aplicada. RLS activo en todas las tablas.
6. **Idempotencia y concurrencia**: reply locks para no responder dos veces, holds de 30 min contra doble reserva, `claimAppointmentForEventCreation()` para un solo evento por cita.
7. **Fail-safe sobre fail-fast en producción**: si un servicio externo falla, se degrada con log (`logSystemEvent`) en vez de romper el bot. Excepción: verificación del webhook, que es fail-closed.
8. **Privacidad en logs**: teléfonos siempre con `maskPhone()`.
9. **Cabecera de archivo**: los módulos grandes abren con un bloque de comentario `// ===` explicando el flujo. Mantenerlo actualizado al cambiar la lógica.
10. **Idioma**: código y tipos en inglés, comentarios y textos al paciente en español.
11. **Commits en español** con prefijo `feat:` / `fix:` / `refactor:`, en imperativo y describiendo el efecto visible.
12. **Antes de commitear**: `npm run typecheck` (y `npm run prompt:check` si se tocó el prompt).
