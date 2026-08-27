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
//   5c. Si piden el QR sin agendar (pago suelto) → enviar QR y listo
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
  autoPauseBotFromBusinessApp,
} from "@/lib/engine/data";
import { extractHumanTakeoverEvents, normalizeIncomingMessages } from "@/lib/engine/messages";

import {
  getClinicConfig,
  buildClinicSystemPrompt,
  getBusinessByPhoneNumberId,
  DEFAULT_BUSINESS_SLUG,
  CLINIC_WELCOME_MESSAGE,
  type ClinicConfig,
} from "@/lib/clinic/config";
import { matchService, formatServicePrice } from "@/lib/clinic/services";
import { PAYMENT_WINDOW_MINUTES } from "@/lib/clinic/types";
import {
  advanceBooking,
  handlePaymentProof,
  cancelActiveAppointment,
  rescheduleActiveAppointment,
  checkActiveAppointment,
} from "@/lib/clinic/booking";
import {
  getBookingSession,
  saveBookingSession,
  expireStalePaymentAppointments,
  getAppointmentStatus,
} from "@/lib/clinic/data";

// Node runtime y ventana amplia: el debounce duerme unos segundos dentro de la
// invocación, así que subimos el límite por defecto de Vercel (10s).
export const runtime = "nodejs";
export const maxDuration = 30;

// Ventana de debounce para agrupar mensajes seguidos del mismo cliente.
const DEBOUNCE_MS = Number(process.env.MESSAGE_DEBOUNCE_MS ?? 6000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// El cliente quiere salir del flujo en curso (sea una reserva o la coordinación
// de un servicio). OJO: no incluir "para" ni "nada" sueltos — son palabras
// comunes ("para las 5", "no es nada grave") y cerraban el flujo por error.
const WANTS_OUT_PATTERN =
  /\b(no quiero|ya no quiero|cancela|cancelar|salir|déjalo|dejalo|olvíd\w+|olvida|olvidalo|mejor no|stop|no gracias)\b/i;

// ¿La respuesta del paciente es una preferencia de horario y no otra duda?
// Cubre horas ("a las 3", "15:30"), franjas, días y comodines ("cuando sea").
// Si no coincide, el mensaje se trata como pregunta y se le vuelve a preguntar.
// Un número suelto NO cuenta como hora: "tengo 40 años y fumo" es una duda, no
// un horario. Se exige contexto ("a las 3", "15:30", "9 am").
const TIME_PREFERENCE_PATTERN =
  /\b(a las \d{1,2}|\d{1,2}[:.]\d{2}|\d{1,2}\s*(am|pm|hrs?|horas?)|ma[ñn]ana|tarde|noche|mediod[ií]a|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|fin de semana|feriado|cualquier\w*|cuando (sea|pueda|guste|usted)|el que sea|lo antes posible|cuanto antes)\b/i;

const GREETING_ONLY_PATTERN =
  /^(?:hola|holaa+|buenas(?: tardes| d[ií]as| noches)?|buen(?:os|as)\s+(?:d[ií]as|tardes|noches)|saludos|hey)[.!\s😊👋]*$/i;

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
  const humanTakeovers = extractHumanTakeoverEvents(payload, request);
  try {
    for (const takeover of humanTakeovers) {
      await autoPauseBotFromBusinessApp(takeover);
    }
  } catch (err) {
    console.error("human takeover failed", getErrorMessage(err));
    return new Response("takeover failed", { status: 500 });
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

  // Liberar reservas de pago vencidas antes de tocar disponibilidad: una cita
  // en `awaiting_payment` bloquea el slot, y el plan Hobby de Vercel solo
  // permite un cron diario — así que la expiración se hace acá, en cada mensaje
  // entrante. Es un solo UPDATE con filtro y no debe tumbar el webhook.
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

  // Barrera 1 reforzada: la pausa puede haber llegado durante el debounce.
  const currentPauseState = await getBotPauseState(conversationId);
  if (currentPauseState.paused) {
    console.log("ai turn omitted because bot is paused", { conversationId });
    return new Response("bot paused", { status: 200 });
  }

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

  // Ubicación/GPS: respuesta determinista para entregar siempre ambos datos.
  if (clinic.locationRequestIntentPatterns.test(newText)) {
    replyText = `📍 Nuestra dirección es: ${clinic.generalInfo.address}\n\n🗺️ Ubicación en Google Maps:\n${clinic.generalInfo.mapsUrl}`;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 2. Cargar sesión de reserva ───────────────────────────────────────────
  const session = await getBookingSession(conversationId);

  if (session.step === "idle" && GREETING_ONLY_PATTERN.test(newText)) {
    replyText = CLINIC_WELCOME_MESSAGE;
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    return new Response("ok", { status: 200 });
  }

  // ── 2b. Servicio del tarifario que NO es consulta ─────────────────────────
  // Ecografías, procedimientos, cirugías, partos, enfermería y certificados no
  // se agendan por WhatsApp: requieren valoración previa y el precio final
  // puede variar. Se informa el precio del tarifario y se le pregunta qué
  // horario le acomoda; con esa respuesta (paso 2c) se deriva a un asesor, que
  // es quien confirma la disponibilidad real. Las consultas (bookable) NO se
  // interceptan: siguen al flujo de agenda + pago de siempre.
  //
  // Va después de cargar la sesión a propósito: con una reserva en curso el
  // paciente puede escribir "ecografía" respondiendo otra cosa, y cortarle el
  // flujo ahí sería peor que no detectar el servicio.
  if (session.step === "idle" && newText.trim()) {
    const service = matchService(newText, clinic.services);
    if (service && !service.bookable) {
      const quote = formatServicePrice(service);
      await saveBookingSession({
        conversationId,
        business: clinic.slug,
        step: "awaiting_service_time",
        draft: { serviceName: service.name, serviceQuote: quote },
        hold: { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null },
      });
      replyText =
        `*${service.name}*: ${quote} 😊` +
        (service.note ? `\n_${service.note}_` : "") +
        "\n\n¿Qué día y en qué horario le quedaría cómodo? Con ese dato lo coordinamos con un asesor de la clínica. 🙏";
      await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
      return new Response("ok", { status: 200 });
    }
  }

  // ── 2c. Respuesta al horario preferido de un servicio no agendable ────────
  // Va ANTES del bloque de sesión activa a propósito: advanceBooking no conoce
  // este paso. Tres salidas: se arrepintió, dio un horario (→ asesor), o hizo
  // otra pregunta (se le responde y se le repregunta el horario).
  if (session.step === "awaiting_service_time" && newText.trim()) {
    const serviceName = session.draft.serviceName ?? "el servicio consultado";
    const serviceQuote = session.draft.serviceQuote;

    if (WANTS_OUT_PATTERN.test(newText)) {
      await saveBookingSession({
        conversationId,
        business: clinic.slug,
        step: "idle",
        draft: {},
        hold: { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null },
      });
      replyText = "Entendido 😊 Si más adelante desea coordinarlo, con gusto le ayudo. ¿Puedo ayudarle en algo más?";
      await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
      return new Response("ok", { status: 200 });
    }

    if (TIME_PREFERENCE_PATTERN.test(newText)) {
      await saveBookingSession({
        conversationId,
        business: clinic.slug,
        step: "idle",
        draft: {},
        hold: { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null },
      });
      await pauseBotForHumanHandoff(conversationId);
      await logSystemEvent({
        level: "info",
        eventType: "service_handoff_requested",
        business: clinic.slug,
        conversationId,
        contactPhone,
        metadata: { service: serviceName, preferredTime: newText.slice(0, 200) },
      });
      replyText =
        `¡Perfecto! 😊 Anoté *${serviceName}*${serviceQuote ? ` (${serviceQuote})` : ""} para *${newText.trim()}*.` +
        "\n\nLe paso toda la información a un asesor de la clínica para confirmarle la disponibilidad. En un momento se comunica con usted 🙏";
      await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
      return new Response("ok", { status: 200 });
    }

    // No dio un horario: es una duda. Se responde con el Q&A general y se
    // mantiene el paso (la sesión expira sola por TTL si abandona).
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
      replyText =
        (text.trim() || `Con gusto le ayudo con *${serviceName}* 😊`) +
        "\n\n_¿Qué día y en qué horario le quedaría cómodo? Así lo coordinamos con un asesor._";
    } catch {
      replyText = `Para coordinar *${serviceName}* dígame qué día y en qué horario le quedaría cómodo 😊`;
    }
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    return new Response("ok", { status: 200 });
  }

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

    // La reserva pudo vencer mientras el paciente iba a pagar: reenviarle el QR
    // sería cobrarle por un horario que ya se liberó.
    const appointmentGone =
      session.draft.appointmentId
        ? (await getAppointmentStatus(session.draft.appointmentId)) === "canceled"
        : false;

    if (asksForQr && appointmentGone) {
      replyText = [
        `Su reserva ya venció: el horario se aparta ${PAYMENT_WINDOW_MINUTES} minutos esperando el pago y luego vuelve a quedar disponible 😕`,
        ``,
        `Escríbanos *cita* y le buscamos un nuevo horario 😊`,
      ].join("\n");
      await saveBookingSession({
        conversationId,
        business: clinic.slug,
        step: "idle",
        draft: {},
        hold: { heldDoctorId: null, heldSlotStart: null, holdExpiresAt: null },
      });
      await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "none", lastMessage, clinic });
    } else if (asksForQr && clinic.qrImageUrl) {
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
    if (WANTS_OUT_PATTERN.test(newText)) {
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

  // ── 5c. Piden el QR sin estar agendando ───────────────────────────────────
  // Se llega acá solo con la sesión en idle (los pasos activos del flujo
  // retornan antes), así que es alguien que quiere pagar algo que no es
  // necesariamente una consulta. Se le manda el QR y NO se le abre un flujo de
  // cita que no pidió.
  if (clinic.qrRequestIntentPatterns.test(newText) && clinic.qrImageUrl) {
    replyText = [
      `Aquí tiene nuestro QR para el pago 😊`,
      ``,
      `Cuando realice el pago, envíenos la *foto del comprobante* por aquí y lo verificamos.`,
      ``,
      `Si el pago es para una consulta médica, escríbanos *cita* y le reservamos su horario.`,
    ].join("\n");
    await sendAndPersist({ kapso, phoneNumberId, contactPhone, conversationId, replyText, action: "send_qr", lastMessage, clinic });
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
    // Si el modelo no responde no dejamos al paciente sin salida ni le damos un
    // teléfono: se deriva de verdad, pausando el bot para que lo tome el equipo.
    await pauseBotForHumanHandoff(conversationId);
    replyText =
      "Disculpe, tuve un problema para procesar su consulta 🙏 Ya estamos derivando su petición a un asesor de la clínica, que le atenderá en un momento.";
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

  // Segunda barrera: una persona puede tomar el control mientras OpenAI procesa.
  const pauseState = await getBotPauseState(conversationId);
  if (pauseState.paused) {
    console.log("ai response omitted because bot is paused", { conversationId });
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
