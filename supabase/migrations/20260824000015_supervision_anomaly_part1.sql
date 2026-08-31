-- ============================================================
-- BIENENHAUS - Detección de Anomalías (Parte 1: Tablas y Config)
-- ============================================================

-- ============================================================
-- 1. Tabla de baselines
-- ============================================================
CREATE TABLE IF NOT EXISTS supervision_baselines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    module text NOT NULL,
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    action text,
    metric text NOT NULL DEFAULT 'count',
    time_window text NOT NULL DEFAULT '1 hour',
    baseline_start timestamptz NOT NULL,
    baseline_end timestamptz NOT NULL,
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
    percentile_rank numeric(5,2),
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
-- 3. Configuración de detección
-- ============================================================
CREATE TABLE IF NOT EXISTS supervision_anomaly_config (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    description text,
    module text,
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    action text,
    metric text NOT NULL DEFAULT 'count',
    time_window text NOT NULL DEFAULT '1 hour',
    baseline_days integer NOT NULL DEFAULT 30,
    min_samples integer NOT NULL DEFAULT 100,
    sigma_threshold numeric(4,2) NOT NULL DEFAULT 2.5,
    percentile_threshold numeric(5,2) NOT NULL DEFAULT 95.0,
    enabled boolean DEFAULT true,
    cooldown_minutes integer DEFAULT 60,
    excluded_users uuid[] DEFAULT '{}',
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supervision_anomaly_config_lookup
    ON supervision_anomaly_config (enabled, module, user_id, action);

-- Config por defecto
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