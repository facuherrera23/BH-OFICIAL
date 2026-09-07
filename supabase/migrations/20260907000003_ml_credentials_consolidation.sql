-- =====================================================================
-- 20260907000003_ml_credentials_consolidation
--
-- Consolida las credenciales de la app de Mercado Libre en site_settings
-- (storage CANÓNICO que leen getMlCredentials()/_shared/ml.ts y ml-oauth).
--
-- Antes: el panel guardaba en portal_settings.settings (ml_app_id /
-- ml_secret_key) via ml-config, pero el flujo OAuth leía de site_settings
-- (ml_app_id / ml_client_secret) o env vars -> el botón "Conectar ML"
-- siempre fallaba con "ML_CLIENT_ID / ML_CLIENT_SECRET no configurados".
--
-- Esta migración:
--   1. Copia ml_app_id y ml_secret_key desde portal_settings a site_settings.
--   2. Fija ml_redirect_uri (canónico + legacy) al flujo MODERNO ml-oauth.
--      IMPORTANTE: registrar esta URI EXACTA en la consola de desarrollador
--      de Mercado Libre (https://auth.mercadolibre.com.ar/developers).
-- =====================================================================
BEGIN;

-- 1) ml_app_id (canónico, shape {"value": "..."} para s.value?.value)
INSERT INTO public.site_settings (key, value, updated_at)
SELECT
    'ml_app_id',
    jsonb_build_object('value', p.settings->>'ml_app_id'),
    now()
FROM public.portal_settings AS p
WHERE p.portal_name = 'Mercado Libre'
  AND COALESCE(p.settings->>'ml_app_id', '') <> ''
ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = now();

-- 2) ml_client_secret (canónico, desde ml_secret_key legacy)
INSERT INTO public.site_settings (key, value, updated_at)
SELECT
    'ml_client_secret',
    jsonb_build_object('value', p.settings->>'ml_secret_key'),
    now()
FROM public.portal_settings AS p
WHERE p.portal_name = 'Mercado Libre'
  AND COALESCE(p.settings->>'ml_secret_key', '') <> ''
ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = now();

-- 3) ml_redirect_uri canónico -> flujo moderno ml-oauth
INSERT INTO public.site_settings (key, value, updated_at)
VALUES (
    'ml_redirect_uri',
    jsonb_build_object('value', 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/ml-oauth'),
    now()
)
ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = now();

-- 4) Espejo en portal_settings para compatibilidad con UI legacy / ml-auth / ml-callback
UPDATE public.portal_settings
SET settings = jsonb_set(
        jsonb_set(settings, '{ml_redirect_uri}', '"https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/ml-oauth"'),
        '{ml_app_id}',
        to_jsonb(COALESCE(settings->>'ml_app_id', ''))
    ),
    updated_at = now()
WHERE portal_name = 'Mercado Libre';

COMMIT;