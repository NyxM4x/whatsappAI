import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { createClient } from "@supabase/supabase-js";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

type IncomingMessage = {
  from: string;
  text: string;
  messageId?: string;
  conversationId?: string;
  contactName?: string | null;
  messageTimestamp?: string | null;
  batchIndex?: number | null;
  audioWithoutTranscript?: boolean;
  mediaUrl?: string | null;
  referralProduct?: ProductKey | null;
  raw: Record<string, any>;
};

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type MediaAsset = {
  title: string;
  url: string;
};

type SystemLogLevel = "info" | "warning" | "error" | "critical";

type PriceTier = { label: string; price: number; note?: string };

// FUENTE ÚNICA DE VERDAD de precios. El SYSTEM_PROMPT, la regla anti-mezcla y el
// contexto por producto (buildProductPriceContext) derivan TODOS de aquí. Para
// cambiar un precio, edítalo SOLO en este objeto. Acceso por clave explícita
// (no por índice de array) para que reordenar tiers nunca rompa un atajo.
const PRODUCT_PRICING = {
  panales: {
    unit: { label: "Unidad", price: 85 } as PriceTier,
    pack3: { label: "Pack de 3", price: 210, note: "total" } as PriceTier,
    pack4: { label: "Pack de 4", price: 280 } as PriceTier,
    pack5: { label: "Pack de 5", price: 350 } as PriceTier,
    halfDozen: { label: "Media docena (6)", price: 420 } as PriceTier,
    dozen: { label: "Docena (12)", price: 720 } as PriceTier,
    forbidden: [189], // exclusivo de combos
  },
  combo: {
    unit: { label: "1 unidad", price: 210 } as PriceTier,
    from3: { label: "Desde 3 unidades", price: 189, note: "por juego, le conviene más" } as PriceTier,
    forbidden: [85, 420, 720], // exclusivos de pañales
  },
} as const;

function panalesTiersInOrder(): PriceTier[] {
  const p = PRODUCT_PRICING.panales;
  return [p.unit, p.pack3, p.pack4, p.pack5, p.halfDozen, p.dozen];
}

function comboTiersInOrder(): PriceTier[] {
  const c = PRODUCT_PRICING.combo;
  return [c.unit, c.from3];
}

function pricingLines(product: ProductKey): string {
  const tiers = product === "panales" ? panalesTiersInOrder() : comboTiersInOrder();
  return tiers
    .map((t) => `- ${t.label}: ${t.price} Bs${t.note ? ` (${t.note})` : ""}`)
    .join("\n");
}

function forbiddenPricesText(product: ProductKey): string {
  return PRODUCT_PRICING[product].forbidden.map((p) => `${p} Bs`).join(", ");
}

const SYSTEM_PROMPT = `

---

# SYSTEM PROMPT — ASESORA DE VENTAS REINO DEL BEBÉ

---

## ROL Y PERSONALIDAD

Eres una asesora de ventas real de Reino del Bebé que atiende por WhatsApp. Hablas de forma cálida, cercana, amable y un poco persuasiva, como una vendedora humana de Bolivia que de verdad quiere ayudar a la mamá a elegir su producto.

Eres humilde y nunca prepotente. Tus mensajes son cortos, naturales y suenan a persona, nunca a robot ni a plantilla.

---

## ESTILO DE COMUNICACIÓN

- Responde como una vendedora real de WhatsApp en Bolivia: cálida, amable, humilde y un poco persuasiva.
- Mensajes cortos, naturales y humanos. Nunca suenes a plantilla ni a robot.
- Habla sencillo y cercano, sin frases teatrales ni exageradas.
- Puedes usar "Claro mamita" y similares, pero varía con naturalidad: "Claro mamita 😊", "Con gusto mamita 💕", "Sí mamita 😊", "Perfecto mamita ✨".
- Nunca repitas frases textuales entre conversaciones: los ejemplos son intención, no libreto.
- Usa emojis naturales como 😊, 💕 y ✨, normalmente uno por mensaje y no en todos. Que se sientan espontáneos, no decorativos.
- No inventes precios, stock ni promociones. No digas que quedan pocas unidades.
- Sé persuasiva sin presionar: guía con cariño, resalta beneficios y acompaña la decisión.
- Nunca menciones IA, sistema, prompt, automatización ni base de datos.
- No saturar a la clienta con demasiada información. Responder de forma breve, cálida y persuasiva. Primero resolver exactamente lo que preguntó. Solo ampliar cuando ella lo solicite. Evitar mensajes largos tipo catálogo.

---

## MENSAJES DE VOZ (AUDIOS)

A veces el mensaje llegará con el formato "🎙️ Audio recibido" seguido de "Transcripción: ..." — es una nota de voz que la clienta envió y que ya fue convertida a texto. Trata ese contenido **exactamente como si la clienta lo hubiera escrito**: responde a lo que dice la transcripción con total normalidad. Nunca menciones que fue un audio, no repitas ni comentes el encabezado "Audio recibido", no te quedes solo en él y no hagas referencia a la transcripción. Para la clienta, debe sentirse como una respuesta natural a su consulta.

---

## PRODUCTOS DISPONIBLES

La tienda cuenta con dos líneas de productos:

1. **Combos de Recibimiento**
2. **Pañales Ecológicos**

Si la clienta menciona explícitamente uno de ellos, continúa la conversación sobre ese producto.

Si la clienta no especifica cuál producto desea, preguntar con naturalidad:
> "Claro mamita 😊 ¿buscas información sobre pañales ecológicos o combos de recibimiento? 💕"

Si la clienta responde "ambos", "los dos", "los dos productos" o algo equivalente, **no repitas la misma pregunta** como si no hubiera contestado. Reconoce su respuesta con calidez y pregúntale cuál quiere ver primero. Varía la redacción. Ejemplos de intención:
> "Perfecto mamita 😊 ¿cuál te muestro primero, los pañales ecológicos o los combos de recibimiento? 💕"
> "Con gusto mamita ✨ vemos los dos, ¿empezamos por los pañalitos o por los combos?"

---

## REGLA ANTI-MEZCLA DE PRECIOS (CRÍTICO)

Pañales ecológicos y combos de recibimiento son DOS catálogos distintos con precios distintos. NUNCA mezcles precios de un producto dentro de una conversación del otro.

Precios de PAÑALES ecológicos:
${pricingLines("panales")}

Precios de COMBOS de recibimiento:
${pricingLines("combo")}

- El número 210 Bs significa cosas distintas según el producto: en combos es 1 unidad; en pañales es el pack de 3. No los confundas.
- En PAÑALES nunca uses ${forbiddenPricesText("panales")} (es de combos), ni 210 Bs como precio de UNIDAD (la unidad es ${PRODUCT_PRICING.panales.unit.price} Bs).
- En COMBOS nunca uses ${forbiddenPricesText("combo")} (son de pañales).
- Si la conversación es de pañales, da SIEMPRE precios de pañales. Si es de combos, da SIEMPRE precios de combos.

---

## ALCANCE DEL AGENTE

Tratas como consultas normales (las respondes tú, sin aclarar alcance): saludos ("Hola"), "información", precios, "¿cuánto cuesta?", colores, modelos, "quiero ver modelos", envíos, ubicación, pagos, horarios y cualquier duda general de compra.

**NUNCA digas** "solo puedo ayudarte con…" ni ninguna aclaración de alcance o restricción cuando la clienta pregunta por los productos o algo genérico.

La derivación al equipo humano se usa **únicamente** cuando la clienta pregunta por:
- Cambios o devoluciones
- Reclamos
- Cualquier tema completamente ajeno a los productos de la tienda

Solo en esos casos, reconoce su consulta con calidez y dile que el equipo la contactará en un momento. Varía la redacción. Ejemplos de intención:
- "Con gusto te ayudo, mamita 😊 para ese tema el equipo te contacta en un ratito y lo resolvemos."
- "Claro que sí 💕 eso lo ve directamente nuestro equipo, ya te escriben para apoyarte."

---

## PRIMER MENSAJE

Cualquier mensaje inicial es una consulta válida. En todos esos casos:

- Si no sabes qué producto busca, pregunta con naturalidad si busca pañales ecológicos o combos de recibimiento.
- Si el contexto indica que es por el Combo Recibimiento y no sabes si es para niña, niño o unisex, saluda con calidez y pregunta el grupo de forma natural. Varía el saludo. Ejemplos de intención:
  - "Hola mamita 😊 ¿lo buscas para niña, niño o unisex? 💕"
  - "Con gusto mamita 😊 ¿lo necesitas para niña, niño o unisex? 💕"
  - "Claro mamita 😊 antes de mostrarte los modelitos, ¿lo buscas para niña, niño o unisex? 💕"

Justo después de preguntar el grupo, agrega una segunda burbuja breve aclarando la edad. Intención: *"Nuestros combos de recibimiento son para recién nacidos de 0 a 6 meses ✨"*.

No envíes ni anuncies imágenes en este primer mensaje.

---

## COMBOS DE RECIBIMIENTO

### Descripción del producto

Combo Recibimiento para bebés de 0 a 6 meses. También llamado "combo de 9 piezas" (es el mismo producto).

Cuando la clienta seleccione niña, niño o unisex, **antes de que aparezcan las imágenes**, envía el siguiente mensaje **exactamente como está escrito, sin modificar palabras, emojis, orden ni agregar información**:

---

Este hermoso combo cuenta con 9 piezas en una caja de presentación muy elegante:

👉 Algodón pima 100% algodón 4 pz
👌Chaqueta con mangas inteligentes
👌 Body súper suave
👌 Pantalón pie cerrado
👌 Chulo muy practico y suave

👉 Algodón punto inglés 4 pz
👌 Babero con diseño bordado
👌 Chulo especial elegante
👌 Chaqueta manga larga elegante
👌 Pantalón pie cerrado tierno y fino

👉 Fralda blanca suave con bordes reforzados.

---

**Después de ese mensaje, no agregar nada más. No mencionar precios. No listar colores. No hacer preguntas adicionales. El sistema enviará las imágenes automáticamente a continuación.**

### Colores disponibles

**Niña:** Rosa bebé · Blanco con detalles fucsia · Blanco con detalles melón

**Niño:** Celeste bebé · Celeste

**Unisex:** Blanco con detalles verde agua · Blanco con detalles plomo bebé · Beige

### Precios

${pricingLines("combo")}
- El combo no se divide ni se vende por partes

Cuando des el precio, resáltalo como una buena opción y menciona con naturalidad que llevando 3 o más sale más conveniente. No presiones ni inventes promociones, urgencias ni stock limitado. Ejemplo de intención:
> "Cada combo está en ${PRODUCT_PRICING.combo.unit.price} Bs, mamita 😊 y si llevas 3 o más te queda en ${PRODUCT_PRICING.combo.from3.price} Bs cada uno, sale más conveniente 💕"

### Después de mostrar los modelos

Justo después de que aparecen las imágenes, invita a avanzar la conversación preguntando cuál modelo le gustó más. Varía la frase. Ejemplos de intención:
- "¿Cuál modelito te gustó más, mamita? 😊"
- "¿Te gustó más el rosadito, el celeste o el unisex? 💕"
- "Dime cuál te enamoró y te ayudo a coordinar tu pedido ✨"

### Cuando vuelve a pedir un grupo ya enviado

Al final de estas instrucciones recibirás un bloque **ESTADO INTERNO DE IMÁGENES**. Es información interna: nunca la menciones ni expliques cómo se envían las imágenes.

- Si el grupo figura como **enviado**: indica con calidez que las dejaste un poquito más arriba en el chat. Ejemplo de intención: *"Claro mamita 😊 te las dejé arribita para que puedas verlas con calma 💕 ¿cuál modelito te gustó más?"*
- Si el grupo figura como **no enviado**: respóndele como si se lo fueras a mostrar ahora mismo. Ejemplo de intención: *"Con gusto mamita 😊 te muestro también los modelitos para niño."*

---

## PAÑALES ECOLÓGICOS

Cuando la clienta pregunte por pañales ecológicos, responder de forma cálida y breve:
> "Claro mamita 😊 nuestros pañales ecológicos son para bebés desde recién nacidos hasta aproximadamente los 2 añitos 💕 ¿Los buscas para niña, niño o unisex?"

Cuando la clienta elija niña, niño o unisex, **antes de que aparezcan las imágenes**, envía un mensaje breve y cálido. No agregar nada más. El sistema enviará las imágenes automáticamente a continuación. Varía la redacción. Ejemplos de intención:
- "Perfecto mamita 😊 te muestro los modelitos para niña 💕"
- "Con gusto mamita ✨ te dejo las opciones para niño."
- "Claro mamita 💕 aquí te muestro los diseños unisex."

No enviar información técnica completa de manera automática. Usar la información a continuación **únicamente cuando la clienta pregunte específicamente**.

### Características

- Talla única, desde recién nacido hasta aproximadamente 2 años
- Ajustables mediante botones
- Reutilizables y lavables
- Material importado desde Brasil; confección en Santa Cruz, Bolivia
- 3 capas con capa intermedia impermeable
- Incluyen absorbente
- Tela interior suave y transpirable
- Ideales para clima cálido y uso diario
- No diseñados para piscina
- No poseen cierre crash, únicamente botones de ajuste

### Lavado

- Lavado a mano o en lavadora ciclo suave
- Enjuagar primero, usar jabón suave
- Evitar cloro y suavizante

### Precios

Solo mostrar cuando la clienta los solicite:

${pricingLines("panales")}

**Regla importante:** solo existen estos precios. No calcules ni inventes valores intermedios. Si la clienta pregunta por una cantidad que no está en la lista, indícale los packs disponibles con naturalidad. Ejemplo de intención:
> "Mamita manejamos packs de 3, 4, 5, media docena y docena 😊 ¿cuál se acomoda mejor a lo que necesitas? 💕"

**Cuando solo escribe "precio" (o similar) sin decir cantidad:** no envíes la tabla completa de packs. Da únicamente el precio por unidad y el pack de 3 como referencia, e invítala a decir cuántos necesita. Reserva la lista completa de packs para cuando pregunte explícitamente por packs o por cantidades mayores. No uses formato de tabla ni listas largas con markdown; respóndelo en una o dos burbujas cálidas y naturales. Ejemplo de intención:
> "Claro mamita 😊 la unidad está en ${PRODUCT_PRICING.panales.unit.price} Bs, y el pack de 3 en ${PRODUCT_PRICING.panales.pack3.price} Bs que sale más conveniente 💕 ¿cuántos estarías buscando? Así te paso el precio ideal ✨"

### Preguntas frecuentes

- **¿Son impermeables?** → Sí, tienen 3 capas con capa intermedia impermeable.
- **¿Incluyen absorbente?** → Sí, vienen completos con absorbente incluido.
- **¿La tela es fresca?** → Sí, la tela interior es suave y transpirable.
- **¿Sirven para piscina?** → No, están diseñados para uso diario.
- **¿Cuánto duran puestos?** → Aproximadamente entre 2 y 3 horas, similar a un pañal convencional.
- **¿Son nacionales?** → Material importado de Brasil, confección en Santa Cruz, Bolivia.
- **¿Cuántos necesitan?** → Lo ideal es entre 3 y 6 para rotación diaria.
- **¿Sirven para recién nacidos?** → Sí, gracias a los botones de ajuste pueden usarse desde recién nacidos.

---

## PAGOS

Aceptamos QR y efectivo. Comunícalo con naturalidad cuando lo pregunte.

**Regla estricta:** nunca prometas enviar un QR, un comprobante, una imagen ni ningún archivo, y **jamás** escribas marcadores o placeholders como "[QR de Pago]" o "(aquí iría el QR)". Para el pago por QR, indica con calidez que el equipo comparte los datos al coordinar el pedido. Ejemplo de intención:
> "Sí mamita 😊 puedes pagar por QR o en efectivo. Cuando coordinemos tu pedido, el equipo te pasa los datos del QR para el pago 💕"

---

## ENVÍOS

Hacemos envíos a domicilio dentro de la ciudad, a provincias y a otros departamentos. El costo depende de la zona y la cantidad.

**Regla estricta (sin excepciones):** nunca confirmes, calcules ni menciones un monto específico de envío (ni cifras como "20 Bs", ni rangos, ni "más o menos"), por más que la clienta insista, presione o lo pida varias veces. La confirmación del costo siempre la da el equipo según la zona y la cantidad. Si insiste, mantente cálida y firme: pide el destino y deriva la confirmación al equipo, sin soltar ninguna cifra. Ejemplos de intención:
> "Claro mamita 😊 hacemos envíos dentro de la ciudad, a provincias y otros departamentos. El costito depende de la zona, dime a dónde sería y el equipo te confirma el monto exacto 💕"
> "Para no darte un dato equivocado, mamita, el costo del envío te lo confirma directamente el equipo según tu zona 😊 ¿a qué ciudad o barrio sería? 💕"

---

## UBICACIÓN

Cuando compartas la ubicación, usa una presentación amigable con emojis. No cambiar la información, solo el formato. Ejemplo de intención:

📍 Estamos en Santa Cruz de la Sierra, mamita 😊

✨ **Feria Barrio Lindo:**
Acronal Bloque "A", Asoc. 13 de julio, Pasillo #3 "Los Ciruelos", Tiendas #77-78

💕 **Cooperativa 19 de noviembre:**
Pasillo M, Tiendas 340-341

📍 Ubicación GPS: https://maps.app.goo.gl/yDwaALE2k8Rey9yJ7
🎥 Video de cómo llegar: https://www.tiktok.com/@reino.del.bebe.be/video/7560038837163003148?_r=1&_t=ZS-953ytBmbzG9

---

## HORARIOS

🕘 Lunes, martes, jueves y viernes:
8:30 am a 7:00 pm

🕘 Miércoles y sábado:
7:30 am a 8:30 pm

Atendemos de lunes a sábado.

---

## OTROS PRODUCTOS

Si la clienta pregunta por productos que no sean pañales ecológicos ni combos de recibimiento, respóndele con calidez e invítala a explorar el catálogo completo de la tienda. No inventes productos ni precios. Varía la redacción. Ejemplos de intención:
- "Claro mamita 😊 tenemos más productos con descuentos imperdibles, échales un vistazo aquí 💕 https://reinodelbebe.net/reino-del-bebe-v5.html"
- "Mamita tenemos un catálogo hermoso con ofertas que te van a encantar ✨ https://reinodelbebe.net/reino-del-bebe-v5.html"

---

## VENTA Y CIERRE

Ayuda a la clienta a elegir su producto según para quién es: niña, niño, unisex, regalo, baby shower o recibimiento. Guía la conversación hacia la compra de forma natural y persuasiva, sin presionar.

Cuando muestre intención de compra, acompáñala con calidez y avanza pidiendo los datos del pedido. No menciones asesoras ni derivaciones en una compra normal: esa la cierras tú. Varía la redacción. Ejemplos de intención:
- "Perfecto mamita 😊 te ayudo con los datitos para tu pedido."
- "Con gusto mamita 💕 lo coordinamos enseguida, ¿me confirmas para cuándo lo necesitas?"

---

## CLIENTAS MOLESTAS O QUE PIDEN PERSONA

Si la clienta está molesta, reclama, pide hablar con una persona o dice que no quiere hablar con un bot, respóndele con empatía y humildad, y deriva a una asesora humana. Varía la frase. Ejemplos de intención:
- "Te entiendo, mamita 💕 una de nuestras asesoras te ayuda mejor con esto, ya te contacta."
- "Lamento la molestia 😊 dejo que una asesora te atienda directamente para resolverlo bien."

---

## OBJETIVO

Presentar los productos de Reino del Bebé, mostrar los modelos disponibles mediante las imágenes automáticas, resolver dudas sobre precios, colores, envíos, ubicación y pagos, y guiar a la clienta con calidez y persuasión, de forma natural, hacia la compra.

`;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function getKapsoClient() {
  return new WhatsAppClient({
    baseUrl: "https://api.kapso.ai/meta/whatsapp",
    kapsoApiKey: getRequiredEnv("KAPSO_API_KEY"),
  });
}

function getSupabaseClient() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
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

function cleanMetadata(metadata?: Record<string, any>): Record<string, any> {
  try {
    return JSON.parse(JSON.stringify(metadata ?? {}));
  } catch {
    return {};
  }
}

async function sendSlackAlert(params: {
  level: SystemLogLevel;
  eventType: string;
  business?: string;
  conversationId?: string;
  messageId?: string;
  contactPhone?: string;
  errorMessage?: string;
}) {
  const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;

  if (!webhookUrl) return;
  if (!["error", "critical"].includes(params.level)) return;

  try {
    const emoji = params.level === "critical" ? "🚨" : "⚠️";

    const text = [
      `${emoji} *${params.level.toUpperCase()} - Kapso/Vercel*`,
      `*Evento:* ${params.eventType}`,
      `*Negocio:* ${params.business ?? "reino-del-bebe"}`,
      `*Conversación:* ${params.conversationId ?? "N/A"}`,
      `*Mensaje:* ${params.messageId ?? "N/A"}`,
      `*Teléfono:* ${maskPhone(params.contactPhone) ?? "N/A"}`,
      `*Error:* ${params.errorMessage ?? "Sin detalle"}`,
      `*Hora:* ${new Date().toISOString()}`,
    ].join("\n");

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    console.error("sendSlackAlert failed", error);
  }
}

async function logSystemEvent(params: {
  level?: SystemLogLevel;
  eventType: string;
  business?: string;
  clientId?: string | null;
  conversationId?: string;
  messageId?: string;
  contactPhone?: string;
  statusCode?: number;
  errorMessage?: string;
  metadata?: Record<string, any>;
}) {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase.from("system_logs").insert({
      level: params.level ?? "info",
      event_type: params.eventType,
      source: "kapso-vercel",
      business: params.business ?? "reino-del-bebe",
      client_id: params.clientId ?? null,
      kapso_conversation_id: params.conversationId ?? null,
      kapso_message_id: params.messageId ?? null,
      contact_phone_masked: maskPhone(params.contactPhone),
      status_code: params.statusCode ?? null,
      error_message: params.errorMessage ?? null,
      metadata: cleanMetadata(params.metadata),
    });

    if (error) {
      console.error("system_logs insert failed", error);
    }

    await sendSlackAlert({
      level: params.level ?? "info",
      eventType: params.eventType,
      business: params.business ?? "reino-del-bebe",
      conversationId: params.conversationId,
      messageId: params.messageId,
      contactPhone: params.contactPhone,
      errorMessage: params.errorMessage,
    });
  } catch (error) {
    console.error("logSystemEvent threw", error);
  }
}

function parseKapsoTimestamp(timestamp?: string | number | null): string | null {
  if (!timestamp) return null;
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) return null;
  return new Date(numericTimestamp * 1000).toISOString();
}

function getWebhookEvents(payload: Record<string, any>, request: Request): Record<string, any>[] {
  const isBatch =
    payload.batch === true ||
    request.headers.get("x-webhook-batch") === "true";

  if (isBatch && Array.isArray(payload.data)) return payload.data;
  return [payload];
}

function extractMessageText(
  message?: Record<string, any> | null,
  conversation?: Record<string, any> | null,
): string {
  const textBody = message?.text?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const transcriptText = message?.kapso?.transcript?.text;
  if (typeof transcriptText === "string" && transcriptText.trim()) return transcriptText.trim();

  const buttonText = message?.button?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const interactiveButtonText =
    message?.interactive?.button_reply?.title ??
    message?.interactive?.list_reply?.title;

  if (typeof interactiveButtonText === "string" && interactiveButtonText.trim()) {
    return interactiveButtonText.trim();
  }

  const kapsoContent = message?.kapso?.content;
  if (typeof kapsoContent === "string" && kapsoContent.trim()) {
    const transcriptMatch = kapsoContent.match(/Transcript:\s*([\s\S]*)$/i);
    if (transcriptMatch?.[1]?.trim()) {
      return `🎙️ Audio recibido\n\nTranscripción: ${transcriptMatch[1].trim()}`;
    }

    return "🎙️ Audio recibido";
  }


  const lastMessageText = conversation?.kapso?.last_message_text;
  if (typeof lastMessageText === "string" && lastMessageText.trim()) {
    const transcriptMatch = lastMessageText.match(/Transcript:\s*([\s\S]*)$/i);
    if (transcriptMatch?.[1]?.trim()) {
      return `🎙️ Audio recibido\n\nTranscripción: ${transcriptMatch[1].trim()}`;
    }

    return "🎙️ Audio recibido";
  }

  return "";
}

// Devuelve el transcript del audio si existe, mirando las mismas fuentes que
// extractMessageText. Si retorna null, el audio llegó sin transcripción.
function audioTranscriptText(
  message?: Record<string, any> | null,
  conversation?: Record<string, any> | null,
): string | null {
  const direct = message?.kapso?.transcript?.text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const content = message?.kapso?.content;
  if (typeof content === "string") {
    const match = content.match(/Transcript:\s*([\s\S]*)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  const lastMessageText = conversation?.kapso?.last_message_text;
  if (typeof lastMessageText === "string") {
    const match = lastMessageText.match(/Transcript:\s*([\s\S]*)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  return null;
}

function getAudioMediaUrl(message?: Record<string, any> | null): string | null {
  const candidates = [
    message?.kapso?.media_url,
    message?.kapso?.media_data?.url,
    message?.audio?.link,
    message?.audio?.url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

async function extractIncomingFromEvent(event: Record<string, any>): Promise<IncomingMessage | null> {
  const kapsoDirection = event.message?.kapso?.direction;

  if (kapsoDirection && kapsoDirection !== "inbound") {
    const origin = event.message?.kapso?.origin ?? null;
    const conversationId = event.conversation?.id ?? null;
    const phone = event.conversation?.phone_number ?? event.message?.to ?? null;
    const messageId = event.message?.id ?? null;

    console.log("outbound message detected", {
      direction: kapsoDirection,
      origin,
      messageId,
      conversationId,
      status: event.message?.kapso?.status ?? null,
    });

    if (origin === "business_app" && conversationId) {
      const supabase = getSupabaseClient();
      const nowIso = new Date().toISOString();
      const expiresAt = null;

      const { error } = await supabase
        .from("kapso_conversations")
        .update({
          bot_paused: true,
          bot_paused_at: nowIso,
          bot_pause_expires_at: null,
          bot_paused_reason: "human_whatsapp_business_app",
          bot_pause_mode: "auto",
          bot_pause_duration_minutes: null,
          updated_at: nowIso,
        })
        .eq("kapso_conversation_id", conversationId);

      if (error) {
        console.error("auto pause from business_app failed", error);
      } else {
        console.log("bot auto-paused from business_app", {
          conversationId,
          phone,
          expiresAt,
        });
      }
    }

    return null;
  }

  // Las reacciones inbound (emoji sobre un mensaje) no son consultas reales: no
  // deben guardarse, ni clasificarse, ni disparar respuesta del bot. Si no se
  // filtran aquí, extractMessageText las etiqueta como "🎙️ Audio recibido" y
  // terminan generando respuestas fuera de contexto. Cortamos el evento de raíz.
  const messageType = event.message?.type;
  if (messageType === "reaction" || event.message?.reaction) {
    await logSystemEvent({
      level: "info",
      eventType: "payload_ignored_reaction",
      conversationId: event.conversation?.id ?? undefined,
      messageId: event.message?.id ?? undefined,
      contactPhone: event.conversation?.phone_number ?? event.message?.from ?? undefined,
      metadata: {
        message_type: messageType ?? null,
        emoji: event.message?.reaction?.emoji ?? null,
      },
    });

    return null;
  }

  const from = event.message?.from ?? "";
  const text = extractMessageText(event.message, event.conversation);
  const messageId = event.message?.id;
  const conversationId = event.conversation?.id ?? from;
  const contactName = event.conversation?.contact_name ?? null;
  const messageTimestamp = parseKapsoTimestamp(event.message?.timestamp);

  if (!from || !text) return null;

  // Audio que llegó sin transcripción (transcript pendiente o fallido en Kapso).
  // No es una consulta legible: no debe pasar al LLM como mensaje normal.
  const isAudio = event.message?.type === "audio" || Boolean(event.message?.audio);
  const audioWithoutTranscript =
    isAudio && !audioTranscriptText(event.message, event.conversation);

  return {
    from,
    text,
    messageId,
    conversationId,
    contactName,
    messageTimestamp,
    audioWithoutTranscript,
    mediaUrl: audioWithoutTranscript ? getAudioMediaUrl(event.message) : null,
    referralProduct: detectReferralProduct(event.message),
    raw: event,
  };
}

async function normalizeIncomingMessages(
  payload: Record<string, any>,
  request: Request,
): Promise<IncomingMessage[]> {
  const events = getWebhookEvents(payload, request);
  const incomingMessages: IncomingMessage[] = [];

  for (const [index, event] of events.entries()) {
    const incoming = await extractIncomingFromEvent(event);
    if (!incoming) continue;

    incomingMessages.push({
      ...incoming,
      batchIndex: index,
    });
  }

  return incomingMessages;
}


async function saveContactAndConversation(message: IncomingMessage) {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const { error: contactError } = await supabase
    .from("kapso_contacts")
    .upsert(
      {
        phone: message.from,
        name: message.contactName,
        updated_at: nowIso,
      },
      { onConflict: "phone" },
    );

  if (contactError) {
    console.error("supabase upsert kapso_contacts failed", contactError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_contact_upsert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: contactError.message,
      metadata: {
        code: contactError.code,
        details: contactError.details,
      },
    });
  }

  const { error: conversationError } = await supabase
    .from("kapso_conversations")
    .upsert(
      {
        kapso_conversation_id: message.conversationId,
        contact_phone: message.from,
        updated_at: nowIso,
      },
      { onConflict: "kapso_conversation_id" },
    );

  if (conversationError) {
    console.error("supabase upsert kapso_conversations failed", conversationError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_conversation_upsert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: conversationError.message,
      metadata: {
        code: conversationError.code,
        details: conversationError.details,
      },
    });
  }
}

async function saveInboundMessage(message: IncomingMessage): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error: messageError } = await supabase
    .from("kapso_messages")
    .insert({
      kapso_message_id: message.messageId,
      kapso_conversation_id: message.conversationId,
      contact_phone: message.from,
      direction: "inbound",
      role: "user",
      content: message.text,
      message_timestamp: message.messageTimestamp,
      batch_index: message.batchIndex ?? null,
      raw_payload: message.raw,
    });

  if (messageError) {
    if (messageError.code === "23505") {
      console.log("duplicate inbound message ignored", message.messageId);
      return false;
    }

    console.error("supabase insert kapso_messages inbound failed", messageError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_inbound_insert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: messageError.message,
      metadata: {
        code: messageError.code,
        details: messageError.details,
        batch_index: message.batchIndex ?? null,
      },
    });

    return false;
  }

  return true;
}

async function saveOutboundMessage(params: {
  conversationId?: string;
  phone: string;
  content: string;
  rawPayload?: Record<string, any> | null;
}) {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("kapso_messages").insert({
    kapso_message_id: null,
    kapso_conversation_id: params.conversationId,
    contact_phone: params.phone,
    direction: "outbound",
    role: "assistant",
    content: params.content,
    message_timestamp: new Date().toISOString(),
    batch_index: null,
    raw_payload: params.rawPayload ?? null,
  });

  if (error) {
    console.error("supabase insert kapso_messages outbound failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_outbound_insert_failed",
      conversationId: params.conversationId,
      contactPhone: params.phone,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
  }
}

async function acquireReplyLock(params: {
  conversationId?: string;
  lastMessageId?: string;
  phone?: string;
  batchSize: number;
}): Promise<boolean> {
  if (!params.lastMessageId) return true;

  const supabase = getSupabaseClient();

  const { error } = await supabase.from("kapso_response_locks").insert({
    kapso_conversation_id: params.conversationId,
    last_kapso_message_id: params.lastMessageId,
    batch_size: params.batchSize,
    status: "processing",
  });

  if (!error) return true;

  if (error.code === "23505") {
    console.log("reply lock already exists, skipping reply", params.lastMessageId);
    return false;
  }

  console.error("supabase insert kapso_response_locks failed", error);

  await logSystemEvent({
    level: "error",
    eventType: "reply_lock_insert_failed",
    conversationId: params.conversationId,
    messageId: params.lastMessageId,
    contactPhone: params.phone,
    errorMessage: error.message,
    metadata: {
      code: error.code,
      details: error.details,
      batch_size: params.batchSize,
    },
  });

  return false;
}

async function markReplyLockSent(params: {
  lastMessageId?: string;
  conversationId?: string;
  phone?: string;
  responseText: string;
}) {
  if (!params.lastMessageId) return;

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("kapso_response_locks")
    .update({
      status: "sent",
      response_text: params.responseText,
      updated_at: new Date().toISOString(),
    })
    .eq("last_kapso_message_id", params.lastMessageId);

  if (error) {
    console.error("supabase update kapso_response_locks failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "reply_lock_update_failed",
      conversationId: params.conversationId,
      messageId: params.lastMessageId,
      contactPhone: params.phone,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
  }
}

type BotPauseState = {
  paused: boolean;
  expired: boolean;
  reason?: string | null;
  expiresAt?: string | null;
};

async function getBotPauseState(conversationId?: string): Promise<BotPauseState> {
  if (!conversationId) {
    return { paused: false, expired: false };
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_conversations")
    .select("bot_paused, bot_pause_expires_at, bot_paused_reason")
    .eq("kapso_conversation_id", conversationId)
    .maybeSingle();

  if (error) {
    console.error("supabase select bot pause state failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "bot_pause_state_select_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return { paused: false, expired: false };
  }

  if (!data?.bot_paused) {
    return { paused: false, expired: false };
  }

  const expiresAt = data.bot_pause_expires_at
    ? new Date(data.bot_pause_expires_at).getTime()
    : null;

  const expired = expiresAt ? expiresAt <= Date.now() : false;

  return {
    paused: true,
    expired,
    reason: data.bot_paused_reason,
    expiresAt: data.bot_pause_expires_at,
  };
}

async function resumeBotIfPauseExpired(conversationId?: string) {
  if (!conversationId) return;

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("kapso_conversations")
    .update({
      bot_paused: false,
      bot_resumed_at: new Date().toISOString(),
      bot_pause_expires_at: null,
      bot_paused_reason: "auto_resume_expired",
      updated_at: new Date().toISOString(),
    })
    .eq("kapso_conversation_id", conversationId);

  if (error) {
    console.error("supabase auto resume bot failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "bot_auto_resume_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
  }
}

async function getRecentConversationHistory(
  conversationId?: string,
  limit = 12,
): Promise<HistoryMessage[]> {
  if (!conversationId) return [];

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("role, content, message_timestamp, batch_index, created_at")
    .eq("kapso_conversation_id", conversationId)
    .order("message_timestamp", { ascending: false, nullsFirst: false })
    .order("batch_index", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("supabase select recent history failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_history_select_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return [];
  }

  return (data ?? [])
    .reverse()
    .map((row): HistoryMessage => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: String(row.content ?? ""),
    }))
    .filter((message) => message.content.trim().length > 0)
    // Los marcadores internos ([MEDIA_SENT:combo_nina], [PRODUCT_CONTEXT:panales] ...)
    // se guardan en kapso_messages para el historial/sidebar, pero NO deben
    // enviarse a OpenAI como si fueran mensajes reales de la conversación.
    .filter((message) => !/^\[(MEDIA_SENT|PRODUCT_CONTEXT)[:\]]/.test(message.content.trim()));
}

type MediaSentState = Record<ComboMediaIntent, boolean>;

// Lee los marcadores internos [MEDIA_SENT:...] de toda la conversación y devuelve
// qué grupos de imágenes ya fueron enviados. Estos marcadores se filtran del
// historial conversacional (no van a OpenAI como mensajes), por eso aquí los
// consultamos aparte para reconstruir el estado real de imágenes.
async function getMediaSentState(
  conversationId?: string,
): Promise<MediaSentState> {
  const state: MediaSentState = {
    combo_nina: false,
    combo_nino: false,
    combo_unisex: false,
  };

  if (!conversationId) return state;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content")
    .eq("kapso_conversation_id", conversationId)
    .ilike("content", "[MEDIA_SENT:%");

  if (error) {
    console.error("supabase select media sent state failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_state_select_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    // Degradación segura: si no podemos leer el estado, asumimos no enviado y
    // el modelo simplemente no dirá "arribita".
    return state;
  }

  for (const row of data ?? []) {
    const content = String(row.content ?? "");
    for (const intent of COMBO_MEDIA_INTENTS) {
      if (content.startsWith(`[MEDIA_SENT:${intent}]`)) {
        state[intent] = true;
      }
    }
  }

  return state;
}

function buildMediaStateContext(state: MediaSentState): string {
  const label = (sent: boolean) => (sent ? "enviado" : "no enviado");

  return [
    "ESTADO INTERNO DE IMÁGENES (uso interno, NO lo menciones a la clienta):",
    `- combo_nina: ${label(state.combo_nina)}`,
    `- combo_nino: ${label(state.combo_nino)}`,
    `- combo_unisex: ${label(state.combo_unisex)}`,
  ].join("\n");
}

// Contexto FUERTE por producto activo del turno. Se inyecta al final del system
// prompt (máxima recencia) para que el LLM no mezcle catálogos ni cambie precios.
// Deriva de PRODUCT_PRICING (fuente única). NO bloquea el producto: recibe el
// `product` re-resuelto en cada turno por resolveProduct.
function buildProductPriceContext(product: ProductKey): string {
  const nombre = product === "panales" ? "PAÑALES ECOLÓGICOS" : "COMBO DE RECIBIMIENTO";
  const tema = product === "panales" ? "pañales ecológicos" : "combos de recibimiento";

  return [
    `PRODUCTO ACTIVO EN ESTE TURNO: ${nombre} (uso interno, NO lo menciones).`,
    `Responde SOLO sobre ${tema}. Si la clienta pregunta por precio, usa SÍ O SÍ esta tabla, sin inventar ni calcular valores intermedios:`,
    pricingLines(product),
    `PROHIBIDO en este producto: usar ${forbiddenPricesText(product)} (son precios del otro catálogo).`,
    product === "panales"
      ? `En pañales la UNIDAD es ${PRODUCT_PRICING.panales.unit.price} Bs: nunca uses 210 Bs como precio de unidad.`
      : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

// Contexto FUERTE anti-asunción de grupo. Si niña/niño/unisex aún no se
// resolvió en este turno, prohíbe prometer/anunciar imágenes o asumir un
// grupo (p.ej. "unisex" por defecto) y obliga a preguntar el grupo primero.
// Aplica a pañales y combo por igual: ambos llaman a generateAssistantReply.
function buildGroupContext(group: GroupKey | null): string {
  if (group) return "";

  return [
    "GRUPO (niña/niño/unisex) AÚN NO DEFINIDO en este turno.",
    'Si la clienta pide fotos, diseños, modelos, imágenes o ver opciones SIN decir niña, niño o unisex:',
    '- NO digas "te muestro" ni nada que prometa o anuncie imágenes.',
    '- NO digas "unisex" ni asumas ningún grupo.',
    '- Responde EXACTAMENTE: "Claro mamita 😊 ¿los buscas para niña, niño o unisex?"',
  ].join("\n");
}

async function generateAssistantReply(params: {
  product: ProductKey;
  group: GroupKey | null;
  history: HistoryMessage[];
  mediaState: MediaSentState;
  conversationId?: string;
  messageId?: string;
  phone?: string;
}): Promise<string> {
  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: `${SYSTEM_PROMPT}\n\n${buildProductPriceContext(params.product)}\n\n${buildGroupContext(params.group)}\n\n${buildMediaStateContext(params.mediaState)}`,
      messages: params.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: 0.4,
    });

    return text.trim();
  } catch (error) {
    console.error("openai generateText failed", error);

    await logSystemEvent({
      level: "critical",
      eventType: "openai_generate_failed",
      conversationId: params.conversationId,
      messageId: params.messageId,
      contactPhone: params.phone,
      errorMessage: getErrorMessage(error),
      metadata: {
        fallback_used: true,
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      },
    });

    return "Gracias por escribirnos 😊 ¿Te gustaría información de pañales ecológicos o del combo recibimiento?";
  }
}

async function hasMediaAlreadySent(
  conversationId: string | undefined,
  intent: string,
): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .ilike("content", `[MEDIA_SENT:${intent}]%`)
    .limit(1);

  if (error) {
    console.error("supabase check media already sent failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_check_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
        intent,
      },
    });

    return false;
  }

  return (data ?? []).length > 0;
}

async function getActiveMediaAssets(intent: string): Promise<MediaAsset[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_media_assets")
    .select("title, url")
    .eq("business", "reino-del-bebe")
    .eq("intent", intent)
    .eq("media_type", "image")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("supabase select kapso_media_assets failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_assets_select_failed",
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
        intent,
      },
    });

    return [];
  }

  return (data ?? [])
    .map((asset): MediaAsset => ({
      title: String(asset.title ?? "Imagen enviada"),
      url: String(asset.url ?? ""),
    }))
    .filter((asset) => asset.url.trim().length > 0);
}

async function sendKapsoImage(params: {
  phoneNumberId: string;
  to: string;
  imageUrl: string;
  caption?: string;
}) {
  const response = await fetch(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${params.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": getRequiredEnv("KAPSO_API_KEY"),
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: params.to,
        type: "image",
        image: {
          link: params.imageUrl,
          ...(params.caption ? { caption: params.caption } : {}),
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kapso image send failed ${response.status}: ${body}`);
  }
}



const COMBO_MEDIA_INTENTS = ["combo_nina", "combo_nino", "combo_unisex"] as const;
type ComboMediaIntent = (typeof COMBO_MEDIA_INTENTS)[number];

type ProductKey = "combo" | "panales";
type GroupKey = "nina" | "nino" | "unisex";
type MediaIntent = `${ProductKey}_${GroupKey}`;
type ProductOutcome = ProductKey | "ask" | "ask_both";

// Reutilizamos la clasificación de grupo existente (devuelve combo_*) y le
// quitamos el prefijo para recomponer el intent según el producto resuelto.
function intentToGroup(intent: ComboMediaIntent): GroupKey {
  return intent.replace(/^combo_/, "") as GroupKey;
}

const COMBO_MEDIA_CLASSIFIER_PROMPT = `
Eres un clasificador de intención para una tienda de combos de recibimiento para bebés.

A partir de los MENSAJES NUEVOS de la clienta (la gente escribe mal, con typos y diminutivos en WhatsApp), debes decidir para qué grupo quiere el combo.

Responde EXCLUSIVAMENTE con una sola palabra, sin comillas, sin explicación, exactamente una de estas:
combo_nina
combo_nino
combo_unisex
null

REGLA PRINCIPAL (la más importante):
La decisión la manda el MENSAJE NUEVO de la clienta, NO el historial.
Si el mensaje nuevo nombra un grupo (niña, niño o unisex), ese grupo gana, AUNQUE antes se haya pedido o enviado otro distinto.
NO devuelvas null solo porque antes se habló de otro género: si el mensaje nuevo elige un grupo, clasifícalo según ese mensaje nuevo.
El historial solo sirve como contexto; nunca debe volver ambiguo un mensaje nuevo que sí elige un grupo.

Reglas:
- niña, nena, mujer, hembra, hembrita, mujercita, rosado, rosadito, fucsia, melón → combo_nina
- niño, nene, varón, varoncito, hombrecito, celeste, azul, azulito → combo_nino
- unisex, neutro, sorpresa, no sabe el sexo todavía, ambos, los dos, cualquiera, y typos como insex, unisec, unisexx → combo_unisex
- Si solo saluda, pregunta por precio general, ubicación, envío, pago, o es ambiguo / no relacionado al grupo → null

Ejemplos de cambio de género (el historial ya hablaba de otro grupo, pero manda el mensaje nuevo):
- "y para insex también" → combo_unisex
- "y para unisex también" → combo_unisex
- "para niño quiero ver" → combo_nino
- "y para niña" → combo_nina
- "también unisex" → combo_unisex
- "también niña" → combo_nina

Considera los errores de tipeo y diminutivos comunes (ej: "nena", "varoncito", "rosadito", "azulito", "insex", "unisec", "unisexx").
Solo responde null por ambigüedad de género cuando la clienta menciona niña y niño JUNTOS en el MISMO mensaje nuevo sin elegir (no por lo que diga el historial).
`;

function parseComboMediaIntent(raw: string): ComboMediaIntent | null {
  // Normaliza la respuesta del modelo para tolerar tildes (combo_niño),
  // comillas, puntuación, saltos de línea y espacios en vez de guion bajo.
  // Sin esto, cualquier variante del literal exacto se perdía como null.
  const normalized = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita tildes/diacríticos (ñ→n, í→i)
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, " ") // descarta comillas, puntos, etc.
    .replace(/[\s_]+/g, " ")
    .trim();

  if (!normalized || normalized === "null") return null;

  // Match directo contra el token canónico, con o sin el prefijo "combo".
  const compact = normalized.replace(/ /g, "_");
  for (const intent of COMBO_MEDIA_INTENTS) {
    if (compact === intent || compact === intent.replace(/^combo_/, "")) {
      return intent;
    }
  }

  // Red de seguridad: si el modelo responde con una palabra suelta
  // ("niño", "varón", "unisex"), la mapeamos igual. Señales contradictorias
  // entre niña y niño se descartan, igual que en el prompt del clasificador.
  const hasNina = /\b(nina|nena|hembr\w*|mujer\w*)\b/.test(normalized);
  const hasNino = /\b(nino|nene|varon\w*|hombrecito)\b/.test(normalized);
  const hasUnisex = /unisex|neutro|\bambos\b/.test(normalized);

  if (hasNina && hasNino) return null;
  if (hasNina) return "combo_nina";
  if (hasNino) return "combo_nino";
  if (hasUnisex) return "combo_unisex";

  return null;
}

function detectComboMediaIntentFromNewText(newText: string): ComboMediaIntent | null {
  // Fallback determinista que decide SOLO con el mensaje nuevo, sin mirar
  // historial. Resuelve el caso en que el modelo se ancla al primer género
  // ya hablado y devuelve null/intent equivocado ante un cambio explícito
  // (ej: "y para unisex también" tras haber pedido niña).
  const normalized = newText
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita tildes (ñ→n, í→i)
    .toLowerCase();

  const hasUnisex = /unisex|insex|unisec|unisexx|neutro|sorpresa/.test(normalized);
  const hasNino = /\bni[nñ]o\w*|\bvaron\w*|celeste|azul/.test(normalized);
  const hasNina = /\bni[nñ]a\w*|\bnena\w*|rosado|fucsia/.test(normalized);

  // Si el mensaje nuevo nombra más de un grupo, no decidimos por fallback:
  // dejamos que el modelo de IA resuelva con el contexto completo.
  const matchedGroups = [hasUnisex, hasNino, hasNina].filter(Boolean).length;
  if (matchedGroups !== 1) return null;

  if (hasUnisex) return "combo_unisex";
  if (hasNino) return "combo_nino";
  if (hasNina) return "combo_nina";

  return null;
}

async function classifyComboMediaIntentWithAI(
  newMessages: IncomingMessage[],
  history: HistoryMessage[],
  conversationId?: string,
): Promise<ComboMediaIntent | null> {
  const newText = newMessages
    .map((message) => message.text ?? "")
    .filter((text) => text.trim().length > 0)
    .join("\n");

  if (!newText.trim()) {
    return null;
  }

  // Fallback determinista: si el mensaje nuevo elige un único grupo de forma
  // explícita, decidimos sin OpenAI. Evita que el modelo se ancle al primer
  // género del historial y devuelva null/intent equivocado.
  const deterministicIntent = detectComboMediaIntentFromNewText(newText);
  if (deterministicIntent) {
    return deterministicIntent;
  }

  const historyText = history
    .map((message) => `${message.role === "assistant" ? "Asesora" : "Clienta"}: ${message.content}`)
    .join("\n");

  const userPrompt = [
    historyText ? `HISTORIAL RECIENTE:\n${historyText}` : null,
    `MENSAJES NUEVOS DE LA CLIENTA:\n${newText}`,
    "Clasifica y responde solo con: combo_nina, combo_nino, combo_unisex o null.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: COMBO_MEDIA_CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0,
    });

    const intent = parseComboMediaIntent(text);

    console.log("combo media intent classified", {
      raw: text.trim(),
      intent,
    });

    return intent;
  } catch (error) {
    // Si OpenAI falla, no rompemos el webhook: simplemente no enviamos media.
    console.error("classifyComboMediaIntentWithAI failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "combo_media_intent_classify_failed",
      errorMessage: getErrorMessage(error),
      metadata: {
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        fallback_used: true,
      },
    });

    return null;
  }
}

async function sendMediaAssetsIfNeeded(params: {
  conversationId?: string;
  phone: string;
  phoneNumberId: string;
  intent: MediaIntent;
}) {
  const alreadySent = await hasMediaAlreadySent(params.conversationId, params.intent);

  if (alreadySent) {
    console.log("media already sent for conversation", {
      conversationId: params.conversationId,
      intent: params.intent,
    });
    return;
  }

  const assets = await getActiveMediaAssets(params.intent);

  if (assets.length === 0) {
    console.log("no active media assets found", { intent: params.intent });
    return;
  }

  for (const asset of assets) {
    try {
      await sendKapsoImage({
        phoneNumberId: params.phoneNumberId,
        to: params.phone,
        imageUrl: asset.url,
      });

      await saveOutboundMessage({
        conversationId: params.conversationId,
        phone: params.phone,
        content: `[MEDIA_SENT:${params.intent}] ${asset.title}`,
        rawPayload: {
          type: "image",
          title: asset.title,
          url: asset.url,
          intent: params.intent,
          source: "kapso_media_assets",
        },
      });

      console.log("Kapso image sent successfully", {
        intent: params.intent,
        title: asset.title,
      });
    } catch (error) {
      console.error("kapso image send/save failed", asset.title, error);

      await logSystemEvent({
        level: "error",
        eventType: "media_send_failed",
        conversationId: params.conversationId,
        contactPhone: params.phone,
        errorMessage: getErrorMessage(error),
        metadata: {
          intent: params.intent,
          asset_title: asset.title,
          asset_url_present: Boolean(asset.url),
        },
      });
    }
  }
}

const AUDIO_NO_TRANSCRIPT_REPLY =
  "Mamita, no pude escuchar bien el audio 😥 ¿Me escribes tu consulta por aquí por favor? 💕";

const PANALES_INTRO =
  "Claro mamita 😊 nuestros pañales ecológicos son para bebés de 0 a 2 añitos 💕 ¿Los buscas para niña, niño o unisex?";

const PRODUCT_DISAMBIGUATION =
  "Claro mamita 😊 ¿buscas información sobre pañales ecológicos o combos de recibimiento?";

const PRODUCT_ASK_BOTH =
  "Claro mamita 😊 ¿cuál te muestro primero, los pañales ecológicos o los combos de recibimiento? 💕";

function panalesPreshow(group: GroupKey): string {
  const label = group === "nina" ? "niña" : group === "nino" ? "niño" : "unisex";
  return `Perfecto mamita 😊 te muestro nuestros pañales ecológicos para ${label} 💕`;
}

const PRODUCT_CLASSIFIER_PROMPT = `
Eres un clasificador de PRODUCTO para una tienda de bebés en Bolivia que vende dos cosas distintas:
1) Combo Recibimiento (también "combo de 9 piezas", ajuar de prendas: babero, saquito, body, etc.).
2) Pañales Ecológicos (pañales ecológicos, lavables, reutilizables).

Decide SOLO a partir del MENSAJE de la clienta (puede tener typos y diminutivos) si ese mensaje menciona o pide explícitamente uno de los productos.
NO infieras por contexto previo ni por el grupo (niña/niño/unisex): el grupo NO es producto.

Responde EXCLUSIVAMENTE con una sola palabra, sin comillas ni explicación, exactamente una de estas:
combo
panales
both
null

Reglas:
- Menciona pañales, ecológicos, lavables o reutilizables → panales
- Menciona combo, recibimiento, 9 piezas, ajuar o las prendas del combo → combo
- Menciona AMBOS productos en el mismo mensaje → both
- Saludos ("hola"), precio, ubicación, envío, pago, o SOLO el grupo ("para niña", "y para niño", "unisex"), o cualquier cosa que no nombre el producto → null

Considera typos y diminutivos (pañalitos, ecologicos, combito, recibimiento).
`;

function parseProductClassification(raw: string): ProductKey | "both" | null {
  const normalized = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (!normalized || normalized === "null") return null;

  const hasPanales = normalized.includes("panal");
  const hasCombo = normalized.includes("combo");

  if (normalized === "both" || normalized === "ambos" || (hasPanales && hasCombo)) {
    return "both";
  }
  if (hasPanales) return "panales";
  if (hasCombo) return "combo";

  return null;
}

function detectProductFromText(text: string): ProductKey | "both" | null {
  const normalized = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  const hasPanales = /\bpanal\w*|ecologic\w*|lavable\w*|reutilizable\w*/.test(normalized);
  const hasCombo = /\bcombo\w*|recibimiento|(\b9|nueve)\s*piezas|babero|saquito|ajuar/.test(normalized);

  if (hasPanales && hasCombo) return "both";
  if (hasPanales) return "panales";
  if (hasCombo) return "combo";

  return null;
}

// Lee el referral del anuncio Click-to-WhatsApp (event.message.referral) y, si el
// copy del anuncio nombra un producto, lo devuelve. Reutiliza el detector
// determinista sobre headline/body/welcome_message/source. Un anuncio apunta a un
// solo producto, así que "both" se trata como null (no fuerza desambiguación).
function detectReferralProduct(message?: Record<string, any> | null): ProductKey | null {
  const referral = message?.referral;
  if (!referral || typeof referral !== "object") return null;

  const haystack = [
    referral.body,
    referral.headline,
    referral.welcome_message?.text,
    referral.source_url,
    referral.source_id,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  if (!haystack.trim()) return null;

  const detected = detectProductFromText(haystack);
  return detected === "both" ? null : detected;
}

// IA de producto que mira SOLO el mensaje nuevo (sin historial): captura
// menciones difusas de producto que el detector determinista no listó.
async function classifyProductWithAI(newText: string): Promise<ProductKey | "both" | null> {
  if (!newText.trim()) return null;

  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: PRODUCT_CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: newText }],
      temperature: 0,
    });

    const product = parseProductClassification(text);

    console.log("product classified", {
      raw: text.trim(),
      product,
    });

    return product;
  } catch (error) {
    // Si OpenAI falla, no rompemos el webhook: caemos al sticky/ask.
    console.error("classifyProductWithAI failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "product_classify_failed",
      errorMessage: getErrorMessage(error),
      metadata: {
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        fallback_used: true,
      },
    });

    return null;
  }
}

// Sticky de producto: lee el marcador interno [PRODUCT_CONTEXT:...] más reciente
// de la conversación. Mismo mecanismo que [MEDIA_SENT:...], sin tocar el esquema.
async function getStickyProduct(conversationId?: string): Promise<ProductKey | null> {
  if (!conversationId) return null;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content")
    .eq("kapso_conversation_id", conversationId)
    .ilike("content", "[PRODUCT_CONTEXT:%")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("supabase select sticky product failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_sticky_product_select_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return null;
  }

  const content = String(data?.[0]?.content ?? "");

  if (content.startsWith("[PRODUCT_CONTEXT:panales]")) return "panales";
  if (content.startsWith("[PRODUCT_CONTEXT:combo]")) return "combo";

  return null;
}

// Orden acordado: mensaje nuevo (determinista → IA solo del mensaje nuevo) y
// recién después el sticky. El mensaje nuevo siempre manda; el sticky solo
// resuelve continuaciones tipo "para niña" que no nombran producto.
async function resolveProduct(params: {
  newText: string;
  conversationId?: string;
  referralProduct?: ProductKey | null;
}): Promise<ProductOutcome> {
  // 1. El mensaje nuevo manda: detección determinista explícita.
  const explicit = detectProductFromText(params.newText);
  if (explicit === "both") return "ask_both";
  if (explicit) return explicit;

  // 2. IA SOLO sobre el mensaje nuevo: captura menciones difusas de producto.
  const aiProduct = await classifyProductWithAI(params.newText);
  if (aiProduct === "both") return "ask_both";
  if (aiProduct) return aiProduct;

  // 3. Recién aquí, si el mensaje nuevo no nombró producto, usamos el sticky.
  const sticky = await getStickyProduct(params.conversationId);
  if (sticky) return sticky;

  // 4. Si no hay sticky, el producto del anuncio CTWA (referral) resuelve el lead:
  //    así "precio"/"ubicación"/"sí" desde un anuncio de pañales no caen en "ask".
  if (params.referralProduct) return params.referralProduct;

  // 5. Sin señal de producto en ningún lado → preguntar cuál quiere.
  return "ask";
}

export async function POST(request: Request) {
  let payload: Record<string, any>;

  try {
    payload = await request.json();
  } catch (error) {
    console.error("invalid json", error);

    await logSystemEvent({
      level: "warning",
      eventType: "invalid_json",
      statusCode: 400,
      errorMessage: getErrorMessage(error),
    });

    return new Response("invalid json", { status: 400 });
  }

  const events = getWebhookEvents(payload, request);
  const incomingMessages = await normalizeIncomingMessages(payload, request);

  if (incomingMessages.length === 0) {
    await logSystemEvent({
      level: "info",
      eventType: "payload_ignored_no_incoming_messages",
      metadata: {
        payload_type: payload.type ?? null,
        batch: payload.batch === true,
        event_count: events.length,
        message_types: events.map((event) => event?.message?.type ?? "unknown"),
      },
    });

    return new Response("ignored", { status: 200 });
  }

  const firstMessage = incomingMessages[0];
  const lastMessage = incomingMessages[incomingMessages.length - 1];

  const testPhone = process.env.TEST_PHONE?.replace(/\D/g, "");
  const incomingPhone = lastMessage?.from?.replace(/\D/g, "");

  if (testPhone && incomingPhone !== testPhone) {
    console.log("test mode active, message ignored", {
      allowedPhone: testPhone,
      incomingPhone,
      conversationId: lastMessage?.conversationId ?? null,
    });

    return new Response("test mode ignored", { status: 200 });
  }

  console.log("Kapso webhook received", {
    payloadType: payload.type ?? null,
    batch: payload.batch === true,
    batchSize: Array.isArray(payload.data) ? payload.data.length : 1,
    incomingCount: incomingMessages.length,
    messageTypes: events.map((event) => event?.message?.type ?? "unknown"),
    conversationId: lastMessage?.conversationId ?? null,
    phone: maskPhone(lastMessage?.from),
  });

  await logSystemEvent({
    level: "info",
    eventType: "webhook_received",
    conversationId: lastMessage?.conversationId,
    messageId: lastMessage?.messageId,
    contactPhone: lastMessage?.from,
    metadata: {
      payload_type: payload.type ?? null,
      batch: payload.batch === true,
      batch_size: Array.isArray(payload.data) ? payload.data.length : 1,
      incoming_count: incomingMessages.length,
      message_types: events.map((event) => event?.message?.type ?? "unknown"),
    },
  });

  try {
    await saveContactAndConversation(lastMessage);
  } catch (error) {
    console.error("supabase save contact/conversation threw", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_save_contact_conversation_threw",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      errorMessage: getErrorMessage(error),
    });
  }

  const newMessages: IncomingMessage[] = [];

  for (const message of incomingMessages) {
    try {
      const saved = await saveInboundMessage(message);

      if (saved) newMessages.push(message);
    } catch (error) {
      console.error("supabase save inbound threw", error);

      await logSystemEvent({
        level: "error",
        eventType: "supabase_save_inbound_threw",
        conversationId: message.conversationId,
        messageId: message.messageId,
        contactPhone: message.from,
        errorMessage: getErrorMessage(error),
        metadata: {
          batch_index: message.batchIndex ?? null,
        },
      });
    }
  }

  if (newMessages.length === 0) {
    console.log("all inbound messages were duplicates, no reply sent");
    return new Response("duplicate ignored", { status: 200 });
  }

  const canReply = await acquireReplyLock({
    conversationId: lastMessage.conversationId,
    lastMessageId: lastMessage.messageId,
    phone: lastMessage.from,
    batchSize: incomingMessages.length,
  });

  if (!canReply) {
    return new Response("reply already processed", { status: 200 });
  }

  const pauseState = await getBotPauseState(lastMessage.conversationId);

  if (pauseState.paused && !pauseState.expired) {
    console.log("bot paused, inbound saved but no reply sent", {
      conversationId: lastMessage.conversationId,
      reason: pauseState.reason ?? null,
      expiresAt: pauseState.expiresAt ?? null,
    });

    await logSystemEvent({
      level: "info",
      eventType: "bot_reply_skipped_paused",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        reason: pauseState.reason ?? null,
        expires_at: pauseState.expiresAt ?? null,
      },
    });

    return new Response("bot paused", { status: 200 });
  }

  if (pauseState.paused && pauseState.expired) {
    await resumeBotIfPauseExpired(lastMessage.conversationId);

    await logSystemEvent({
      level: "info",
      eventType: "bot_auto_resumed_pause_expired",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        previous_reason: pauseState.reason ?? null,
        expired_at: pauseState.expiresAt ?? null,
      },
    });
  }

  const kapso = getKapsoClient();
  const phoneNumberId = getRequiredEnv("KAPSO_PHONE_NUMBER_ID");

  if (lastMessage.messageId) {
    try {
      await kapso.messages.markRead({
        phoneNumberId,
        messageId: lastMessage.messageId,
        typingIndicator: { type: "text" },
      });

      console.log("Kapso last message marked as read with typing");
    } catch (error) {
      console.error("kapso markRead failed", error);

      await logSystemEvent({
        level: "warning",
        eventType: "kapso_mark_read_failed",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        errorMessage: getErrorMessage(error),
      });
    }
  }

  // El inbound ya quedó guardado con content "🎙️ Audio recibido" y el lock ya
  // fue adquirido. Si el último mensaje es un audio sin transcripción, cortamos
  // aquí: respuesta fija, sin LLM, sin imágenes, sin flujo de producto.
  if (lastMessage.audioWithoutTranscript) {
    const conversationId = lastMessage.conversationId ?? firstMessage.conversationId;
    const replyText = AUDIO_NO_TRANSCRIPT_REPLY;

    try {
      await kapso.messages.sendText({
        phoneNumberId,
        to: lastMessage.from,
        body: replyText,
      });

      console.log("audio without transcript: fixed reply sent", {
        conversationId,
        messageId: lastMessage.messageId,
      });
    } catch (error) {
      console.error("kapso sendText (audio no transcript) failed", error);

      await logSystemEvent({
        level: "critical",
        eventType: "kapso_send_text_failed",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        statusCode: 502,
        errorMessage: getErrorMessage(error),
        metadata: { response_not_sent: true, audio_no_transcript: true },
      });

      return new Response("send failed", { status: 502 });
    }

    try {
      await saveOutboundMessage({
        conversationId,
        phone: lastMessage.from,
        content: replyText,
      });

      await markReplyLockSent({
        lastMessageId: lastMessage.messageId,
        conversationId: lastMessage.conversationId,
        phone: lastMessage.from,
        responseText: replyText,
      });
    } catch (error) {
      console.error("audio no transcript persistence threw", error);

      await logSystemEvent({
        level: "error",
        eventType: "post_send_persistence_or_media_threw",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        errorMessage: getErrorMessage(error),
      });
    }

    await logSystemEvent({
      level: "warning",
      eventType: "audio_transcript_missing",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        media_url: lastMessage.mediaUrl ?? null,
        reply_sent: true,
      },
    });

    return new Response("ok", { status: 200 });
  }

  const history = await getRecentConversationHistory(lastMessage.conversationId, 12);

  const mediaState = await getMediaSentState(lastMessage.conversationId);

  const conversationId = lastMessage.conversationId ?? firstMessage.conversationId;

  const newText = newMessages
    .map((message) => message.text ?? "")
    .filter((text) => text.trim().length > 0)
    .join("\n");

  // Capa de PRODUCTO: el mensaje nuevo manda (determinista → IA solo del mensaje
  // nuevo) y solo si no nombra producto se usa el sticky de conversación. El
  // producto del anuncio CTWA (referral) entra como respaldo bajo el sticky.
  const referralProduct = lastMessage.referralProduct ?? firstMessage.referralProduct ?? null;
  const product = await resolveProduct({ newText, conversationId, referralProduct });

  let replyText: string;
  let mediaIntent: MediaIntent | null = null;

  if (product === "combo" || product === "panales") {
    // El grupo (niña/niño/unisex) se clasifica con la misma lógica de siempre;
    // el intent final se recompone según el producto resuelto.
    const groupIntent = await classifyComboMediaIntentWithAI(
      newMessages,
      history,
      conversationId,
    );
    const group = groupIntent ? intentToGroup(groupIntent) : null;
    mediaIntent = group ? (`${product}_${group}` as MediaIntent) : null;

    if (product === "combo") {
      replyText = await generateAssistantReply({
        product,
        group,
        history,
        mediaState,
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        phone: lastMessage.from,
      });
    } else {
      if (group) {
        replyText = panalesPreshow(group);
      } else {
        replyText = await generateAssistantReply({
          product,
          group,
          history,
          mediaState,
          conversationId: lastMessage.conversationId,
          messageId: lastMessage.messageId,
          phone: lastMessage.from,
        });
      }
    }
  } else if (product === "ask_both") {
    replyText = PRODUCT_ASK_BOTH;
  } else {
    replyText = PRODUCT_DISAMBIGUATION;
  }

  try {
    await kapso.messages.sendText({
      phoneNumberId,
      to: lastMessage.from,
      body: replyText,
    });

    console.log("Kapso SDK text sent successfully");
  } catch (error) {
    console.error("kapso sendText failed", error);

    await logSystemEvent({
      level: "critical",
      eventType: "kapso_send_text_failed",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      statusCode: 502,
      errorMessage: getErrorMessage(error),
      metadata: {
        response_not_sent: true,
      },
    });

    return new Response("send failed", { status: 502 });
  }

  try {
    await saveOutboundMessage({
      conversationId,
      phone: lastMessage.from,
      content: replyText,
    });

    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: replyText,
    });

    // Persistimos el sticky de producto solo cuando hubo producto resuelto y
    // cambió respecto al último marcador (evita filas redundantes).
    if (product === "combo" || product === "panales") {
      const currentSticky = await getStickyProduct(conversationId);

      if (currentSticky !== product) {
        await saveOutboundMessage({
          conversationId,
          phone: lastMessage.from,
          content: `[PRODUCT_CONTEXT:${product}]`,
          rawPayload: {
            type: "product_context",
            product,
            source: "product_router",
          },
        });
      }
    }

    if ((product === "combo" || product === "panales") && mediaIntent) {
      await sendMediaAssetsIfNeeded({
        conversationId,
        phone: lastMessage.from,
        phoneNumberId,
        intent: mediaIntent,
      });
    }

  } catch (error) {
    console.error("supabase save outbound/lock/media threw", error);

    await logSystemEvent({
      level: "error",
      eventType: "post_send_persistence_or_media_threw",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      errorMessage: getErrorMessage(error),
    });
  }

  await logSystemEvent({
    level: "info",
    eventType: "webhook_processed",
    conversationId: lastMessage.conversationId,
    messageId: lastMessage.messageId,
    contactPhone: lastMessage.from,
    metadata: {
      new_messages_count: newMessages.length,
      incoming_messages_count: incomingMessages.length,
      reply_sent: true,
      media_check_done: true,
    },
  });

  return new Response("ok", { status: 200 });
}
