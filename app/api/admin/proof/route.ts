// ============================================================================
// Proxy autenticado para ver comprobantes de pago desde el panel interno.
// ----------------------------------------------------------------------------
// Las URLs de media de Kapso requieren el header X-API-Key para descargarse
// (no son públicas), así que un <a href> directo no funciona para la
// secretaria. Este endpoint descarga la imagen del lado del servidor (con la
// API key) y se la reenvía, exigiendo sesión de staff válida.
// ============================================================================

import { getStaffSession } from "@/lib/admin/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const staff = await getStaffSession();
  if (!staff) return new Response("Unauthorized", { status: 401 });

  const target = new URL(request.url).searchParams.get("url");
  if (!target) return new Response("Missing url", { status: 400 });

  try {
    const upstream = await fetch(target, {
      headers: process.env.KAPSO_API_KEY ? { "X-API-Key": process.env.KAPSO_API_KEY } : {},
    });

    if (!upstream.ok || !upstream.body) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      },
    });
  } catch (err) {
    console.error("admin proof proxy failed", err);
    return new Response("Error", { status: 502 });
  }
}
