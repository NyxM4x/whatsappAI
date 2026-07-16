// ============================================================================
// Webhook — Clínica San Martín de Porres
// ----------------------------------------------------------------------------
// Ruta: POST /api/webhooks/clinica
// Orquesta:
//   1. Normalizar evento Kapso → filtrar test phone → guardar inbound → lock
//   2. Detectar emergencias (respuesta inmediata)
//   3. Si step=awaiting_proof y llega imagen/doc → comprobante de pago
//   4. Si hay sesión activa → advanceBooking
//   5. Si intención de cancelar/reprogramar → flujo correspondiente
//   6. Si intención de agendar → iniciar flujo (advanceBooking con step=idle)
//   7. Si no → Q&A con OpenAI (catálogos + info clínica)
//   8. Enviar respuesta + QR si action=send_qr → guardar outbound → lock → sesión
// ============================================================================

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
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
  getRecentConversationHistory,
  isLatestInboundMessage,
  getUnansweredInboundText,
  pauseBotForHumanHandoff,
} from "@/lib/engine/data";
import { normalizeIncomingMessages } from "@/lib/engine/messages";

import {
  getClinicConfig,
  buildClinicSystemPrompt,
  getBusinessByPhoneNumberId,
  DEFAULT_BUSINESS_SLUG,
  type ClinicConfig,
} from "@/lib/clinic/config";
import {
  advanceBooking,
  handlePaymentProof,
  cancelActiveAppointment,
  rescheduleActiveAppointment,
  checkActiveAppointment,
} from "@/lib/clinic/booking";
import { getBookingSession } from "@/lib/clinic/data";

// Node runtime y ventana amplia: el debounce duerme unos segundos dentro de la
// invocación, así que subimos el límite por defecto de Vercel (10s).
export const runtime = "nodejs";
export const maxDuration = 30;

// Ventana de debounce para agrupar mensajes seguidos del mismo cliente.
const DEBOUNCE_MS = Number(process.env.MESSAGE_DEBOUNCE_MS ?? 6000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // ── Pausa del bot ─────────────────────────────────────────────────────────
  const pauseState = await getBotPauseState(lastMessage.conversationId);

  if (pauseState.paused && !pauseState.expired) {
    return new Response("bot paused", { status: 200 });
  }

  if (pauseState.paused && pauseState.expired) {
    await resumeBotIfPauseExpired(lastMessage.conversationId);
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

  const conversationId = lastMessage.conversationId ?? firstMessage.conversationId ?? lastMessage.from;
  const contactPhone = lastMessage.from;

  // ── Debounce: agrupar mensajes seguidos del mismo cliente ─────────────────
  // Kapso entrega cada mensaje en un webhook aparte. Esperamos una ventana
  // corta; si mientras tanto llega otro mensaje, esta invocación cede el turno
  // a la más reciente (que ya verá el texto completo). Así respondemos UNA vez.
  // Se omite para mensajes con media (comprobantes) para no demorar el pago.
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

  const textLc = newText.toLowerCase();

  let replyText: string;
  let action: "send_qr" | "none" = "none";

  // ── 1. Emergencias ────────────────────────────────────────────────────────
  // Desactivado por defecto (los clientes no lo quieren habilitado). Para
  // reactivarlo en una clínica: CLINIC_EMERGENCY_DETECTION=true.
  const emergencyDetectionEnabled = process.env.CLINIC_EMERGENCY_DETECTION === "true";
  const isEmergency =
    emergencyDetectionEnabled &&
    clinic.emergencyKeywords.some((kw) => textLc.includes(kw.toLowerCase()));

  if (isEmergency) {
    replyText = clinic.emergencyResponse;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 1b. Derivación a humano (reclamos / "quiero hablar con una persona") ──
  // Prioridad alta: corta cualquier flujo (incluso una reserva en curso) y
  // pausa el bot para que el equipo retome la conversación manualmente.
  if (clinic.humanHandoffIntentPatterns.test(newText)) {
    await pauseBotForHumanHandoff(conversationId);
    replyText = clinic.replies.humanHandoff;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 2. Cargar sesión de reserva ───────────────────────────────────────────
  const session = await getBookingSession(conversationId);

  // ── 3. Comprobante de pago (media entrante) ───────────────────────────────
  const hasMedia = Boolean(lastMessage.mediaUrl) && (lastMessage.mediaType === "image" || lastMessage.mediaType === "document");

  if (session.step === "awaiting_proof" && hasMedia && lastMessage.mediaUrl) {
    const result = await handlePaymentProof({
      conversationId,
      business: clinic.slug,
      contactPhone,
      mediaUrl: lastMessage.mediaUrl,
      session,
      clinic,
    });
    replyText = result.reply;
    action = result.action;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action, lastMessage, updatedSession: result.session, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 4a. awaiting_proof + texto (sin media) → reenviar QR o Q&A ───────────
  if (session.step === "awaiting_proof" && !hasMedia && newText.trim()) {
    const asksForQr = /qr|pago|código|codigo|envía|envia|manda|pásame|pasame|comparte/i.test(newText);
    if (asksForQr && clinic.qrImageUrl) {
      replyText = "Aquí le reenvío el QR de pago 😊 Una vez realizado el pago, envíe el comprobante (foto o PDF) y lo validamos. ¡Gracias! 🙏";
      await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "send_qr", lastMessage, clinic });
    } else {
      try {
        const history = await getRecentConversationHistory(conversationId, 8);
        const { text } = await generateText({
          model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
          system: buildClinicSystemPrompt(clinic),
          messages: [
            ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
            { role: "user", content: newText },
          ],
          temperature: 0.35,
          abortSignal: AbortSignal.timeout(15000),
        });
        replyText = (text.trim() || clinic.replies.welcome) +
          "\n\n_Recuerde que para confirmar su cita debe enviarnos el comprobante de pago (foto o PDF) 😊_";
      } catch {
        replyText = "Estamos esperando el *comprobante de pago* (imagen o PDF) para confirmar su cita 😊";
      }
      await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    }
    return new Response("ok", { status: 200 });
  }

  // ── 4b. Sesión de reserva activa ──────────────────────────────────────────
  if (session.step !== "idle" && newText.trim()) {
    // Detectar si el cliente quiere salir del flujo o hacer otra cosa.
    // OJO: no incluir "para" ni "nada" sueltos aquí — son palabras comunes
    // ("para las 5", "no es nada grave") y cerraban el flujo por error.
    const wantsOut = /\b(no quiero|ya no quiero|cancela|cancelar|salir|déjalo|dejalo|olvíd\w+|olvida|olvidalo|mejor no|stop|no gracias)\b/i.test(newText);
    if (wantsOut) {
      const { saveBookingSession } = await import("@/lib/clinic/data");
      await saveBookingSession({ conversationId, business: clinic.slug, step: "idle", draft: {}, hold: { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null } });
      replyText = "Entendido 😊 Si en algún momento desea agendar una cita, con gusto le ayudo. ¿Puedo ayudarle en algo más?";
      await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
      return new Response("ok", { status: 200 });
    }

    const result = await advanceBooking({
      conversationId,
      business: clinic.slug,
      contactPhone,
      incomingText: newText,
      session,
      clinic,
    });
    replyText = result.reply;
    action = result.action;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action, lastMessage, updatedSession: result.session, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 5. Intenciones de cancelar / reprogramar ──────────────────────────────
  if (clinic.cancelIntentPatterns.test(newText)) {
    const result = await cancelActiveAppointment({ conversationId, business: clinic.slug, contactPhone, session, clinic });
    replyText = result.reply;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, updatedSession: result.session, clinic });
    return new Response("ok", { status: 200 });
  }

  if (clinic.rescheduleIntentPatterns.test(newText)) {
    const result = await rescheduleActiveAppointment({ conversationId, business: clinic.slug, contactPhone, session, clinic });
    replyText = result.reply;
    action = result.action;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action, lastMessage, updatedSession: result.session, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 5b. Intención de consultar la cita ("¿cuándo es mi cita?") ───────────
  if (clinic.checkAppointmentIntentPatterns.test(newText)) {
    const result = await checkActiveAppointment({ business: clinic.slug, contactPhone, session, clinic });
    replyText = result.reply;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 6. Intención de agendar — detección con GPT ───────────────────────────
  // El patrón rígido se usa como fast-path. Si no coincide, GPT decide.
  let wantsBooking = clinic.bookingIntentPatterns.test(newText);

  if (!wantsBooking) {
    try {
      const { generateText: gt } = await import("ai");
      const { openai: oai } = await import("@ai-sdk/openai");
      const { text: intent } = await gt({
        model: oai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
        system: `Determina si el siguiente mensaje de WhatsApp expresa intención de agendar/reservar una cita médica, ver horarios disponibles, o hablar con un doctor. Responde SOLO "si" o "no".`,
        prompt: newText,
        temperature: 0,
        abortSignal: AbortSignal.timeout(8000),
      });
      wantsBooking = intent.trim().toLowerCase().startsWith("si");
    } catch {
      wantsBooking = false;
    }
  }

  if (wantsBooking) {
    const result = await advanceBooking({
      conversationId,
      business: clinic.slug,
      contactPhone,
      incomingText: newText,
      session: { ...session, step: "idle" },
      clinic,
    });
    replyText = result.reply;
    action = result.action;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action, lastMessage, updatedSession: result.session, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 7. Q&A general con OpenAI ─────────────────────────────────────────────
  if (!newText.trim()) {
    // Media sin texto y sin flujo activo → respuesta de bienvenida.
    replyText = clinic.replies.welcome;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    return new Response("ok", { status: 200 });
  }

  try {
    const history = await getRecentConversationHistory(conversationId, 10);
    const systemPrompt = buildClinicSystemPrompt(clinic);

    const messages: { role: "user" | "assistant"; content: string }[] = [
      ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
      { role: "user", content: newText },
    ];

    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: systemPrompt,
      messages,
      temperature: 0.35,
      abortSignal: AbortSignal.timeout(15000),
    });

    replyText = text.trim() || clinic.replies.welcome;
  } catch (err) {
    console.error("openai generateText failed", err);
    await logSystemEvent({
      level: "error",
      eventType: "openai_generate_failed",
      conversationId,
      contactPhone,
      errorMessage: getErrorMessage(err),
    });
    replyText = "Lo sentimos, hubo un problema al procesar su consulta. Por favor intente nuevamente o llámenos al +591 75681881.";
  }

  await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
  return new Response("ok", { status: 200 });
}

// ─── Helper: enviar mensaje + persistir ──────────────────────────────────────

async function sendAndPersist(params: {
  kapso: ReturnType<typeof getKapsoClient>;
  phoneNumberId: string;
  contactPhone: string;
  conversationId: string;
  replyText: string;
  action: "send_qr" | "none";
  lastMessage: Awaited<ReturnType<typeof normalizeIncomingMessages>>[number];
  updatedSession?: any;
  clinic: ClinicConfig;
}) {
  const { kapso, phoneNumberId, contactPhone, conversationId, replyText, action, lastMessage, clinic } = params;

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

  // Enviar QR si se solicitó.
  if (action === "send_qr" && clinic.qrImageUrl) {
    try {
      await kapso.messages.sendImage({
        phoneNumberId,
        to: contactPhone,
        image: {
          link: clinic.qrImageUrl,
          caption: "Escanee este QR para realizar el pago 😊",
        },
      });
    } catch (err) {
      console.error("kapso sendImage (QR) failed", err);
    }
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
}
