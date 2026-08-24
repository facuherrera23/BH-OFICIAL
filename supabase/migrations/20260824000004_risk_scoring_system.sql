-- ============================================================
-- BIENENHAUS - Risk Signal Scoring System
-- Scoring explicable de señales de riesgo operacional
-- ============================================================

-- Tabla para almacenar scores calculados
CREATE TABLE IF NOT EXISTS user_risk_scores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    score integer NOT NULL DEFAULT 0,
    level text NOT NULL CHECK (level IN ('low', 'medium', 'high', 'critical')),
    factors jsonb NOT NULL DEFAULT '[]'::jsonb,  -- Array de {factor, points, description}
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    calculated_at timestamptz DEFAULT now(),
    UNIQUE (user_id, period_start, period_end)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_user_risk_scores_user_period ON user_risk_scores (user_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_user_risk_scores_level ON user_risk_scores (level, period_end DESC);

-- Comentarios
COMMENT ON TABLE user_risk_scores IS 'Scores de riesgo calculados periódicamente. Explicables: cada factor tiene puntos y descripción.';
COMMENT ON COLUMN user_risk_scores.factors IS 'Array de objetos: {factor: string, points: int, description: string, details: jsonb}';

-- Función para calcular score de un usuario en una ventana temporal
CREATE OR REPLACE FUNCTION calculate_user_risk_score(
    p_user_id uuid,
    p_window_start timestamptz,
    p_window_end timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_factors jsonb := '[]'::jsonb;
    v_total_score integer := 0;
    v_level text := 'low';
    v_factor jsonb;
BEGIN
    -- Factor 1: Exportaciones elevadas
    WITH export_count AS (
        SELECT COUNT(*) AS cnt
        FROM audit_log
        WHERE user_id = p_user_id
          AND action = 'export'
          AND created_at BETWEEN p_window_start AND p_window_end
    )
    SELECT CASE 
        WHEN cnt > 100 THEN 40
        WHEN cnt > 50 THEN 25
        WHEN cnt > 20 THEN 15
        WHEN cnt > 10 THEN 8
        ELSE 0
    END INTO v_factor
    FROM export_count;
    
    IF v_factor > 0 THEN
        v_factors := v_factors || jsonb_build_object(
            'factor', 'high_exports',
            'points', v_factor,
            'description', 'Exportaciones elevadas en la ventana',
            'details', jsonb_build_object('count', (SELECT cnt FROM export_count))
        );
        v_total_score := v_total_score + v_factor;
    END IF;

    -- Factor 2: Operaciones masivas
    WITH bulk_count AS (
        SELECT COUNT(*) AS cnt
        FROM audit_log
        WHERE user_id = p_user_id
          AND action LIKE 'bulk_%'
          AND created_at BETWEEN p_window_start AND p_window_end
    )
    SELECT CASE 
        WHEN cnt > 20 THEN 30
        WHEN cnt > 10 THEN 20
        WHEN cnt > 5 THEN 10
        ELSE 0
    END INTO v_factor
    FROM bulk_count;
    
    IF v_factor > 0 THEN
        v_factors := v_factors || jsonb_build_object(
            'factor', 'bulk_operations',
            'points', v_factor,
            'description', 'Operaciones masivas detectadas',
            'details', jsonb_build_object('count', (SELECT cnt FROM bulk_count))
        );
        v_total_score := v_total_score + v_factor;
    END IF;

    -- Factor 3: Cambios sensibles (roles, permisos, config)
    WITH sensitive_count AS (
        SELECT COUNT(*) AS cnt
        FROM audit_log
        WHERE user_id = p_user_id
          AND action IN ('update_sensitive', 'delete', 'publish', 'assign', 'change_role', 'change_settings')
          AND created_at BETWEEN p_window_start AND p_window_end
    )
    SELECT CASE 
        WHEN cnt > 10 THEN 25
        WHEN cnt > 5 THEN 15
        WHEN cnt > 2 THEN 8
        ELSE 0
    END INTO v_factor
    FROM sensitive_count;
    
    IF v_factor > 0 THEN
        v_factors := v_factors || jsonb_build_object(
            'factor', 'sensitive_changes',
            'points', v_factor,
            'description', 'Cambios sensibles (roles, permisos, configuración)',
            'details', jsonb_build_object('count', (SELECT cnt FROM sensitive_count))
        );
        v_total_score := v_total_score + v_factor;
    END IF;

    -- Factor 4: Intentos de escalada de privilegios
    WITH priv_esc_count AS (
        SELECT COUNT(*) AS cnt
        FROM audit_log
        WHERE user_id = p_user_id
          AND (action = 'update_sensitive' AND metadata->>'sensitive_fields_changed' ? 'role')
          AND created_at BETWEEN p_window_start AND p_window_end
    )
    SELECT CASE 
        WHEN cnt > 0 THEN 50
        ELSE 0
    END INTO v_factor
    FROM priv_esc_count;
    
    IF v_factor > 0 THEN
        v_factors := v_factors || jsonb_build_object(
            'factor', 'privilege_escalation',
            'points', v_factor,
            'description', 'Intento de escalada de privilegios (cambio de rol a super_admin)',
            'details', jsonb_build_object('count', (SELECT cnt FROM priv_esc_count))
        );
        v_total_score := v_total_score + v_factor;
    END IF;

    -- Factor 5: Errores repetidos
    WITH error_count AS (
        SELECT COUNT(*) AS cnt
        FROM audit_log
        WHERE user_id = p_user_id
          AND status = 'error'
          AND created_at BETWEEN p_window_start AND p_window_end
    )
    SELECT CASE 
        WHEN cnt > 20 THEN 20
        WHEN cnt > 10 THEN 12
        WHEN cnt > 5 THEN 6
        ELSE 0
    END INTO v_factor
    FROM error_count;
    
    IF v_factor > 0 THEN
        v_factors := v_factors || jsonb_build_object(
            'factor', 'repeated_errors',
            'points', v_factor,
            'description', 'Errores operacionales repetidos',
            'details', jsonb_build_object('count', (SELECT cnt FROM error_count))
        );
        v_total_score := v_total_score + v_factor;
    END IF;

    -- Factor 6: Accesos denegados / Rate limiting
    WITH denied_count AS (
        SELECT COUNT(*) AS cnt
        FROM audit_log
        WHERE user_id = p_user_id
          AND error_code IN ('403', '401', 'permission_denied', 'unauthorized', '429')
          AND created_at BETWEEN p_window_start AND p_window_end
    )
    SELECT CASE 
        WHEN cnt > 20 THEN 15
        WHEN cnt > 10 THEN 10
        WHEN cnt > 5 THEN 5
        ELSE 0
    END INTO v_factor
    FROM denied_count;
    
    IF v_factor > 0 THEN
        v_factors := v_factors || jsonb_build_object(
            'factor', 'access_denied_rate_limit',
            'points', v_factor,
            'description', 'Accesos denegados repetidos o rate limiting',
            'details', jsonb_build_object('count', (SELECT cnt FROM denied_count))
        );
        v_total_score := v_total_score + v_factor;
    END IF;

    -- Factor 7: Actividad fuera de horario (22:00 - 06:00)
    WITH off_hours_count AS (
        SELECT COUNT(*) AS cnt
        FROM audit_log
        WHERE user_id = p_user_id
          AND EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') NOT BETWEEN 6 AND 21
          AND created_at BETWEEN p_window_start AND p_window_end
    )
    SELECT CASE 
        WHEN cnt > 50 THEN 15
        WHEN cnt > 20 THEN 8
        WHEN cnt > 5 THEN 3
        ELSE 0
    END INTO v_factor
    FROM off_hours_count;
    
    IF v_factor > 0 THEN
        v_factors := v_factors || jsonb_build_object(
            'factor', 'off_hours_activity',
            'points', v_factor,
            'description', 'Actividad significativa fuera de horario comercial',
            'details', jsonb_build_object('count', (SELECT cnt FROM off_hours_count))
        );
        v_total_score := v_total_score + v_factor;
    END IF;

    -- Determinar nivel
    v_level := CASE 
        WHEN v_total_score >= 100 THEN 'critical'
        WHEN v_total_score >= 60 THEN 'high'
        WHEN v_total_score >= 30 THEN 'medium'
        ELSE 'low'
    END;

    RETURN jsonb_build_object(
        'score', v_total_score,
        'level', v_level,
        'factors', v_factors
    );
END;
$$;

-- Función para calcular y almacenar scores de todos los usuarios
CREATE OR REPLACE FUNCTION calculate_all_risk_scores(
    p_window_start timestamptz DEFAULT (now() - interval '24 hours'),
    p_window_end timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user RECORD;
    v_result jsonb;
BEGIN
    FOR v_user IN 
        SELECT DISTINCT user_id FROM audit_log 
        WHERE created_at BETWEEN p_window_start AND p_window_end
    LOOP
        v_result := calculate_user_risk_score(v_user.user_id, p_window_start, p_window_end);
        
        INSERT INTO user_risk_scores (user_id, score, level, factors, period_start, period_end)
        VALUES (v_user.user_id, (v_result->>'score')::int, v_result->>'level', v_result->'factors', p_window_start, p_window_end)
        ON CONFLICT (user_id, period_start, period_end) DO UPDATE SET
            score = EXCLUDED.score,
            level = EXCLUDED.level,
            factors = EXCLUDED.factors,
            calculated_at = now();
    END LOOP;
END;
$$;

-- Job pg_cron para calcular scores cada hora
SELECT cron.schedule(
    'calculate-risk-scores',
    '0 * * * *',
    'SELECT calculate_all_risk_scores(now() - interval ''24 hours'', now());'
) WHERE NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'calculate-risk-scores'
);

-- Vista para consultar scores actuales
CREATE OR REPLACE VIEW current_user_risk_scores AS
SELECT 
    urs.user_id,
    p.full_name,
    p.email,
    p.role,
    urs.score,
    urs.level,
    urs.factors,
    urs.period_start,
    urs.period_end,
    urs.calculated_at
FROM user_risk_scores urs
JOIN profiles p ON p.id = urs.user_id
WHERE urs.period_end = (
    SELECT MAX(period_end) FROM user_risk_scores WHERE user_id = urs.user_id
);

-- RLS para user_risk_scores
ALTER TABLE user_risk_scores ENABLE ROW LEVEL SECURITY;

-- Función helper para RLS (idempotente)
CREATE OR REPLACE FUNCTION is_super_admin(user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM profiles 
        WHERE id = user_id AND role = 'super_admin' AND is_active != false
    );
$$;

DROP POLICY IF EXISTS "user_risk_scores_super_admin_select" ON user_risk_scores;
CREATE POLICY "user_risk_scores_super_admin_select" ON user_risk_scores
    FOR SELECT USING (is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "user_risk_scores_system_insert" ON user_risk_scores;
CREATE POLICY "user_risk_scores_system_insert" ON user_risk_scores
    FOR INSERT WITH CHECK (false); -- Solo función SECURITY DEFINER

COMMENT ON FUNCTION calculate_user_risk_score IS 'Calcula score de riesgo explicable para un usuario en una ventana temporal. Retorna JSON con score, nivel y factores detallados.';
COMMENT ON FUNCTION calculate_all_risk_scores IS 'Calcula y almacena scores para todos los usuarios activos en la ventana. Ejecutar via pg_cron cada hora.';