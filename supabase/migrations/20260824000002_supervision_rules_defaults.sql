-- ============================================================
-- BIENENHAUS - Reglas de Supervisión por Defecto
-- Datos iniciales para supervision_rules
-- ============================================================

-- Reglas de detección de anomalías operativas
INSERT INTO supervision_rules (name, description, module, action, event_type, condition, severity, enabled, cooldown_minutes, created_by)
VALUES
-- Exportaciones masivas
(
    'bulk_export_detection',
    'Detecta exportaciones masivas en ventana de 1 hora',
    NULL, -- todos los módulos
    'export',
    'tool_usage',
    '{"metric": "count", "operator": ">", "threshold": 30, "window": "1 hour", "group_by": ["user_id"]}',
    'medium',
    true,
    60,
    NULL
),
(
    'critical_bulk_export_detection',
    'Exportaciones críticas: más de 100 en 1 hora',
    NULL,
    'export',
    'tool_usage',
    '{"metric": "count", "operator": ">", "threshold": 100, "window": "1 hour", "group_by": ["user_id"]}',
    'high',
    true,
    60,
    NULL
),

-- Eliminaciones masivas
(
    'bulk_delete_detection',
    'Detecta eliminaciones masivas en 10 minutos',
    NULL,
    'delete',
    'tool_usage',
    '{"metric": "count", "operator": ">", "threshold": 10, "window": "10 minutes", "group_by": ["user_id"]}',
    'high',
    true,
    30,
    NULL
),

-- Publicaciones masivas en portales
(
    'bulk_publish_ml_detection',
    'Publicaciones masivas en Mercado Libre',
    'portales',
    'publish',
    'tool_usage',
    '{"metric": "count", "operator": ">", "threshold": 20, "window": "1 hour", "group_by": ["user_id"]}',
    'medium',
    true,
    60,
    NULL
),

-- Cambios masivos de precio
(
    'bulk_price_change_detection',
    'Cambios masivos de precio en propiedades',
    'properties',
    'update',
    'tool_usage',
    '{"metric": "count", "operator": ">", "threshold": 15, "window": "1 hour", "group_by": ["user_id"], "filter": {"field": "changed_fields", "contains": "price_usd"}}',
    'medium',
    true,
    60,
    NULL
),

-- Cambios de rol/permisos (siempre críticos)
(
    'role_change_detection',
    'Cualquier cambio de rol de usuario',
    'users',
    'update_sensitive',
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 0, "window": "1 hour", "group_by": ["user_id"], "filter": {"field": "changed_fields", "contains": "role"}}',
    'high',
    true,
    0,
    NULL
),

-- Desactivación de usuarios
(
    'user_deactivation_detection',
    'Desactivación de usuarios',
    'users',
    'update_sensitive',
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 0, "window": "1 hour", "group_by": ["user_id"], "filter": {"field": "changed_fields", "contains": "is_active"}}',
    'high',
    true,
    0,
    NULL
),

-- Intentos de escalada de privilegios
(
    'privilege_escalation_attempt',
    'Intentos de elevar propio rol o crear super_admin',
    'users',
    'update_sensitive',
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 0, "window": "1 hour", "group_by": ["user_id"], "filter": {"or": [{"field": "changed_fields", "contains": "role", "value": "super_admin"}, {"field": "metadata.new_data.role", "equals": "super_admin"}]}}',
    'critical',
    true,
    0,
    NULL
),

-- Errores repetidos
(
    'repeated_errors_detection',
    'Errores repetidos del mismo usuario en 15 minutos',
    NULL,
    NULL,
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 5, "window": "15 minutes", "group_by": ["user_id"], "filter": {"field": "status", "equals": "error"}}',
    'medium',
    true,
    30,
    NULL
),

-- Errores críticos de Edge Functions
(
    'critical_edge_function_errors',
    'Errores críticos en Edge Functions administrativas',
    NULL,
    NULL,
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 3, "window": "15 minutes", "group_by": ["user_id"], "filter": {"field": "status", "equals": "error", "module_in": ["ml-sync", "ml-webhook", "zernio-webhook", "manage-users", "zernio-proxy"]}}',
    'high',
    true,
    15,
    NULL
),

-- Cambios de configuración sensible
(
    'sensitive_config_change',
    'Cambios en configuración sensible (USD rate, feature flags, integraciones)',
    'config',
    'update',
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 0, "window": "1 hour", "group_by": ["user_id"], "filter": {"field": "table_name", "equals": "app_settings"}}',
    'high',
    true,
    60,
    NULL
),

-- Accesos denegados repetidos
(
    'permission_denied_threshold',
    'Múltiples accesos denegados (403/401)',
    NULL,
    NULL,
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 10, "window": "1 hour", "group_by": ["user_id"], "filter": {"field": "error_code", "in": ["403", "401", "permission_denied", "unauthorized"]}}',
    'medium',
    true,
    30,
    NULL
),

-- Rate limiting excesivo
(
    'rate_limit_exceeded_threshold',
    'Rate limiting excesivo - posible scraping o abuso',
    NULL,
    NULL,
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 5, "window": "1 hour", "group_by": ["user_id"], "filter": {"field": "error_code", "equals": "429"}}',
    'medium',
    true,
    30,
    NULL
),

-- Operaciones masivas en CRM
(
    'bulk_crm_operations',
    'Operaciones masivas en CRM (leads, visits)',
    'crm',
    NULL,
    'bulk_operation',
    '{"metric": "count", "operator": ">", "threshold": 20, "window": "1 hour", "group_by": ["user_id"]}',
    'medium',
    true,
    60,
    NULL
),

-- Descargas masivas de Ficha HTML
(
    'bulk_ficha_html_export',
    'Descargas masivas de HTML/PDF de fichas',
    'ficha_html',
    'export',
    'tool_usage',
    '{"metric": "count", "operator": ">", "threshold": 50, "window": "1 hour", "group_by": ["user_id"]}',
    'medium',
    true,
    60,
    NULL
),

-- Actividad fuera de horario (opcional - requiere config de horario)
(
    'off_hours_activity',
    'Actividad significativa fuera de horario comercial',
    NULL,
    NULL,
    NULL,
    '{"metric": "count", "operator": ">", "threshold": 20, "window": "1 hour", "group_by": ["user_id"], "time_window": {"start": "22:00", "end": "06:00", "timezone": "America/Argentina/Buenos_Aires"}}',
    'low',
    false, -- deshabilitada por defecto, requiere configuración de horario
    60,
    NULL
),

-- Secuencia sospechosa: crear usuario -> elevar rol -> exportar
(
    'suspicious_sequence_user_create_role_export',
    'Secuencia: crear usuario -> elevar rol -> exportar datos',
    'users',
    NULL,
    NULL,
    '{"metric": "sequence", "pattern": ["create", "update_sensitive:role:super_admin", "export"], "window": "30 minutes", "group_by": ["user_id"]}',
    'high',
    true,
    60,
    NULL
);

-- ============================================================
-- ÍNDICES ADICIONALES PARA PERFORMANCE
-- ============================================================

-- Índices compuestos para consultas de alertas
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_user_status_created 
    ON supervision_alerts (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supervision_alerts_user_severity_created 
    ON supervision_alerts (user_id, severity, created_at DESC);

-- Índice para búsquedas de alertas por tipo y estado
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_type_status 
    ON supervision_alerts (alert_type, status, created_at DESC);

-- Índice parcial para alertas abiertas
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_open 
    ON supervision_alerts (user_id, module, created_at DESC) 
    WHERE status = 'open';

-- ============================================================
-- VISTAS PARA CONSULTAS FRECUENTES DEL CENTRO DE SUPERVISIÓN
-- ============================================================

-- Vista: actividad diaria por usuario
CREATE OR REPLACE VIEW daily_user_activity AS
SELECT 
    user_id,
    DATE(created_at) as activity_date,
    COUNT(*) as total_events,
    COUNT(*) FILTER (WHERE status = 'success') as success_events,
    COUNT(*) FILTER (WHERE status = 'error') as error_events,
    COUNT(*) FILTER (WHERE action = 'export') as exports,
    COUNT(*) FILTER (WHERE action = 'delete') as deletions,
    COUNT(*) FILTER (WHERE action IN ('create', 'update', 'publish')) as modifications,
    COUNT(DISTINCT module) as modules_used
FROM audit_log
GROUP BY user_id, DATE(created_at);

-- Vista: actividad diaria por módulo
CREATE OR REPLACE VIEW daily_module_activity AS
SELECT 
    module,
    DATE(created_at) as activity_date,
    COUNT(*) as total_events,
    COUNT(DISTINCT user_id) as active_users,
    COUNT(*) FILTER (WHERE status = 'error') as errors
FROM audit_log
GROUP BY module, DATE(created_at);

-- Vista: alertas abiertas por usuario
CREATE OR REPLACE VIEW open_alerts_by_user AS
SELECT 
    user_id,
    severity,
    COUNT(*) as count,
    MAX(created_at) as latest_alert
FROM supervision_alerts
WHERE status = 'open'
GROUP BY user_id, severity;

-- Vista: resumen de alertas por módulo
CREATE OR REPLACE VIEW alerts_by_module AS
SELECT 
    module,
    severity,
    status,
    COUNT(*) as count
FROM supervision_alerts
GROUP BY module, severity, status;

-- ============================================================
-- FUNCIÓN PARA EVALUAR REGLAS DE SUPERVISIÓN
-- ============================================================

CREATE OR REPLACE FUNCTION evaluate_supervision_rules()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_rule RECORD;
    v_query text;
    v_count bigint;
    v_existing_alert uuid;
    v_user_id uuid;
    v_module text;
    v_severity text;
    v_alert_type text;
    v_title text;
    v_description text;
    v_evidence jsonb;
BEGIN
    FOR v_rule IN 
        SELECT * FROM supervision_rules WHERE enabled = true
    LOOP
        -- Construir query dinámica basada en la condición
        v_query := build_rule_query(v_rule);
        
        EXECUTE v_query INTO v_count;
        
        IF v_count > 0 THEN
            -- Verificar cooldown (evitar alertas duplicadas recientes)
            SELECT id INTO v_existing_alert
            FROM supervision_alerts
            WHERE alert_type = v_rule.name
            AND created_at > now() - (v_rule.cooldown_minutes || ' minutes')::interval
            AND status IN ('open', 'acknowledged')
            LIMIT 1;
            
            IF v_existing_alert IS NULL THEN
                -- Crear nueva alerta
                -- Extraer user_id de la query si es posible
                EXECUTE format('
                    SELECT user_id, %L as module, %L as severity, %L as alert_type, %L as title, %L as description, %L as evidence
                    FROM (%s) sub
                    LIMIT 1
                ', 
                    COALESCE(v_rule.module, 'system'),
                    v_rule.severity,
                    v_rule.name,
                    'Alerta: ' || v_rule.name,
                    v_rule.description,
                    jsonb_build_object('count', v_count, 'threshold', v_rule.condition->>'threshold', 'window', v_rule.condition->>'window', 'rule', v_rule.name),
                    v_query
                ) INTO v_user_id, v_module, v_severity, v_alert_type, v_title, v_description, v_evidence;
                
                IF v_user_id IS NOT NULL THEN
                    INSERT INTO supervision_alerts (
                        user_id, module, severity, alert_type, title, description, evidence
                    ) VALUES (
                        v_user_id, v_module, v_severity, v_alert_type, v_title, v_description, v_evidence
                    );
                ELSE
                    -- Alerta a nivel sistema sin usuario específico
                    INSERT INTO supervision_alerts (
                        module, severity, alert_type, title, description, evidence
                    ) VALUES (
                        v_module, v_severity, v_alert_type, v_title, v_description, v_evidence
                    );
                END IF;
            END IF;
        END IF;
    END LOOP;
END;
$$;

-- Función helper para construir queries de reglas
CREATE OR REPLACE FUNCTION build_rule_query(p_rule supervision_rules)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_query text;
    v_window text := p_rule.condition->>'window';
    v_threshold text := p_rule.condition->>'threshold';
    v_operator text := p_rule.condition->>'operator';
    v_metric text := p_rule.condition->>'metric';
    v_group_by text[] := COALESCE(p_rule.condition->'group_by', ARRAY['user_id'])::text[];
    v_filter jsonb := p_rule.condition->'filter';
    v_module text := COALESCE(p_rule.module, '');
    v_action text := COALESCE(p_rule.action, '');
    v_event_type text := COALESCE(p_rule.event_type, '');
BEGIN
    -- Construir query base según el tipo de métrica
    IF v_metric = 'count' THEN
        v_query := format(
            'SELECT COUNT(*) FROM audit_log 
             WHERE created_at > now() - %L::interval',
            v_window
        );
        
        -- Filtros opcionales
        IF v_module <> '' THEN
            v_query := v_query || format(' AND module = %L', v_module);
        END IF;
        
        IF v_action <> '' THEN
            v_query := v_query || format(' AND action = %L', v_action);
        END IF;
        
        IF v_filter IS NOT NULL THEN
            -- Filtros adicionales desde condition.filter
            IF v_filter ? 'field' AND v_filter ? 'contains' THEN
                v_query := v_query || format(
                    ' AND changed_fields @> %L',
                    jsonb_build_array(v_filter->>'contains')
                );
            END IF;
            IF v_filter ? 'field' AND v_filter ? 'equals' THEN
                v_query := v_query || format(
                    ' AND new_data->>%L = %L',
                    v_filter->>'field',
                    v_filter->>'equals'
                );
            END IF;
            IF v_filter ? 'field' AND v_filter ? 'value' THEN
                v_query := v_query || format(
                    ' AND new_data->>%L = %L',
                    v_filter->>'field',
                    v_filter->>'value'
                );
            END IF;
            IF v_filter ? 'in' THEN
                v_query := v_query || format(
                    ' AND error_code = ANY(%L)',
                    (v_filter->'in')::text[]
                );
            END IF;
        END IF;
        
        RETURN v_query;
    END IF;
    
    RETURN 'SELECT 0'; -- fallback
END;
$$;

-- ============================================================
-- CRON JOB PARA EVALUAR REGLAS PERIÓDICAMENTE
-- ============================================================

-- Habilitar pg_cron si no está habilitado
-- SELECT cron.schedule('evaluate-supervision-rules', '*/5 * * * *', 'SELECT evaluate_supervision_rules();');

-- Nota: pg_cron debe habilitarse en Supabase Dashboard > Database > Extensions
-- Luego ejecutar manualmente:
-- SELECT cron.schedule('evaluate-supervision-rules', '*/5 * * * *', 'SELECT evaluate_supervision_rules();');

-- ============================================================
-- COMENTARIOS
-- ============================================================
COMMENT ON FUNCTION evaluate_supervision_rules IS 'Evalúa todas las reglas de supervisión habilitadas y crea alertas si se superan umbrales. Ejecutar vía pg_cron cada 5 minutos.';
COMMENT ON FUNCTION build_rule_query IS 'Construye query SQL dinámica a partir de una regla de supervisión.';