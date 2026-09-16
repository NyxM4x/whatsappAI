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
//   7. analyzeTurn: pide persona, pide algo que no ofrecemos, frustración
//      (3 veces → alarma + pausa)
//   8. Servicio del tarifario o ficha → startLead
//   9. Pide una gestión ("avísele a la doctora", "ya llegué") → alarma + pausa
//  10. Si no → Q&A con OpenAI
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
  normalizeIncomingMessages,
  type IncomingMessage,
} from "@/lib/engine/messages";

import {
  getClinicConfig,
  getBusinessByPhoneNumberId,
  DEFAULT_BUSINESS_SLUG,
  CLINIC_WELCOME_MESSAGE,
} from "@/lib/clinic/config";
import { matchService } from "@/lib/clinic/services";
import {
  analyzeTurn,
  answerQuestion,
  continueLead,
  isLeadStep,
  LEAD_REPLIES,
  registerEscalation,
  startLead,
  unavailableReply,
  type LeadContext,
  type TurnAnalysis,
} from "@/lib/clinic/leads";
import { registerIncomingProof, type IncomingProofResult } from "@/lib/clinic/payments";
import {
  getBookingSession,
  saveBookingSession,
  expireStalePaymentAppointments,
} from "@/lib/clinic/data";
import type { BookingSession, LeadKind } from "@/lib/clinic/types";

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
    await watchWhilePaused(leadCtx, newMessages);
    return new Response("bot paused", { status: 200 });
  }

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
  const ok = () => new Response("ok", { status: 200 });

  const session = normalizeSession(await getBookingSession(conversationId));

  // Derivar a una persona: alarma en el panel, sesión limpia, aviso al
  // paciente y pausa del bot.
  const escalate = async (kind: LeadKind, replyText: string) => {
    await registerEscalation({ ...leadCtx, kind, lastMessage: newText, lead: session.draft.lead ?? null });
    await saveBookingSession({ conversationId, business: clinic.slug, step: "idle", draft: {} });
    await send(replyText, { pauseAfter: true });
    return ok();
  };

  // ── 1. Comprobantes y archivos ────────────────────────────────────────────
  let proof: IncomingProofResult = null;
  for (const message of newMessages) {
    const result = await registerIncomingProof({ ...leadCtx, message });
    if (result === "receipt" || (result === "unverified" && proof !== "receipt")) proof = result;
  }

  // ── 2. Emergencias ────────────────────────────────────────────────────────
  // Desactivado por defecto (los clientes no lo quieren habilitado). Para
  // reactivarlo en una clínica: CLINIC_EMERGENCY_DETECTION=true.
  const emergencyDetectionEnabled = process.env.CLINIC_EMERGENCY_DETECTION === "true";
  const textLc = newText.toLowerCase();
  if (emergencyDetectionEnabled && clinic.emergencyKeywords.some((kw) => textLc.includes(kw.toLowerCase()))) {
    await send(clinic.emergencyResponse);
    return ok();
  }

  // ── 3. Pide hablar con una persona ────────────────────────────────────────
  // Prioridad alta: corta cualquier flujo, incluso una solicitud en curso.
  if (clinic.humanHandoffIntentPatterns.test(newText)) {
    return escalate("humano", clinic.replies.humanHandoff);
  }

  // ── 4. Ubicación / GPS: respuesta determinista con ambos datos ────────────
  if (clinic.locationRequestIntentPatterns.test(newText)) {
    await send(`📍 Nuestra dirección es: ${clinic.generalInfo.address}\n\n🗺️ Ubicación en Google Maps:\n${clinic.generalInfo.mapsUrl}`);
    return ok();
  }

  // ── 5. Llegó un comprobante o un archivo ──────────────────────────────────
  if (proof) {
    await send(proof === "receipt" ? LEAD_REPLIES.receipt : LEAD_REPLIES.file);
    return ok();
  }

  // ── 6. Solicitud en curso ─────────────────────────────────────────────────
  if (isLeadStep(session.step)) {
    const analysis = newText
      ? await analyzeTurn({ ...leadCtx, text: newText, step: session.step, draft: session.draft.lead ?? null })
      : null;
    if (analysis?.wantsHuman) return escalate("humano", clinic.replies.humanHandoff);

    const tracked = await trackFailedAttempts(leadCtx, session, analysis);
    if (tracked.limitReached) return escalate("fallidos", LEAD_REPLIES.failedAttempts);

    const result = await continueLead({ ...leadCtx, session: tracked.session, analysis, text: newText });
    await send(result.reply, { pauseAfter: result.pauseAfterReply });
    return ok();
  }

  // ── 7. Archivo o audio sin texto, o saludo solo ───────────────────────────
  if (!newText) {
    await send(clinic.replies.welcome);
    return ok();
  }
  if (GREETING_ONLY_PATTERN.test(newText)) {
    await send(CLINIC_WELCOME_MESSAGE);
    return ok();
  }

  // ── 8. Pedidos que solo resuelve una persona ──────────────────────────────
  // El bot ya no cancela, reprograma, consulta citas ni envía el QR.
  if (clinic.cancelIntentPatterns.test(newText)) return escalate("cancelar", LEAD_REPLIES.toAdvisor);
  if (clinic.rescheduleIntentPatterns.test(newText)) return escalate("reprogramar", LEAD_REPLIES.toAdvisor);
  if (clinic.checkAppointmentIntentPatterns.test(newText)) return escalate("consulta_cita", LEAD_REPLIES.toAdvisor);
  if (clinic.qrRequestIntentPatterns.test(newText)) return escalate("pago", LEAD_REPLIES.payment);

  // ── 9. Análisis del mensaje ───────────────────────────────────────────────
  const analysis = await analyzeTurn({ ...leadCtx, text: newText, step: "idle", draft: null });
  if (analysis?.wantsHuman) return escalate("humano", clinic.replies.humanHandoff);

  // Pidió por su nombre algo que la clínica no ofrece (fisioterapia,
  // odontología…). Va ANTES de servicio y ficha: si no, el mensaje seguiría de
  // largo y se le abriría una solicitud de otra cosa. Nunca se sustituye en
  // silencio por otra especialidad.
  if (analysis?.unavailableRequest) {
    return escalate("no_disponible", unavailableReply(analysis.unavailableRequest));
  }

  const tracked = await trackFailedAttempts(leadCtx, session, analysis);
  if (tracked.limitReached) return escalate("fallidos", LEAD_REPLIES.failedAttempts);

  // ── 10. Servicio del tarifario → solicitud de servicio ────────────────────
  // Las consultas de emergencia solo se informan (Q&A): no esperan a un asesor.
  const service = matchService(newText, clinic.services);
  if (service && service.category !== "emergencia") {
    const result = await startLead({ ...leadCtx, session: tracked.session, kind: "servicio", service, analysis });
    await send(result.reply);
    return ok();
  }

  // ── 11. Pide ficha / consulta ─────────────────────────────────────────────
  if (clinic.bookingIntentPatterns.test(newText) || analysis?.wantsLead) {
    const result = await startLead({ ...leadCtx, session: tracked.session, kind: "ficha", analysis });
    await send(result.reply);
    return ok();
  }

  // ── 12. Red de seguridad: pide una gestión, no información ────────────────
  // "Avísele a la doctora", "ya llegué", "me confirma": nada de eso lo puede
  // hacer el bot. Va acá, después de servicio y ficha, para no robarle mensajes
  // a la recolección ("quiero una ficha, me confirma") y justo antes del Q&A,
  // que es donde el agujero existía: el modelo contestaba "Ok" y nadie se
  // enteraba. Tiene que ser una rama del código, no una regla del prompt: el
  // Q&A solo devuelve texto, no puede dejar la alarma en el panel.
  if (analysis?.needsHumanAction) return escalate("accion", LEAD_REPLIES.action);

  // ── 13. Q&A general con OpenAI ────────────────────────────────────────────
  // Si el modelo no responde no dejamos al paciente sin salida: se deriva de
  // verdad, con alarma en el panel.
  const answer = await answerQuestion(leadCtx, newText);
  if (!answer) return escalate("humano", LEAD_REPLIES.technicalError);

  await send(answer);
  return ok();
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
