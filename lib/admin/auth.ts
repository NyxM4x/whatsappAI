// ============================================================================
// Autenticación del panel interno (secretaria) — /admin
// ----------------------------------------------------------------------------
// Login por usuario/contraseña contra la tabla clinic_staff (password_hash con
// bcrypt/pgcrypto). Sesión = cookie HttpOnly firmada con HMAC (sin librería de
// JWT: un payload base64 + firma, verificado con comparación a tiempo
// constante). No hay "recordar contraseña" ni gestión de usuarios desde la UI
// todavía — altas/bajas de personal se hacen por SQL (ver migración).
// ============================================================================

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/engine/clients";

export type StaffSession = {
  staffId: string;
  business: string;
  name: string;
  email: string;
};

export const ADMIN_COOKIE_NAME = "clinic_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function getSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("Missing ADMIN_SESSION_SECRET");
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function verifySignature(payload: string, signature: string): boolean {
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function createSessionToken(staff: StaffSession): string {
  const payload = JSON.stringify({ ...staff, exp: Date.now() + SESSION_TTL_MS });
  const encoded = Buffer.from(payload).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifySessionToken(token: string | undefined | null): StaffSession | null {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !verifySignature(encoded, signature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return {
      staffId: String(payload.staffId),
      business: String(payload.business),
      name: String(payload.name),
      email: String(payload.email),
    };
  } catch {
    return null;
  }
}

export async function verifyStaffCredentials(
  business: string,
  email: string,
  password: string,
): Promise<StaffSession | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clinic_staff")
    .select("id, name, email, password_hash, is_active")
    .eq("business", business)
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  if (error || !data || !data.is_active) return null;

  const valid = await bcrypt.compare(password, data.password_hash);
  if (!valid) return null;

  return { staffId: String(data.id), business, name: data.name, email: data.email };
}

// ─── Rate limiting del login (P1.8) ──────────────────────────────────────────
// Sin memoria persistente entre invocaciones serverless, así que el conteo vive
// en Supabase (tabla clinic_login_attempts, migración 20260717010000).

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min

// true si (business, email) superó el máximo de fallos en la ventana reciente.
// Ante error de consulta, fail-open (no bloquear): una falla transitoria de BD
// no debe dejar a la secretaria sin poder entrar.
export async function isLoginRateLimited(business: string, email: string): Promise<boolean> {
  const supabase = getSupabaseClient();
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();

  const { count, error } = await supabase
    .from("clinic_login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("business", business)
    .eq("email", email.trim().toLowerCase())
    .eq("success", false)
    .gte("created_at", since);

  if (error) {
    console.error("isLoginRateLimited failed", error);
    return false;
  }
  return (count ?? 0) >= LOGIN_MAX_FAILURES;
}

export async function recordLoginAttempt(
  business: string,
  email: string,
  success: boolean,
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("clinic_login_attempts").insert({
    business,
    email: email.trim().toLowerCase(),
    success,
  });
  if (error) console.error("recordLoginAttempt failed", error);
}

// Lee la sesión sin redirigir — para usar en Route Handlers (API), donde hay
// que devolver 401 en vez de una redirección de página.
export async function getStaffSession(): Promise<StaffSession | null> {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
}

// Para usar en Server Components / Server Actions: redirige al login si no
// hay sesión válida.
export async function requireStaff(): Promise<StaffSession> {
  const session = await getStaffSession();
  if (!session) redirect("/admin/login");
  return session;
}
