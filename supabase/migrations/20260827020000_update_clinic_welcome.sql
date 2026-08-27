-- Actualiza el saludo efectivo de la clínica y el prompt persistido.
update public.clinic_settings
set welcome_message = 'Buenas, somos la Clínica San Martín de Porres. Un gusto, ¿en qué puedo ayudarte hoy? 😊',
    replies = coalesce(replies, '{}'::jsonb) || jsonb_build_object(
      'welcome', 'Buenas, somos la Clínica San Martín de Porres. Un gusto, ¿en qué puedo ayudarte hoy? 😊'
    ),
    system_prompt_base = coalesce(system_prompt_base, '') || E'\n\nREGLA DE SALUDO OBLIGATORIA:\n'
      || 'Si el paciente solo saluda o no especifica qué necesita, responde exactamente: '
      || '"Buenas, somos la Clínica San Martín de Porres. Un gusto, ¿en qué puedo ayudarte hoy? 😊" '
      || 'Si el paciente saluda y además hace una solicitud concreta, responde directamente a esa solicitud sin usar este saludo.',
    updated_at = now()
where business = 'clinica-san-martin';