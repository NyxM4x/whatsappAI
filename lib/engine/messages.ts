// ============================================================================
// Normalización genérica de eventos Kapso (WhatsApp Cloud API).
// ----------------------------------------------------------------------------
// Reutilizable por cualquier webhook (clínica, Reino del Bebé, etc.).
// No contiene lógica de negocio: solo extrae y tipifica los campos del evento.
// ============================================================================

import { autoPauseBotFromBusinessApp } from "@/lib/engine/data";

// Transcribe un audio usando OpenAI Whisper. Descarga el archivo desde la URL
// (con la API key de Kapso si es necesario) y lo envía a la API de Whisper.
async function transcribeAudio(audioUrl: string): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const audioRes = await fetch(audioUrl, {
      headers: process.env.KAPSO_API_KEY
        ? { "X-API-Key": process.env.KAPSO_API_KEY }
        : {},
    });
    if (!audioRes.ok) return null;

    const buffer = await audioRes.arrayBuffer();
    const blob = new Blob([buffer], { type: "audio/ogg" });

    const form = new FormData();
    form.append("file", blob, "audio.ogg");
    form.append("model", "whisper-1");
    form.append("language", "es");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!res.ok) return null;
    const json = await res.json() as { text?: string };
    return typeof json.text === "string" && json.text.trim() ? json.text.trim() : null;
  } catch {
    return null;
  }
}

export type MediaType = "image" | "document" | "audio" | null;

export type IncomingMessage = {
  from: string;
  text: string;
  messageId?: string;
  conversationId?: string;
  contactName?: string | null;
  messageTimestamp?: string | null;
  batchIndex?: number | null;
  audioWithoutTranscript?: boolean;
  mediaUrl?: string | null;
  mediaType?: MediaType;
  raw: Record<string, any>;
};

// ─── Helpers internos ─────────────────────────────────────────────────────────

function parseKapsoTimestamp(timestamp?: string | number | null): string | null {
  if (!timestamp) return null;
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

function extractMessageText(
  message?: Record<string, any> | null,
  conversation?: Record<string, any> | null,
): string {
  const textBody = message?.text?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const transcriptText = message?.kapso?.transcript?.text;
  if (typeof transcriptText === "string" && transcriptText.trim()) return transcriptText.trim();

  const buttonText = message?.button?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const interactiveTitle =
    message?.interactive?.button_reply?.title ?? message?.interactive?.list_reply?.title;
  if (typeof interactiveTitle === "string" && interactiveTitle.trim()) {
    return interactiveTitle.trim();
  }

  const kapsoContent = message?.kapso?.content;
  if (typeof kapsoContent === "string" && kapsoContent.trim()) {
    const match = kapsoContent.match(/Transcript:\s*([\s\S]*)$/i);
    if (match?.[1]?.trim()) return `🎙️ Audio recibido\n\nTranscripción: ${match[1].trim()}`;
    return "🎙️ Audio recibido";
  }

  const lastMessageText = conversation?.kapso?.last_message_text;
  if (typeof lastMessageText === "string" && lastMessageText.trim()) {
    const match = lastMessageText.match(/Transcript:\s*([\s\S]*)$/i);
    if (match?.[1]?.trim()) return `🎙️ Audio recibido\n\nTranscripción: ${match[1].trim()}`;
    return "🎙️ Audio recibido";
  }

  return "";
}

function audioTranscriptText(
  message?: Record<string, any> | null,
  conversation?: Record<string, any> | null,
): string | null {
  const direct = message?.kapso?.transcript?.text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const content = message?.kapso?.content;
  if (typeof content === "string") {
    const match = content.match(/Transcript:\s*([\s\S]*)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  const lastMessageText = conversation?.kapso?.last_message_text;
  if (typeof lastMessageText === "string") {
    const match = lastMessageText.match(/Transcript:\s*([\s\S]*)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  return null;
}

// Extrae la URL de media de un mensaje (imagen, documento o audio).
function extractMediaUrl(
  message?: Record<string, any> | null,
): { url: string | null; type: MediaType } {
  // Imagen
  const imageUrl =
    message?.image?.link ??
    message?.image?.url ??
    (message?.type === "image" ? (message?.kapso?.media_url ?? message?.kapso?.media_data?.url ?? null) : null);
  if (typeof imageUrl === "string" && imageUrl.trim()) {
    return { url: imageUrl.trim(), type: "image" };
  }

  // Documento (PDF, etc.)
  const docUrl =
    message?.document?.link ??
    message?.document?.url ??
    (message?.type === "document" ? (message?.kapso?.media_url ?? message?.kapso?.media_data?.url ?? null) : null);
  if (typeof docUrl === "string" && docUrl.trim()) {
    return { url: docUrl.trim(), type: "document" };
  }

  // Audio
  const audioUrl =
    message?.audio?.link ??
    message?.audio?.url ??
    message?.kapso?.media_url ??
    message?.kapso?.media_data?.url ??
    null;
  if (typeof audioUrl === "string" && audioUrl.trim()) {
    return { url: audioUrl.trim(), type: "audio" };
  }

  return { url: null, type: null };
}

function getWebhookEvents(payload: Record<string, any>, request: Request): Record<string, any>[] {
  const isBatch =
    payload.batch === true || request.headers.get("x-webhook-batch") === "true";
  if (isBatch && Array.isArray(payload.data)) return payload.data;
  return [payload];
}

async function extractIncomingFromEvent(
  event: Record<string, any>,
): Promise<IncomingMessage | null> {
  const kapsoDirection = event.message?.kapso?.direction;

  if (kapsoDirection && kapsoDirection !== "inbound") {
    const origin = event.message?.kapso?.origin ?? null;
    const conversationId = event.conversation?.id ?? null;

    if (origin === "business_app" && conversationId) {
      await autoPauseBotFromBusinessApp(conversationId);
    }
    return null;
  }

  // Reacciones: no generan respuesta.
  const messageType = event.message?.type;
  if (messageType === "reaction" || event.message?.reaction) return null;

  const from = event.message?.from ?? "";
  const text = extractMessageText(event.message, event.conversation);
  const messageId = event.message?.id;
  const conversationId = event.conversation?.id ?? from;
  const contactName = event.conversation?.contact_name ?? null;
  const messageTimestamp = parseKapsoTimestamp(event.message?.timestamp);

  // Audio sin texto → intentar transcripción con Whisper.
  const isAudio = messageType === "audio" || Boolean(event.message?.audio);
  let audioWithoutTranscript = isAudio && !audioTranscriptText(event.message, event.conversation);

  // Media adjunta (imagen/documento/audio).
  const { url: mediaUrl, type: mediaType } = extractMediaUrl(event.message);

  // Transcripción con Whisper si el audio no trae texto de Kapso.
  let finalText = text;
  if (audioWithoutTranscript && mediaUrl) {
    const transcript = await transcribeAudio(mediaUrl);
    if (transcript) {
      finalText = `🎙️ _Audio:_ ${transcript}`;
      audioWithoutTranscript = false;
    }
  }

  // Eventos sin remitente ni texto (y sin media) no son mensajes procesables.
  if (!from || (!finalText && !mediaUrl)) return null;

  return {
    from,
    text: finalText || "",
    messageId,
    conversationId,
    contactName,
    messageTimestamp,
    audioWithoutTranscript,
    mediaUrl: mediaUrl ?? null,
    mediaType,
    raw: event,
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function normalizeIncomingMessages(
  payload: Record<string, any>,
  request: Request,
): Promise<IncomingMessage[]> {
  const events = getWebhookEvents(payload, request);
  const result: IncomingMessage[] = [];

  for (const [index, event] of events.entries()) {
    const incoming = await extractIncomingFromEvent(event);
    if (!incoming) continue;
    result.push({ ...incoming, batchIndex: index });
  }

  return result;
}
