// ============================================================================
// CONFIGURACIÓN — por clínica (multi-tenant, P2)
// ----------------------------------------------------------------------------
// Datos FIJOS del negocio. Las especialidades/doctores/precios de CONSULTA
// viven en la BD (clinic_specialties / clinic_doctors). Aquí: identidad, QR,
// emergencias, catálogos de labs/medicamentos y el tono del bot.
//
// getClinicConfig() es la ÚNICA puerta de entrada — nada más en el código debe
// importar `defaultClinicConfig` directo. Hoy devuelve el objeto estático de
// abajo (estamos migrando de "un archivo" a "una fila por clínica" de a
// pasos); cuando se conecte a la tabla clinic_settings + caché, el cambio será
// puramente interno a este archivo, sin tocar a quienes ya llaman
// `await getClinicConfig(business)`.
// ============================================================================

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

  generalInfo: {
    address: "Av. Moscú, a una cuadra del Mercado La Cuchilla",
    phone: "+591 75681881",
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
    "🚨 Diríjase inmediatamente a Emergencias. Comparta su ubicación en tiempo real con una persona cercana y solicite ayuda inmediata.\n\n📍 Av. Moscú, a una cuadra del Mercado La Cuchilla\n🗺️ https://maps.app.goo.gl/RcMqdE3z8NX1ZULG6\n📞 +591 75681881",

  // Dispara el flujo de agendamiento.
  bookingIntentPatterns:
    /\bagendar|agenda|cita|citas|turno|reserva\w*|sacar (una|un)|quiero (una|un)? ?(cita|turno|consulta)|atender\w*|consultar con/i,

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

// Caché en memoria del runtime (por instancia serverless), TTL corto. Hoy no
// hace efecto real (getClinicConfig no pega a ninguna BD todavía), pero queda
// lista para cuando este archivo pase a leer de clinic_settings — así ese
// cambio no necesita tocar a los callers ni agregar otra capa después.
const CONFIG_CACHE_TTL_MS = 45_000;
const configCache = new Map<string, { value: ClinicConfig; expiresAt: number }>();

export function invalidateClinicConfigCache(business?: string) {
  if (business) configCache.delete(business);
  else configCache.clear();
}

// Única puerta de entrada a la config de una clínica. Firma async a propósito
// desde ya (aunque hoy resuelve en memoria) para que el futuro salto a
// Supabase no obligue a tocar cada call site una segunda vez.
export async function getClinicConfig(business: string = DEFAULT_BUSINESS_SLUG): Promise<ClinicConfig> {
  const cached = configCache.get(business);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // TODO (P2): reemplazar por una lectura a la tabla clinic_settings cuando
  // exista más de una clínica. Por ahora, single-tenant: cualquier business
  // devuelve la config estática de la Clínica San Martín.
  const value = defaultClinicConfig;
  configCache.set(business, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  return value;
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
    "Si preguntan por una especialidad o doctor en particular y no lo tienes, invita a agendar para verificar disponibilidad.",
    "",
    "REGLAS CRÍTICAS (repetidas por prioridad — nunca las rompas):",
    "- No inventes precios, doctores, especialidades, horarios ni disponibilidad que no estén arriba. Si no está en los datos provistos, no existe para vos.",
    "- Para urgencias médicas reales indica acudir a Emergencias / llamar a la clínica; nunca des diagnósticos ni consejo médico.",
    "- Nunca menciones que sos un bot, IA o automatización, aunque te lo pregunten directamente.",
  ].join("\n");
}
