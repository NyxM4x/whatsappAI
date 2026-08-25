-- ============================================================================
-- Teléfono: sale el número de pruebas, entra el oficial de la clínica
-- ----------------------------------------------------------------------------
-- El +591 75681881 que el bot venía dando (dato de contacto, respuesta de
-- emergencias y varios mensajes de error) es el número personal donde se hacen
-- las pruebas, no el de la clínica: mandar pacientes ahí es un riesgo real.
--
-- Pasa a ser el oficial, el mismo que la clínica publica en su campaña. En los
-- mensajes de ERROR ya no va ningún teléfono: el bot dice que deriva la
-- petición a un asesor y la deriva de verdad (ver el catch del Q&A en
-- app/api/webhooks/clinica/route.ts, que ahora pausa el bot).
--
-- La fila de clinic_settings es la fuente de verdad en producción: sin este
-- update el bot sigue dando el número viejo aunque el código esté desplegado.
-- ============================================================================

update public.clinic_settings
set phone = '+591 773 85 200',
    emergency_response = replace(emergency_response, '+591 75681881', '+591 773 85 200'),
    updated_by = 'fix:telefono-oficial'
where business = 'clinica-san-martin'
  and (phone = '+591 75681881' or emergency_response like '%75681881%');
