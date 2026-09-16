// ============================================================================
// Comprobantes de pago que llegan por WhatsApp → listado de pagos del panel
// ----------------------------------------------------------------------------
// El bot ya no cobra ni envía el QR: eso lo hace un asesor después de confirmar
// la ficha. Pero el paciente igual manda comprobantes (muchas veces con el bot
// en pausa, mientras lo atiende una persona) y la clínica los quiere anotados
// para revisarlos. Por eso esto corre con el bot pausado o no.
//
// Imágenes: GPT-vision decide si es un comprobante y lee el monto. Si el
// análisis falla, se anota igual como "sin verificar": perder un pago es peor
// que revisar una foto de más. PDF y otros documentos no se pueden leer así y
// se anotan siempre para revisión manual.
// ============================================================================

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

import type { ClinicConfig } from "@/lib/clinic/config";
import { recordPaymentProof } from "@/lib/clinic/data";
import type { IncomingMessage } from "@/lib/engine/messages";

const MAX_PROOF_BYTES = 8 * 1024 * 1024; // 8 MB

// receipt: la IA confirmó que es un comprobante · unverified: se anotó sin poder
// verificarlo · null: no es un comprobante (o el mensaje no trae archivo).
export type IncomingProofResult = "receipt" | "unverified" | null;

type Classification = {
  result: "receipt" | "unverified" | "not_receipt";
  amount: number | null;
  note: string | null;
};

async function classifyImage(mediaUrl: string): Promise<Classification> {
  try {
    const res = await fetch(mediaUrl, {
      headers: process.env.KAPSO_API_KEY ? { "X-API-Key": process.env.KAPSO_API_KEY } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { result: "unverified", amount: null, note: `⚠️ No se pudo descargar la imagen (HTTP ${res.status}): revisar si es un comprobante.` };
    }
    if (Number(res.headers.get("content-length") ?? 0) > MAX_PROOF_BYTES) {
      return { result: "unverified", amount: null, note: "⚠️ Imagen demasiado grande para analizarla: revisar si es un comprobante." };
    }

    const image = new Uint8Array(await res.arrayBuffer());
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image },
            {
              type: "text",
              text: `¿Esta imagen es un comprobante de pago, de transferencia bancaria o de pago por QR (Bolivia)? Respondé ÚNICAMENTE con un JSON: {"es_comprobante": true|false, "monto": <monto total pagado en Bs como número, o null si no se lee>}`,
            },
          ],
        },
      ],
      temperature: 0,
      abortSignal: AbortSignal.timeout(15000),
    });

    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, "").trim());
    if (parsed?.es_comprobante !== true) return { result: "not_receipt", amount: null, note: null };

    const amount = typeof parsed.monto === "number" && Number.isFinite(parsed.monto) ? parsed.monto : null;
    return { result: "receipt", amount, note: amount === null ? "No se pudo leer el monto: revisar el comprobante." : null };
  } catch (err) {
    console.error("classifyImage failed", err);
    return { result: "unverified", amount: null, note: "⚠️ Falló el análisis automático: revisar si es un comprobante." };
  }
}

export async function registerIncomingProof(params: {
  clinic: ClinicConfig;
  message: IncomingMessage;
  conversationId: string;
  contactPhone: string;
  contactName: string | null;
}): Promise<IncomingProofResult> {
  const { clinic, message, conversationId, contactPhone, contactName } = params;
  if (!message.mediaUrl || (message.mediaType !== "image" && message.mediaType !== "document")) return null;

  const classification: Classification =
    message.mediaType === "image"
      ? await classifyImage(message.mediaUrl)
      : { result: "unverified", amount: null, note: "📄 Documento (PDF u otro): revisar si es un comprobante." };

  if (classification.result === "not_receipt") return null;

  await recordPaymentProof({
    business: clinic.slug,
    conversationId,
    messageId: message.messageId ?? null,
    contactPhone,
    contactName,
    mediaUrl: message.mediaUrl,
    mediaType: message.mediaType,
    detectedAmount: classification.amount,
    aiNote: classification.note,
  });

  return classification.result;
}
