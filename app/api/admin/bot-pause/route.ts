// ============================================================================
// Pausar / reactivar la IA para UN cliente puntual desde el panel /admin.
// ----------------------------------------------------------------------------
// Actúa siempre por teléfono (identidad durable, ver lib/engine/data.ts), nunca
// por conversation.id: es justo lo que evita que un conversation.id nuevo del
// mismo cliente "resucite" al bot. Requiere sesión de staff (cookie firmada,
// ver lib/admin/auth.ts) — no hay ningún endpoint público de reactivación.
// ============================================================================

import { getStaffSession } from "@/lib/admin/auth";
import { logAdminAudit } from "@/lib/clinic/data";
import { getBotPauseState, setManualBotPause, clearBotPause } from "@/lib/engine/data";
import { normalizePhone } from "@/lib/engine/phone";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const staff = await getStaffSession();
  if (!staff) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const phone = typeof body?.phone === "string" ? body.phone : null;
  const action = body?.action === "pause" || body?.action === "resume" ? body.action : null;

  if (!phone || !normalizePhone(phone) || !action) {
    return Response.json({ error: "phone and action ('pause'|'resume') are required" }, { status: 400 });
  }

  const before = await getBotPauseState(undefined, phone);

  if (action === "pause") {
    await setManualBotPause({ phone, reason: "manual_pause_admin_panel" });
  } else {
    await clearBotPause({ phone, reason: "manual_resume_admin_panel" });
  }

  const after = await getBotPauseState(undefined, phone);

  await logAdminAudit({
    business: staff.business,
    actorId: staff.staffId,
    actorName: staff.name,
    action: action === "pause" ? "bot.pause" : "bot.resume",
    entity: "bot_pause_state",
    entityId: normalizePhone(phone)!,
    before: { paused: before.paused && !before.expired },
    after: { paused: after.paused && !after.expired },
  });

  return Response.json({
    ok: true,
    phone: normalizePhone(phone),
    botPaused: after.paused && !after.expired,
  });
}
