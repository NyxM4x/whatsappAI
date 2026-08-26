import assert from "node:assert/strict";
import { extractHumanTakeoverEvent } from "@/lib/engine/messages";

const base = {
  type: "whatsapp.message.sent",
  message: {
    id: "wamid.test-1",
    timestamp: "1787753046",
    kapso: { direction: "outbound", origin: "business_app" },
  },
  conversation: {
    id: "technical-id",
    phone_number: "59165006685",
  },
};

assert.deepEqual(extractHumanTakeoverEvent(base), {
  conversationId: "technical-id",
  customerPhone: "59165006685",
  providerMessageId: "wamid.test-1",
  messageTimestamp: "2026-08-26T14:04:06.000Z",
});

for (const event of [
  { ...base, type: "whatsapp.message.delivered" },
  { ...base, type: "whatsapp.message.read" },
  { ...base, type: "whatsapp.message.failed" },
  { ...base, message: { ...base.message, kapso: { direction: "outbound", origin: "cloud_api" } } },
  { ...base, message: { ...base.message, kapso: { direction: "inbound", origin: "business_app" } } },
]) {
  assert.equal(extractHumanTakeoverEvent(event), null);
}

assert.equal(extractHumanTakeoverEvent({ ...base, conversation: { id: "technical-id" } }), null);
console.log("human takeover classifier tests passed");