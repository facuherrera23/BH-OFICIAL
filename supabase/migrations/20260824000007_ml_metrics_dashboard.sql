-- ============================================================
-- BIENENHAUS - ML Metrics Dashboard
-- Métricas de precisión/recall para detección de anomalías ML
-- ============================================================

-- Tabla para almacenar métricas de evaluación del modelo ML
CREATE TABLE IF NOT EXISTS ml_model_metrics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_version text NOT NULL DEFAULT 'v1.0',
    evaluation_period_start timestamptz NOT NULL,
    evaluation_period_end timestamptz NOT NULL,
    
    -- Métricas globales
    total_predictions integer NOT NULL DEFAULT 0,
    true_positives integer NOT NULL DEFAULT 0,
    false_positives integer NOT NULL DEFAULT 0,
    true_negatives integer NOT NULL DEFAULT 0,
    false_negatives integer NOT NULL DEFAULT 0,
    
    -- Métricas calculadas
    precision numeric(5,4),           -- TP / (TP + FP)
    recall numeric(5,4),              -- TP / (TP + FN)
    f1_score numeric(5,4),            -- 2 * (P * R) / (P + R)
    accuracy numeric(5,4),            -- (TP + TN) / Total
    specificity numeric(5,4),         -- TN / (TN + FP)
    auc_roc numeric(5,4),             -- Area Under ROC Curve
    
    -- Por severidad
    precision_critical numeric(5,4),
    recall_critical numeric(5,4),
    precision_high numeric(5,4),
    recall_high numeric(5,4),
    precision_medium numeric(5,4),
    recall_medium numeric(5,4),
    
    -- Configuración del modelo
    config jsonb DEFAULT '{}',
    
    created_at timestamptz DEFAULT now(),
    UNIQUE (model_version, evaluation_period_start, evaluation_period_end)
);

-- Tabla para almacenar predicciones individuales para análisis posterior
CREATE TABLE IF NOT EXISTS ml_predictions_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_version text NOT NULL,
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    prediction_timestamp timestamptz NOT NULL DEFAULT now(),
    
    -- Features usadas
    features jsonb NOT NULL,
    
    -- Scores de cada método
    zscore_anomaly boolean DEFAULT false,
    iqr_anomaly boolean DEFAULT false,
    isolation_forest_score numeric(5,4),
    ensemble_score numeric(5,4),
    ensemble_anomaly boolean DEFAULT false,
    
    -- Ground truth (para evaluación posterior)
    actual_anomaly boolean,           -- NULL = no evaluado aún
    actual_severity text,             -- critical, high, medium, low
    evaluated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    evaluated_at timestamptz,
    
    -- Metadatos
    window_start timestamptz,
    window_end timestamptz,
    contributing_features jsonb,
    details jsonb,
    
    UNIQUE (model_version, user_id, prediction_timestamp)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_ml_predictions_user_time ON ml_predictions_log (user_id, prediction_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ml_predictions_evaluated ON ml_predictions_log (actual_anomaly, prediction_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ml_predictions_model ON ml_predictions_log (model_version, prediction_timestamp DESC);

-- Vista para métricas en tiempo real
CREATE OR REPLACE VIEW ml_model_performance AS
SELECT 
    model_version,
    COUNT(*) as total_predictions,
    COUNT(*) FILTER (WHERE ensemble_anomaly = true) as anomalies_detected,
    COUNT(*) FILTER (WHERE actual_anomaly = true) as actual_anomalies,
    COUNT(*) FILTER (WHERE ensemble_anomaly = true AND actual_anomaly = true) as true_positives,
    COUNT(*) FILTER (WHERE ensemble_anomaly = true AND actual_anomaly = false) as false_positives,
    COUNT(*) FILTER (WHERE ensemble_anomaly = false AND actual_anomaly = true) as false_negatives,
    COUNT(*) FILTER (WHERE ensemble_anomaly = false AND actual_anomaly = false) as true_negatives,
    
    -- Precision = TP / (TP + FP)
    CASE 
        WHEN COUNT(*) FILTER (WHERE ensemble_anomaly = true) > 0
        THEN ROUND(
            COUNT(*) FILTER (WHERE ensemble_anomaly = true AND actual_anomaly = true)::numeric / 
            COUNT(*) FILTER (WHERE ensemble_anomaly = true)::numeric, 4
        )
        ELSE NULL
    END as precision,
    
    -- Recall = TP / (TP + FN)
    CASE 
        WHEN COUNT(*) FILTER (WHERE actual_anomaly = true) > 0
        THEN ROUND(
            COUNT(*) FILTER (WHERE ensemble_anomaly = true AND actual_anomaly = true)::numeric / 
            COUNT(*) FILTER (WHERE actual_anomaly = true)::numeric, 4
        )
        ELSE NULL
    END as recall,
    
    -- F1 Score
    CASE 
        WHEN (
            COUNT(*) FILTER (WHERE ensemble_anomaly = true) > 0 AND
            COUNT(*) FILTER (WHERE actual_anomaly = true) > 0
        )
        THEN ROUND(
            2.0 * 
            (COUNT(*) FILTER (WHERE ensemble_anomaly = true AND actual_anomaly = true)::numeric / 
             NULLIF(COUNT(*) FILTER (WHERE ensemble_anomaly = true), 0)::numeric) *
            (COUNT(*) FILTER (WHERE ensemble_anomaly = true AND actual_anomaly = true)::numeric / 
             NULLIF(COUNT(*) FILTER (WHERE actual_anomaly = true), 0)::numeric) /
            (
                (COUNT(*) FILTER (WHERE ensemble_anomaly = true AND actual_anomaly = true)::numeric / 
                 NULLIF(COUNT(*) FILTER (WHERE ensemble_anomaly = true), 0)::numeric) +
                (COUNT(*) FILTER (WHERE ensemble_anomaly = true AND actual_anomaly = true)::numeric / 
                 NULLIF(COUNT(*) FILTER (WHERE actual_anomaly = true), 0)::numeric)
            ) , 4
        )
        ELSE NULL
    END as f1_score,
    
    -- Accuracy
    ROUND(
        (COUNT(*) FILTER (WHERE ensemble_anomaly = actual_anomaly)::numeric / 
         NULLIF(COUNT(*), 0)::numeric), 4
    ) as accuracy,
    
    MIN(prediction_timestamp) as period_start,
    MAX(prediction_timestamp) as period_end
FROM ml_predictions_log
WHERE actual_anomaly IS NOT NULL
GROUP BY model_version;

-- Función para registrar una predicción
CREATE OR REPLACE FUNCTION log_ml_prediction(
    p_model_version text,
    p_user_id uuid,
    p_features jsonb,
    p_zscore_anomaly boolean,
    p_iqr_anomaly boolean,
    p_isolation_forest_score numeric,
    p_ensemble_score numeric,
    p_ensemble_anomaly boolean,
    p_window_start timestamptz,
    p_window_end timestamptz,
    p_contributing_features jsonb,
    p_details jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO ml_predictions_log (
        model_version, user_id, features, zscore_anomaly, iqr_anomaly,
        isolation_forest_score, ensemble_score, ensemble_anomaly,
        window_start, window_end, contributing_features, details
    ) VALUES (
        p_model_version, p_user_id, p_features, p_zscore_anomaly, p_iqr_anomaly,
        p_isolation_forest_score, p_ensemble_score, p_ensemble_anomaly,
        p_window_start, p_window_end, p_contributing_features,
        jsonb_build_object('details', p_details)
    ) RETURNING id INTO v_id;
    
    RETURN v_id;
END;
$$;

-- Función para evaluar predicciones (ground truth)
CREATE OR REPLACE FUNCTION evaluate_ml_prediction(
    p_prediction_id uuid,
    p_actual_anomaly boolean,
    p_evaluated_by uuid,
    p_actual_severity text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE ml_predictions_log
    SET 
        actual_anomaly = p_actual_anomaly,
        actual_severity = p_actual_severity,
        evaluated_by = p_evaluated_by,
        evaluated_at = now()
    WHERE id = p_prediction_id;
END;
$$;

-- RLS para ml_model_metrics
ALTER TABLE ml_model_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ml_model_metrics_super_admin_select" ON ml_model_metrics;
CREATE POLICY "ml_model_metrics_super_admin_select" ON ml_model_metrics
    FOR SELECT USING (is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "ml_model_metrics_system_insert" ON ml_model_metrics;
CREATE POLICY "ml_model_metrics_system_insert" ON ml_model_metrics
    FOR INSERT WITH CHECK (false);

-- RLS para ml_predictions_log
ALTER TABLE ml_predictions_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ml_predictions_log_super_admin_select" ON ml_predictions_log;
CREATE POLICY "ml_predictions_log_super_admin_select" ON ml_predictions_log
    FOR SELECT USING (is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "ml_predictions_log_system_insert" ON ml_predictions_log;
CREATE POLICY "ml_predictions_log_system_insert" ON ml_predictions_log
    FOR INSERT WITH CHECK (false);

DROP POLICY IF EXISTS "ml_predictions_log_super_admin_update" ON ml_predictions_log;
CREATE POLICY "ml_predictions_log_super_admin_update" ON ml_predictions_log
    FOR UPDATE USING (is_super_admin(auth.uid()));

COMMENT ON TABLE ml_model_metrics IS 'Métricas de evaluación del modelo ML (precision, recall, F1, etc.)';
COMMENT ON TABLE ml_predictions_log IS 'Log de predicciones individuales del modelo ML para evaluación posterior';
COMMENT ON VIEW ml_model_performance IS 'Métricas de performance del modelo ML calculadas en tiempo real';