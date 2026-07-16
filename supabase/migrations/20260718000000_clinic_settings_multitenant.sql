-- ============================================================================
-- Multi-tenant real (P2) — tabla clinic_settings + resolución por WhatsApp
-- ----------------------------------------------------------------------------
-- Una fila por clínica. Reemplaza el objeto estático de lib/clinic/config.ts
-- como fuente de verdad (getClinicConfig() ya lee de acá, con caché de 45s).
--
-- Los patrones de detección de intención (agendar/cancelar/emergencia/etc.)
-- siguen siendo los mismos para todas las clínicas por ahora — son lógica de
-- código, no contenido editable por clínica. Solo identidad/catálogos/textos
-- viven en esta tabla.
--
-- Resolución de tenant: cada clínica tiene su propio número de WhatsApp
-- (Kapso), guardado en kapso_phone_number_id. Al llegar un webhook, se busca
-- la fila cuyo kapso_phone_number_id coincide con el que recibió el mensaje.
--
-- Versionado para auditoría: version se incrementa en cada UPDATE (ver
-- trigger abajo), updated_by guarda quién hizo el cambio (staff_id o 'seed').
-- ============================================================================

create table if not exists public.clinic_settings (
  id                    uuid primary key default gen_random_uuid(),
  business              text not null unique,
  kapso_phone_number_id text unique,

  clinic_name    text not null,
  timezone       text not null default 'America/La_Paz',
  address        text,
  phone          text,
  maps_url       text,
  hours          text,
  welcome_message text,
  qr_image_url   text,
  payment_methods text[] not null default '{}',

  labs             jsonb not null default '[]'::jsonb,
  medications      jsonb not null default '[]'::jsonb,
  emergency_keywords text[] not null default '{}',
  emergency_response text,
  system_prompt_base text,
  replies          jsonb not null default '{}'::jsonb,

  version    int not null default 1,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists clinic_settings_phone_number_idx
on public.clinic_settings (kapso_phone_number_id);

alter table public.clinic_settings enable row level security;

-- Bump automático de version + updated_at en cada UPDATE, para no depender de
-- que cada caller se acuerde de incrementarlo a mano.
create or replace function public.bump_clinic_settings_version()
returns trigger
language plpgsql
as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists clinic_settings_bump_version on public.clinic_settings;

create trigger clinic_settings_bump_version
before update on public.clinic_settings
for each row
execute function public.bump_clinic_settings_version();

-- ── Seed: fila de la Clínica San Martín con los datos que hoy están
-- hardcodeados en lib/clinic/config.ts. ⚠️ Reemplazar <KAPSO_PHONE_NUMBER_ID>
-- por el phone_number_id real de Kapso de esta clínica antes de correr, si ya
-- lo tenés a mano (si no, se puede dejar null y completarlo después con un
-- UPDATE — mientras sea null, esta clínica sigue funcionando igual como
-- fallback por defecto de getClinicConfig).
insert into public.clinic_settings (
  business, kapso_phone_number_id, clinic_name, timezone,
  address, phone, maps_url, hours, welcome_message, qr_image_url,
  payment_methods, labs, medications, emergency_keywords, emergency_response,
  system_prompt_base, replies, updated_by
)
values (
  'clinica-san-martin',
  '<KAPSO_PHONE_NUMBER_ID>',
  'Clínica San Martín de Porres',
  'America/La_Paz',
  'Av. Moscú, a una cuadra del Mercado La Cuchilla',
  '+591 75681881',
  'https://maps.app.goo.gl/RcMqdE3z8NX1ZULG6',
  'Lunes a Sábado, 8:00 a 20:00',
  'Bienvenido a Clínica San Martín de Porres 😊 ¿En qué podemos ayudarle?',
  'https://whatsapp-ai-chi.vercel.app/qr-bnb.jpg',
  array['QR BNB', 'Efectivo'],
  '[
    {"name": "Hemograma Completo", "price": 80},
    {"name": "Glucosa", "price": 30},
    {"name": "Perfil Lipídico", "price": 120},
    {"name": "Prueba de Embarazo", "price": 50},
    {"name": "Examen General de Orina", "price": 40}
  ]'::jsonb,
  '[
    {"name": "Paracetamol 500mg", "price": 10},
    {"name": "Ibuprofeno 400mg", "price": 15},
    {"name": "Amoxicilina 500mg", "price": 25},
    {"name": "Loratadina", "price": 12},
    {"name": "Omeprazol", "price": 18}
  ]'::jsonb,
  array['desmayando', 'me estoy desmayando', 'dolor fuerte en el pecho', 'no puedo respirar', 'convulsiones', 'convulsión', 'accidente grave', 'emergencia'],
  '🚨 Diríjase inmediatamente a Emergencias. Comparta su ubicación en tiempo real con una persona cercana y solicite ayuda inmediata.

📍 Av. Moscú, a una cuadra del Mercado La Cuchilla
🗺️ https://maps.app.goo.gl/RcMqdE3z8NX1ZULG6
📞 +591 75681881',
  '
Eres el asistente virtual de la Clínica San Martín de Porres y atiendes por WhatsApp.
Hablas cálido, cercano, profesional y empático, como una recepcionista de Bolivia.
Mensajes cortos y naturales, nunca suenes a robot. Puedes usar "señor/a" con respeto y
algún emoji (😊, 👍) sin exagerar.

QUÉ HACES:
- Resuelves dudas generales: especialidades, precios de consulta, dirección, horarios,
  formas de pago, exámenes de laboratorio y medicamentos.
- Si la persona quiere AGENDAR, el sistema la guía paso a paso: NO inventes el flujo ni
  pidas datos por tu cuenta, solo invítala a agendar.

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
',
  '{
    "welcome": "Bienvenido a Clínica San Martín de Porres 😊 Puedo ayudarle a *agendar una cita* o darle información (especialidades, precios, dirección, horarios). ¿Qué necesita?",
    "proofButNoBooking": "Gracias 😊 ¿Desea agendar una cita? Escríbame y empezamos.",
    "noActiveAppointment": "No encontré una cita activa a su nombre 😊 ¿Desea agendar una nueva?",
    "humanHandoff": "Entiendo 🙏 Ya aviso a nuestro equipo para que le atienda directamente. En un momento se comunican con usted."
  }'::jsonb,
  'seed'
)
on conflict (business) do nothing;

-- ── clinic_staff: login por correo SIN depender de saber la clínica de
-- antemano. La pantalla /admin/login es compartida por todas las clínicas —
-- hoy el email era único POR clínica (unique(business,email)); pasa a ser
-- único globalmente, y el login busca por email y recién ahí sabe a qué
-- clínica pertenece esa persona.
alter table public.clinic_staff drop constraint if exists clinic_staff_business_email_key;
create unique index if not exists clinic_staff_email_uidx on public.clinic_staff (email);

-- clinic_login_attempts: el rate limit ahora es por correo solamente (no se
-- sabe la clínica hasta DESPUÉS de autenticar), así que business deja de ser
-- obligatoria.
alter table public.clinic_login_attempts alter column business drop not null;
