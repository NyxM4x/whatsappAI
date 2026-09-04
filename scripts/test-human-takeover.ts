// ============================================================================
// Tests del human takeover (sin base de datos).
// ----------------------------------------------------------------------------
// Cubren las dos mitades del fallo original:
//   * CLASIFICACIÓN — qué evento de Kapso pausa el bot (A–D).
//   * IDENTIDAD/TTL — dónde se guarda la pausa y cuándo se renueva (E–I).
//
// La segunda mitad usa un repositorio en memoria que implementa el mismo puerto
// (HumanTakeoverRepo) que la implementación real de Supabase, así que se prueba
// el orden de operaciones, la idempotencia y la monotonía del TTL de verdad.
//
// Correr: npm test
// ============================================================================

import assert from "node:assert/strict";

import {
  extractHumanTakeoverEvent,
  extractHumanTakeoverEvents,
} from "@/lib/engine/messages";
import { normalizePhone, samePhoneIdentity } from "@/lib/engine/phone";
import {
  applyHumanTakeover,
  computeTakeoverPause,
  getHumanTakeoverMinutes,
  resolveBotPauseState,
  type DurablePauseRow,
  type HumanTakeoverRepo,
  type LegacyPauseRow,
} from "@/lib/engine/data";

const results: string[] = [];
function pass(name: string) {
  results.push(name);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HUMAN_TS = "1787753046"; // 2026-08-26T14:04:06.000Z
const HUMAN_TS_ISO = "2026-08-26T14:04:06.000Z";

function humanEvent(over: Record<string, any> = {}) {
  return {
    type: "whatsapp.message.sent",
    message: {
      id: "wamid.test-1",
      timestamp: HUMAN_TS,
      kapso: { direction: "outbound", origin: "business_app" },
    },
    conversation: { id: "technical-id", phone_number: "59170000000" },
    ...over,
  };
}

function req(headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/webhooks/clinica", {
    method: "POST",
    headers,
  });
}

// ─── A. El header X-Webhook-Event identifica el evento sin `type` en el body ──

{
  const { type: _omitted, ...bodyWithoutType } = humanEvent();
  assert.equal((bodyWithoutType as any).type, undefined);

  const detected = extractHumanTakeoverEvents(
    bodyWithoutType,
    req({ "X-Webhook-Event": "whatsapp.message.sent" }),
  );

  assert.equal(detected.length, 1, "el header debe poder identificar el evento");
  assert.deepEqual(detected[0], {
    conversationId: "technical-id",
    customerPhone: "59170000000",
    customerPhoneNormalized: "59170000000",
    providerMessageId: "wamid.test-1",
    messageTimestamp: HUMAN_TS_ISO,
  });

  // Sin header y sin `type` en el body no hay clasificación posible.
  assert.equal(extractHumanTakeoverEvents(bodyWithoutType, req()).length, 0);

  // Compatibilidad: el body sigue mandando y sigue funcionando solo.
  assert.equal(extractHumanTakeoverEvents(humanEvent(), req()).length, 1);
  assert.ok(extractHumanTakeoverEvent(humanEvent()));

  // El body gana sobre el header (no se degrada lo que ya funcionaba).
  assert.equal(
    extractHumanTakeoverEvents(
      humanEvent({ type: "whatsapp.message.read" }),
      req({ "X-Webhook-Event": "whatsapp.message.sent" }),
    ).length,
    0,
  );

  // Variantes históricas del nombre en el body.
  for (const key of ["event", "name"]) {
    const { type: _t, ...rest } = humanEvent();
    assert.equal(
      extractHumanTakeoverEvents({ ...rest, [key]: "whatsapp.message.sent" }, req()).length,
      1,
      `event.${key} debe seguir soportado`,
    );
  }

  pass("A. X-Webhook-Event identifica el evento sin `type` en el body");
}

// ─── B. cloud_api (el propio bot) NO pausa ───────────────────────────────────

{
  const botEcho = humanEvent({
    message: {
      id: "wamid.bot-1",
      timestamp: HUMAN_TS,
      kapso: { direction: "outbound", origin: "cloud_api" },
    },
  });

  assert.equal(extractHumanTakeoverEvent(botEcho), null);
  assert.equal(
    extractHumanTakeoverEvents(botEcho, req({ "X-Webhook-Event": "whatsapp.message.sent" })).length,
    0,
    "el header no puede convertir un envío del bot en takeover",
  );

  pass("B. outbound + cloud_api no pausa");
}

// ─── C. delivered / read / failed / inbound / desconocido NO pausan ──────────

{
  for (const type of [
    "whatsapp.message.delivered",
    "whatsapp.message.read",
    "whatsapp.message.failed",
    "whatsapp.message.received",
    "whatsapp.something.unknown",
  ]) {
    assert.equal(extractHumanTakeoverEvent(humanEvent({ type })), null, `${type} no debe pausar`);
    assert.equal(
      extractHumanTakeoverEvents(humanEvent({ type }), req({ "X-Webhook-Event": type })).length,
      0,
      `${type} no debe pausar ni por header`,
    );
  }

  // inbound (el paciente) tampoco.
  assert.equal(
    extractHumanTakeoverEvent(
      humanEvent({
        message: {
          id: "wamid.in-1",
          timestamp: HUMAN_TS,
          kapso: { direction: "inbound", origin: "business_app" },
        },
      }),
    ),
    null,
  );

  // Campos incompletos: sin conversation.id o sin teléfono no hay identidad.
  assert.equal(extractHumanTakeoverEvent(humanEvent({ conversation: { id: "technical-id" } })), null);
  assert.equal(
    extractHumanTakeoverEvent(humanEvent({ conversation: { id: "x", phone_number: "+++" } })),
    null,
    "un teléfono sin dígitos no produce identidad durable",
  );

  pass("C. delivered/read/failed/inbound/desconocido no pausan");
}

// ─── D. Batch: solo los business_app sent generan takeover ───────────────────

{
  const batch = {
    batch: true,
    data: [
      humanEvent({ type: "whatsapp.message.delivered" }),
      humanEvent({
        message: {
          id: "wamid.human-a",
          timestamp: HUMAN_TS,
          kapso: { direction: "outbound", origin: "business_app" },
        },
        conversation: { id: "conv-a", phone_number: "+591 70000000" },
      }),
      humanEvent({
        message: {
          id: "wamid.bot",
          timestamp: HUMAN_TS,
          kapso: { direction: "outbound", origin: "cloud_api" },
        },
      }),
      humanEvent({
        message: {
          id: "wamid.human-b",
          timestamp: HUMAN_TS,
          kapso: { direction: "outbound", origin: "business_app" },
        },
        conversation: { id: "conv-b", phone_number: "59180000000" },
      }),
    ],
  };

  const detected = extractHumanTakeoverEvents(batch, req({ "x-webhook-batch": "true" }));
  assert.deepEqual(
    detected.map((e) => e.providerMessageId),
    ["wamid.human-a", "wamid.human-b"],
  );
  assert.equal(detected[0].customerPhoneNormalized, "59170000000");

  // Un header de envoltorio NO puede promover a todos los eventos del lote.
  const promoted = extractHumanTakeoverEvents(
    { batch: true, data: [humanEvent({ type: "whatsapp.message.read" })] },
    req({ "x-webhook-batch": "true", "X-Webhook-Event": "whatsapp.message.sent" }),
  );
  assert.equal(promoted.length, 0, "en batch cada evento se clasifica por su propio body");

  pass("D. batch: solo business_app + sent generan takeover");
}

// ─── E. +591... y 591... son la MISMA identidad ──────────────────────────────

{
  assert.equal(normalizePhone("+59170000000"), "59170000000");
  assert.equal(normalizePhone("59170000000"), "59170000000");
  assert.equal(normalizePhone("+591 7000-0000"), "59170000000");
  assert.equal(normalizePhone("(591) 7.000.0000"), "59170000000");
  assert.ok(samePhoneIdentity("+59170000000", "59170000000"));

  // No destructiva: no inventa ni recorta código de país.
  assert.equal(normalizePhone("70000000"), "70000000");
  assert.ok(!samePhoneIdentity("70000000", "59170000000"));

  // Sin dígitos no hay identidad.
  assert.equal(normalizePhone("+"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);

  // Misma identidad saliendo del clasificador, con formatos distintos.
  const a = extractHumanTakeoverEvent(
    humanEvent({ conversation: { id: "conv-a", phone_number: "+59170000000" } }),
  );
  const b = extractHumanTakeoverEvent(
    humanEvent({ conversation: { id: "conv-b", phone_number: "59170000000" } }),
  );
  assert.equal(a?.customerPhoneNormalized, b?.customerPhoneNormalized);

  pass("E. +591... y 591... resuelven a la misma identidad durable");
}

// ─── Repositorio en memoria (mismo puerto que Supabase) ──────────────────────

type FakeStore = {
  pauseState: Map<string, DurablePauseRow>;
  conversations: Map<string, { contact_phone: string } & LegacyPauseRow>;
  controlEvents: { identity: string; action: string; providerMessageId: string }[];
  messages: string[];
};

function makeRepo(overrides: Partial<HumanTakeoverRepo> = {}) {
  const store: FakeStore = {
    pauseState: new Map(),
    conversations: new Map(),
    controlEvents: [],
    messages: [],
  };

  const repo: HumanTakeoverRepo = {
    async hasPauseEventForWamid(identity, providerMessageId) {
      return store.controlEvents.some(
        (e) =>
          e.identity === identity && e.action === "pause" && e.providerMessageId === providerMessageId,
      );
    },
    async getDurablePause(identity) {
      return store.pauseState.get(identity) ?? null;
    },
    async writeDurablePause(row) {
      store.pauseState.set(row.contact_phone_normalized, {
        ...store.pauseState.get(row.contact_phone_normalized),
        ...row,
      });
    },
    async mirrorConversationPause({ identity, conversationId, contactPhone, fields }) {
      const existing = store.conversations.get(conversationId);
      store.conversations.set(conversationId, {
        contact_phone: existing?.contact_phone ?? contactPhone,
        ...existing,
      });
      // Espeja sobre todas las conversaciones del mismo teléfono.
      for (const [id, row] of store.conversations) {
        if (normalizePhone(row.contact_phone) === identity) {
          store.conversations.set(id, { ...row, ...fields });
        }
      }
    },
    async insertPauseControlEvent({ identity, providerMessageId }) {
      const duplicate = store.controlEvents.some(
        (e) =>
          e.identity === identity && e.action === "pause" && e.providerMessageId === providerMessageId,
      );
      if (duplicate) return { duplicate: true };
      store.controlEvents.push({ identity, action: "pause", providerMessageId });
      return { duplicate: false };
    },
    async saveHumanMessage({ providerMessageId }) {
      store.messages.push(providerMessageId);
    },
    ...overrides,
  };

  return { repo, store };
}

const MINUTES = 30;
const T0 = Date.parse("2026-08-26T14:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ─── F. La pausa sobrevive a un cambio de conversation.id ────────────────────

{
  const { repo, store } = makeRepo();

  // Takeover con conversation.id = A y teléfono en formato "+591 ...".
  const takeover = extractHumanTakeoverEvent(
    humanEvent({
      message: {
        id: "wamid.human-1",
        timestamp: HUMAN_TS,
        kapso: { direction: "outbound", origin: "business_app" },
      },
      conversation: { id: "conv-A", phone_number: "+591 70000000" },
    }),
  )!;

  const result = await applyHumanTakeover(repo, takeover, { nowMs: T0, minutes: MINUTES });
  assert.equal(result.applied, true);
  assert.equal(result.outcome, "applied");
  assert.equal(result.identity, "59170000000");

  // Nuevo inbound del MISMO paciente, con conversation.id = B (sin formato "+").
  store.conversations.set("conv-B", { contact_phone: "59170000000" });

  const durable = store.pauseState.get(normalizePhone("59170000000")!)!;
  const stateFromB = resolveBotPauseState({
    durable,
    legacy: store.conversations.get("conv-B"),
    nowMs: T0 + 60_000,
  });

  assert.equal(stateFromB.paused, true, "la conversación debe seguir pausada con conv-B");
  assert.equal(stateFromB.expired, false);
  assert.equal(stateFromB.source, "durable");

  // Demuestra la regresión original: mirando SOLO la fila de conv-B, el bot
  // habría creído que no estaba pausado y habría respondido por encima.
  const legacyOnly = resolveBotPauseState({
    legacy: store.conversations.get("conv-B"),
    nowMs: T0 + 60_000,
  });
  assert.equal(legacyOnly.paused, false);

  pass("F. la pausa sobrevive al cambio de conversation.id (A → B)");
}

// ─── G. Mismo WAMID reentregado → duplicate y NO renueva TTL ─────────────────

{
  const { repo, store } = makeRepo();
  const identity = "59170000000";

  const takeover = {
    conversationId: "conv-A",
    customerPhone: "+59170000000",
    customerPhoneNormalized: identity,
    providerMessageId: "wamid.human-1",
    messageTimestamp: iso(T0),
  };

  const first = await applyHumanTakeover(repo, takeover, { nowMs: T0, minutes: MINUTES });
  const expiryAfterFirst = store.pauseState.get(identity)!.bot_pause_expires_at;
  assert.equal(first.applied, true);
  assert.equal(expiryAfterFirst, iso(T0 + MINUTES * 60_000));

  // Reentrega del MISMO WAMID, 10 minutos más tarde.
  const second = await applyHumanTakeover(repo, takeover, {
    nowMs: T0 + 10 * 60_000,
    minutes: MINUTES,
  });

  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
  assert.equal(second.outcome, "duplicate_wamid");
  assert.equal(
    store.pauseState.get(identity)!.bot_pause_expires_at,
    expiryAfterFirst,
    "una reentrega no puede renovar el TTL",
  );
  assert.equal(store.controlEvents.length, 1, "no se duplica el control event");
  assert.equal(store.messages.length, 1, "no se duplica el mensaje humano");

  pass("G. mismo WAMID → duplicate, sin renovar TTL");
}

// ─── H. WAMID nuevo → renueva el TTL ─────────────────────────────────────────

{
  const { repo, store } = makeRepo();
  const identity = "59170000000";

  await applyHumanTakeover(
    repo,
    {
      conversationId: "conv-A",
      customerPhone: identity,
      customerPhoneNormalized: identity,
      providerMessageId: "wamid.human-1",
      messageTimestamp: iso(T0),
    },
    { nowMs: T0, minutes: MINUTES },
  );
  const firstExpiry = store.pauseState.get(identity)!.bot_pause_expires_at!;

  // Segundo mensaje humano, 10 minutos después y con otro conversation.id.
  const second = await applyHumanTakeover(
    repo,
    {
      conversationId: "conv-B",
      customerPhone: `+${identity}`,
      customerPhoneNormalized: identity,
      providerMessageId: "wamid.human-2",
      messageTimestamp: iso(T0 + 10 * 60_000),
    },
    { nowMs: T0 + 10 * 60_000, minutes: MINUTES },
  );

  const renewed = store.pauseState.get(identity)!.bot_pause_expires_at!;
  assert.equal(second.applied, true);
  assert.equal(second.duplicate, false);
  assert.equal(renewed, iso(T0 + 40 * 60_000));
  assert.ok(Date.parse(renewed) > Date.parse(firstExpiry), "un WAMID nuevo debe renovar el TTL");
  assert.equal(store.pauseState.size, 1, "sigue habiendo una sola identidad durable");

  pass("H. WAMID humano nuevo renueva el TTL");
}

// ─── I. Un evento viejo nunca acorta la pausa vigente ────────────────────────

{
  const { repo, store } = makeRepo();
  const identity = "59170000000";

  await applyHumanTakeover(
    repo,
    {
      conversationId: "conv-A",
      customerPhone: identity,
      customerPhoneNormalized: identity,
      providerMessageId: "wamid.human-recent",
      messageTimestamp: iso(T0 + 20 * 60_000),
    },
    { nowMs: T0 + 20 * 60_000, minutes: MINUTES },
  );
  const expiry = store.pauseState.get(identity)!.bot_pause_expires_at!;
  assert.equal(expiry, iso(T0 + 50 * 60_000));

  // Llega, tarde y desordenado, un mensaje humano ANTERIOR.
  const late = await applyHumanTakeover(
    repo,
    {
      conversationId: "conv-A",
      customerPhone: identity,
      customerPhoneNormalized: identity,
      providerMessageId: "wamid.human-old",
      messageTimestamp: iso(T0),
    },
    { nowMs: T0 + 21 * 60_000, minutes: MINUTES },
  );

  assert.equal(late.applied, true);
  assert.equal(
    store.pauseState.get(identity)!.bot_pause_expires_at,
    expiry,
    "un evento viejo no puede reducir el expiry existente",
  );

  // Monotonía a nivel de la función pura.
  const decision = computeTakeoverPause({
    current: { contact_phone_normalized: identity, bot_paused: true, bot_pause_expires_at: iso(T0 + 50 * 60_000) },
    eventTimestamp: iso(T0),
    nowMs: T0 + 21 * 60_000,
    minutes: MINUTES,
  });
  assert.equal(decision.kind, "apply");
  assert.equal(decision.expiresAt, iso(T0 + 50 * 60_000));

  pass("I. un evento viejo no reduce el expiry existente");
}

// ─── J. Una pausa manual indefinida no se degrada a temporal ─────────────────

{
  const { repo, store } = makeRepo();
  const identity = "59170000000";

  store.pauseState.set(identity, {
    contact_phone_normalized: identity,
    bot_paused: true,
    bot_pause_expires_at: null,
    bot_paused_reason: "manual_pause",
    bot_pause_mode: "manual",
  });

  const result = await applyHumanTakeover(
    repo,
    {
      conversationId: "conv-A",
      customerPhone: identity,
      customerPhoneNormalized: identity,
      providerMessageId: "wamid.human-1",
      messageTimestamp: iso(T0),
    },
    { nowMs: T0, minutes: MINUTES },
  );

  assert.equal(result.outcome, "manual_pause_kept");
  const row = store.pauseState.get(identity)!;
  assert.equal(row.bot_pause_expires_at, null, "la pausa manual sigue siendo indefinida");
  assert.equal(row.bot_pause_mode, "manual");
  assert.equal(resolveBotPauseState({ durable: row, nowMs: T0 + 10 * 24 * 3600_000 }).expired, false);

  pass("J. una pausa manual indefinida no se convierte en temporal");
}

// ─── K. La pausa sobrevive a un fallo al guardar el mensaje humano ───────────

{
  const { repo, store } = makeRepo({
    async saveHumanMessage() {
      throw new Error("kapso_messages insert failed");
    },
  });

  const result = await applyHumanTakeover(
    repo,
    {
      conversationId: "conv-A",
      customerPhone: "59170000000",
      customerPhoneNormalized: "59170000000",
      providerMessageId: "wamid.human-1",
      messageTimestamp: iso(T0),
    },
    { nowMs: T0, minutes: MINUTES },
  );

  assert.equal(result.applied, true, "un fallo auxiliar no puede perder la pausa");
  assert.equal(store.pauseState.get("59170000000")!.bot_paused, true);

  pass("K. un fallo al persistir el mensaje no pierde la pausa");
}

// ─── L. Expiración y TTL configurable ────────────────────────────────────────

{
  const expiredRow: DurablePauseRow = {
    contact_phone_normalized: "59170000000",
    bot_paused: true,
    bot_pause_expires_at: iso(T0),
    bot_pause_mode: "auto",
  };

  const before = resolveBotPauseState({ durable: expiredRow, nowMs: T0 - 1 });
  assert.equal(before.paused, true);
  assert.equal(before.expired, false);

  const after = resolveBotPauseState({ durable: expiredRow, nowMs: T0 + 1 });
  assert.equal(after.paused, true);
  assert.equal(after.expired, true, "vencida debe reportarse como expirada, no como vigente");

  // HUMAN_TAKEOVER_PAUSE_MINUTES: default 30, rango 1–1440.
  const original = process.env.HUMAN_TAKEOVER_PAUSE_MINUTES;
  try {
    for (const [value, expected] of [
      [undefined, 30],
      ["", 30],
      ["0", 30],
      ["1441", 30],
      ["abc", 30],
      ["12.5", 30],
      ["1", 1],
      ["45", 45],
      ["1440", 1440],
    ] as [string | undefined, number][]) {
      if (value === undefined) delete process.env.HUMAN_TAKEOVER_PAUSE_MINUTES;
      else process.env.HUMAN_TAKEOVER_PAUSE_MINUTES = value;
      assert.equal(getHumanTakeoverMinutes(), expected, `HUMAN_TAKEOVER_PAUSE_MINUTES=${value}`);
    }
  } finally {
    if (original === undefined) delete process.env.HUMAN_TAKEOVER_PAUSE_MINUTES;
    else process.env.HUMAN_TAKEOVER_PAUSE_MINUTES = original;
  }

  pass("L. expiración correcta y TTL configurable (default 30, rango 1–1440)");
}

console.log(results.map((r) => `  ✓ ${r}`).join("\n"));
console.log(`\nhuman takeover: ${results.length} tests passed`);
