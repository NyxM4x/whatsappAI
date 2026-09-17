-- ============================================================================
-- Forma de pago anunciada (F7) y auditoria de turnos (F8)
-- ----------------------------------------------------------------------------
-- F7: el paciente decia "va a cancelar por QR" o "pago llegando" y eso no se
--     guardaba en ningun lado. Ahora es un dato mas de la solicitud, para que
--     el asesor lo vea en el panel. El bot sigue sin cobrar ni mandar el QR.
--
-- F8: una fila por mensaje respondido, con la rama del webhook que lo atendio y
--     el JSON crudo del analisis. Sirve para revisar conversaciones que no
--     terminaron en nada sin tener que reconstruirlas a mano.
--
-- Va JUNTO con el despliegue del codigo.
-- ============================================================================

-- ── A. Forma de pago en la solicitud ────────────────────────────────────────
alter table public.clinic_leads
  add column if not exists payment_intention text
    check (payment_intention in ('qr', 'efectivo'));

comment on column public.clinic_leads.payment_intention is
  'Como dijo el paciente que va a pagar. Dato informativo para el asesor: el bot no cobra ni envia el QR.';

-- ── B. Auditoria de turnos ──────────────────────────────────────────────────
-- analysis guarda el JSON ya saneado de analyzeTurn (no el texto del paciente,
-- que ya vive en la tabla de mensajes). Contiene datos personales -- el nombre
-- del paciente, lo que pidio -- asi que conviene purgarla cada tanto; abajo
-- queda la consulta de retencion sugerida.
create table if not exists public.clinic_webhook_audits (
  id                    uuid primary key default gen_random_uuid(),
  business              text not null,
  kapso_conversation_id text,
  contact_phone         text not null,
  intent                text not null,
  step                  text,
  analysis              jsonb,
  created_at            timestamptz not null default now()
);

comment on table public.clinic_webhook_audits is
  'Un registro por mensaje respondido: que rama del webhook lo atendio y que devolvio el analisis. Para auditar por que el bot contesto lo que contesto.';

-- Las dos busquedas reales: "que paso en esta conversacion" y "cuantos mensajes
-- cayeron en el Q&A esta semana".
create index if not exists clinic_webhook_audits_phone_idx
  on public.clinic_webhook_audits (business, contact_phone, created_at desc);
create index if not exists clinic_webhook_audits_intent_idx
  on public.clinic_webhook_audits (business, intent, created_at desc);

-- Igual que el resto de tablas del proyecto: solo la service role key accede.
alter table public.clinic_webhook_audits enable row level security;

-- Retencion sugerida (correr a mano o por cron cada tanto):
--   delete from public.clinic_webhook_audits where created_at < now() - interval '90 days';
