// Tipos compartidos del MOTOR genérico. No contienen nada propio de un negocio:
// los productos/grupos concretos los aporta la configuración (config/business.ts)
// a través del contrato BusinessConfig de más abajo.

export type IncomingMessage = {
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

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MediaAsset = {
  title: string;
  url: string;
};

export type SystemLogLevel = "info" | "warning" | "error" | "critical";

export type PriceTier = { label: string; price: number; note?: string };

// El motor trabaja con claves genéricas (string). La taxonomía concreta
// ("combo"/"panales", "nina"/"nino"/"unisex") la define cada negocio.
export type ProductKey = string;
export type GroupKey = string;
export type MediaIntent = string; // `${ProductKey}_${GroupKey}`
export type ProductOutcome = ProductKey | "ask" | "ask_both";

// Estado de imágenes enviadas, keyed por grupo (ej: { nina: true, nino: false }).
export type MediaSentState = Record<GroupKey, boolean>;

// --- Contrato que cada negocio debe cumplir en config/business.ts ---

export interface ProductDef {
  // Etiqueta legible (uso interno / debug).
  label: string;
  // Regex determinista para detectar el producto en el texto de la clienta.
  detect: RegExp;
  // Substring a buscar en la respuesta del clasificador de IA (ej: "panal").
  aiToken: string;
  // Si está definido, cuando ya se conoce el grupo se responde con este texto
  // fijo en vez de llamar al LLM (caso pañales). Si es null/undefined, siempre LLM.
  preshow?: ((groupLabel: string) => string) | null;
}

export interface GroupDef {
  label: string;
  // Regex para el detector determinista sobre el mensaje NUEVO (sin historial).
  detectNew: RegExp;
  // Regex (más laxa) usada al parsear la salida del clasificador de IA.
  detectLoose: RegExp;
}

export interface BusinessConfig {
  // Identificador del negocio. Filtra todas las tablas multi-negocio.
  slug: string;
  // Modelo OpenAI por defecto si no hay env OPENAI_MODEL.
  openaiModelDefault: string;

  products: Record<ProductKey, ProductDef>;
  groups: Record<GroupKey, GroupDef>;

  // Producto cuyo estado de imágenes se expone al LLM ("arribita"). En Reino
  // del Bebé es "combo": solo los combos rastrean qué grupo ya se mostró.
  mediaStateProduct: ProductKey;

  systemPrompt: string;
  classifierPrompts: { product: string; group: string };

  replies: {
    audioNoTranscript: string;
    productDisambiguation: string;
    askBoth: string;
    fallback: string;
  };

  // Bloques de contexto inyectados al final del system prompt (máxima recencia).
  buildPriceContext(product: ProductKey): string;
  buildGroupContext(group: GroupKey | null): string;
  buildMediaStateContext(state: MediaSentState): string;
}
