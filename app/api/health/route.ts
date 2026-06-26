import { createClient } from "@supabase/supabase-js";

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
        error: error.message,
      };
    }

    return {
      ok: true,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET() {
  const env = checkEnv();
  const supabase = await checkSupabase();

  const status =
    env.ok && supabase.ok
      ? "ok"
      : "error";

  const body = {
    status,
    service: "reino-del-bebe-kapso-vercel",
    timestamp: new Date().toISOString(),
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
    },
  };

  return Response.json(body, {
    status: status === "ok" ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}