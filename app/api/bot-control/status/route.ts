import { createClient } from "@supabase/supabase-js";

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
      .select("bot_paused, bot_pause_expires_at, bot_paused_reason")
      .eq("kapso_conversation_id", conversationId)
      .maybeSingle();

    if (error) {
      return Response.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    if (!data) {
      return Response.json({
        ok: true,
        conversation_id: conversationId,
        bot_paused: false,
        bot_enabled: true,
        enabled: true,
        is_active: true,
        agent_active: true,
        exists: false,
      });
    }

    const expiresAt = data.bot_pause_expires_at;
    const expired = expiresAt
      ? new Date(expiresAt).getTime() <= Date.now()
      : false;

    const isPaused = Boolean(data.bot_paused) && !expired;
    const isAgentEnabled = !isPaused;

    return Response.json({
      ok: true,
      exists: true,
      conversation_id: conversationId,
      bot_paused: isPaused,
      bot_enabled: isAgentEnabled,
      enabled: isAgentEnabled,
      is_active: isAgentEnabled,
      agent_active: isAgentEnabled,
      expired,
      expires_at: expiresAt,
      reason: data.bot_paused_reason,
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