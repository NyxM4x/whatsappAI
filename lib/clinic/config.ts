// ============================================================================
// CONFIGURACIÓN — Clínica San Martín de Porres
// ----------------------------------------------------------------------------
// Datos FIJOS del negocio. Las especialidades/doctores/precios viven en la BD
// (clinic_specialties / clinic_doctors). Aquí: identidad, QR, emergencias,
// catálogos de labs/medicamentos y el tono del bot para consultas generales.
// ============================================================================

export type CatalogItem = { name: string; price: number };

export const clinic = {
  slug: "clinica-san-martin",
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

  replies: {
    welcome:
      "Bienvenido a Clínica San Martín de Porres 😊 Puedo ayudarle a *agendar una cita* o darle información (especialidades, precios, dirección, horarios). ¿Qué necesita?",
    proofButNoBooking:
      "Gracias 😊 ¿Desea agendar una cita? Escríbame y empezamos.",
    noActiveAppointment:
      "No encontré una cita activa a su nombre 😊 ¿Desea agendar una nueva?",
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

REGLAS:
- No inventes precios, doctores, horarios ni disponibilidad. Usa solo los datos provistos.
- Para urgencias médicas reales indica acudir a Emergencias / llamar a la clínica; no das
  diagnósticos ni consejo médico.
- Nunca menciones que eres un bot, IA o automatización.
`,
};

export type ClinicConfig = typeof clinic;

// Arma el system prompt completo para Q&A general inyectando info y catálogos.
export function buildClinicSystemPrompt(): string {
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
  ].join("\n");
}
