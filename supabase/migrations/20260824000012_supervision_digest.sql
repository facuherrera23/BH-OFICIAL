-- ============================================================
-- BIENENHAUS - Digest Semanal de Supervisión
-- pg_cron job + configuración
-- ============================================================

-- Requiere extensión pg_cron (ya habilitada en Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- 1. Configuración en app_settings (defaults)
-- ============================================================
DO $$
BEGIN
    -- Integrations config para digest
    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'integrations' AND value ? 'supervision_digest_recipients') THEN
        UPDATE app_settings
        SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{supervision_digest_recipients}',
            '[]'::jsonb
        )
        WHERE key = 'integrations';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'integrations' AND value ? 'supervision_digest_kpis') THEN
        UPDATE app_settings
        SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{supervision_digest_kpis}',
            'true'::jsonb
        )
        WHERE key = 'integrations';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'integrations' AND value ? 'supervision_digest_rankings') THEN
        UPDATE app_settings
        SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{supervision_digest_rankings}',
            'true'::jsonb
        )
        WHERE key = 'integrations';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'integrations' AND value ? 'supervision_digest_alerts') THEN
        UPDATE app_settings
        SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{supervision_digest_alerts}',
            'true'::jsonb
        )
        WHERE key = 'integrations';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'integrations' AND value ? 'supervision_digest_trends') THEN
        UPDATE app_settings
        SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{supervision_digest_trends}',
            'true'::jsonb
        )
        WHERE key = 'integrations';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'integrations' AND value ? 'supervision_digest_unassigned') THEN
        UPDATE app_settings
        SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{supervision_digest_unassigned}',
            'true'::jsonb
        )
        WHERE key = 'integrations';
    END IF;
END $$;

-- ============================================================
-- 2. pg_cron job: ejecución semanal los lunes a las 08:00 ART (11:00 UTC)
-- ============================================================
-- Eliminar job existente si existe
SELECT cron.unschedule('supervision-digest-weekly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'supervision-digest-weekly');

-- Programar digest semanal: lunes 08:00 Argentina (UTC-3) = 11:00 UTC
SELECT cron.schedule(
    'supervision-digest-weekly',
    '0 11 * * 1',  -- 11:00 UTC los lunes = 08:00 ART
    'SELECT net.http_post(
        current_setting(''app.settings.supabase_url'', true) || ''/functions/v1/supervision-digest'',
        jsonb_build_object(
            ''Content-Type'', ''application/json'',
            ''Authorization'', ''Bearer '' || current_setting(''app.settings.service_role_key'', true)
        ),
        ''{}''::jsonb
    );'
);

-- ============================================================
-- 3. Función auxiliar para invocación manual (testing)
-- ============================================================
CREATE OR REPLACE FUNCTION run_supervision_digest(p_test_email text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result jsonb;
BEGIN
    -- Fire-and-forget via pg_net
    BEGIN
        v_result := net.http_post(
            current_setting('app.settings.supabase_url', true) || '/functions/v1/supervision-digest',
            jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
            ),
            jsonb_build_object('test_mode', true, 'test_email', p_test_email)
        );
    EXCEPTION WHEN others THEN
        v_result := jsonb_build_object('error', SQLERRM);
    END;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION run_supervision_digest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_supervision_digest(text) TO service_role;