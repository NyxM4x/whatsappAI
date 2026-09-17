// ============================================================================
// Webhook — Clínica San Martín de Porres
// ----------------------------------------------------------------------------
// Ruta: POST /api/webhooks/clinica
// Desde 2026-09-15 el bot NO agenda: recopila solicitudes y las deja en el
// panel con alarma para que un asesor confirme por WhatsApp (ver
// lib/clinic/leads.ts). Orquesta:
//   1. Normalizar evento Kapso → takeover humano → guardar inbound → lock
//   2. Bot en pausa: no responde, pero anota comprobantes y deja alarma si el
//      paciente pide cancelar o reprogramar
//   3. Comprobantes de pago (imagen/PDF) → listado de pagos del panel
//   4. Pide hablar con una persona → alarma + pausa
//   5. Solicitud en curso (collecting_lead / confirming_lead) → continueLead
//   6. Cancelar / reprogramar / "¿cuándo es mi cita?" / pedir QR → alarma + pausa
//   7. analyzeTurn: pide persona, frustración (3 veces → alarma + pausa)
//   8. Pide una especialidad fuera de catálogo → ficha igual (nunca se le dice
//      que no la tenemos: no sabemos si la clínica la ofrece o no)
//   9. Servicio del tarifario o ficha → startLead
//  10. Pide una gestión ("avísele a la doctora", "ya llegué") → alarma + pausa
//  11. Si no → Q&A con OpenAI
// Toda derivación pausa el bot DESPUÉS de enviar la respuesta: la barrera de
// pausa de sendAndPersist descartaría el aviso al paciente si se pausara antes.
// ============================================================================

import { verifySignature } from "@kapso/whatsapp-cloud-api/server";

import { getKapsoClient, getRequiredEnv } from "@/lib/engine/clients";
import { maskPhone, getErrorMessage, logSystemEvent } from "@/lib/engine/logging";
import {
  saveContactAndConversation,
  saveInboundMessage,
  saveOutboundMessage,
  acquireReplyLock,
  markReplyLockSent,
  getBotPauseState,
  resumeBotIfPauseExpired,
  isLatestInboundMessage,
  getUnansweredInboundText,
  pauseBotForHumanHandoff,
  autoPauseBotFromBusinessApp,
} from "@/lib/engine/data";
import {
  extractHumanTakeoverEvents,
  extractOutboundSentDiagnostics,
  normalizeIncomingMessages,
  type IncomingMessage,
} from "@/lib/engine/messages";

import {
  getClinicConfig,
  getBusinessByPhoneNumberId,
  DEFAULT_BUSINESS_SLUG,
} from "@/lib/clinic/config";
import { decideAction } from "@/lib/clinic/routing";
import {
  analyzeTurn,
  answerQuestion,
  continueLead,
  isLeadStep,
  LEAD_REPLIES,
  offerLead,
  registerEscalation,
  startLead,
  type LeadContext,
  type TurnAnalysis,
} from "@/lib/clinic/leads";
import { registerIncomingProof, type IncomingProofResult } from "@/lib/clinic/payments";
import {
  getBookingSession,
  saveBookingSession,
  expireStalePaymentAppointments,
  recordWebhookAudit,
} from "@/lib/clinic/data";
import type { AuditIntent, BookingSession, LeadKind } from "@/lib/clinic/types";

// Node runtime y ventana amplia: el debounce duerme unos segundos dentro de la
// invocación, así que subimos el límite por defecto de Vercel (10s).
export const runtime = "nodejs";
export const maxDuration = 30;

// Ventana de debounce para agrupar mensajes seguidos del mismo cliente.
const DEBOUNCE_MS = Number(process.env.MESSAGE_DEBOUNCE_MS ?? 6000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const GREETING_ONLY_PATTERN =
  /^(?:hola|holaa+|buenas(?: tardes| d[ií]as| noches)?|buen(?:os|as)\s+(?:d[ií]as|tardes|noches)|saludos|hey)[.!\s😊👋]*$/i;

// "Intentos fallidos": veces que el paciente dice que no se le está ayudando.
// Al llegar al límite dentro de la ventana, se deriva a una persona.
const FAILED_ATTEMPTS_LIMIT = 3;
const FAILED_ATTEMPTS_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── GET: verificación del webhook de Kapso ───────────────────────────────────

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const verifyToken = process.env.KAPSO_VERIFY_TOKEN ?? process.env.KAPSO_API_KEY ?? "";

  // Fail-closed: sin verify token configurado, no hay nada válido contra qué
  // comparar (antes "" pasaba si el challenge también traía token vacío).
  if (!verifyToken) {
    return new Response("Forbidden", { status: 403 });
  }

  if (mode === "subscribe" && token === verifyToken) {
    return new Response(challenge ?? "", { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

// ─── POST: mensajes entrantes ─────────────────────────────────────────────────

export async function POST(request: Request) {
  let rawBody: string;

  try {
    rawBody = await request.text();
  } catch {
    return new Response("invalid body", { status: 400 });
  }

  // Verificación de firma (P1.1): Meta/Kapso firman el payload con
  // X-Hub-Signature-256 (HMAC-SHA256 sobre el body crudo, con el App Secret de
  // Meta). Sin esto, cualquiera en internet puede POSTear mensajes falsos.
  //
  // Rollout seguro: si META_APP_SECRET no está configurada, NO se bloquea (solo
  // se avisa por log) para no tumbar el bot en producción antes de que se
  // configure la env var. Una vez seteada, se exige siempre.
  const appSecret = process.env.META_APP_SECRET;
  if (appSecret) {
    const ok = verifySignature({
      appSecret,
      rawBody,
      signatureHeader: request.headers.get("x-hub-signature-256") ?? undefined,
    });
    if (!ok) {
      console.error("clinica webhook: invalid X-Hub-Signature-256, rejecting");
      return new Response("invalid signature", { status: 401 });
    }
  } else {
    console.warn("clinica webhook: META_APP_SECRET not set, skipping signature verification");
    // Persistido (no solo console.warn, que se pierde con los runtime logs de
    // Vercel): mientras falte esta env var, cualquiera en internet puede
    // forjar un POST a este webhook, incluyendo un evento falso de takeover
    // humano que pause/despause el bot. Configurar META_APP_SECRET (panel de
    // Meta for Developers → tu app → Settings → Basic) cierra esto sin tocar
    // código — el mecanismo (X-Hub-Signature-256) ya es el correcto, según la
    // documentación oficial del SDK de Kapso.
    await logSystemEvent({
      level: "warning",
      eventType: "webhook_signature_verification_disabled",
      errorMessage: "META_APP_SECRET no configurada: firma del webhook sin verificar",
    });
  }

  let payload: Record<string, any>;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Takeover humano: se procesa antes de debounce, OpenAI o cualquier respuesta.
  // Cada evento se aísla: un fallo en uno no puede tumbar el webhook entero
  // (antes un 500 acá también impedía guardar el inbound del paciente, y el
  // reintento de Kapso volvía a fallar igual).
  const humanTakeovers = extractHumanTakeoverEvents(payload, request);
  for (const takeover of humanTakeovers) {
    try {
      const result = await autoPauseBotFromBusinessApp(takeover);
      console.log("human takeover processed", {
        phone: maskPhone(takeover.customerPhone),
        outcome: result.outcome,
        duplicate: result.duplicate,
        expiresAt: result.expiresAt,
      });
      // Log estructurado y persistido (no solo console.log, que expira con los
      // runtime logs de Vercel) para poder auditar en producción quién pausó a
      // quién y cuándo.
      await logSystemEvent({
        level: "info",
        eventType: "human_takeover",
        conversationId: takeover.conversationId,
        contactPhone: takeover.customerPhone,
        messageId: takeover.providerMessageId,
        metadata: {
          decision: result.duplicate ? "HUMAN_MESSAGE_DETECTED_DUPLICATE" : "HUMAN_MESSAGE_DETECTED",
          outcome: result.outcome,
          bot_paused: result.applied || result.outcome === "manual_pause_kept",
          pause_expires_at: result.expiresAt,
        },
      });
    } catch (err) {
      console.error("human takeover failed", getErrorMessage(err));
      await logSystemEvent({
        level: "critical",
        eventType: "human_takeover_failed",
        conversationId: takeover.conversationId,
        contactPhone: takeover.customerPhone,
        messageId: takeover.providerMessageId,
        errorMessage: getErrorMessage(err),
      });
    }
  }

  // Captura DIAGNÓSTICA temporal — quitar una vez confirmado en producción cuál
  // campo real usa Kapso para marcar "esto lo mandó la recepcionista" (ver
  // extractOutboundSentDiagnostics). No incluye texto de mensajes.
  for (const diag of extractOutboundSentDiagnostics(payload, request)) {
    await logSystemEvent({
      level: "info",
      eventType: "outbound_sent_shape_capture",
      conversationId: diag.conversationId ?? undefined,
      messageId: diag.providerMessageId ?? undefined,
      metadata: { matched_as_human_takeover: diag.matched, kapso: diag.kapso },
    });
  }

  const incomingMessages = await normalizeIncomingMessages(payload, request);

  if (incomingMessages.length === 0) {
    return new Response("ignored", { status: 200 });
  }

  const firstMessage = incomingMessages[0];
  const lastMessage = incomingMessages[incomingMessages.length - 1];

  // Modo test: solo responder al número de prueba si está configurado.
  const testPhone = process.env.TEST_PHONE?.replace(/\D/g, "");
  const incomingPhone = lastMessage.from?.replace(/\D/g, "");
  if (testPhone && incomingPhone !== testPhone) {
    return new Response("test mode ignored", { status: 200 });
  }

  // Multi-tenant (P2): qué clínica es dueña del número que recibió el
  // mensaje. Si no se pudo resolver (payload sin el campo esperado, o número
  // no dado de alta todavía), cae a la clínica por defecto — no rompe el bot.
  const business = lastMessage.phoneNumberId
    ? (await getBusinessByPhoneNumberId(lastMessage.phoneNumberId)) ?? DEFAULT_BUSINESS_SLUG
    : DEFAULT_BUSINESS_SLUG;
  const clinic = await getClinicConfig(business);

  // Liberar reservas de pago vencidas del agendamiento anterior: una cita en
  // `awaiting_payment` bloquea el slot. Es un solo UPDATE con filtro y no debe
  // tumbar el webhook.
  try {
    const freed = await expireStalePaymentAppointments(clinic.slug);
    if (freed.length) {
      console.log("reservas de pago liberadas por vencimiento", {
        count: freed.length,
        ids: freed.map((a) => a.id),
      });
    }
  } catch (err) {
    console.error("expireStalePaymentAppointments threw", err);
  }

  console.log("clinica webhook received", {
    phone: maskPhone(lastMessage.from),
    conversationId: lastMessage.conversationId ?? null,
    hasMedia: Boolean(lastMessage.mediaUrl),
    mediaType: lastMessage.mediaType ?? null,
  });

  // ── Guardar contacto, conversación e inbound ─────────────────────────────
  try {
    await saveContactAndConversation(lastMessage as any);
  } catch (err) {
    console.error("saveContactAndConversation threw", err);
  }

  const newMessages: typeof incomingMessages = [];
  for (const msg of incomingMessages) {
    try {
      const saved = await saveInboundMessage(msg as any);
      if (saved) newMessages.push(msg);
    } catch (err) {
      console.error("saveInboundMessage threw", err);
    }
  }

  if (newMessages.length === 0) {
    return new Response("duplicate ignored", { status: 200 });
  }

  // ── Lock anti-duplicado ───────────────────────────────────────────────────
  const canReply = await acquireReplyLock({
    conversationId: lastMessage.conversationId,
    lastMessageId: lastMessage.messageId,
    phone: lastMessage.from,
    batchSize: incomingMessages.length,
  });

  if (!canReply) return new Response("reply already processed", { status: 200 });

  const conversationId = lastMessage.conversationId ?? firstMessage.conversationId ?? lastMessage.from;
  const contactPhone = lastMessage.from;
  const contactName = lastMessage.contactName ?? firstMessage.contactName ?? null;
  const leadCtx: LeadContext = { clinic, conversationId, contactPhone, contactName };

  // ── Pausa del bot ─────────────────────────────────────────────────────────
  // La identidad durable es el teléfono; conversationId queda como referencia.
  // En pausa el bot no responde, pero sigue mirando (ver watchWhilePaused).
  const pauseState = await getBotPauseState(lastMessage.conversationId, lastMessage.from);

  if (pauseState.paused && !pauseState.expired) {
    await logSystemEvent({
      level: "info",
      eventType: "ai_turn_decision",
      conversationId,
      contactPhone,
      messageId: lastMessage.messageId,
      metadata: {
        decision: "BOT_PAUSED",
        bot_paused: true,
        pause_reason: pauseState.reason ?? null,
        pause_expires_at: pauseState.expiresAt ?? null,
      },
    });
    await watchWhilePaused(leadCtx, newMessages);
    return new Response("bot paused", { status: 200 });
  }

  if (pauseState.paused && pauseState.expired) {
    await resumeBotIfPauseExpired(lastMessage.conversationId, lastMessage.from);
  }

  // ── Marcar como leído ─────────────────────────────────────────────────────
  const kapso = getKapsoClient();
  // Responder desde el número PROPIO de la clínica resuelta; si todavía no
  // tiene uno cargado en clinic_settings, cae al env var global (caso
  // single-tenant / mientras se completa el alta de una clínica nueva).
  const phoneNumberId = clinic.kapsoPhoneNumberId ?? getRequiredEnv("KAPSO_PHONE_NUMBER_ID");

  if (lastMessage.messageId) {
    try {
      await kapso.messages.markRead({
        phoneNumberId,
        messageId: lastMessage.messageId,
        typingIndicator: { type: "text" },
      });
    } catch (err) {
      console.error("kapso markRead failed", err);
    }
  }

  // ── Debounce: agrupar mensajes seguidos del mismo cliente ─────────────────
  // Kapso entrega cada mensaje en un webhook aparte. Esperamos una ventana
  // corta; si mientras tanto llega otro mensaje, esta invocación cede el turno
  // a la más reciente (que ya verá el texto completo). Así respondemos UNA vez.
  // Se omite para mensajes con media (comprobantes) para no demorarlos.
  if (DEBOUNCE_MS > 0 && lastMessage.messageId && !lastMessage.mediaUrl) {
    await sleep(DEBOUNCE_MS);
    const stillLatest = await isLatestInboundMessage(conversationId, lastMessage.messageId);
    if (!stillLatest) {
      return new Response("debounced: superseded by newer message", { status: 200 });
    }
  }

  // ── Texto consolidado: todo lo que el cliente escribió sin respuesta ──────
  const gathered = await getUnansweredInboundText(conversationId);
  const newText = (
    gathered.trim()
      ? gathered
      : newMessages.map((m) => m.text ?? "").filter((t) => t.trim().length > 0).join("\n")
  ).trim();

  // Barrera A (antes de OpenAI): la pausa puede haber llegado durante el
  // debounce. Se distingue una pausa VIGENTE de una temporal ya expirada.
  const currentPauseState = await getBotPauseState(conversationId, contactPhone);
  if (currentPauseState.paused && !currentPauseState.expired) {
    console.log("ai turn omitted because bot is paused", {
      conversationId,
      reason: currentPauseState.reason,
      expiresAt: currentPauseState.expiresAt,
    });
    await logSystemEvent({
      level: "info",
      eventType: "ai_turn_decision",
      conversationId,
      contactPhone,
      messageId: lastMessage.messageId,
      metadata: {
        decision: "AI_SKIPPED_HUMAN_TAKEOVER",
        bot_paused: true,
        pause_reason: currentPauseState.reason ?? null,
        pause_expires_at: currentPauseState.expiresAt ?? null,
      },
    });
    await watchWhilePaused(leadCtx, newMessages);
    return new Response("bot paused", { status: 200 });
  }

  await logSystemEvent({
    level: "info",
    eventType: "ai_turn_decision",
    conversationId,
    contactPhone,
    messageId: lastMessage.messageId,
    metadata: { decision: "AI_PROCESSING_ALLOWED", bot_paused: false },
  });

  const send = (replyText: string, options: { pauseAfter?: boolean } = {}) =>
    sendAndPersist({
      kapso,
      phoneNumberId,
      contactPhone,
      conversationId,
      replyText,
      lastMessage,
      pauseAfter: options.pauseAfter,
    });
  const session = normalizeSession(await getBookingSession(conversationId));

  // Cierre de cada turno: deja la fila de auditoría y responde 200. El `intent`
  // es obligatorio, así que el compilador no deja salir del webhook sin decir
  // qué rama atendió el mensaje — que es justo lo que faltaba para poder
  // revisar después por qué el bot contestó lo que contestó.
  let lastAnalysis: TurnAnalysis | null = null;
  const ok = async (intent: AuditIntent) => {
    await recordWebhookAudit({
      business: clinic.slug,
      conversationId,
      contactPhone,
      intent,
      analysis: lastAnalysis,
      step: session.step,
    });
    return new Response("ok", { status: 200 });
  };

  // Derivar a una persona: alarma en el panel, sesión limpia, aviso al
  // paciente y pausa del bot.
  const escalate = async (kind: LeadKind, replyText: string, intent: AuditIntent) => {
    await registerEscalation({ ...leadCtx, kind, lastMessage: newText, lead: session.draft.lead ?? null });
    await saveBookingSession({ conversationId, business: clinic.slug, step: "idle", draft: {} });
    await send(replyText, { pauseAfter: true });
    return ok(intent);
  };

  // ── Comprobantes y archivos ───────────────────────────────────────────────
  // Se registran siempre (aunque el turno termine en otra rama): el resultado
  // entra como dato de la decisión.
  let proof: IncomingProofResult = null;
  for (const message of newMessages) {
    const result = await registerIncomingProof({ ...leadCtx, message });
    if (result === "receipt" || (result === "unverified" && proof !== "receipt")) proof = result;
  }

  // ── Análisis del mensaje ──────────────────────────────────────────────────
  // Una sola llamada por turno. Antes había dos sitios que llamaban a
  // analyzeTurn (dentro y fuera de la solicitud en curso) con el mismo texto.
  const needsAnalysis =
    Boolean(newText) &&
    !clinic.humanHandoffIntentPatterns.test(newText) &&
    !clinic.locationRequestIntentPatterns.test(newText) &&
    !proof &&
    !GREETING_ONLY_PATTERN.test(newText);

  const analysis = needsAnalysis
    ? await analyzeTurn({
        ...leadCtx,
        text: newText,
        step: session.step,
        draft: session.draft.lead ?? null,
      })
    : null;
  lastAnalysis = analysis;

  // Frustración repetida: se cuenta antes de decidir, porque al llegar al
  // límite manda sobre cualquier otra rama.
  const tracked = await trackFailedAttempts(leadCtx, session, analysis);
  if (tracked.limitReached) return escalate("fallidos", LEAD_REPLIES.failedAttempts, "fallidos");

  // ── Decisión ──────────────────────────────────────────────────────────────
  // Función pura (lib/clinic/routing.ts): no toca base de datos ni red. Todo lo
  // que sigue es ejecución.
  const action = decideAction({
    clinic,
    text: newText,
    analysis,
    step: session.step,
    proof,
    emergencyDetectionEnabled: process.env.CLINIC_EMERGENCY_DETECTION === "true",
    greetingOnly: Boolean(newText) && GREETING_ONLY_PATTERN.test(newText),
  });

  // ── Ejecución ─────────────────────────────────────────────────────────────
  switch (action.type) {
    case "reply": {
      await send(action.text);
      return ok(action.intent);
    }

    case "escalate":
      return escalate(action.kind, action.reply, action.intent);

    case "continueLead": {
      const result = await continueLead({ ...leadCtx, session: tracked.session, analysis, text: newText });
      await send(result.reply, { pauseAfter: result.pauseAfterReply });
      return ok(action.intent);
    }

    case "offerLead": {
      const result = await offerLead({ ...leadCtx, session: tracked.session, request: action.request, analysis });
      await send(result.reply, { pauseAfter: result.pauseAfterReply });
      return ok(action.intent);
    }

    case "startLead": {
      const result = await startLead({
        ...leadCtx,
        session: tracked.session,
        kind: action.kind,
        service: action.service,
        analysis,
      });
      await send(result.reply, { pauseAfter: result.pauseAfterReply });
      return ok(action.intent);
    }

    case "qa": {
      // Si el modelo no responde no dejamos al paciente sin salida: se deriva de
      // verdad, con alarma en el panel.
      const answer = await answerQuestion(leadCtx, newText);
      if (!answer) return escalate("humano", LEAD_REPLIES.technicalError, "qa_fallido");
      await send(answer);
      return ok(action.intent);
    }
  }

}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Las sesiones que quedaron en un paso del agendamiento anterior se tratan como
// idle: esos flujos ya no existen.
function normalizeSession(session: BookingSession): BookingSession {
  if (session.step === "idle" || isLeadStep(session.step)) return session;
  return { ...session, step: "idle", draft: { failedAttempts: session.draft.failedAttempts } };
}

// Cuenta las veces que el paciente dice que no se le ayuda. Devuelve la sesión
// con el conteo actualizado para que el paso siguiente no lo pise.
async function trackFailedAttempts(
  ctx: LeadContext,
  session: BookingSession,
  analysis: TurnAnalysis | null,
): Promise<{ limitReached: boolean; session: BookingSession }> {
  if (!analysis?.frustrated) return { limitReached: false, session };

  const cutoff = Date.now() - FAILED_ATTEMPTS_WINDOW_MS;
  const attempts = [
    ...(session.draft.failedAttempts ?? []).filter((iso) => new Date(iso).getTime() > cutoff),
    new Date().toISOString(),
  ];
  const updated: BookingSession = { ...session, draft: { ...session.draft, failedAttempts: attempts } };

  if (attempts.length >= FAILED_ATTEMPTS_LIMIT) return { limitReached: true, session: updated };

  await saveBookingSession({
    conversationId: ctx.conversationId,
    business: ctx.clinic.slug,
    step: session.step,
    draft: updated.draft,
  });
  return { limitReached: false, session: updated };
}

// Con el bot en pausa (lo atiende una persona) no se responde nada, pero:
//   - los comprobantes se anotan en el listado de pagos del panel;
//   - si el paciente pide cancelar o reprogramar, salta una alarma nueva.
// Así se cubre al paciente ya confirmado por un humano y al que cambió de idea
// antes de que lo atiendan, sin que el bot se despierte.
async function watchWhilePaused(ctx: LeadContext, messages: IncomingMessage[]) {
  try {
    for (const message of messages) await registerIncomingProof({ ...ctx, message });

    const text = messages.map((m) => m.text ?? "").filter((t) => t.trim()).join("\n");
    if (!text) return;

    const kind: LeadKind | null = ctx.clinic.cancelIntentPatterns.test(text)
      ? "cancelar"
      : ctx.clinic.rescheduleIntentPatterns.test(text)
        ? "reprogramar"
        : null;
    if (kind) await registerEscalation({ ...ctx, kind, lastMessage: text });
  } catch (err) {
    console.error("watchWhilePaused failed", getErrorMessage(err));
  }
}

async function sendAndPersist(params: {
  kapso: ReturnType<typeof getKapsoClient>;
  phoneNumberId: string;
  contactPhone: string;
  conversationId: string;
  replyText: string;
  lastMessage: IncomingMessage;
  // Pausar el bot después de enviar (derivación a una persona).
  pauseAfter?: boolean;
}) {
  const { kapso, phoneNumberId, contactPhone, conversationId, replyText, lastMessage } = params;

  try {
    // Barrera B (justo antes de enviar): una persona puede tomar el control
    // mientras OpenAI procesa. Solo frena una pausa VIGENTE — una pausa temporal
    // ya expirada no debe silenciar esta respuesta.
    const pauseState = await getBotPauseState(conversationId, contactPhone);
    if (pauseState.paused && !pauseState.expired) {
      console.log("ai response omitted because bot is paused", {
        conversationId,
        reason: pauseState.reason,
        expiresAt: pauseState.expiresAt,
      });
      await logSystemEvent({
        level: "info",
        eventType: "ai_turn_decision",
        conversationId,
        contactPhone,
        messageId: lastMessage.messageId,
        metadata: {
          decision: "AI_ABORTED_BEFORE_SEND",
          bot_paused: true,
          pause_reason: pauseState.reason ?? null,
          pause_expires_at: pauseState.expiresAt ?? null,
        },
      });
      return;
    }

    try {
      await kapso.messages.sendText({
        phoneNumberId,
        to: contactPhone,
        body: replyText,
      });
    } catch (err) {
      console.error("kapso sendText failed", err);
      await logSystemEvent({
        level: "critical",
        eventType: "kapso_send_text_failed",
        conversationId,
        contactPhone,
        errorMessage: getErrorMessage(err),
      });
      return;
    }

    // Verificación POST-envío: la llamada de red a Kapso (arriba) tiene latencia
    // propia, y en ese hueco puede aterrizar una pausa real (auditoría
    // 2026-09-17: ocurrió en producción, ~4 s de diferencia). Para entonces el
    // mensaje ya salió hacia Meta — no hay forma de "desenviarlo" — pero antes
    // esto era invisible. Ahora queda como evento CRÍTICO para poder medir cuán
    // seguido pasa y decidir si hace falta acortar la latencia del turno.
    try {
      const postSendPauseState = await getBotPauseState(conversationId, contactPhone);
      if (postSendPauseState.paused && !postSendPauseState.expired) {
        console.error("ai response sent during a race window with a human takeover", { conversationId });
        await logSystemEvent({
          level: "critical",
          eventType: "ai_turn_decision",
          conversationId,
          contactPhone,
          messageId: lastMessage.messageId,
          metadata: {
            decision: "AI_SENT_DURING_RACE_WINDOW",
            bot_paused: true,
            pause_reason: postSendPauseState.reason ?? null,
            pause_expires_at: postSendPauseState.expiresAt ?? null,
          },
        });
      }
    } catch (err) {
      console.error("post-send pause re-check failed", err);
    }

    try {
      await saveOutboundMessage({ conversationId, phone: contactPhone, content: replyText });
      await markReplyLockSent({
        lastMessageId: lastMessage.messageId,
        conversationId,
        phone: contactPhone,
        responseText: replyText,
      });
    } catch (err) {
      console.error("post-send persistence failed", err);
    }
  } finally {
    // Aunque el envío falle, la derivación se mantiene: la alarma ya está en
    // el panel y el asesor va a escribir.
    if (params.pauseAfter) await pauseBotForHumanHandoff(conversationId, contactPhone);
  }
}
