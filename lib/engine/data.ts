// ============================================================================
// CAPA DE DATOS  —  todo el acceso a Supabase vive aquí y SOLO aquí.
// ----------------------------------------------------------------------------
// Es el límite de migración: el día que se cambie Supabase por un Postgres
// propio (pg / Drizzle / Prisma), se reescribe el "cómo" de estas funciones
// SIN tocar el motor (webhook/ai/media) ni la config de ningún negocio.
// Estas funciones tienen nombres de dominio (saveInboundMessage, getRecentHistory…)
// y no exponen el cliente Supabase hacia afuera.
// ============================================================================

import { getSupabaseClient } from "@/lib/engine/clients";
import { logSystemEvent, maskPhone, getErrorMessage } from "@/lib/engine/logging";
import { normalizePhone } from "@/lib/engine/phone";
import type {
  GroupKey,
  HistoryMessage,
  IncomingMessage,
  MediaAsset,
  MediaIntent,
  MediaSentState,
  ProductKey,
} from "@/lib/engine/types";

export type BotPauseState = {
  paused: boolean;
  expired: boolean;
  reason?: string | null;
  expiresAt?: string | null;
  mode?: string | null;
  // De dónde salió la respuesta: la identidad durable (teléfono) o la fila
  // legacy de conversación. Solo para diagnóstico en logs.
  source?: "durable" | "conversation" | "none";
};

export const DEFAULT_HUMAN_TAKEOVER_MINUTES = 30;

// HUMAN_TAKEOVER_PAUSE_MINUTES: entero en [1, 1440]; cualquier otra cosa cae al
// default de 30 minutos.
export function getHumanTakeoverMinutes(): number {
  const value = Number(process.env.HUMAN_TAKEOVER_PAUSE_MINUTES);
  return Number.isInteger(value) && value >= 1 && value <= 1440 ? value : DEFAULT_HUMAN_TAKEOVER_MINUTES;
}

// ─── Identidad durable de la pausa ────────────────────────────────────────────
// El `conversation.id` de Kapso NO es estable: el mismo paciente puede aparecer
// con ids distintos (conversación cerrada y reabierta). Antes la pausa se
// ESCRIBÍA buscando por teléfono y se LEÍA por conversation.id, así que un
// cambio de id hacía que el bot "perdiera" la pausa y siguiera respondiendo.
//
// A partir de acá la identidad durable es el TELÉFONO NORMALIZADO y vive en
// public.bot_pause_state (una fila por teléfono, PK). `kapso_conversations`
// sigue siendo metadata técnica y se mantiene espejada por compatibilidad,
// pero ya no es la fuente de verdad.

export type DurablePauseRow = {
  contact_phone_normalized: string;
  contact_phone?: string | null;
  bot_paused: boolean;
  bot_paused_at?: string | null;
  bot_resumed_at?: string | null;
  bot_pause_expires_at?: string | null;
  bot_paused_reason?: string | null;
  bot_pause_mode?: string | null;
  bot_pause_duration_minutes?: number | null;
  last_kapso_conversation_id?: string | null;
  last_provider_message_id?: string | null;
  updated_at?: string | null;
};

export type LegacyPauseRow = {
  bot_paused?: boolean | null;
  bot_pause_expires_at?: string | null;
  bot_paused_reason?: string | null;
  bot_pause_mode?: string | null;
};

function toMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Resolución canónica del estado de pausa. La fila durable (por teléfono) manda;
// la fila de conversación solo se usa si todavía no hay identidad durable.
export function resolveBotPauseState(params: {
  durable?: DurablePauseRow | null;
  legacy?: LegacyPauseRow | null;
  nowMs?: number;
}): BotPauseState {
  const nowMs = params.nowMs ?? Date.now();
  const row: DurablePauseRow | LegacyPauseRow | null = params.durable ?? params.legacy ?? null;
  const source: BotPauseState["source"] = params.durable
    ? "durable"
    : params.legacy
      ? "conversation"
      : "none";

  if (!row?.bot_paused) return { paused: false, expired: false, source };

  const expiresAt = row.bot_pause_expires_at ?? null;
  const expiresMs = toMs(expiresAt);
  // Sin vencimiento = pausa indefinida (manual): nunca expira.
  const expired = expiresMs !== null ? expiresMs <= nowMs : false;

  return {
    paused: true,
    expired,
    reason: row.bot_paused_reason ?? null,
    expiresAt,
    mode: row.bot_pause_mode ?? null,
    source,
  };
}

export type TakeoverPauseDecision =
  | { kind: "keep_manual_pause"; expiresAt: string | null; durationMinutes: number | null }
  | { kind: "apply"; expiresAt: string; durationMinutes: number };

// Decide la nueva ventana de pausa ante un mensaje humano.
export function computeTakeoverPause(params: {
  current?: DurablePauseRow | null;
  eventTimestamp?: string | null;
  nowMs: number;
  minutes: number;
}): TakeoverPauseDecision {
  const current = params.current ?? null;
  const currentExpiryMs = toMs(current?.bot_pause_expires_at ?? null);

  // 1) Una pausa manual / indefinida NO se degrada a temporal.
  if (current?.bot_paused && (current.bot_pause_mode === "manual" || currentExpiryMs === null)) {
    return {
      kind: "keep_manual_pause",
      expiresAt: current.bot_pause_expires_at ?? null,
      durationMinutes: current.bot_pause_duration_minutes ?? null,
    };
  }

  // 2) La ventana se ancla al timestamp DEL MENSAJE humano, no a "ahora": así
  //    una reentrega del mismo WAMID calcula exactamente el mismo expiry y no
  //    puede renovar el TTL ni aunque se cuele por delante del dedupe.
  const baseMs = toMs(params.eventTimestamp ?? null) ?? params.nowMs;
  const candidateMs = baseMs + params.minutes * 60_000;

  // 3) Monotonía: un evento viejo nunca acorta una pausa vigente.
  const finalMs = currentExpiryMs !== null ? Math.max(currentExpiryMs, candidateMs) : candidateMs;

  return {
    kind: "apply",
    expiresAt: new Date(finalMs).toISOString(),
    durationMinutes: params.minutes,
  };
}

// ─── Takeover humano ──────────────────────────────────────────────────────────

export type HumanTakeoverParams = {
  conversationId: string;
  customerPhone: string;
  customerPhoneNormalized?: string | null;
  providerMessageId: string;
  messageTimestamp: string | null;
};

export type HumanTakeoverResult = {
  applied: boolean;
  duplicate: boolean;
  identity: string | null;
  expiresAt: string | null;
  outcome: "applied" | "duplicate_wamid" | "manual_pause_kept" | "unresolved_identity";
};

// Puerto de persistencia del takeover. Existe para poder probar orden,
// idempotencia y TTL sin base de datos real (ver scripts/test-human-takeover.ts).
export type HumanTakeoverRepo = {
  hasPauseEventForWamid(identity: string, providerMessageId: string): Promise<boolean>;
  getDurablePause(identity: string): Promise<DurablePauseRow | null>;
  writeDurablePause(row: DurablePauseRow): Promise<void>;
  mirrorConversationPause(params: {
    identity: string;
    conversationId: string;
    contactPhone: string;
    fields: LegacyPauseRow & {
      bot_paused_at?: string | null;
      bot_pause_duration_minutes?: number | null;
    };
  }): Promise<void>;
  insertPauseControlEvent(params: {
    identity: string;
    conversationId: string;
    contactPhone: string;
    providerMessageId: string;
    expiresAt: string | null;
  }): Promise<{ duplicate: boolean }>;
  saveHumanMessage(params: {
    identity: string;
    conversationId: string;
    contactPhone: string;
    providerMessageId: string;
    messageTimestamp: string | null;
  }): Promise<void>;
};

// Orden deliberado (la pausa pesa más que el almacenamiento auxiliar):
//   1. resolver identidad durable
//   2. comprobar WAMID duplicado
//   3. leer el estado humano actual
//   4. aplicar / renovar la pausa      ← lo crítico
//   5. registrar el control event
//   6. persistir el mensaje humano     ← best-effort, nunca tumba la pausa
export async function applyHumanTakeover(
  repo: HumanTakeoverRepo,
  params: HumanTakeoverParams,
  options?: { nowMs?: number; minutes?: number },
): Promise<HumanTakeoverResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const minutes = options?.minutes ?? getHumanTakeoverMinutes();

  // 1. Identidad durable.
  const identity = params.customerPhoneNormalized ?? normalizePhone(params.customerPhone);
  if (!identity) {
    return {
      applied: false,
      duplicate: false,
      identity: null,
      expiresAt: null,
      outcome: "unresolved_identity",
    };
  }

  // 2. Dedupe por WAMID, alineado con el índice único
  //    (contact_phone_normalized, action, provider_message_id).
  if (await repo.hasPauseEventForWamid(identity, params.providerMessageId)) {
    return {
      applied: false,
      duplicate: true,
      identity,
      expiresAt: null,
      outcome: "duplicate_wamid",
    };
  }

  // 3. Estado humano actual.
  const current = await repo.getDurablePause(identity);

  // 4. Aplicar o renovar la pausa.
  const decision = computeTakeoverPause({
    current,
    eventTimestamp: params.messageTimestamp,
    nowMs,
    minutes,
  });

  const keepManual = decision.kind === "keep_manual_pause";

  const pauseFields = keepManual
    ? {
        bot_paused: true,
        bot_paused_at: current?.bot_paused_at ?? nowIso,
        bot_paused_reason: current?.bot_paused_reason ?? "manual",
        bot_pause_mode: current?.bot_pause_mode ?? "manual",
        bot_pause_expires_at: decision.expiresAt,
        bot_pause_duration_minutes: decision.durationMinutes,
      }
    : {
        bot_paused: true,
        bot_paused_at: params.messageTimestamp ?? nowIso,
        bot_paused_reason: "human_whatsapp_business_app",
        bot_pause_mode: "auto",
        bot_pause_expires_at: decision.expiresAt,
        bot_pause_duration_minutes: decision.durationMinutes,
      };

  await repo.writeDurablePause({
    contact_phone_normalized: identity,
    contact_phone: params.customerPhone,
    ...pauseFields,
    last_kapso_conversation_id: params.conversationId,
    last_provider_message_id: params.providerMessageId,
    updated_at: nowIso,
  });

  // Espejo en kapso_conversations: mantiene coherentes al panel y al fallback
  // legacy. Best-effort — la verdad ya quedó escrita en bot_pause_state.
  try {
    await repo.mirrorConversationPause({
      identity,
      conversationId: params.conversationId,
      contactPhone: params.customerPhone,
      fields: pauseFields,
    });
  } catch (err) {
    console.error("human takeover: mirror to kapso_conversations failed", getErrorMessage(err));
  }

  // 5. Control event (cierra la idempotencia también contra carreras).
  let duplicate = false;
  try {
    const inserted = await repo.insertPauseControlEvent({
      identity,
      conversationId: params.conversationId,
      contactPhone: params.customerPhone,
      providerMessageId: params.providerMessageId,
      expiresAt: decision.expiresAt,
    });
    duplicate = inserted.duplicate;
  } catch (err) {
    console.error("human takeover: control event insert failed", getErrorMessage(err));
  }

  // 6. Mensaje humano — auxiliar. Un fallo acá NO puede perder la pausa.
  try {
    await repo.saveHumanMessage({
      identity,
      conversationId: params.conversationId,
      contactPhone: params.customerPhone,
      providerMessageId: params.providerMessageId,
      messageTimestamp: params.messageTimestamp,
    });
  } catch (err) {
    console.error("human takeover: message persistence failed", getErrorMessage(err));
  }

  return {
    applied: true,
    duplicate,
    identity,
    expiresAt: decision.expiresAt,
    outcome: keepManual ? "manual_pause_kept" : "applied",
  };
}

function getSupabaseHumanTakeoverRepo(): HumanTakeoverRepo {
  const supabase = getSupabaseClient();

  return {
    async hasPauseEventForWamid(identity, providerMessageId) {
      // `.limit(1)` en vez de `.maybeSingle()`: la consulta ya calca el índice
      // único, pero así ni siquiera es posible un PGRST116 por varias filas
      // (que antes devolvía 500 y descartaba la pausa entera).
      const { data, error } = await supabase
        .from("bot_control_events")
        .select("id")
        .eq("contact_phone_normalized", identity)
        .eq("action", "pause")
        .eq("provider_message_id", providerMessageId)
        .limit(1);
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },

    async getDurablePause(identity) {
      const { data, error } = await supabase
        .from("bot_pause_state")
        .select(
          "contact_phone_normalized, contact_phone, bot_paused, bot_paused_at, bot_resumed_at, bot_pause_expires_at, bot_paused_reason, bot_pause_mode, bot_pause_duration_minutes, last_kapso_conversation_id",
        )
        .eq("contact_phone_normalized", identity)
        .maybeSingle();
      if (error) throw error;
      return (data as DurablePauseRow | null) ?? null;
    },

    async writeDurablePause(row) {
      const { error } = await supabase
        .from("bot_pause_state")
        .upsert(row, { onConflict: "contact_phone_normalized" });
      if (error) throw error;
    },

    async mirrorConversationPause({ identity, conversationId, contactPhone, fields }) {
      const nowIso = new Date().toISOString();

      // Asegura que exista la fila técnica (contact_phone_normalized es columna
      // generada: se calcula sola, no se escribe a mano).
      const { error: upsertError } = await supabase.from("kapso_conversations").upsert(
        {
          kapso_conversation_id: conversationId,
          contact_phone: contactPhone,
          updated_at: nowIso,
        },
        { onConflict: "kapso_conversation_id" },
      );
      if (upsertError) throw upsertError;

      // Espeja sobre TODAS las conversaciones del mismo teléfono, no solo la del
      // evento: es lo que evita que un conversation.id nuevo "resucite" al bot.
      const { error } = await supabase
        .from("kapso_conversations")
        .update({ ...fields, updated_at: nowIso })
        .eq("contact_phone_normalized", identity);
      if (error) throw error;
    },

    async insertPauseControlEvent({
      identity,
      conversationId,
      contactPhone,
      providerMessageId,
      expiresAt,
    }) {
      const { error } = await supabase.from("bot_control_events").insert({
        kapso_conversation_id: conversationId,
        contact_phone_normalized: identity,
        contact_phone_masked: maskPhone(contactPhone),
        action: "pause",
        actor_source: "whatsapp_business_app",
        reason: "human_whatsapp_business_app",
        expires_at: expiresAt,
        provider_message_id: providerMessageId,
        metadata: { takeover_completed: true, kapso_conversation_id: conversationId },
      });
      if (error) {
        if (error.code === "23505") return { duplicate: true };
        throw error;
      }
      return { duplicate: false };
    },

    async saveHumanMessage({ conversationId, contactPhone, providerMessageId, messageTimestamp }) {
      const { error } = await supabase.from("kapso_messages").insert({
        kapso_message_id: providerMessageId,
        kapso_conversation_id: conversationId,
        contact_phone: contactPhone,
        direction: "outbound",
        role: "assistant",
        content: "[HUMAN_TAKEOVER]",
        message_timestamp: messageTimestamp ?? new Date().toISOString(),
        raw_payload: null,
      });
      if (error && error.code !== "23505") throw error;
    },
  };
}

// Auto-pausa el bot cuando un humano responde desde la app de WhatsApp Business
// (origin=business_app). Llamado desde el webhook, antes de cualquier IA.
export async function autoPauseBotFromBusinessApp(
  params: HumanTakeoverParams,
): Promise<HumanTakeoverResult> {
  return applyHumanTakeover(getSupabaseHumanTakeoverRepo(), params);
}

// Teléfono normalizado asociado a un conversation.id, para los callers que solo
// tienen el id técnico (hoy: /api/bot-control).
export async function resolveConversationPhone(
  conversationId?: string | null,
): Promise<string | null> {
  if (!conversationId) return null;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("kapso_conversations")
    .select("contact_phone")
    .eq("kapso_conversation_id", conversationId)
    .limit(1);

  if (error) {
    console.error("resolveConversationPhone failed", error);
    return null;
  }

  return normalizePhone(data?.[0]?.contact_phone ?? null);
}

// Pausa el bot cuando el propio paciente pide hablar con una persona (reclamos,
// temas fuera de alcance, o simplemente no querer seguir con el bot). Vence a
// los HUMAN_TAKEOVER_PAUSE_MINUTES; antes de eso el equipo puede retomarla a
// mano desde el panel / bot-control cuando ya atendió al paciente.
export async function pauseBotForHumanHandoff(conversationId: string, phone?: string | null) {
  const supabase = getSupabaseClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const minutes = getHumanTakeoverMinutes();

  const fields = {
    bot_paused: true,
    bot_paused_at: nowIso,
    bot_paused_reason: "human_handoff_requested",
    bot_pause_mode: "auto",
    bot_pause_expires_at: new Date(now + minutes * 60_000).toISOString(),
    bot_pause_duration_minutes: minutes,
  };

  const identity = normalizePhone(phone) ?? (await resolveConversationPhone(conversationId));

  if (identity) {
    const { error } = await supabase.from("bot_pause_state").upsert(
      {
        contact_phone_normalized: identity,
        contact_phone: phone ?? null,
        ...fields,
        last_kapso_conversation_id: conversationId,
        updated_at: nowIso,
      },
      { onConflict: "contact_phone_normalized" },
    );
    if (error) console.error("pauseBotForHumanHandoff durable write failed", error);
  }

  const { error } = await supabase
    .from("kapso_conversations")
    .update({ ...fields, updated_at: nowIso })
    .eq("kapso_conversation_id", conversationId);

  if (error) {
    console.error("pauseBotForHumanHandoff failed", error);
  } else {
    console.log("bot paused: human handoff requested", { conversationId, identity });
  }
}

// Pausa manual (indefinida) desde el panel / API de bot-control.
export async function setManualBotPause(params: {
  conversationId: string;
  phone?: string | null;
  reason: string;
}): Promise<void> {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const identity =
    normalizePhone(params.phone) ?? (await resolveConversationPhone(params.conversationId));
  if (!identity) return;

  const { error } = await supabase.from("bot_pause_state").upsert(
    {
      contact_phone_normalized: identity,
      contact_phone: params.phone ?? null,
      bot_paused: true,
      bot_paused_at: nowIso,
      bot_pause_expires_at: null,
      bot_paused_reason: params.reason,
      bot_pause_mode: "manual",
      bot_pause_duration_minutes: null,
      last_kapso_conversation_id: params.conversationId,
      updated_at: nowIso,
    },
    { onConflict: "contact_phone_normalized" },
  );
  if (error) console.error("setManualBotPause failed", error);
}

// Reanudación manual desde el panel / API de bot-control.
export async function clearBotPause(params: {
  conversationId: string;
  phone?: string | null;
  reason: string;
}): Promise<void> {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const identity =
    normalizePhone(params.phone) ?? (await resolveConversationPhone(params.conversationId));
  if (!identity) return;

  const { error } = await supabase.from("bot_pause_state").upsert(
    {
      contact_phone_normalized: identity,
      contact_phone: params.phone ?? null,
      bot_paused: false,
      bot_resumed_at: nowIso,
      bot_pause_expires_at: null,
      bot_paused_reason: params.reason,
      bot_pause_mode: "manual",
      bot_pause_duration_minutes: null,
      last_kapso_conversation_id: params.conversationId,
      updated_at: nowIso,
    },
    { onConflict: "contact_phone_normalized" },
  );
  if (error) console.error("clearBotPause failed", error);
}

export async function saveContactAndConversation(message: IncomingMessage) {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const { error: contactError } = await supabase
    .from("kapso_contacts")
    .upsert(
      {
        phone: message.from,
        name: message.contactName,
        updated_at: nowIso,
      },
      { onConflict: "phone" },
    );

  if (contactError) {
    console.error("supabase upsert kapso_contacts failed", contactError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_contact_upsert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: contactError.message,
      metadata: {
        code: contactError.code,
        details: contactError.details,
      },
    });
  }

  const { error: conversationError } = await supabase
    .from("kapso_conversations")
    .upsert(
      {
        kapso_conversation_id: message.conversationId,
        contact_phone: message.from,
        updated_at: nowIso,
      },
      { onConflict: "kapso_conversation_id" },
    );

  if (conversationError) {
    console.error("supabase upsert kapso_conversations failed", conversationError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_conversation_upsert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: conversationError.message,
      metadata: {
        code: conversationError.code,
        details: conversationError.details,
      },
    });
  }
}

export async function saveInboundMessage(message: IncomingMessage): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error: messageError } = await supabase
    .from("kapso_messages")
    .insert({
      kapso_message_id: message.messageId,
      kapso_conversation_id: message.conversationId,
      contact_phone: message.from,
      direction: "inbound",
      role: "user",
      content: message.text,
      message_timestamp: message.messageTimestamp,
      batch_index: message.batchIndex ?? null,
      raw_payload: message.raw,
    });

  if (messageError) {
    if (messageError.code === "23505") {
      console.log("duplicate inbound message ignored", message.messageId);
      return false;
    }

    console.error("supabase insert kapso_messages inbound failed", messageError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_inbound_insert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: messageError.message,
      metadata: {
        code: messageError.code,
        details: messageError.details,
        batch_index: message.batchIndex ?? null,
      },
    });

    return false;
  }

  return true;
}

export async function saveOutboundMessage(params: {
  conversationId?: string;
  phone: string;
  content: string;
  rawPayload?: Record<string, any> | null;
}) {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("kapso_messages").insert({
    kapso_message_id: null,
    kapso_conversation_id: params.conversationId,
    contact_phone: params.phone,
    direction: "outbound",
    role: "assistant",
    content: params.content,
    message_timestamp: new Date().toISOString(),
    batch_index: null,
    raw_payload: params.rawPayload ?? null,
  });

  if (error) {
    console.error("supabase insert kapso_messages outbound failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_outbound_insert_failed",
      conversationId: params.conversationId,
      contactPhone: params.phone,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
  }
}

export async function acquireReplyLock(params: {
  conversationId?: string;
  lastMessageId?: string;
  phone?: string;
  batchSize: number;
}): Promise<boolean> {
  if (!params.lastMessageId) return true;

  const supabase = getSupabaseClient();

  // Limpieza de lock COLGADO: si una invocación previa del MISMO mensaje se cayó
  // o hizo timeout entre adquirir el lock y responder, la fila queda 'processing'
  // para siempre y el reintento de Kapso se descartaría sin responder nunca.
  // Como el timeout máximo de la función es 30s, un lock 'processing' de más de
  // 90s es seguro considerarlo muerto y borrarlo para permitir re-procesar.
  const STALE_LOCK_MS = 90_000;
  await supabase
    .from("kapso_response_locks")
    .delete()
    .eq("last_kapso_message_id", params.lastMessageId)
    .eq("status", "processing")
    .lt("created_at", new Date(Date.now() - STALE_LOCK_MS).toISOString());

  const { error } = await supabase.from("kapso_response_locks").insert({
    kapso_conversation_id: params.conversationId,
    last_kapso_message_id: params.lastMessageId,
    batch_size: params.batchSize,
    status: "processing",
  });

  if (!error) return true;

  if (error.code === "23505") {
    console.log("reply lock already exists, skipping reply", params.lastMessageId);
    return false;
  }

  console.error("supabase insert kapso_response_locks failed", error);

  await logSystemEvent({
    level: "error",
    eventType: "reply_lock_insert_failed",
    conversationId: params.conversationId,
    messageId: params.lastMessageId,
    contactPhone: params.phone,
    errorMessage: error.message,
    metadata: {
      code: error.code,
      details: error.details,
      batch_size: params.batchSize,
    },
  });

  return false;
}

export async function markReplyLockSent(params: {
  lastMessageId?: string;
  conversationId?: string;
  phone?: string;
  responseText: string;
}) {
  if (!params.lastMessageId) return;

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("kapso_response_locks")
    .update({
      status: "sent",
      response_text: params.responseText,
      updated_at: new Date().toISOString(),
    })
    .eq("last_kapso_message_id", params.lastMessageId);

  if (error) {
    console.error("supabase update kapso_response_locks failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "reply_lock_update_failed",
      conversationId: params.conversationId,
      messageId: params.lastMessageId,
      contactPhone: params.phone,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
  }
}

// ─── Debounce de mensajes entrantes ──────────────────────────────────────────

// true si `messageId` sigue siendo el mensaje inbound MÁS reciente de la
// conversación. Se usa para debounce: si llegó otro mensaje después de esperar
// la ventana, esta invocación cede el turno a la más reciente.
//
// Orden por message_timestamp (hora real de WhatsApp) y luego created_at, porque
// created_at (inserción en BD) puede reordenarse bajo concurrencia y elegir mal
// al "más reciente".
//
// Ante error de query devolvemos true (procesar). Es deliberado: el caso común es
// UN solo mensaje, y ahí ceder por un error transitorio dejaría al paciente sin
// respuesta (peor que una eventual respuesta doble, que solo ocurre si además hay
// concurrencia — doble improbabilidad). El lock por messageId sigue evitando el
// duplicado exacto por reintento.
export async function isLatestInboundMessage(
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("kapso_message_id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("message_timestamp", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("isLatestInboundMessage failed", error);
    return true;
  }
  return !data || data.kapso_message_id === messageId;
}

// Texto consolidado de TODOS los mensajes inbound sin responder (los posteriores
// al último outbound). Agrupa lo que el cliente escribió en mensajes seguidos
// para poder responder una sola vez. Orden cronológico.
export async function getUnansweredInboundText(conversationId: string): Promise<string> {
  const supabase = getSupabaseClient();

  const { data: lastOut } = await supabase
    .from("kapso_messages")
    .select("created_at")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let query = supabase
    .from("kapso_messages")
    .select("content, created_at")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: true });

  if (lastOut?.created_at) {
    query = query.gt("created_at", lastOut.created_at);
  }

  const { data, error } = await query;
  if (error) {
    console.error("getUnansweredInboundText failed", error);
    return "";
  }

  return (data ?? [])
    .map((m) => (m.content ?? "").trim())
    .filter((t) => t.length > 0)
    .join("\n");
}

// ─── Ventana de servicio de WhatsApp (24h) ───────────────────────────────────

// Fecha del último mensaje ENTRANTE del cliente (por teléfono). null si nunca
// escribió. Se usa para saber si la ventana de servicio de 24h sigue abierta.
export async function getLastInboundMessageAt(phone: string): Promise<Date | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("message_timestamp, created_at")
    .eq("contact_phone", phone)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const ts = data.message_timestamp ?? data.created_at;
  return ts ? new Date(ts) : null;
}

// true si el cliente escribió dentro de la ventana (default 24h), es decir, si
// WhatsApp permite enviarle texto libre sin plantilla aprobada.
export async function isWithinServiceWindow(
  phone: string,
  windowMs: number = 24 * 60 * 60 * 1000,
): Promise<boolean> {
  const last = await getLastInboundMessageAt(phone);
  if (!last) return false;
  return Date.now() - last.getTime() < windowMs;
}

// Estado de pausa del bot para ESTA conversación.
//
// `phone` es la identidad durable y tiene prioridad: si existe fila en
// bot_pause_state para ese teléfono, esa es la respuesta, sin importar con qué
// conversation.id llegó el mensaje. La lectura por kapso_conversation_id queda
// solo como fallback para conversaciones que aún no tienen identidad durable.
export async function getBotPauseState(
  conversationId?: string,
  phone?: string | null,
): Promise<BotPauseState> {
  const identity = normalizePhone(phone);

  if (!conversationId && !identity) {
    return { paused: false, expired: false, source: "none" };
  }

  const supabase = getSupabaseClient();

  if (identity) {
    const { data, error } = await supabase
      .from("bot_pause_state")
      .select(
        "contact_phone_normalized, bot_paused, bot_paused_at, bot_pause_expires_at, bot_paused_reason, bot_pause_mode",
      )
      .eq("contact_phone_normalized", identity)
      .maybeSingle();

    if (error) {
      console.error("supabase select durable bot pause state failed", error);
      await logSystemEvent({
        level: "error",
        eventType: "bot_pause_state_durable_select_failed",
        conversationId,
        errorMessage: error.message,
        metadata: { code: error.code, details: error.details },
      });
      // Cae al fallback legacy en vez de asumir "no pausado".
    } else if (data) {
      return resolveBotPauseState({ durable: data as DurablePauseRow });
    }
  }

  if (!conversationId) {
    return { paused: false, expired: false, source: "none" };
  }

  const { data, error } = await supabase
    .from("kapso_conversations")
    .select("bot_paused, bot_pause_expires_at, bot_paused_reason, bot_pause_mode")
    .eq("kapso_conversation_id", conversationId)
    .maybeSingle();

  if (error) {
    console.error("supabase select bot pause state failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "bot_pause_state_select_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return { paused: false, expired: false, source: "none" };
  }

  return resolveBotPauseState({ legacy: (data as LegacyPauseRow | null) ?? null });
}

// Reanuda una pausa TEMPORAL ya vencida. Limpia la identidad durable y la fila
// de conversación; nunca toca una pausa sin vencimiento (manual/indefinida),
// porque el filtro exige bot_pause_expires_at not null.
export async function resumeBotIfPauseExpired(conversationId?: string, phone?: string | null) {
  const identity = normalizePhone(phone);
  if (!conversationId && !identity) return;

  const supabase = getSupabaseClient();

  const nowIso = new Date().toISOString();

  if (identity) {
    const { error: durableError } = await supabase
      .from("bot_pause_state")
      .update({
        bot_paused: false,
        bot_resumed_at: nowIso,
        bot_pause_expires_at: null,
        bot_paused_reason: "auto_resume_expired",
        updated_at: nowIso,
      })
      .eq("contact_phone_normalized", identity)
      .eq("bot_paused", true)
      .not("bot_pause_expires_at", "is", null)
      .lte("bot_pause_expires_at", nowIso);
    if (durableError) console.error("supabase durable auto resume failed", durableError);
  }

  if (!conversationId) return;

  const { error } = await supabase
    .from("kapso_conversations")
    .update({
      bot_paused: false,
      bot_resumed_at: nowIso,
      bot_pause_expires_at: null,
      bot_paused_reason: "auto_resume_expired",
      updated_at: nowIso,
    })
    .eq("kapso_conversation_id", conversationId)
    .eq("bot_paused", true)
    .not("bot_pause_expires_at", "is", null)
    .lte("bot_pause_expires_at", nowIso);

  if (error) {
    console.error("supabase auto resume bot failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "bot_auto_resume_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
    return;
  }

  await supabase.from("bot_control_events").insert({
    kapso_conversation_id: conversationId,
    action: "resume",
    actor_source: "system",
    reason: "auto_resume_expired",
    expires_at: null,
    metadata: {},
  });
}

export async function getRecentConversationHistory(
  conversationId?: string,
  limit = 12,
): Promise<HistoryMessage[]> {
  if (!conversationId) return [];

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("role, content, message_timestamp, batch_index, created_at")
    .eq("kapso_conversation_id", conversationId)
    .order("message_timestamp", { ascending: false, nullsFirst: false })
    .order("batch_index", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("supabase select recent history failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_history_select_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return [];
  }

  return (data ?? [])
    .reverse()
    .map((row): HistoryMessage => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: String(row.content ?? ""),
    }))
    .filter((message) => message.content.trim().length > 0)
    // Los marcadores internos ([MEDIA_SENT:combo_nina], [PRODUCT_CONTEXT:panales] ...)
    // se guardan en kapso_messages para el historial/sidebar, pero NO deben
    // enviarse a OpenAI como si fueran mensajes reales de la conversación.
    .filter((message) => !/^\[(MEDIA_SENT|PRODUCT_CONTEXT)[:\]]/.test(message.content.trim()));
}

// Lee los marcadores internos [MEDIA_SENT:...] de la conversación y devuelve qué
// grupos de imágenes ya fueron enviados para el producto que rastrea el negocio
// (business.mediaStateProduct). Se consultan aparte porque se filtran del
// historial conversacional.
export async function getMediaSentState(params: {
  conversationId?: string;
  mediaStateProduct: ProductKey;
  groups: GroupKey[];
}): Promise<MediaSentState> {
  const state: MediaSentState = {};
  for (const group of params.groups) state[group] = false;

  if (!params.conversationId) return state;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content")
    .eq("kapso_conversation_id", params.conversationId)
    .ilike("content", "[MEDIA_SENT:%");

  if (error) {
    console.error("supabase select media sent state failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_state_select_failed",
      conversationId: params.conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    // Degradación segura: si no podemos leer el estado, asumimos no enviado.
    return state;
  }

  for (const row of data ?? []) {
    const content = String(row.content ?? "");
    for (const group of params.groups) {
      if (content.startsWith(`[MEDIA_SENT:${params.mediaStateProduct}_${group}]`)) {
        state[group] = true;
      }
    }
  }

  return state;
}

export async function hasMediaAlreadySent(
  conversationId: string | undefined,
  intent: MediaIntent,
): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .ilike("content", `[MEDIA_SENT:${intent}]%`)
    .limit(1);

  if (error) {
    console.error("supabase check media already sent failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_check_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
        intent,
      },
    });

    return false;
  }

  return (data ?? []).length > 0;
}

export async function getActiveMediaAssets(
  businessSlug: string,
  intent: MediaIntent,
): Promise<MediaAsset[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_media_assets")
    .select("title, url")
    .eq("business", businessSlug)
    .eq("intent", intent)
    .eq("media_type", "image")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("supabase select kapso_media_assets failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_assets_select_failed",
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
        intent,
      },
    });

    return [];
  }

  return (data ?? [])
    .map((asset): MediaAsset => ({
      title: String(asset.title ?? "Imagen enviada"),
      url: String(asset.url ?? ""),
    }))
    .filter((asset) => asset.url.trim().length > 0);
}

// Sticky de producto: lee el marcador interno [PRODUCT_CONTEXT:...] más reciente
// de la conversación. Mismo mecanismo que [MEDIA_SENT:...], sin tocar el esquema.
export async function getStickyProduct(params: {
  conversationId?: string;
  productKeys: ProductKey[];
}): Promise<ProductKey | null> {
  if (!params.conversationId) return null;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content")
    .eq("kapso_conversation_id", params.conversationId)
    .ilike("content", "[PRODUCT_CONTEXT:%")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("supabase select sticky product failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_sticky_product_select_failed",
      conversationId: params.conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return null;
  }

  const content = String(data?.[0]?.content ?? "");

  for (const product of params.productKeys) {
    if (content.startsWith(`[PRODUCT_CONTEXT:${product}]`)) return product;
  }

  return null;
}
