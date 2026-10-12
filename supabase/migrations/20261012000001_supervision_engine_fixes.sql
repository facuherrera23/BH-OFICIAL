-- ============================================================
-- Supervisión: fixes del motor (remediación Fase 1, 2026-10-12)
-- ============================================================
-- 1) purge_supervision_alerts(): usaba `updated_at`, columna inexistente en
--    supervision_alerts (tiene resolved_at / dismissed_at / created_at).
--    El cron purge-supervision-daily falló TODAS sus corridas desde la
--    creación del job y, por el rollback de purge_supervision_all(), tampoco
--    corría la purga de audit_log. Fix: COALESCE de las fechas de cierre.
-- 2) evaluate_supervision_rules(): el motor solo implementaba
--    filter.contains (changed_fields). Las reglas con filter.equals
--    (repeated_errors_detection → status='error';
--    sensitive_config_change → table_name='app_settings') caían al conteo
--    SIN filtro y disparaban falsos positivos ante actividad normal
--    (evidencia: 12 alerts en la semana con count 19/8/36 y cero errores
--    reales en audit_log). Motor unificado con CASE y whitelist de campos.
--    Sin SQL dinámico.
-- Aplicada vía MCP el 2026-10-12 (registro manual en el repo).

-- 1) Purga: fechas de cierre reales (mismo header/atributos del original)
CREATE OR REPLACE FUNCTION public.purge_supervision_alerts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_retention_days integer;
    v_deleted_count integer;
BEGIN
    SELECT COALESCE((value->>'alerts_retention_days')::integer, 90)
    INTO v_retention_days
    FROM app_settings
    WHERE key = 'preferences';

    DELETE FROM supervision_alerts
    WHERE status IN ('resolved', 'dismissed')
      AND COALESCE(resolved_at, dismissed_at, created_at) < now() - (v_retention_days || ' days')::interval;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

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

-- 2) Motor de reglas: soporta filter.contains (changed_fields) y
--    filter.equals con whitelist de campos (status, table_name).
--    Un equals con campo desconocido NO filtra (ELSE true, no rompe).
CREATE OR REPLACE FUNCTION public.evaluate_supervision_rules()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rule RECORD;
    v_hit RECORD;
    v_recent_alert uuid;
    v_window interval;
    v_threshold numeric;
    v_filter jsonb;
BEGIN
    FOR v_rule IN SELECT * FROM supervision_rules WHERE enabled LOOP
        v_window := COALESCE(v_rule.condition->>'window', '1 hour')::interval;
        v_threshold := COALESCE((v_rule.condition->>'threshold')::numeric, 0);
        v_filter := v_rule.condition->'filter';

        FOR v_hit IN
            SELECT user_id, count(*) AS c
            FROM audit_log
            WHERE created_at > now() - v_window
              AND (v_rule.module IS NULL OR module = v_rule.module)
              AND (v_rule.action IS NULL OR action = v_rule.action)
              AND user_id IS NOT NULL
              AND CASE
                    WHEN v_filter ? 'contains' THEN
                      changed_fields @> ARRAY[v_filter->>'contains']
                    WHEN v_filter ? 'equals' AND v_filter->>'field' = 'status' THEN
                      status = v_filter->>'equals'
                    WHEN v_filter ? 'equals' AND v_filter->>'field' = 'table_name' THEN
                      table_name = v_filter->>'equals'
                    ELSE true
                  END
            GROUP BY user_id
            HAVING count(*) > v_threshold
        LOOP
            SELECT id INTO v_recent_alert FROM supervision_alerts
            WHERE alert_type = v_rule.name AND user_id = v_hit.user_id
              AND created_at > now() - (v_rule.cooldown_minutes || ' minutes')::interval
              AND status IN ('open', 'acknowledged');

            IF v_recent_alert IS NULL THEN
                INSERT INTO supervision_alerts (user_id, module, severity, alert_type, title, description, evidence)
                VALUES (
                    v_hit.user_id,
                    COALESCE(v_rule.module, 'system'),
                    v_rule.severity,
                    v_rule.name,
                    v_rule.name,
                    v_rule.description,
                    jsonb_build_object(
                        'count', v_hit.c,
                        'threshold', v_threshold,
                        'window', v_rule.condition->>'window',
                        'filter', v_filter
                    )
                );
            END IF;
        END LOOP;
    END LOOP;
END;
$$;
