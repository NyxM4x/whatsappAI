-- Actualiza el saludo efectivo de la clínica.
update public.clinic_settings
set welcome_message = 'Bienvenido a la Clínica San Martín de Porres, ¿en qué podemos ayudarle?',
    replies = coalesce(replies, '{}'::jsonb) || jsonb_build_object(
      'welcome', 'Bienvenido a la Clínica San Martín de Porres, ¿en qué podemos ayudarle?'
    ),
    updated_at = now()
where business = 'clinica-san-martin';