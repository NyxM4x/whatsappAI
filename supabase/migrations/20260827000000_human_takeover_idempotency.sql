-- Human takeover idempotency. A WAMID can create only one pause event per conversation.
alter table public.bot_control_events
  add column if not exists provider_message_id text;

alter table public.kapso_conversations
  alter column bot_pause_duration_minutes drop not null;

create unique index if not exists bot_control_pause_wamid_uidx
on public.bot_control_events (kapso_conversation_id, action, provider_message_id)
where action = 'pause' and provider_message_id is not null;