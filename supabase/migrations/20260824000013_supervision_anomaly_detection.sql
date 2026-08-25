-- ============================================================
-- BIENENHAUS - Detección de Anomalías Estadísticas (z-score / p95)
-- ============================================================

-- ============================================================
-- 1. Tabla de baselines (media, desviación, percentiles por módulo/usuario/acción)
-- ============================================================
CREATE TABLE IF NOT EXISTS supervision_baselines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    module text NOT NULL,
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    action text,
    metric text NOT NULL DEFAULT 'count',  -- 'count' | 'duration_ms' | 'error_rate'
    time_window text NOT NULL DEFAULT '1 hour', -- ventana de agregación
    baseline_start timestamptz NOT NULL,   -- inicio período baseline
    baseline_end timestamptz NOT NULL,     -- fin período baseline
    sample_count integer NOT NULL DEFAULT 0,
    mean_value numeric(18,6) NOT NULL,
    stddev_value numeric(18,6),
    p50_value numeric(18,6),
    p90_value numeric(18,6),
    p95_value numeric(18,6),
    p99_value numeric(18,6),
    min_value numeric(18,6),
    max_value numeric(18,6),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (module, user_id, action, metric, time_window, baseline_start, baseline_end)
);

CREATE INDEX IF NOT EXISTS idx_supervision_baselines_lookup
    ON supervision_baselines (module, user_id, action, metric, time_window);

CREATE INDEX IF NOT EXISTS idx_supervision_baselines_recent
    ON supervision_baselines (baseline_end DESC);

-- ============================================================
-- 2. Tabla de anomalías detectadas
-- ============================================================
CREATE TABLE IF NOT EXISTS supervision_anomalies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    baseline_id uuid REFERENCES supervision_baselines(id) ON DELETE SET NULL,
    module text NOT NULL,
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    action text,
    metric text NOT NULL DEFAULT 'count',
    time_window text NOT NULL DEFAULT '1 hour',
    observed_value numeric(18,6) NOT NULL,
    expected_mean numeric(18,6) NOT NULL,
    expected_stddev numeric(18,6),
    z_score numeric(10,4),
    percentile_rank numeric(5,2),  -- 0-100
    severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    status text DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed', 'false_positive')),
    acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    acknowledged_at timestamptz,
    resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    resolved_at timestamptz,
    dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    dismissed_at timestamptz,
    evidence jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supervision_anomalies_status_severity
    ON supervision_anomalies (status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supervision_anomalies_module_user
    ON supervision_anomalies (module, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supervision_anomalies_open
    ON supervision_anomalies (module, user_id, severity, created_at DESC)
    WHERE status = 'open';

-- ============================================================
-- 3. Configuración de detección (umbrales, ventanas, exclusiones)
-- ============================================================
CREATE TABLE IF NOT EXISTS supervision_anomaly_config (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    description text,
    module text,                    -- null = todos
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    action text,
    metric text NOT NULL DEFAULT 'count',
    time_window text NOT NULL DEFAULT '1 hour',
    baseline_days integer NOT NULL DEFAULT 30,  -- días de historia para baseline
    min_samples integer NOT NULL DEFAULT 100,   -- mínimo observaciones para calcular baseline
    sigma_threshold numeric(4,2) NOT NULL DEFAULT 2.5,  -- z-score umbral
    percentile_threshold numeric(5,2) NOT NULL DEFAULT 95.0,  -- p95 umbral
    enabled boolean DEFAULT true,
    cooldown_minutes integer DEFAULT 60,
    excluded_users uuid[] DEFAULT '{}',  -- usuarios a excluir (ej. service accounts)
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supervision_anomaly_config_lookup
    ON supervision_anomaly_config (enabled, module, user_id, action);

-- Config por defecto (se inserta si no existe)
INSERT INTO supervision_anomaly_config (name, description, module, action, metric, time_window, baseline_days, min_samples, sigma_threshold, percentile_threshold, enabled, cooldown_minutes)
VALUES
('global_count_anomaly', 'Anomalía global en conteo de eventos por módulo', NULL, NULL, 'count', '1 hour', 30, 100, 2.5, 95.0, true, 60),
('global_error_rate_anomaly', 'Pico de tasa de error por módulo', NULL, NULL, 'error_rate', '15 minutes', 30, 50, 3.0, 99.0, true, 30),
('user_activity_spike', 'Pico de actividad inusual por usuario', NULL, NULL, 'count', '1 hour', 30, 50, 3.0, 95.0, true, 60),
('bulk_operation_burst', 'Ráfaga de operaciones masivas', NULL, NULL, 'count', '10 minutes', 30, 20, 2.5, 95.0, true, 15)
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 4. RLS
-- ============================================================
ALTER TABLE supervision_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervision_anomalies ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervision_anomaly_config ENABLE ROW LEVEL SECURITY;

-- Solo super_admin puede leer/escribir
DROP POLICY IF EXISTS "supervision_baselines_super_admin" ON supervision_baselines;
CREATE POLICY "supervision_baselines_super_admin" ON supervision_baselines
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));

DROP POLICY IF EXISTS "supervision_anomalies_super_admin" ON supervision_anomalies;
CREATE POLICY "supervision_anomalies_super_admin" ON supervision_anomalies
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));

DROP POLICY IF EXISTS "supervision_anomaly_config_super_admin" ON supervision_anomaly_config;
CREATE POLICY "supervision_anomaly_config_super_admin" ON supervision_anomaly_config
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================================
-- 5. Función: calcular baselines (se ejecuta cada hora via pg_cron)
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
BEGIN
    -- Para cada configuración habilitada
    FOR v_config IN SELECT * FROM supervision_anomaly_config WHERE enabled LOOP
        v_window := COALESCE(v_config.time_window, '1 hour')::interval;
        v_baseline_end := date_trunc('hour', now()) - v_window;
        v_baseline_start := v_baseline_end - (v_config.baseline_days || ' days')::interval;

        -- Query base filtrada por config
        EXECUTE format($q$
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
                AVG(val)::numeric(18,6) as mean_value,
                STDDEV(val)::numeric(18,6) as stddev_value,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY val)::numeric(18,6) as p50_value,
                PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY val)::numeric(18,6) as p90_value,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY val)::numeric(18,6) as p95_value,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY val)::numeric(18,6) as p99_value,
                MIN(val)::numeric(18,6) as min_value,
                MAX(val)::numeric(18,6) as max_value
            FROM (
                SELECT
                    module,
                    user_id,
                    action,
                    date_trunc('hour', created_at) as bucket,
                    CASE
                        WHEN %L = 'count' THEN COUNT(*)::numeric
                        WHEN %L = 'error_rate' THEN
                            COUNT(*) FILTER (WHERE severity IN ('error','critical'))::numeric / NULLIF(COUNT(*), 0)
                        WHEN %L = 'duration_ms' THEN AVG(duration_ms)::numeric
                        ELSE COUNT(*)::numeric
                    END as val
                FROM audit_log
                WHERE created_at >= %L
                  AND created_at < %L
                  AND (%L IS NULL OR module = %L)
                  AND (%L IS NULL OR user_id = %L)
                  AND (%L IS NULL OR action = %L)
                  AND user_id NOT IN (SELECT unnest(%L::uuid[]))
                GROUP BY module, user_id, action, date_trunc('hour', created_at)
                HAVING COUNT(*) >= 1  -- al menos 1 evento por bucket
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
        $q$, v_config.metric, v_config.time_window, v_baseline_start, v_baseline_end,
           v_config.metric, v_config.metric, v_config.metric,
           v_baseline_start, v_baseline_end,
           v_config.metric, v_config.metric, v_config.metric,
           v_baseline_start, v_baseline_end,
           v_config.module, v_config.module,
           v_config.user_id, v_config.user_id,
           v_config.action, v_config.action,
           v_config.excluded_users,
           v_config.min_samples
        USING v_config.metric, v_config.time_window, v_baseline_start, v_baseline_end,
           v_config.metric, v_config.metric, v_config.metric,
           v_baseline_start, v_baseline_end,
           v_config.module, v_config.module,
           v_config.user_id, v_config.user_id,
           v_config.action, v_config.action,
           v_config.excluded_users,
           v_config.min_samples;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION calculate_supervision_baselines() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calculate_supervision_baselines() TO service_role;

-- ============================================================
-- 6. Función: detectar anomalías (se ejecuta cada 5-15 min via pg_cron)
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
    v_aggregated RECORD;
    v_z_score numeric;
    v_percentile_rank numeric;
    v_severity text;
    v_existing_anomaly uuid;
BEGIN
    FOR v_config IN SELECT * FROM supervision_anomaly_config WHERE enabled LOOP
        v_window := COALESCE(v_config.time_window, '1 hour')::interval;
        v_check_end := date_trunc('minute', now());
        v_check_start := v_check_end - v_window;

        -- Obtener baseline más reciente para esta config
        SELECT * INTO v_baseline
        FROM supervision_baselines
        WHERE metric = v_config.metric
          AND time_window = v_config.time_window
          AND (v_config.module IS NULL OR module = v_config.module)
          AND (v_config.user_id IS NULL OR user_id = v_config.user_id)
          AND (v_config.action IS NULL OR action = v_config.action)
        ORDER BY baseline_end DESC
        LIMIT 1;

        IF NOT FOUND OR v_baseline.sample_count < v_config.min_samples THEN
            CONTINUE; -- No hay baseline suficiente
        END IF;

        -- Agregar observación actual
        EXECUTE format($q$
            SELECT
                al.module,
                al.user_id,
                al.action,
                CASE
                    WHEN %L = 'count' THEN COUNT(*)::numeric
                    WHEN %L = 'error_rate' THEN
                        COUNT(*) FILTER (WHERE severity IN ('error','critical'))::numeric / NULLIF(COUNT(*), 0)
                    WHEN %L = 'duration_ms' THEN AVG(duration_ms)::numeric
                    ELSE COUNT(*)::numeric
                END as observed_val
            FROM audit_log
            WHERE created_at >= %L
              AND created_at < %L
              AND (%L IS NULL OR module = %L)
              AND (%L IS NULL OR user_id = %L)
              AND (%L IS NULL OR action = %L)
              AND user_id NOT IN (SELECT unnest(%L::uuid[]))
            GROUP BY al.module, al.user_id, al.action
        $q$, v_config.metric, v_config.metric, v_config.metric,
           v_check_start, v_check_end,
           v_config.module, v_config.module,
           v_config.user_id, v_config.user_id,
           v_config.action, v_config.action,
           v_config.excluded_users
        USING v_config.metric, v_config.metric, v_config.metric,
           v_check_start, v_check_end,
           v_config.module, v_config.module,
           v_config.user_id, v_config.user_id,
           v_config.action, v_config.action,
           v_config.excluded_users
        INTO v_aggregated;

        IF NOT FOUND THEN
            CONTINUE; -- No hay datos en esta ventana
        END IF;

        -- Calcular z-score
        IF v_baseline.stddev_value IS NOT NULL AND v_baseline.stddev_value > 0 THEN
            v_z_score := (v_aggregated.observed_val - v_baseline.mean_value) / v_baseline.stddev_value;
        ELSE
            v_z_score := 0;
        END IF;

        -- Calcular percentil rank (aprox usando baseline percentiles)
        IF v_aggregated.observed_val >= v_baseline.p99_value THEN
            v_percentile_rank := 99.5;
        ELSIF v_aggregated.observed_val >= v_baseline.p95_value THEN
            v_percentile_rank := 97.5;
        ELSIF v_aggregated.observed_val >= v_baseline.p90_value THEN
            v_percentile_rank := 92.5;
        ELSIF v_aggregated.observed_val >= v_baseline.p50_value THEN
            v_percentile_rank := 75.0;
        ELSE
            v_percentile_rank := 25.0;
        END IF;

        -- Determinar severidad
        IF ABS(v_z_score) >= v_config.sigma_threshold * 2 OR v_percentile_rank >= 99 THEN
            v_severity := 'critical';
        ELSIF ABS(v_z_score) >= v_config.sigma_threshold OR v_percentile_rank >= 99 THEN
            v_severity := 'high';
        ELSIF ABS(v_z_score) >= v_config.sigma_threshold * 0.75 OR v_percentile_rank >= 95 THEN
            v_severity := 'medium';
        ELSIF ABS(v_z_score) >= v_config.sigma_threshold * 0.5 OR v_percentile_rank >= 90 THEN
            v_severity := 'low';
        ELSE
            v_severity := 'info';
        END IF;

        -- Solo crear anomalía si supera umbrales configurados
        IF ABS(v_z_score) < v_config.sigma_threshold AND v_percentile_rank < v_config.percentile_threshold THEN
            CONTINUE;
        END IF;

        -- Verificar cooldown (anomalía existente reciente)
        SELECT id INTO v_existing_anomaly
        FROM supervision_anomalies
        WHERE module = v_aggregated.module
          AND (v_config.user_id IS NULL OR user_id = v_aggregated.user_id)
          AND (v_config.action IS NULL OR action = v_aggregated.action)
          AND metric = v_config.metric
          AND time_window = v_config.time_window
          AND created_at > now() - (v_config.cooldown_minutes || ' minutes')::interval
          AND status IN ('open', 'acknowledged')
        LIMIT 1;

        IF v_existing_anomaly IS NOT NULL THEN
            CONTINUE; -- Ya hay anomalía activa en cooldown
        END IF;

        -- Determinar severidad final
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

        -- Solo crear anomalía si supera umbrales configurados
        IF ABS(v_z_score) < v_config.sigma_threshold AND v_percentile_rank < v_config.percentile_threshold THEN
            CONTINUE;
        END IF;

        -- Verificar cooldown (anomalía existente reciente)
        SELECT id INTO v_existing_anomaly
        FROM supervision_anomalies
        WHERE module = v_aggregated.module
          AND (v_config.user_id IS NULL OR user_id = v_aggregated.user_id)
          AND (v_config.action IS NULL OR action = v_aggregated.action)
          AND metric = v_config.metric
          AND time_window = v_config.time_window
          AND created_at > now() - (v_config.cooldown_minutes || ' minutes')::interval
          AND status IN ('open', 'acknowledged')
        LIMIT 1;

        IF v_existing_anomaly IS NOT NULL THEN
            CONTINUE; -- Ya hay anomalía activa en cooldown
        END IF;

        -- Determinar severidad final
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

        -- Solo crear anomalía si supera umbrales configurados
        IF ABS(v_z_score) < v_config.sigma_threshold AND v_percentile_rank < v_config.percentile_threshold THEN
            CONTINUE;
        END IF;

        -- Verificar cooldown (anomalía existente reciente)
        SELECT id INTO v_existing_anomaly
        FROM supervision_anomalies
        WHERE module = v_aggregated.module
          AND (v_config.user_id IS NULL OR user_id = v_aggregated.user_id)
          AND (v_config.action IS NULL OR action = v_aggregated.action)
          AND metric = v_config.metric
          AND time_window = v_config.time_window
          AND created_at > now() - (v_config.cooldown_minutes || ' minutes')::interval
          AND status IN ('open', 'acknowledged')
        LIMIT 1;

        IF v_existing_anomaly IS NOT NULL THEN
            CONTINUE; -- Ya hay anomalía activa en cooldown
        END IF;

        -- Determinar severidad final
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

        -- Solo crear anomalía si supera umbrales configurados
        IF ABS(v_z_score) < v_config.sigma_threshold AND v_percentile_rank < v_config.percentile_threshold THEN
            CONTINUE;
        END IF;

        -- Verificar cooldown (anomalía existente reciente)
        SELECT id INTO v_existing_anomaly
        FROM supervision_anomalies
        WHERE module = v_aggregated.module
          AND (v_config.user_id IS NULL OR user_id = v_aggregated.user_id)
          AND (v_config.action IS NULL OR action = v_aggregated.action)
          AND metric = v_config.metric
          AND time_window = v_config.time_window
          AND created_at > now() - (v_config.cooldown_minutes || ' minutes')::interval
          AND status IN ('open', 'acknowledged')
        LIMIT 1;

        IF v_existing_anomaly IS NOT NULL THEN
            CONTINUE; -- Ya hay anomalía activa en cooldown
        END IF;

        -- Determinar severidad final
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

        -- Solo crear anomalía si supera umbrales configurados
        IF ABS(v_z_score) < v_config.sigma_threshold AND v_percentile_rank < v_config.percentile_threshold THEN
            CONTINUE;
        END IF;

        -- Insertar anomalía
        INSERT INTO supervision_anomalies (
            baseline_id, module, user_id, action, metric, time_window,
            observed_value, expected_mean, expected_stddev,
            z_score, percentile_rank, severity,
            evidence
        ) VALUES (
            (SELECT id FROM supervision_baselines
             WHERE metric = v_config.metric
               AND time_window = v_config.time_window
               AND (v_config.module IS NULL OR module = v_config.module)
               AND (v_config.user_id IS NULL OR user_id = v_aggregated.user_id)
               AND (v_config.action IS NULL OR action = v_aggregated.action)
             ORDER BY baseline_end DESC LIMIT 1),
            v_aggregated.module,
            v_aggregated.user_id,
            v_aggregated.action,
            v_config.metric,
            v_config.time_window,
            v_aggregated.observed_val,
            v_baseline.mean_value,
            v_baseline.stddev_value,
            v_z_score,
            v_percentile_rank,
            v_severity,
            jsonb_build_object(
                'baseline_mean', v_baseline.mean_value,
                'baseline_stddev', v_baseline.stddev_value,
                'baseline_p50', v_baseline.p50_value,
                'baseline_p95', v_baseline.p95_value,
                'baseline_p99', v_baseline.p99_value,
                'config_name', v_config.name,
                'check_window', v_config.time_window,
                'sigma_threshold', v_config.sigma_threshold,
                'percentile_threshold', v_config.percentile_threshold
            )
        );

        -- Log en audit_log
        PERFORM insert_audit_log(
            p_user_id := NULL,
            p_action := 'anomaly_detected',
            p_module := 'supervision',
            p_status := 'success',
            p_metadata := jsonb_build_object(
                'anomaly_module', v_aggregated.module,
                'anomaly_user_id', v_aggregated.user_id,
                'anomaly_action', v_aggregated.action,
                'metric', v_config.metric,
                'observed', v_aggregated.observed_val,
                'expected_mean', v_baseline.mean_value,
                'z_score', v_z_score,
                'percentile', v_percentile_rank,
                'severity', v_severity
            )
        );

    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION detect_supervision_anomalies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION detect_supervision_anomalies() TO service_role;

-- ============================================================
-- 7. pg_cron jobs
-- ============================================================
-- Baseline calculation: cada hora (minuto 5)
SELECT cron.unschedule('supervision-baselines-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'supervision-baselines-hourly');
SELECT cron.schedule(
    'supervision-baselines-hourly',
    '5 * * * *',
    'SELECT calculate_supervision_baselines();'
);

-- Anomaly detection: cada 15 minutos
SELECT cron.unschedule('supervision-anomalies-15min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'supervision-anomalies-15min');
SELECT cron.schedule(
    'supervision-anomalies-15min',
    '*/15 * * * *',
    'SELECT detect_supervision_anomalies();'
);

-- ============================================================
-- 7. Vista para monitoreo
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