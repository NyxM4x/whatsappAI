-- Actualiza el enlace oficial de Google Maps de la clínica.
update public.clinic_settings
set maps_url = 'https://maps.app.goo.gl/cZcqhWE9LGhWifvo7?g_st=ic',
    updated_at = now()
where business = 'clinica-san-martin';