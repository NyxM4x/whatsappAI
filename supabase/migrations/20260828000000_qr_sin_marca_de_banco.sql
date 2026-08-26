-- ============================================================================
-- El QR de pago se nombra sin la marca del banco
-- ----------------------------------------------------------------------------
-- `payment_methods` se inyecta en el system prompt, así que el bot repetía
-- "QR BNB" al hablar con los pacientes. La clínica no quiere nombrar al banco:
-- es simplemente "el QR de la clínica".
--
-- El resto de los textos ("1. Pago con QR", etc.) vive en el código
-- (lib/clinic/booking.ts y lib/clinic/config.ts) y ya se actualizó ahí.
-- ============================================================================

update public.clinic_settings
set payment_methods = array['QR', 'Efectivo']
where 'QR BNB' = any(payment_methods);
