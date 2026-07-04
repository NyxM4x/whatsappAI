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
import { logSystemEvent } from "@/lib/engine/logging";
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
};

// Auto-pausa el bot cuando un humano responde desde la app de WhatsApp Business
// (origin=business_app). Llamado desde la normalización del evento saliente.
export async function autoPauseBotFromBusinessApp(conversationId: string) {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from("kapso_conversations")
    .update({
      bot_paused: true,
      bot_paused_at: nowIso,
      bot_pause_expires_at: null,
      bot_paused_reason: "human_whatsapp_business_app",
      bot_pause_mode: "auto",
      bot_pause_duration_minutes: null,
      updated_at: nowIso,
    })
    .eq("kapso_conversation_id", conversationId);

  if (error) {
    console.error("auto pause from business_app failed", error);
  } else {
    console.log("bot auto-paused from business_app", { conversationId });
  }
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
// la ventana, esta invocación cede el turno a la más reciente. Ante error,
// devuelve true (procesar) para no perder la respuesta.
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

export async function getBotPauseState(conversationId?: string): Promise<BotPauseState> {
  if (!conversationId) {
    return { paused: false, expired: false };
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_conversations")
    .select("bot_paused, bot_pause_expires_at, bot_paused_reason")
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

    return { paused: false, expired: false };
  }

  if (!data?.bot_paused) {
    return { paused: false, expired: false };
  }

  const expiresAt = data.bot_pause_expires_at
    ? new Date(data.bot_pause_expires_at).getTime()
    : null;

  const expired = expiresAt ? expiresAt <= Date.now() : false;

  return {
    paused: true,
    expired,
    reason: data.bot_paused_reason,
    expiresAt: data.bot_pause_expires_at,
  };
}

export async function resumeBotIfPauseExpired(conversationId?: string) {
  if (!conversationId) return;

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("kapso_conversations")
    .update({
      bot_paused: false,
      bot_resumed_at: new Date().toISOString(),
      bot_pause_expires_at: null,
      bot_paused_reason: "auto_resume_expired",
      updated_at: new Date().toISOString(),
    })
    .eq("kapso_conversation_id", conversationId);

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
  }
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
