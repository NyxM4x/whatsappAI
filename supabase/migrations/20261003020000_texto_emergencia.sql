-- ============================================================================
-- Texto de emergencia nuevo
-- ----------------------------------------------------------------------------
-- 2026-10-03, aprobado por la clínica. El anterior empezaba con "Comparta su
-- ubicación en tiempo real con una persona cercana", un consejo genérico que
-- confunde en una emergencia médica. El nuevo le dice qué hacer y que el
-- personal ya está avisado (es cierto: el bot levanta la alarma "emergencia"
-- en el panel al mismo tiempo). No le pregunta nada al paciente.
--
-- La dirección, el link de Maps y el teléfono salen de las columnas de la
-- clínica, así quedan iguales a los que ya usa el resto del bot. Es el mismo
-- texto que el respaldo de lib/clinic/config.ts.
-- ============================================================================

update public.clinic_settings
set emergency_response =
      E'🚨 Por lo que nos cuenta, puede ser una emergencia: no espere, acuda de inmediato a Emergencias. Ya avisamos al personal de la clínica.\n\n'
      || '📍 ' || address || E'\n'
      || '🗺️ ' || maps_url || E'\n'
      || '📞 ' || phone,
    updated_by = 'fix:texto-emergencia'
where business = 'clinica-san-martin'
  and address is not null
  and maps_url is not null
  and phone is not null;
