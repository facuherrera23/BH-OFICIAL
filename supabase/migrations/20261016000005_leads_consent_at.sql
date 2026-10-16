-- Registro de consentimiento del tratamiento de datos personales (Ley 25.326).
-- El landing ya exige aceptación explícita (checkbox required), pero no
-- registraba CUÁNDO se dio el consentimiento. Esta columna es la evidencia
-- legal: "el usuario consintió el tratamiento de sus datos el [fecha]".

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS consent_at timestamptz;
COMMENT ON COLUMN public.leads.consent_at IS 'Fecha y hora del consentimiento del tratamiento de datos personales (Ley 25.326). Se llena al enviar el formulario del landing.';
