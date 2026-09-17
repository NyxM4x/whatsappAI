// ============================================================================
// Solicitudes para la alarma del panel interno (/admin).
// ----------------------------------------------------------------------------
// LeadsBoard lo consulta cada 5 s: pendientes (hacen sonar la alarma) y las
// últimas cerradas. Requiere sesión de staff; sin ella devuelve 401 y el panel
// avisa que la sesión se cerró.
// ============================================================================

import { getStaffSession } from "@/lib/admin/auth";
import { listLeadsForAdmin } from "@/lib/clinic/data";
import type { Lead } from "@/lib/clinic/types";
import { getBotPauseStatesForPhones } from "@/lib/engine/data";
import { normalizePhone, whatsappWebChatUrl } from "@/lib/engine/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toDto(lead: Lead, botPaused: boolean) {
  const { summary: _summary, business: _business, ...rest } = lead;
  return { ...rest, waUrl: whatsappWebChatUrl(lead.contactPhone), botPaused };
}

export async function GET() {
  const staff = await getStaffSession();
  if (!staff) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { pending, recent } = await listLeadsForAdmin(staff.business);

  // Estado de pausa por teléfono en una sola consulta (identidad durable, no
  // conversation.id): así el panel muestra si la IA sigue activa para ese
  // cliente sin importar cuántas conversaciones técnicas haya tenido.
  const phones = [...pending, ...recent].map((l) => l.contactPhone);
  const pauseStates = await getBotPauseStatesForPhones(phones);
  const isPaused = (phone: string) => {
    const state = pauseStates[normalizePhone(phone) ?? ""];
    return Boolean(state?.paused && !state.expired);
  };

  return Response.json(
    {
      pending: pending.map((lead) => toDto(lead, isPaused(lead.contactPhone))),
      recent: recent.map((lead) => toDto(lead, isPaused(lead.contactPhone))),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
