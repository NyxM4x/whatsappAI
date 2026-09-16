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
import { whatsappWebChatUrl } from "@/lib/engine/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toDto(lead: Lead) {
  const { summary: _summary, business: _business, ...rest } = lead;
  return { ...rest, waUrl: whatsappWebChatUrl(lead.contactPhone) };
}

export async function GET() {
  const staff = await getStaffSession();
  if (!staff) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { pending, recent } = await listLeadsForAdmin(staff.business);
  return Response.json(
    { pending: pending.map(toDto), recent: recent.map(toDto) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
