// ============================================================================
// Proxy autenticado para ver comprobantes de pago desde el panel interno.
// ----------------------------------------------------------------------------
// Las URLs de media de Kapso requieren el header X-API-Key para descargarse
// (no son públicas), así que un <a href> directo no funciona para la
// secretaria. Este endpoint descarga la imagen del lado del servidor (con la
// API key) y se la reenvía, exigiendo sesión de staff válida.
//
// Endurecimiento (P0.2):
//   - Solo http/https y se bloquean hosts internos (anti-SSRF): sin la
//     validación, un `?url=` arbitrario permitía pedir URLs internas.
//   - El header X-API-Key SOLO se envía a hosts de Kapso; a cualquier otro
//     dominio no se adjunta, para no filtrar la API key si la URL apunta afuera.
// ============================================================================

import { getStaffSession } from "@/lib/admin/auth";

export const runtime = "nodejs";

// Hosts a los que SÍ se puede adjuntar la API key de Kapso.
const KAPSO_HOST_SUFFIX = ".kapso.ai";
const KAPSO_HOST_EXACT = "kapso.ai";

function isKapsoHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === KAPSO_HOST_EXACT || h.endsWith(KAPSO_HOST_SUFFIX);
}

// Bloqueo best-effort de destinos internos/privados (anti-SSRF).
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (!h.includes(".")) return true; // hostnames sin punto (metadata internos, etc.)
  // Rangos IPv4 privados / loopback / link-local.
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  return false;
}

export async function GET(request: Request) {
  const staff = await getStaffSession();
  if (!staff) return new Response("Unauthorized", { status: 401 });

  const target = new URL(request.url).searchParams.get("url");
  if (!target) return new Response("Missing url", { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Invalid url", { status: 400 });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new Response("Invalid scheme", { status: 400 });
  }
  if (isBlockedHost(parsed.hostname)) {
    return new Response("Forbidden host", { status: 400 });
  }

  // La API key SOLO viaja a hosts de Kapso; a cualquier otro dominio no se adjunta.
  const headers: Record<string, string> =
    isKapsoHost(parsed.hostname) && process.env.KAPSO_API_KEY
      ? { "X-API-Key": process.env.KAPSO_API_KEY }
      : {};

  try {
    const upstream = await fetch(parsed.toString(), { headers, redirect: "error" });

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
