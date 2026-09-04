// ============================================================================
// Identidad telefónica canónica.
// ----------------------------------------------------------------------------
// Kapso entrega el número del paciente por rutas distintas según el evento:
//   - inbound  → event.message.from          (ej: "59170000000")
//   - outbound → event.conversation.phone_number (ej: "+591 70000000")
// Comparar esas cadenas tal cual hacía que el takeover humano escribiera la
// pausa contra una identidad y el webhook la leyera contra otra.
//
// La normalización es deliberadamente CONSERVADORA: solo elimina diferencias de
// formato (prefijo "+", espacios, guiones, paréntesis, puntos). NO infiere
// códigos de país, no recorta dígitos ni reescribe el número de ninguna forma.
//
// IMPORTANTE: debe coincidir EXACTAMENTE con public.normalize_phone() en
// supabase/migrations/20260904000000_human_takeover_durable_identity.sql
//   sql: nullif(regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g'), '')
// ============================================================================

export function normalizePhone(raw?: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits : null;
}

// true si dos representaciones apuntan al mismo número (misma identidad
// durable). Devuelve false si alguna no es normalizable.
export function samePhoneIdentity(a?: string | null, b?: string | null): boolean {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return left !== null && left === right;
}
