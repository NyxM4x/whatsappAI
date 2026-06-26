import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { createClient } from "@supabase/supabase-js";

// Endpoint cron de follow-up automático. Invocado por un scheduler externo
// (cron-job.org / GitHub Actions) cada 15-30 min. NO toca el webhook de Kapso,
// el prompt, la lógica de respuestas, bot_paused, ni llama a OpenAI.
//
// Arranca en dry-run (FOLLOWUP_DRY_RUN distinto de 'false'): detecta candidatos y
// los registra en system_logs SIN insertar en kapso_followups y SIN enviar nada,
// de modo que el dry-run nunca "quema" el slot UNIQUE de una conversación.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FOLLOWUP_MESSAGE = `Hola mamita 😊

📍 Te esperamos en nuestras tiendas:

✨ Feria Barrio Lindo:
Acronal Bloque "A", Asoc. 13 de Julio, Pasillo #3 "Los Ciruelos", Tiendas #77-78

💕 Cooperativa 19 de Noviembre:
Pasillo M, Tiendas 340-341

📍 Ubicación GPS:
https://maps.app.goo.gl/yDwaALE2k8Rey9yJ7

🛍️ También puedes ver nuestro catálogo completo aquí:
https://reinodelbebe.net/reino-del-bebe-v5.html

✨ Tenemos descuentos imperdibles y hermosos productos para tu bebé.

💕 Cualquier consulta, estaremos encantados de ayudarte.`;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const WINDOW_24H_MS = 24 * MS_PER_HOUR;
const MAX_SEND_ATTEMPTS = 3;
// Bolivia (America/La_Paz) es UTC-4 todo el año (sin horario de verano).
const LA_PAZ_OFFSET_MS = 4 * MS_PER_HOUR;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function getSupabaseClient() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

function getKapsoClient() {
  return new WhatsAppClient({
    baseUrl: "https://api.kapso.ai/meta/whatsapp",
    kapsoApiKey: getRequiredEnv("KAPSO_API_KEY"),
  });
}

function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Rechazo claro de la clienta: "no", "no gracias", "ya compré" (y variantes con
// typos/acentos). Tolerante a mayúsculas y diacríticos.
function isRejection(text?: string | null): boolean {
  if (!text) return false;
  const normalized = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;
  if (normalized === "no") return true;
  if (normalized.includes("no gracias")) return true;
  // "ya compre", "ya lo compre", "ya las compre", etc.
  if (/\bya\s+(lo\s+|la\s+|los\s+|las\s+)?compre\b/.test(normalized)) return true;

  return false;
}

type SupabaseClient = ReturnType<typeof getSupabaseClient>;

async function logEvent(
  supabase: SupabaseClient,
  params: {
    level?: "info" | "warning" | "error" | "critical";
    eventType: string;
    conversationId?: string | null;
    contactPhone?: string | null;
    errorMessage?: string | null;
    metadata?: Record<string, any>;
  },
) {
  try {
    await supabase.from("system_logs").insert({
      level: params.level ?? "info",
      event_type: params.eventType,
      source: "kapso-vercel",
      business: "reino-del-bebe",
      kapso_conversation_id: params.conversationId ?? null,
      contact_phone_masked: maskPhone(params.contactPhone),
      error_message: params.errorMessage ?? null,
      metadata: params.metadata ?? {},
    });
  } catch (error) {
    console.error("followups logEvent failed", error);
  }
}

// Inicio del día calendario en hora de Bolivia, expresado en UTC ISO.
// Medianoche La Paz (UTC-4) = ese día a las 04:00 UTC.
function startOfLaPazDayIso(): string {
  const laPaz = new Date(Date.now() - LA_PAZ_OFFSET_MS);
  return new Date(
    Date.UTC(laPaz.getUTCFullYear(), laPaz.getUTCMonth(), laPaz.getUTCDate(), 4, 0, 0),
  ).toISOString();
}

type FollowupConfig = {
  dryRun: boolean;
  sendLimit: number;
  dailyLimit: number;
  testConversationId: string | null;
  delayOverride: { minMinutes: number; maxMinutes: number } | null;
};

function readConfig(): FollowupConfig {
  const delayMin = Number(process.env.FOLLOWUP_DELAY_MINUTES_MIN);
  const delayMax = Number(process.env.FOLLOWUP_DELAY_MINUTES_MAX);
  const delayOverride =
    Number.isFinite(delayMin) &&
    Number.isFinite(delayMax) &&
    delayMin > 0 &&
    delayMax >= delayMin
      ? { minMinutes: delayMin, maxMinutes: delayMax }
      : null;

  const testConversationId = process.env.FOLLOWUP_TEST_CONVERSATION_ID || null;

  return {
    // Dry-run por defecto: solo se desactiva con el literal 'false'.
    dryRun: (process.env.FOLLOWUP_DRY_RUN ?? "true") !== "false",
    sendLimit: Math.max(1, intEnv("FOLLOWUP_SEND_LIMIT", 5)),
    dailyLimit: Math.max(0, intEnv("FOLLOWUP_DAILY_LIMIT", 30)),
    testConversationId,
    delayOverride,
  };
}

// scheduled_at = último inbound + delay aleatorio. Normalmente 6-8h; con override
// de prueba, un rango en minutos (p.ej. 10-12) para validar end-to-end sin esperar.
function computeScheduledAt(triggerInboundAtIso: string, config: FollowupConfig): string {
  const base = new Date(triggerInboundAtIso).getTime();
  let offsetMs: number;
  if (config.delayOverride) {
    const { minMinutes, maxMinutes } = config.delayOverride;
    offsetMs = (minMinutes + Math.random() * (maxMinutes - minMinutes)) * MS_PER_MINUTE;
  } else {
    offsetMs = (6 + Math.random() * 2) * MS_PER_HOUR;
  }
  return new Date(base + offsetMs).toISOString();
}

type Candidate = {
  kapso_conversation_id: string;
  last_inbound_at: string;
  last_inbound_content: string | null;
  contact_phone: string;
};

type LastInbound = { at: string; content: string | null };

async function getLastInbound(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<LastInbound | null> {
  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content, message_timestamp, created_at")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("message_timestamp", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;

  const row = data[0];
  const at = row.message_timestamp ?? row.created_at;
  if (!at) return null;
  return { at, content: row.content ?? null };
}

async function saveFollowupOutbound(
  supabase: SupabaseClient,
  conversationId: string,
  phone: string,
) {
  await supabase.from("kapso_messages").insert({
    kapso_message_id: null,
    kapso_conversation_id: conversationId,
    contact_phone: phone,
    direction: "outbound",
    role: "assistant",
    content: FOLLOWUP_MESSAGE,
    message_timestamp: new Date().toISOString(),
    batch_index: null,
    raw_payload: { type: "followup", source: "cron_followups" },
  });
}

async function updateFollowup(
  supabase: SupabaseClient,
  id: string,
  patch: Record<string, any>,
) {
  await supabase
    .from("kapso_followups")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}

export async function GET(request: Request) {
  const supabase = getSupabaseClient();

  // --- Auth: Bearer ${FOLLOWUP_CRON_SECRET} (o header X-Cron-Secret) ---
  const secret = process.env.FOLLOWUP_CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const provided = bearer ?? request.headers.get("x-cron-secret");

  if (!secret || provided !== secret) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const config = readConfig();

  const summary = {
    ok: true,
    dry_run: config.dryRun,
    candidates: 0,
    enqueued: 0,
    sent: 0,
    skipped: 0,
    canceled: 0,
    failed: 0,
    sent_today: 0,
  };

  try {
    // ===================== Pasada 1: detección / enqueue =====================
    const minSilenceMinutes = config.delayOverride ? 1 : 300; // test: ~inmediato; normal: 5h
    const { data: candidates, error: candError } = await supabase.rpc(
      "get_followup_candidates",
      {
        p_min_silence_minutes: minSilenceMinutes,
        p_max_silence_minutes: 1440,
        p_test_conversation_id: config.testConversationId,
      },
    );

    if (candError) {
      await logEvent(supabase, {
        level: "error",
        eventType: "followup_candidates_query_failed",
        errorMessage: candError.message,
      });
      return Response.json({ ok: false, error: candError.message }, { status: 500 });
    }

    const candidateList = (candidates ?? []) as Candidate[];
    summary.candidates = candidateList.length;

    for (const candidate of candidateList) {
      const rejected = isRejection(candidate.last_inbound_content);
      const scheduledAt = computeScheduledAt(candidate.last_inbound_at, config);
      const hoursSilence = Math.round(
        ((Date.now() - new Date(candidate.last_inbound_at).getTime()) / MS_PER_HOUR) * 100,
      ) / 100;
      const snippet = String(candidate.last_inbound_content ?? "").slice(0, 80);

      if (config.dryRun) {
        // Dry-run: SOLO loguear el candidato. No se inserta nada (no quema el slot UNIQUE).
        await logEvent(supabase, {
          eventType: "followup_candidate",
          conversationId: candidate.kapso_conversation_id,
          contactPhone: candidate.contact_phone,
          metadata: {
            scheduled_at: scheduledAt,
            last_inbound_at: candidate.last_inbound_at,
            hours_silence: hoursSilence,
            last_inbound_snippet: snippet,
            would_skip_reason: rejected ? "rejection" : null,
            dry_run: true,
          },
        });
        continue;
      }

      // Modo real: no agendar si el último inbound es un rechazo claro.
      if (rejected) {
        await logEvent(supabase, {
          eventType: "followup_enqueue_skipped_rejection",
          conversationId: candidate.kapso_conversation_id,
          contactPhone: candidate.contact_phone,
          metadata: { last_inbound_snippet: snippet },
        });
        continue;
      }

      const { error: insertError } = await supabase.from("kapso_followups").insert({
        kapso_conversation_id: candidate.kapso_conversation_id,
        contact_phone: candidate.contact_phone,
        trigger_inbound_at: candidate.last_inbound_at,
        scheduled_at: scheduledAt,
        status: "pending",
      });

      if (insertError) {
        // 23505 = ya existe una fila para esa conversación (máx 1). Se ignora.
        if (insertError.code === "23505") continue;
        await logEvent(supabase, {
          level: "error",
          eventType: "followup_enqueue_failed",
          conversationId: candidate.kapso_conversation_id,
          contactPhone: candidate.contact_phone,
          errorMessage: insertError.message,
          metadata: { code: insertError.code },
        });
        continue;
      }

      summary.enqueued += 1;
    }

    // ===================== Pasada 2: envío (solo modo real) =====================
    if (!config.dryRun) {
      // Límite diario (día calendario, hora de Bolivia).
      const { count: sentTodayCount } = await supabase
        .from("kapso_followups")
        .select("*", { count: "exact", head: true })
        .eq("status", "sent")
        .gte("sent_at", startOfLaPazDayIso());

      const sentToday = sentTodayCount ?? 0;
      summary.sent_today = sentToday;
      const remainingToday = config.dailyLimit - sentToday;

      let dueQuery = supabase
        .from("kapso_followups")
        .select("*")
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(config.sendLimit * 4); // holgura para skips/cancels

      if (config.testConversationId) {
        dueQuery = dueQuery.eq("kapso_conversation_id", config.testConversationId);
      }

      const { data: dueRows, error: dueError } = await dueQuery;

      if (dueError) {
        await logEvent(supabase, {
          level: "error",
          eventType: "followup_due_query_failed",
          errorMessage: dueError.message,
        });
        return Response.json({ ok: false, error: dueError.message }, { status: 500 });
      }

      const kapso = getKapsoClient();
      const phoneNumberId = getRequiredEnv("KAPSO_PHONE_NUMBER_ID");
      let sentCount = 0;

      for (const row of dueRows ?? []) {
        const triggerAt = new Date(row.trigger_inbound_at).getTime();
        const current = await getLastInbound(supabase, row.kapso_conversation_id);

        // Reenganche: la clienta volvió a escribir después de agendar → cancelar.
        if (current && new Date(current.at).getTime() > triggerAt) {
          await updateFollowup(supabase, row.id, {
            status: "canceled",
            skip_reason: "reengaged",
          });
          summary.canceled += 1;
          continue;
        }

        // Fuera de la ventana de 24h → no se puede enviar mensaje libre.
        if (current && Date.now() - new Date(current.at).getTime() > WINDOW_24H_MS) {
          await updateFollowup(supabase, row.id, {
            status: "skipped",
            skip_reason: "outside_24h",
          });
          summary.skipped += 1;
          continue;
        }

        // Rechazo en el inbound más reciente → no enviar.
        if (isRejection(current?.content)) {
          await updateFollowup(supabase, row.id, {
            status: "skipped",
            skip_reason: "rejection",
          });
          summary.skipped += 1;
          continue;
        }

        // Límite por corrida y límite diario: dejar pending y cortar.
        if (sentCount >= config.sendLimit || sentCount >= remainingToday) {
          break;
        }

        try {
          await kapso.messages.sendText({
            phoneNumberId,
            to: row.contact_phone,
            body: FOLLOWUP_MESSAGE,
          });

          await saveFollowupOutbound(supabase, row.kapso_conversation_id, row.contact_phone);

          await updateFollowup(supabase, row.id, {
            status: "sent",
            sent_at: new Date().toISOString(),
          });

          sentCount += 1;
          summary.sent += 1;

          await logEvent(supabase, {
            eventType: "followup_sent",
            conversationId: row.kapso_conversation_id,
            contactPhone: row.contact_phone,
            metadata: { followup_id: row.id, scheduled_at: row.scheduled_at },
          });
        } catch (error) {
          const attempts = (row.attempts ?? 0) + 1;

          if (attempts < MAX_SEND_ATTEMPTS) {
            // Fallo transitorio: reintentar en la próxima corrida.
            await updateFollowup(supabase, row.id, { attempts });
          } else {
            await updateFollowup(supabase, row.id, {
              status: "failed",
              attempts,
              error_message: getErrorMessage(error),
            });
            summary.failed += 1;
          }

          await logEvent(supabase, {
            level: "error",
            eventType: "followup_send_failed",
            conversationId: row.kapso_conversation_id,
            contactPhone: row.contact_phone,
            errorMessage: getErrorMessage(error),
            metadata: { followup_id: row.id, attempts },
          });
        }
      }
    }

    return Response.json(summary);
  } catch (error) {
    await logEvent(supabase, {
      level: "critical",
      eventType: "followup_cron_threw",
      errorMessage: getErrorMessage(error),
    });
    return Response.json(
      { ok: false, error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
