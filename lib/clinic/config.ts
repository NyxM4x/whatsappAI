// ============================================================================
// CONFIGURACIÓN — por clínica (multi-tenant, P2)
// ----------------------------------------------------------------------------
// Datos FIJOS del negocio. Las especialidades/doctores/precios de CONSULTA
// viven en la BD (clinic_specialties / clinic_doctors). Aquí: identidad, QR,
// emergencias, catálogos de labs/medicamentos y el tono del bot.
//
// getClinicConfig() es la ÚNICA puerta de entrada — nada más en el código debe
// leer datos de clínica de otro lado. Lee de la tabla clinic_settings (una
// fila por clínica, migración 20260718000000) con una caché corta en memoria.
// Los patrones de detección de intención (bookingIntentPatterns, etc.) NO
// viven en la tabla — son lógica de código, iguales para todas las clínicas
// por ahora; solo identidad/catálogos/textos son por-clínica.
//
// Fail-safe: si la fila no existe todavía o Supabase falla, devuelve la
// config estática de abajo (la de la Clínica San Martín) en vez de romper el
// bot — mismo criterio que el resto del proyecto (ej. debounce, locks).
// ============================================================================

import { getSupabaseClient } from "@/lib/engine/clients";
import {
  defaultServices,
  formatServicePrice,
  SERVICE_CATEGORY_LABELS,
  SERVICE_CATEGORY_ORDER,
  type ServiceItem,
} from "@/lib/clinic/services";

export type CatalogItem = { name: string; price: number };

// Slug por defecto mientras no hay resolución de tenant por número de WhatsApp
// entrante (siguiente paso de P2). Único valor síncrono expuesto a propósito,
// para los pocos lugares que necesitan un fallback de negocio sin poder await
// (ej. un valor por defecto de parámetro).
export const DEFAULT_BUSINESS_SLUG = "clinica-san-martin";

const defaultClinicConfig = {
  slug: DEFAULT_BUSINESS_SLUG,
  clinicName: "Clínica San Martín de Porres",
  timezone: "America/La_Paz",
  // Número de WhatsApp propio de la clínica (Kapso). null = usar el env var
  // global KAPSO_PHONE_NUMBER_ID (caso single-tenant / transición); con más de
  // una clínica, cada una debe tener el suyo en clinic_settings para responder
  // desde su propio número.
  kapsoPhoneNumberId: null as string | null,

  generalInfo: {
    address: "Av. Moscú, a una cuadra del Mercado La Cuchilla",
    phone: "+591 773 85 200",
    mapsUrl: "https://maps.app.goo.gl/RcMqdE3z8NX1ZULG6",
    hours: "Lunes a Sábado, 8:00 a 20:00",
  },

  welcomeMessage:
    "Bienvenido a Clínica San Martín de Porres 😊 ¿En qué podemos ayudarle?",

  qrImageUrl: "https://whatsapp-ai-chi.vercel.app/qr-bnb.jpg",
  paymentMethods: ["QR BNB", "Efectivo"],
  // Catálogos (se muestran cuando el paciente pregunta por exámenes/medicamentos).
  labs: [
    { name: "Hemograma Completo", price: 80 },
    { name: "Glucosa", price: 30 },
    { name: "Perfil Lipídico", price: 120 },
    { name: "Prueba de Embarazo", price: 50 },
    { name: "Examen General de Orina", price: 40 },
  ] as CatalogItem[],

  // Tarifario de servicios (consultas, ecografías, enfermería, etc.). Ver
  // lib/clinic/services.ts: solo ítems cara al paciente, sin costos internos.
  services: defaultServices as ServiceItem[],

  medications: [
    { name: "Paracetamol 500mg", price: 10 },
    { name: "Ibuprofeno 400mg", price: 15 },
    { name: "Amoxicilina 500mg", price: 25 },
    { name: "Loratadina", price: 12 },
    { name: "Omeprazol", price: 18 },
  ] as CatalogItem[],

  // EMERGENCIAS: si el mensaje contiene alguna de estas frases, NO se inicia la
  // reserva; se responde con emergencyResponse + ubicación.
  emergencyKeywords: [
    "desmayando",
    "me estoy desmayando",
    "dolor fuerte en el pecho",
    "no puedo respirar",
    "convulsiones",
    "convulsión",
    "accidente grave",
    "emergencia",
  ],
  emergencyResponse:
    "🚨 Diríjase inmediatamente a Emergencias. Comparta su ubicación en tiempo real con una persona cercana y solicite ayuda inmediata.\n\n📍 Av. Moscú, a una cuadra del Mercado La Cuchilla\n🗺️ https://maps.app.goo.gl/RcMqdE3z8NX1ZULG6\n📞 +591 773 85 200",

  // Dispara el flujo de agendamiento. Es un fast-path: lo que no cae acá lo
  // decide GPT en el webhook, así que conviene cubrir bien las formas comunes
  // para ahorrar esa llamada (y no depender de que responda).
  //
  // "ficha" es como los pacientes bolivianos piden un turno — la usaron varios
  // el 2026-08-24 y ninguno entraba por acá.
  //
  // OJO con "atiend": va anclado a "me atiend…" a propósito. Suelto capturaría
  // "¿a qué hora atienden?" o "¿atienden los domingos?", que son preguntas de
  // horario, y les arrancaría una reserva que nadie pidió.
  bookingIntentPatterns:
    /\bagendar|agenda|cita|citas|turno|ficha\w*|reserva\w*|sacar (una|un)|quiero (una|un)? ?(cita|turno|consulta|ficha)|atender\w*|me atiend\w*|consultar con/i,

  // Dispara cancelación/reprogramación.
  cancelIntentPatterns: /\bcancelar|anular|cancela mi/i,
  rescheduleIntentPatterns: /\breprogramar|reprograma|cambiar (mi|la) cita|reagendar|mover (mi|la) cita/i,

  // Dispara la consulta "¿cuándo es mi cita?" (solo informar, no agendar).
  checkAppointmentIntentPatterns:
    /cu[aá]ndo (es|ser[aá]|tengo) mi cita|a qu[eé] hora (es|tengo) mi cita|hora de mi cita|recu[eé]rdame mi cita|cu[aá]l es mi cita|tengo (una |)cita\?|mi cita es cu[aá]ndo/i,

  // Dispara la derivación a un humano: reclamos, o el paciente pide explícitamente
  // hablar con una persona / no quiere seguir con el bot. Pausa el bot (ver
  // pauseBotForHumanHandoff) para que el equipo retome la conversación.
  humanHandoffIntentPatterns:
    /hablar con (una persona|alguien|un humano)|quiero hablar con|no quiero hablar con (un bot|una máquina|un robot)|persona real|atención humana|\breclamo\b|\bqueja\b|estoy molest[oa]|p[eé]sim[oa] (servicio|atención)/i,

  replies: {
    welcome:
      "Bienvenido a Clínica San Martín de Porres 😊 Puedo ayudarle a *agendar una cita* o darle información (especialidades, precios, dirección, horarios). ¿Qué necesita?",
    proofButNoBooking:
      "Gracias 😊 ¿Desea agendar una cita? Escríbame y empezamos.",
    noActiveAppointment:
      "No encontré una cita activa a su nombre 😊 ¿Desea agendar una nueva?",
    humanHandoff:
      "Entiendo 🙏 Ya aviso a nuestro equipo para que le atienda directamente. En un momento se comunican con usted.",
  },

  // System prompt para consultas GENERALES (no el flujo de reserva, que lo maneja
  // el código). Se le inyectan los catálogos e info fija al vuelo.
  systemPromptBase: `
Eres el asistente virtual de la Clínica San Martín de Porres y atiendes por WhatsApp.
Hablas cálido, cercano, profesional y empático, como una recepcionista de Bolivia.
Mensajes cortos y naturales, nunca suenes a robot. Puedes usar "señor/a" con respeto y
algún emoji (😊, 👍) sin exagerar.

QUÉ HACES:
- Resuelves dudas generales: especialidades, precios de consulta, dirección, horarios,
  formas de pago, exámenes de laboratorio y medicamentos.
- Si la persona quiere AGENDAR, el sistema la guía paso a paso: NO inventes el flujo ni
  pidas datos por tu cuenta, solo invítala a agendar.

SÍNTOMAS: si la persona cuenta un malestar y no sabe a quién acudir, podés orientarla
sobre qué especialidad le corresponde, eligiendo SIEMPRE una de las que la clínica tiene
listadas. Nunca digas qué le pasa ni por qué: no es un diagnóstico, es solo orientarla.
Ante la duda, Medicina General.

PLANIFICACIÓN FAMILIAR: la clínica tiene una campaña vigente de implante subdérmico
anticonceptivo. Podés dar tal cual estos datos del método: protección de larga duración
(5 años), 99% de efectividad, es reversible (se retira cuando la paciente lo decida) y la
colocación es rápida, ambulatoria y la realiza personal profesional. El precio de campaña
está en el tarifario: citalo de ahí, nunca de memoria.

MÉTODOS ANTICONCEPTIVOS QUE OFRECE LA CLÍNICA: implante subdérmico (colocación y retiro),
DIU (colocación y retiro), ligadura, y consejería anticonceptiva dentro de la consulta de
ginecología. No menciones ni cotices ningún otro método (pastillas, inyectables, parches,
preservativos): si preguntan por uno, invitá a una consulta de ginecología para que la
médica le oriente.

DUDAS MÉDICAS del método (si le conviene, efectos secundarios, sangrados, si puede usarlo
con alguna condición, embarazo o lactancia): no respondas con criterio propio. Decí con
calidez que eso lo evalúa la ginecóloga en la valoración previa. Nunca describas el
procedimiento paso a paso ni afirmes que es indoloro o que no tiene riesgos.

DISPONIBILIDAD: nunca prometas un horario, un día, una franja ni "el médico que atiende
más temprano". Eso lo resuelve el sistema al agendar, no vos: invitá a agendar y el
sistema le muestra los turnos reales.

BREVEDAD: mensajes cortos y directos, no tipo catálogo. Primero resolvé exactamente lo
que preguntó la persona; ampliá información solo si la vuelve a pedir. Evitá listas
largas salvo que te las pidan explícitamente.

ALCANCE: nunca digas frases como "solo puedo ayudarte con..." ni aclares restricciones
de alcance cuando te preguntan algo genérico o relacionado a la clínica. Si de verdad
no sabés algo, decilo con calidez e invitá a llamar a la clínica, sin sonar limitado.

AUDIOS: a veces el mensaje del paciente empieza con "🎙️ Audio recibido" / "Transcripción:"
o con "🎙️ Audio:" — es una nota de voz que ya fue transcrita a texto. Tratá ese
contenido EXACTAMENTE como si lo hubiera escrito: respondé a lo que dice, con total
normalidad. Nunca menciones que era un audio ni comentes la transcripción.
`,
};

export type ClinicConfig = typeof defaultClinicConfig;

// Caché en memoria del runtime (por instancia serverless), TTL corto. En
// serverless cada instancia tiene su propia caché — con un TTL de 45s el
// "stale" máximo entre instancias es aceptable para datos de catálogo/textos
// que cambian con poca frecuencia.
const CONFIG_CACHE_TTL_MS = 45_000;
const configCache = new Map<string, { value: ClinicConfig; expiresAt: number }>();

export function invalidateClinicConfigCache(business?: string) {
  if (business) configCache.delete(business);
  else configCache.clear();
}

function mapClinicSettingsRow(row: any): ClinicConfig {
  const replies = row.replies ?? {};
  return {
    ...defaultClinicConfig, // conserva los patrones de intención (regex, iguales para todas)
    slug: String(row.business),
    kapsoPhoneNumberId: row.kapso_phone_number_id ?? null,
    clinicName: String(row.clinic_name ?? defaultClinicConfig.clinicName),
    timezone: String(row.timezone ?? defaultClinicConfig.timezone),
    generalInfo: {
      address: row.address ?? defaultClinicConfig.generalInfo.address,
      phone: row.phone ?? defaultClinicConfig.generalInfo.phone,
      mapsUrl: row.maps_url ?? defaultClinicConfig.generalInfo.mapsUrl,
      hours: row.hours ?? defaultClinicConfig.generalInfo.hours,
    },
    welcomeMessage: row.welcome_message ?? defaultClinicConfig.welcomeMessage,
    qrImageUrl: row.qr_image_url ?? defaultClinicConfig.qrImageUrl,
    paymentMethods: Array.isArray(row.payment_methods) && row.payment_methods.length
      ? row.payment_methods
      : defaultClinicConfig.paymentMethods,
    labs: Array.isArray(row.labs) && row.labs.length ? row.labs : defaultClinicConfig.labs,
    medications: Array.isArray(row.medications) && row.medications.length
      ? row.medications
      : defaultClinicConfig.medications,
    services: Array.isArray(row.services) && row.services.length
      ? row.services
      : defaultClinicConfig.services,
    emergencyKeywords: Array.isArray(row.emergency_keywords) && row.emergency_keywords.length
      ? row.emergency_keywords
      : defaultClinicConfig.emergencyKeywords,
    emergencyResponse: row.emergency_response ?? defaultClinicConfig.emergencyResponse,
    systemPromptBase: row.system_prompt_base ?? defaultClinicConfig.systemPromptBase,
    replies: {
      welcome: replies.welcome ?? defaultClinicConfig.replies.welcome,
      proofButNoBooking: replies.proofButNoBooking ?? defaultClinicConfig.replies.proofButNoBooking,
      noActiveAppointment: replies.noActiveAppointment ?? defaultClinicConfig.replies.noActiveAppointment,
      humanHandoff: replies.humanHandoff ?? defaultClinicConfig.replies.humanHandoff,
    },
  };
}

// Única puerta de entrada a la config de una clínica.
export async function getClinicConfig(business: string = DEFAULT_BUSINESS_SLUG): Promise<ClinicConfig> {
  const cached = configCache.get(business);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: ClinicConfig = defaultClinicConfig;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("clinic_settings")
      .select("*")
      .eq("business", business)
      .maybeSingle();

    if (error) {
      console.error("getClinicConfig: query failed, using static fallback", error);
    } else if (data) {
      value = mapClinicSettingsRow(data);
    } else {
      console.warn(`getClinicConfig: no clinic_settings row for business="${business}", using static fallback`);
    }
  } catch (err) {
    console.error("getClinicConfig threw, using static fallback", err);
  }

  configCache.set(business, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  return value;
}

// Resuelve qué clínica es dueña de un número de WhatsApp (Kapso
// phone_number_id) — usado por el webhook para saber a quién le escribieron.
// null si no hay ninguna fila con ese número (fallback: DEFAULT_BUSINESS_SLUG
// en el caller, para no romper el bot mientras se completa el alta de una
// clínica nueva).
export async function getBusinessByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("clinic_settings")
      .select("business")
      .eq("kapso_phone_number_id", phoneNumberId)
      .maybeSingle();

    if (error || !data) return null;
    return String(data.business);
  } catch (err) {
    console.error("getBusinessByPhoneNumberId threw", err);
    return null;
  }
}

// Tarifario agrupado por categoría, en el orden de SERVICE_CATEGORY_ORDER.
// Las categorías vacías se omiten (una clínica puede no tener ecografías).
function buildServicesBlock(services: ServiceItem[]): string {
  return SERVICE_CATEGORY_ORDER.flatMap((category) => {
    const items = services.filter((s) => s.category === category);
    if (!items.length) return [];
    return [
      `${SERVICE_CATEGORY_LABELS[category]}:`,
      ...items.map((s) => {
        const note = s.note ? ` (${s.note})` : "";
        return `- ${s.name}${note}: ${formatServicePrice(s)}`;
      }),
      "",
    ];
  }).join("\n").trimEnd();
}

// Arma el system prompt completo para Q&A general inyectando info y catálogos.
// Las reglas críticas (no inventar datos, no diagnosticar, no revelar que es un bot)
// se repiten al FINAL a propósito: los modelos priorizan más lo que leen último
// ("recencia"), y acá van justo después de los catálogos que el modelo podría
// verse tentado a completar o extrapolar.
export function buildClinicSystemPrompt(clinic: ClinicConfig): string {
  const labs = clinic.labs.map((l) => `- ${l.name}: ${l.price} Bs`).join("\n");
  const meds = clinic.medications.map((m) => `- ${m.name}: ${m.price} Bs`).join("\n");

  return [
    clinic.systemPromptBase,
    "DATOS DE LA CLÍNICA:",
    `- Nombre: ${clinic.clinicName}`,
    `- Dirección: ${clinic.generalInfo.address}`,
    `- Teléfono: ${clinic.generalInfo.phone}`,
    `- Google Maps: ${clinic.generalInfo.mapsUrl}`,
    `- Horario de atención: ${clinic.generalInfo.hours}`,
    `- Formas de pago: ${clinic.paymentMethods.join(", ")}`,
    "",
    "EXÁMENES DE LABORATORIO (precios):",
    labs,
    "",
    "MEDICAMENTOS (precios):",
    meds,
    "",
    "TARIFARIO DE SERVICIOS (precios exactos, cítalos tal cual):",
    buildServicesBlock(clinic.services),
    "",
    "Si preguntan por una especialidad o doctor en particular y no lo tienes, invita a agendar para verificar disponibilidad.",
    "Si preguntan por un servicio del tarifario que NO es una consulta (ecografías, procedimientos, cirugías, partos, enfermería, certificados): informa el precio, pregúntale qué día y horario le quedaría cómodo, y aclara que con ese dato un asesor del equipo le confirma la disponibilidad. No confirmes vos el horario ni intentes agendarlo.",
    "",
    "REGLAS CRÍTICAS (repetidas por prioridad — nunca las rompas):",
    "- No inventes precios, doctores, especialidades, horarios ni disponibilidad que no estén arriba. Si no está en los datos provistos, no existe para vos. Nunca estimes ni redondees un precio que no figure en el tarifario.",
    "- Para urgencias médicas reales indica acudir a Emergencias / llamar a la clínica; nunca des diagnósticos ni consejo médico.",
    "- Nunca menciones que sos un bot, IA o automatización, aunque te lo pregunten directamente.",
  ].join("\n");
}
