import { createClient } from "@supabase/supabase-js";

import { getBotPauseState } from "@/lib/engine/data";

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

export async function GET(request: Request) {
  try {
    const secret = process.env.BOT_CONTROL_SECRET;
    const requestSecret = request.headers.get("X-Bot-Control-Secret");

    if (!secret || requestSecret !== secret) {
      return Response.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversation_id");

    if (!conversationId) {
      return Response.json(
        { ok: false, error: "conversation_id is required" },
        { status: 400 },
      );
    }

    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("kapso_conversations")
      .select("contact_phone")
      .eq("kapso_conversation_id", conversationId)
      .limit(1);

    if (error) {
      return Response.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    const contactPhone = data?.[0]?.contact_phone ?? searchParams.get("phone");

    // Misma resolución canónica que usa el webhook: identidad durable primero
    // (teléfono), fila de conversación solo como fallback.
    const state = await getBotPauseState(conversationId, contactPhone);

    const isPaused = state.paused && !state.expired;
    const isAgentEnabled = !isPaused;

    return Response.json({
      ok: true,
      exists: (data?.length ?? 0) > 0 || state.source === "durable",
      conversation_id: conversationId,
      bot_paused: isPaused,
      bot_enabled: isAgentEnabled,
      enabled: isAgentEnabled,
      is_active: isAgentEnabled,
      agent_active: isAgentEnabled,
      expired: state.expired,
      expires_at: state.expiresAt ?? null,
      reason: state.reason ?? null,
      identity_source: state.source,
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