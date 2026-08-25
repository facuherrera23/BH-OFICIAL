-- ============================================================
-- BIENENHAUS - Purge Policy para auditoría y alertas
-- pg_cron jobs para limpieza automática
-- ============================================================

-- Requiere extensión pg_cron (ya habilitada en Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- 1. Función: purge_audit_log
-- Borra audit_log > 1 año (configurable via app_settings)
-- ============================================================
CREATE OR REPLACE FUNCTION purge_audit_log()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_retention_days integer;
    v_deleted_count integer;
BEGIN
    -- Leer retención desde app_settings (default 365 días)
    SELECT COALESCE((value->>'audit_log_retention_days')::integer, 365)
    INTO v_retention_days
    FROM app_settings
    WHERE key = 'preferences';

    DELETE FROM audit_log
    WHERE created_at < now() - (v_retention_days || ' days')::interval;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- Log de la purga
    PERFORM insert_audit_log(
        p_user_id := NULL,
        p_action := 'purge_audit_log',
        p_module := 'supervision',
        p_status := 'success',
        p_metadata := jsonb_build_object(
            'deleted_count', v_deleted_count,
            'retention_days', v_retention_days,
            'cutoff_date', (now() - (v_retention_days || ' days')::interval)
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION purge_audit_log() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_audit_log() TO service_role;

-- ============================================================
-- 2. Función: purge_supervision_alerts
-- Borra supervision_alerts resueltas/descartadas > 90 días
-- ============================================================
CREATE OR REPLACE FUNCTION purge_supervision_alerts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_retention_days integer;
    v_deleted_count integer;
BEGIN
    -- Leer retención desde app_settings (default 90 días)
    SELECT COALESCE((value->>'alerts_retention_days')::integer, 90)
    INTO v_retention_days
    FROM app_settings
    WHERE key = 'preferences';

    DELETE FROM supervision_alerts
    WHERE status IN ('resolved', 'dismissed')
      AND updated_at < now() - (v_retention_days || ' days')::interval;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- Log de la purga
    PERFORM insert_audit_log(
        p_user_id := NULL,
        p_action := 'purge_supervision_alerts',
        p_module := 'supervision',
        p_status := 'success',
        p_metadata := jsonb_build_object(
            'deleted_count', v_deleted_count,
            'retention_days', v_retention_days,
            'cutoff_date', (now() - (v_retention_days || ' days')::interval)
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION purge_supervision_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_supervision_alerts() TO service_role;

-- ============================================================
-- 3. Función combinada para cron diario
-- ============================================================
CREATE OR REPLACE FUNCTION purge_supervision_all()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM purge_audit_log();
    PERFORM purge_supervision_alerts();
END;
$$;

REVOKE ALL ON FUNCTION purge_supervision_all() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_supervision_all() TO service_role;

-- ============================================================
-- 4. pg_cron jobs (diarios a las 03:00 AM Buenos Aires = 06:00 UTC)
-- ============================================================
-- Eliminar jobs existentes si existen
SELECT cron.unschedule('purge-supervision-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-supervision-daily');

-- Programar purga diaria a las 03:00 AM Argentina (UTC-3) = 06:00 UTC
SELECT cron.schedule(
    'purge-supervision-daily',
    '0 6 * * *',  -- 06:00 UTC = 03:00 ART
    'SELECT purge_supervision_all();'
);

-- ============================================================
-- 5. Configuración en app_settings (defaults)
-- ============================================================
-- Ejecutar solo si no existe la clave
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'preferences' AND value ? 'audit_log_retention_days') THEN
        UPDATE app_settings
        SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{audit_log_retention_days}',
            '365'::jsonb
        )
        WHERE key = 'preferences';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'preferences' AND value ? 'alerts_retention_days') THEN
        UPDATE app_settings
        SET value = jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{alerts_retention_days}',
            '90'::jsonb
        )
        WHERE key = 'preferences';
    END IF;
END $$;

-- ============================================================
-- 6. Vista para monitorear purges
-- ============================================================
CREATE OR REPLACE VIEW purge_audit_log AS
SELECT
    created_at,
    action,
    status,
    metadata->>'deleted_count' AS deleted_count,
    metadata->>'retention_days' AS retention_days,
    metadata->>'cutoff_date' AS cutoff_date
FROM audit_log
WHERE action IN ('purge_audit_log', 'purge_supervision_alerts')
ORDER BY created_at DESC
LIMIT 100;