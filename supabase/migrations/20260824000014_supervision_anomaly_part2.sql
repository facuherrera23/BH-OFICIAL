-- ============================================================
-- BIENENHAUS - Detección de Anomalías (Parte 2: Funciones Simplificadas)
-- ============================================================

-- ============================================================
-- 5. Función: calcular baselines (versión simplificada)
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_supervision_baselines()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_config RECORD;
    v_window interval;
    v_baseline_start timestamptz;
    v_baseline_end timestamptz;
    v_sql text;
BEGIN
    -- Para cada configuración habilitada
    FOR v_config IN SELECT * FROM supervision_anomaly_config WHERE enabled LOOP
        v_window := COALESCE(v_config.time_window, '1 hour')::interval;
        v_baseline_end := date_trunc('hour', now()) - (v_config.baseline_days || ' days')::interval;
        v_baseline_start := v_baseline_end - (v_config.baseline_days || ' days')::interval;

        -- Solo count metric por ahora (simplificado)
        IF v_config.metric = 'count' THEN
            EXECUTE format($sql$
                INSERT INTO supervision_baselines (
                    module, user_id, action, metric, time_window,
                    baseline_start, baseline_end,
                    sample_count, mean_value, stddev_value,
                    p50_value, p90_value, p95_value, p99_value,
                    min_value, max_value
                )
                SELECT
                    al.module,
                    al.user_id,
                    al.action,
                    %L as metric,
                    %L as time_window,
                    %L as baseline_start,
                    %L as baseline_end,
                    COUNT(*) as sample_count,
                    AVG(cnt)::numeric(18,6) as mean_value,
                    STDDEV(cnt)::numeric(18,6) as stddev_value,
                    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY cnt)::numeric(18,6) as p50_value,
                    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY cnt)::numeric(18,6) as p90_value,
                    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY cnt)::numeric(18,6) as p95_value,
                    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY cnt)::numeric(18,6) as p99_value,
                    MIN(cnt)::numeric(18,6) as min_value,
                    MAX(cnt)::numeric(18,6) as max_value
                FROM (
                    SELECT
                        module, user_id, action,
                        COUNT(*) as cnt
                    FROM audit_log
                    WHERE created_at >= %L
                      AND created_at < %L
                      AND (%L IS NULL OR module = %L)
                      AND (%L IS NULL OR user_id = %L)
                      AND (%L IS NULL OR action = %L)
                    GROUP BY module, user_id, action, date_trunc('hour', created_at)
                ) al
                GROUP BY al.module, al.user_id, al.action
                HAVING COUNT(*) >= %L
                ON CONFLICT (module, user_id, action, metric, time_window, baseline_start, baseline_end)
                DO UPDATE SET
                    sample_count = EXCLUDED.sample_count,
                    mean_value = EXCLUDED.mean_value,
                    stddev_value = EXCLUDED.stddev_value,
                    p50_value = EXCLUDED.p50_value,
                    p90_value = EXCLUDED.p90_value,
                    p95_value = EXCLUDED.p95_value,
                    p99_value = EXCLUDED.p99_value,
                    min_value = EXCLUDED.min_value,
                    max_value = EXCLUDED.max_value,
                    updated_at = now()
            $q$, v_config.metric, v_config.time_window, 
               date_trunc('hour', now()) - (v_config.baseline_days || ' days')::interval - (v_config.baseline_days || ' days')::interval,
               date_trunc('hour', now()) - (v_config.baseline_days || ' days')::interval,
               now() - (v_config.baseline_days || ' days')::interval - interval '1 hour',
               now() - (v_config.baseline_days || ' days')::interval,
               v_config.module, v_config.module,
               v_config.user_id, v_config.user_id,
               v_config.action, v_config.action,
               v_config.min_samples;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION calculate_supervision_baselines() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calculate_supervision_baselines() TO service_role;

-- ============================================================
-- 6. Función: detectar anomalías (versión simplificada para count)
-- ============================================================
CREATE OR REPLACE FUNCTION detect_supervision_anomalies()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_config RECORD;
    v_window interval;
    v_check_start timestamptz;
    v_check_end timestamptz;
    v_baseline RECORD;
    v_observed_count integer;
    v_z_score numeric;
    v_percentile_rank numeric;
    v_severity text;
    v_existing_anomaly uuid;
    v_baseline_id uuid;
BEGIN
    FOR v_config IN SELECT * FROM supervision_anomaly_config WHERE enabled AND metric = 'count' LOOP
        v_window := COALESCE(v_config.time_window, '1 hour')::interval;
        v_check_end := date_trunc('minute', now());
        v_check_start := v_check_end - v_window;

        -- Obtener baseline más reciente para count
        SELECT id, mean_value, stddev_value, p50_value, p90_value, p95_value, p99_value
        INTO v_baseline
        FROM supervision_baselines
        WHERE metric = 'count'
          AND time_window = v_config.time_window
          AND (v_config.module IS NULL OR module = v_config.module)
          AND (v_config.user_id IS NULL OR user_id = v_config.user_id)
          AND (v_config.action IS NULL OR action = v_config.action)
        ORDER BY baseline_end DESC
        LIMIT 1;

        IF NOT FOUND THEN
            CONTINUE;
        END IF;

        -- Conteo actual en la ventana
        EXECUTE format($sql$
            SELECT COUNT(*)
            FROM audit_log
            WHERE created_at >= %L
              AND created_at < %L
              AND (%L IS NULL OR module = %L)
              AND (%L IS NULL OR user_id = %L)
              AND (%L IS NULL OR action = %L)
        $q$, v_check_start, v_check_end,
           v_config.module, v_config.module,
           v_config.user_id, v_config.user_id,
           v_config.action, v_config.action
        INTO v_observed_count;

        IF v_observed_count IS NULL THEN
            CONTINUE;
        END IF;

        -- Calcular z-score usando baseline
        IF v_baseline.stddev_value IS NOT NULL AND v_baseline.stddev_value > 0 THEN
            v_z_score := (v_observed_count - v_baseline.mean_value) / v_baseline.stddev_value;
        ELSE
            v_z_score := 0;
        END IF;

        -- Percentil rank aproximado
        IF v_observed_count >= v_baseline.p99_value THEN
            v_percentile_rank := 99.5;
        ELSIF v_observed_count >= v_baseline.p95_value THEN
            v_percentile_rank := 97.5;
        ELSIF v_observed_count >= v_baseline.p90_value THEN
            v_percentile_rank := 92.5;
        ELSIF v_observed_count >= v_baseline.p50_value THEN
            v_percentile_rank := 75.0;
        ELSE
            v_percentile_rank := 25.0;
        END IF;

        -- Determinar severidad
        IF v_percentile_rank >= 99 THEN
            v_severity := 'critical';
        ELSIF v_percentile_rank >= 95 THEN
            v_severity := 'high';
        ELSIF v_percentile_rank >= 90 THEN
            v_severity := 'medium';
        ELSIF v_percentile_rank >= 75 THEN
            v_severity := 'low';
        ELSE
            v_severity := 'info';
        END IF;

        -- Solo crear anomalía si supera umbrales
        IF v_percentile_rank < v_config.percentile_threshold THEN
            CONTINUE;
        END IF;

        -- Verificar cooldown
        SELECT id INTO v_existing_anomaly
        FROM supervision_anomalies
        WHERE metric = 'count'
          AND time_window = v_config.time_window
          AND created_at > now() - (v_config.cooldown_minutes || ' minutes')::interval
          AND status IN ('open', 'acknowledged')
        LIMIT 1;

        IF v_existing_anomaly IS NOT NULL THEN
            CONTINUE;
        END IF;

        -- Determinar severidad
        IF v_percentile_rank >= 99 THEN
            v_severity := 'critical';
        ELSIF v_percentile_rank >= 95 THEN
            v_severity := 'high';
        ELSIF v_percentile_rank >= 90 THEN
            v_severity := 'medium';
        ELSIF v_percentile_rank >= 75 THEN
            v_severity := 'low';
        ELSE
            v_severity := 'info';
        END IF;

        -- Obtener baseline_id
        SELECT id INTO v_baseline_id
        FROM supervision_baselines
        WHERE metric = 'count'
          AND time_window = v_config.time_window
        ORDER BY baseline_end DESC LIMIT 1;

        -- Insertar anomalía
        INSERT INTO supervision_anomalies (
            baseline_id, module, user_id, action, metric, time_window,
            observed_value, expected_mean, expected_stddev,
            z_score, percentile_rank, severity,
            evidence
        ) VALUES (
            (SELECT id FROM supervision_baselines 
             WHERE metric = 'count' 
               AND time_window = v_config.time_window
             ORDER BY baseline_end DESC LIMIT 1),
            v_config.module,
            v_config.user_id,
            v_config.action,
            'count',
            v_config.time_window,
            v_observed_count,
            v_baseline.mean_value,
            v_baseline.stddev_value,
            (v_observed_count - v_baseline.mean_value) / NULLIF(v_baseline.stddev_value, 0),
            CASE 
                WHEN v_observed_count >= v_baseline.p99_value THEN 99.5
                WHEN v_observed_count >= v_baseline.p95_value THEN 97.5
                WHEN v_observed_count >= v_baseline.p90_value THEN 92.5
                WHEN v_observed_count >= v_baseline.p50_value THEN 75.0
                ELSE 25.0
            END,
            CASE 
                WHEN v_observed_count >= v_baseline.p99_value THEN 'critical'
                WHEN v_observed_count >= v_baseline.p95_value THEN 'high'
                WHEN v_observed_count >= v_baseline.p90_value THEN 'medium'
                WHEN v_observed_count >= v_baseline.p50_value THEN 'low'
                ELSE 'info'
            END,
            jsonb_build_object(
                'baseline_mean', v_baseline.mean_value,
                'baseline_stddev', v_baseline.stddev_value,
                'baseline_p50', v_baseline.p50_value,
                'baseline_p95', v_baseline.p95_value,
                'baseline_p99', v_baseline.p99_value,
                'check_window', v_config.time_window
            )
        );

        -- Log en audit_log
        PERFORM insert_audit_log(
            p_user_id := NULL,
            p_action := 'anomaly_detected',
            p_module := 'supervision',
            p_status := 'success',
            p_metadata := jsonb_build_object(
                'metric', 'count',
                'time_window', v_config.time_window,
                'observed', v_observed_count,
                'expected_mean', v_baseline.mean_value,
                'z_score', (v_observed_count - v_baseline.mean_value) / NULLIF(v_baseline.stddev_value, 0),
                'severity', v_severity
            )
        );

    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION detect_supervision_anomalies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION detect_supervision_anomalies() TO service_role;

-- ============================================================
-- pg_cron jobs
-- ============================================================
SELECT cron.unschedule('supervision-baselines-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'supervision-baselines-hourly');
SELECT cron.schedule(
    'supervision-baselines-hourly',
    '5 * * * *',
    'SELECT calculate_supervision_baselines();'
);

SELECT cron.unschedule('supervision-anomalies-15min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'supervision-anomalies-15min');
SELECT cron.schedule(
    'supervision-anomalies-15min',
    '*/15 * * * *',
    'SELECT detect_supervision_anomalies();'
);

-- ============================================================
-- Vista para monitoreo
-- ============================================================
CREATE OR REPLACE VIEW supervision_anomalies_recent AS
SELECT
    a.id,
    a.module,
    a.user_id,
    a.action,
    a.metric,
    a.time_window,
    a.observed_value,
    a.expected_mean,
    a.z_score,
    a.percentile_rank,
    a.severity,
    a.status,
    a.created_at,
    a.acknowledged_at,
    a.resolved_at
FROM supervision_anomalies a
WHERE a.created_at > now() - interval '7 days'
ORDER BY a.created_at DESC;