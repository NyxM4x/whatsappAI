import { createClient } from "@supabase/supabase-js";

import { setManualBotPause } from "@/lib/engine/data";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function getSupabaseClient() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export async function POST(request: Request) {
  try {
    const secret = process.env.BOT_CONTROL_SECRET;
    const requestSecret = request.headers.get("X-Bot-Control-Secret");

    if (!secret || requestSecret !== secret) {
      return Response.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await request.json();

    const conversationId = body.conversation_id;
    const phone = body.phone;

    const reason = body.reason ?? "manual_pause";
    const actorSource = body.actor_source ?? "api";

    if (!conversationId) {
      return Response.json(
        { ok: false, error: "conversation_id is required" },
        { status: 400 },
      );
    }

    const supabase = getSupabaseClient();

    const nowIso = new Date().toISOString();

    const expiresAt = null;

    const { error } = await supabase
      .from("kapso_conversations")
      .update({
        bot_paused: true,
        bot_paused_at: nowIso,
        bot_pause_expires_at: expiresAt,
        bot_paused_reason: reason,
        bot_pause_mode: "manual",
        bot_pause_duration_minutes: null,
        updated_at: nowIso,
      })
      .eq("kapso_conversation_id", conversationId);

    if (error) {
      return Response.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    // Identidad durable: la pausa manual también se escribe por teléfono, que es
    // lo que lee el webhook. Sin esto el panel pausaba una fila que el bot ya no
    // consulta cuando cambia el conversation.id.
    await setManualBotPause({ conversationId, phone, reason });

    await supabase.from("bot_control_events").insert({
      kapso_conversation_id: conversationId,
      contact_phone_masked: maskPhone(phone),
      action: "pause",
      actor_source: actorSource,
      actor_email: body.actor_email ?? null,
      reason,
      expires_at: expiresAt,
      metadata: body.metadata ?? {},
    });

    return Response.json({
      ok: true,
      action: "pause",
      conversation_id: conversationId,
      expires_at: expiresAt,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
