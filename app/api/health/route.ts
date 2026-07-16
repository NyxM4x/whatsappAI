import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function envExists(name: string): boolean {
  return Boolean(process.env[name]);
}

function checkEnv() {
  const required = [
    "KAPSO_API_KEY",
    "KAPSO_PHONE_NUMBER_ID",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_API_KEY",
  ];

  const missing = required.filter((name) => !envExists(name));

  return {
    ok: missing.length === 0,
    missing,
  };
}

async function checkSupabase() {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return {
        ok: false,
        error: "Supabase env vars missing",
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error } = await supabase
      .from("system_logs")
      .select("id", { head: true, count: "exact" });

    if (error) {
      return {
        ok: false,
        error: "query failed",
      };
    }

    return {
      ok: true,
      error: null,
    };
  } catch {
    return {
      ok: false,
      error: "connection failed",
    };
  }
}

// Timestamp del último mensaje inbound recibido (cualquier conversación) — una
// caída silenciosa del webhook (ej. Kapso deja de llamarlo) se nota si esto
// deja de avanzar.
async function checkLastWebhook() {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return { ok: false, lastReceivedAt: null };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase
      .from("kapso_messages")
      .select("created_at")
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return { ok: false, lastReceivedAt: null };

    return { ok: true, lastReceivedAt: data?.created_at ?? null };
  } catch {
    return { ok: false, lastReceivedAt: null };
  }
}

// Chequeo liviano de config (NO llama a la API de Google): valida que el JSON
// de la service account parsea y trae los campos mínimos. Una llamada real a
// Calendar en cada health check agregaría latencia/cuota innecesarias.
function checkGoogleCalendarConfig() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return { ok: false, error: "GOOGLE_SERVICE_ACCOUNT_JSON missing" };

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) {
      return { ok: false, error: "missing client_email/private_key" };
    }
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

export async function GET() {
  const env = checkEnv();
  const [supabase, lastWebhook] = await Promise.all([checkSupabase(), checkLastWebhook()]);
  const googleCalendar = checkGoogleCalendarConfig();

  const status = env.ok && supabase.ok ? "ok" : "error";

  const body = {
    status,
    service: "reino-del-bebe-kapso-vercel",
    timestamp: new Date().toISOString(),
    deployment: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? null,
      environment: process.env.VERCEL_ENV ?? null,
    },
    checks: {
      env: {
        ok: env.ok,
        missing: env.missing,
      },
      supabase,
      kapso: {
        ok: envExists("KAPSO_API_KEY") && envExists("KAPSO_PHONE_NUMBER_ID"),
        apiKeyConfigured: envExists("KAPSO_API_KEY"),
        phoneNumberIdConfigured: envExists("KAPSO_PHONE_NUMBER_ID"),
      },
      openai: {
        ok: envExists("OPENAI_API_KEY"),
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      },
      googleCalendar,
      lastWebhook,
    },
  };

  return Response.json(body, {
    status: status === "ok" ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
