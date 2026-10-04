// ============================================================================
// Aviso en vivo al panel interno: "cambiaron las solicitudes de esta clínica".
// ----------------------------------------------------------------------------
// El panel consultaba /api/admin/leads cada 5 s por pestaña abierta, las 24 h.
// Ahora cada escritura en clinic_leads manda un aviso por Supabase Realtime
// (Broadcast) y el panel consulta solo al recibirlo; el sondeo queda de
// respaldo, más espaciado.
//
// El aviso va vacío: no lleva datos de pacientes. El panel sigue leyendo las
// solicitudes por /api/admin/leads, con su sesión de staff.
//
// Se activa con SUPABASE_ANON_KEY. Sin esa variable no se avisa y el panel
// sigue sondeando cada 5 s, igual que antes.
// ============================================================================

import { getRequiredEnv } from "@/lib/engine/clients";

const LEADS_CHANGED_EVENT = "changed";

export type LeadsRealtimeConfig = {
  url: string;
  anonKey: string;
  channel: string;
  event: string;
};

function leadsChannelName(business: string): string {
  return `admin-leads:${business}`;
}

// Lo que necesita el navegador para escuchar el aviso. null = sin aviso en vivo.
export function getLeadsRealtimeConfig(business: string): LeadsRealtimeConfig | null {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey, channel: leadsChannelName(business), event: LEADS_CHANGED_EVENT };
}

// Nunca lanza ni frena al bot más de 2 s: si el aviso falla, el sondeo de
// respaldo del panel lo cubre.
export async function notifyLeadsChanged(business: string): Promise<void> {
  if (!process.env.SUPABASE_ANON_KEY) return;
  try {
    const serviceKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const baseUrl = getRequiredEnv("SUPABASE_URL").replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { topic: leadsChannelName(business), event: LEADS_CHANGED_EVENT, payload: {}, private: false },
        ],
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) console.error("notifyLeadsChanged failed", res.status);
  } catch (error) {
    console.error("notifyLeadsChanged failed", error);
  }
}
