// ============================================================================
// Botón "Atender" de una solicitud del panel: la marca como atendida (se calla
// su alarma) y deja auditoría de quién la tomó. Si otra persona ya la atendió,
// responde ok igual: el resultado para quien pulsa es el mismo.
// ============================================================================

import { getStaffSession } from "@/lib/admin/auth";
import { attendLead, logAdminAudit } from "@/lib/clinic/data";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaffSession();
  if (!staff) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const lead = await attendLead(staff.business, id, { staffId: staff.staffId, name: staff.name });

  if (lead) {
    await logAdminAudit({
      business: staff.business,
      actorId: staff.staffId,
      actorName: staff.name,
      action: "lead.attend",
      entity: "lead",
      entityId: id,
      before: { status: "pending" },
      after: { status: "attended" },
    });
  }

  return Response.json({ ok: true, alreadyAttended: !lead });
}
