-- ============================================================
-- BIENENHAUS - Sistema de Auditoría y Supervisión (Foundation)
-- Migración inicial: audit_log, usage_events, supervision_alerts, supervision_rules
-- ============================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. AUDIT_LOG - Registro de cambios persistentes
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    role_snapshot text,                    -- rol en el momento del evento
    broker_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    action text NOT NULL,                  -- create, update, delete, publish, export, assign, etc.
    module text NOT NULL,                  -- properties, crm, agenda, brokers, owners, tasaciones, portales, cms, users, config, chat, ficha_html, ml, zernio
    table_name text,                       -- tabla afectada (opcional)
    record_id uuid,                        -- ID del registro afectado (opcional)
    entity_type text,                      -- property, lead, visit, agent, owner, tasacion, ml_listing, conversation, user, setting
    entity_id uuid,                        -- ID de la entidad de negocio
    entity_label text,                     -- label legible (ej: "BH-2026-0001")
    old_data jsonb,                        -- estado anterior (sin secretos)
    new_data jsonb,                        -- estado nuevo (sin secretos)
    changed_fields text[],                 -- lista de campos modificados
    metadata jsonb DEFAULT '{}',           -- metadatos adicionales (request_id, session_id, ip, user_agent, duration_ms, error_code)
    status text DEFAULT 'success',         -- success, error, partial
    error_code text,                       -- código de error si falló
    ip inet,                               -- IP del cliente
    user_agent text,                       -- User-Agent del cliente
    session_id uuid,                       -- ID de sesión para correlación
    request_id uuid DEFAULT gen_random_uuid(), -- ID único de request para trazabilidad
    created_at timestamptz DEFAULT now()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_module_created ON audit_log (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_created ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_record ON audit_log (record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_request ON audit_log (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_status_created ON audit_log (status, created_at DESC);

-- Comentarios
COMMENT ON TABLE audit_log IS 'Registro inmutable de cambios persistentes y operaciones sensibles. Append-only.';
COMMENT ON COLUMN audit_log.old_data IS 'Estado anterior. Campos sensibles redactados automáticamente.';
COMMENT ON COLUMN audit_log.new_data IS 'Estado nuevo. Campos sensibles redactados automáticamente.';
COMMENT ON COLUMN audit_log.metadata IS 'JSON con request_id, session_id, ip, user_agent, duration_ms, error_code, etc.';
COMMENT ON COLUMN audit_log.changed_fields IS 'Array de nombres de campos que cambiaron en la operación.';

-- ============================================================
-- 2. USAGE_EVENTS - Métricas de utilización (no solo cambios)
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    role_snapshot text,
    broker_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    module text NOT NULL,
    event_type text NOT NULL,              -- tool_usage, navigation, api_call, export, import, bulk_operation
    action text NOT NULL,                  -- export, import, search, filter, generate, send, sync, login, logout
    entity_type text,                      -- property, lead, visit, agent, owner, tasacion, ml_listing, conversation, user, setting, report
    entity_id uuid,
    metadata jsonb DEFAULT '{}',           -- filtros, parámetros, duración, etc.
    status text DEFAULT 'success',         -- success, error, partial, rate_limited
    duration_ms integer,                   -- duración en milisegundos
    request_id uuid DEFAULT gen_random_uuid(),
    session_id uuid,
    created_at timestamptz DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_module_created ON usage_events (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_action_created ON usage_events (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_entity ON usage_events (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_event_type ON usage_events (event_type, created_at DESC);

COMMENT ON TABLE usage_events IS 'Métricas de utilización del sistema (no solo cambios de datos). Para análisis de productividad, adopción y detección de anomalías.';

-- ============================================================
-- 3. SUPERVISION_ALERTS - Sistema de alertas
-- ============================================================
CREATE TABLE IF NOT EXISTS supervision_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    module text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    alert_type text NOT NULL,              -- bulk_threshold, sensitive_action, error_rate, permission_denied, configuration_change, privilege_escalation, unusual_pattern
    title text NOT NULL,
    description text,
    evidence jsonb DEFAULT '{}',           -- datos que sustentan la alerta (conteos, umbrales, ejemplos)
    status text DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    acknowledged_at timestamptz,
    resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    resolved_at timestamptz,
    dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    dismissed_at timestamptz,
    created_at timestamptz DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_status_severity ON supervision_alerts (status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_user ON supervision_alerts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_module ON supervision_alerts (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_type ON supervision_alerts (alert_type, created_at DESC);

COMMENT ON TABLE supervision_alerts IS 'Alertas de supervisión operativa. Generadas por reglas configurables.';

-- ============================================================
-- 4. SUPERVISION_RULES - Reglas configurables de detección
-- ============================================================
CREATE TABLE IF NOT EXISTS supervision_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    description text,
    module text,                           -- NULL = todas
    action text,                           -- NULL = todas
    event_type text,                       -- NULL = todas
    condition jsonb NOT NULL,              -- {metric: 'count', operator: '>', threshold: 30, window: '1 hour', group_by: ['user_id']}
    severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    enabled boolean DEFAULT true,
    cooldown_minutes integer DEFAULT 60,   -- tiempo mínimo entre alertas de la misma regla para el mismo usuario
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_supervision_rules_enabled ON supervision_rules (enabled, module, alert_type);

COMMENT ON TABLE supervision_rules IS 'Reglas configurables para detección automática de anomalías y alertas. Solo super_admin puede gestionarlas.';

-- ============================================================
-- 5. RATE_LIMIT_LOGS - Ya existe (usado por rate-limit.ts)
-- Verificar que existe, si no crearla
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limit_logs (
    id bigserial PRIMARY KEY,
    key text NOT NULL,
    created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_logs_key_created ON rate_limit_logs (key, created_at DESC);

-- ============================================================
-- FUNCIONES DE AYUDA PARA AUDITORÍA
-- ============================================================

-- Función para redactar campos sensibles de un JSON
CREATE OR REPLACE FUNCTION sanitize_audit_payload(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    sensitive_keys CONSTANT text[] := ARRAY[
        'password', 'password_hash', 'api_key', 'access_token', 'refresh_token',
        'client_secret', 'secret', 'encryption_key', 'authorization',
        'cookie', 'session_token', 'jwt', 'bearer', 'private_key',
        'service_role_key', 'anon_key', 'signing_secret', 'webhook_secret'
    ];
    result jsonb := payload;
    key text;
BEGIN
    IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
        RETURN payload;
    END IF;
    
    FOREACH key IN ARRAY sensitive_keys LOOP
        IF result ? key THEN
            result := result - key || jsonb_build_object(key, '[REDACTED]');
        END IF;
        -- También buscar en claves anidadas (primera nivel)
        IF result ? key THEN
            CONTINUE;
        END IF;
    END LOOP;
    
    -- Recursivo para objetos anidados (primer nivel de profundidad)
    RETURN jsonb_object_agg(
        k, 
        CASE 
            WHEN jsonb_typeof(v) = 'object' AND v IS NOT NULL THEN sanitize_audit_payload(v)
            WHEN k = ANY(sensitive_keys) THEN '[REDACTED]'::jsonb
            ELSE v
        END
    ) FROM jsonb_each(result) AS j(k, v);
END;
$$;

COMMENT ON FUNCTION sanitize_audit_payload IS 'Redacta automáticamente campos sensibles de un payload JSON para auditoría.';

-- Función para generar request_id
CREATE OR REPLACE FUNCTION gen_request_id()
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT gen_random_uuid();
$$;

-- Función helper para insertar audit_log con redacción automática
CREATE OR REPLACE FUNCTION insert_audit_log(
    p_user_id uuid DEFAULT NULL,
    p_role_snapshot text DEFAULT NULL,
    p_broker_id uuid DEFAULT NULL,
    p_action text,
    p_module text,
    p_table_name text DEFAULT NULL,
    p_record_id uuid DEFAULT NULL,
    p_entity_type text DEFAULT NULL,
    p_entity_id uuid DEFAULT NULL,
    p_entity_label text DEFAULT NULL,
    p_old_data jsonb DEFAULT NULL,
    p_new_data jsonb DEFAULT NULL,
    p_changed_fields text[] DEFAULT NULL,
    p_metadata jsonb DEFAULT '{}',
    p_status text DEFAULT 'success',
    p_error_code text DEFAULT NULL,
    p_ip inet DEFAULT NULL,
    p_user_agent text DEFAULT NULL,
    p_session_id uuid DEFAULT NULL,
    p_request_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id uuid;
    v_old_sanitized jsonb;
    v_new_sanitized jsonb;
    v_changed_fields text[];
BEGIN
    -- Redactar datos sensibles
    v_old_sanitized := sanitize_audit_payload(p_old_data);
    v_new_sanitized := sanitize_audit_payload(p_new_data);
    
    -- Calcular campos cambiados si no se proporcionaron
    IF p_changed_fields IS NULL AND p_old_data IS NOT NULL AND p_new_data IS NOT NULL THEN
        SELECT array_agg(key) INTO v_changed_fields
        FROM (
            SELECT key FROM jsonb_each(p_new_data)
            EXCEPT
            SELECT key FROM jsonb_each(p_old_data)
        ) t;
        -- También detectar cambios de valor en claves comunes
        SELECT array_agg(key) INTO v_changed_fields
        FROM (
            SELECT key FROM jsonb_each(p_new_data) new
            JOIN jsonb_each(p_old_data) old USING (key)
            WHERE new.value IS DISTINCT FROM old.value
        ) t;
    ELSE
        v_changed_fields := p_changed_fields;
    END IF;
    
    INSERT INTO audit_log (
        user_id, role_snapshot, broker_id, action, module, table_name,
        record_id, entity_type, entity_id, entity_label,
        old_data, new_data, changed_fields, metadata,
        status, error_code, ip, user_agent, session_id, request_id
    ) VALUES (
        p_user_id, p_role_snapshot, p_broker_id, p_action, p_module, p_table_name,
        p_record_id, p_entity_type, p_entity_id, p_entity_label,
        v_old_sanitized, v_new_sanitized, v_changed_fields, p_metadata,
        p_status, p_error_code, p_ip, p_user_agent, p_session_id, 
        COALESCE(p_request_id, gen_random_uuid())
    ) RETURNING id INTO v_id;
    
    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION insert_audit_log IS 'Inserta registro en audit_log con redacción automática de secretos.';

-- Función helper para insertar usage_events
CREATE OR REPLACE FUNCTION insert_usage_event(
    p_user_id uuid DEFAULT NULL,
    p_role_snapshot text DEFAULT NULL,
    p_broker_id uuid DEFAULT NULL,
    p_module text,
    p_event_type text,
    p_action text,
    p_entity_type text DEFAULT NULL,
    p_entity_id uuid DEFAULT NULL,
    p_metadata jsonb DEFAULT '{}',
    p_status text DEFAULT 'success',
    p_duration_ms integer DEFAULT NULL,
    p_session_id uuid DEFAULT NULL,
    p_request_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO usage_events (
        user_id, role_snapshot, broker_id, module, event_type, action,
        entity_type, entity_id, metadata, status, duration_ms,
        session_id, request_id
    ) VALUES (
        p_user_id, p_role_snapshot, p_broker_id, p_module, p_event_type, p_action,
        p_entity_type, p_entity_id, p_metadata, p_status, p_duration_ms,
        p_session_id, COALESCE(p_request_id, gen_random_uuid())
    ) RETURNING id INTO v_id;
    
    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION insert_usage_event IS 'Inserta evento de uso/métrica de utilización.';

-- ============================================================
-- RLS PARA TABLAS DE AUDITORÍA
-- ============================================================

-- Habilitar RLS
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervision_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervision_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_logs ENABLE ROW LEVEL SECURITY;

-- Políticas: solo super_admin puede leer/escribir
-- Nota: Se asume que existe una función is_super_admin() o similar.
-- Si no existe, se crea una política basada en profiles.role

-- Helper function para verificar super_admin
CREATE OR REPLACE FUNCTION is_super_admin(user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM profiles 
        WHERE id = user_id AND role = 'super_admin' AND is_active !== false
    );
$$;

-- Políticas audit_log
DROP POLICY IF EXISTS "audit_log_super_admin_select" ON audit_log;
CREATE POLICY "audit_log_super_admin_select" ON audit_log
    FOR SELECT USING (is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "audit_log_system_insert" ON audit_log;
CREATE POLICY "audit_log_system_insert" ON audit_log
    FOR INSERT WITH CHECK (false); -- Solo triggers/funciones SECURITY DEFINER (bypasan RLS)

DROP POLICY IF EXISTS "audit_log_no_update" ON audit_log;
CREATE POLICY "audit_log_no_update" ON audit_log
    FOR UPDATE USING (false);

DROP POLICY IF EXISTS "audit_log_no_delete" ON audit_log;
CREATE POLICY "audit_log_no_delete" ON audit_log
    FOR DELETE USING (false);

-- Políticas usage_events
DROP POLICY IF EXISTS "usage_events_super_admin_select" ON usage_events;
CREATE POLICY "usage_events_super_admin_select" ON usage_events
    FOR SELECT USING (is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "usage_events_system_insert" ON usage_events;
CREATE POLICY "usage_events_system_insert" ON usage_events
    FOR INSERT WITH CHECK (false); -- Solo triggers/funciones SECURITY DEFINER

-- Políticas supervision_alerts
DROP POLICY IF EXISTS "supervision_alerts_super_admin_all" ON supervision_alerts;
CREATE POLICY "supervision_alerts_super_admin_all" ON supervision_alerts
    FOR ALL USING (is_super_admin(auth.uid()));

-- Políticas supervision_rules
DROP POLICY IF EXISTS "supervision_rules_super_admin_all" ON supervision_rules;
CREATE POLICY "supervision_rules_super_admin_all" ON supervision_rules
    FOR ALL USING (is_super_admin(auth.uid()));

-- rate_limit_logs - solo sistema
DROP POLICY IF EXISTS "rate_limit_logs_system" ON rate_limit_logs;
CREATE POLICY "rate_limit_logs_system" ON rate_limit_logs
    FOR ALL USING (false); -- Solo triggers/funciones SECURITY DEFINER

-- ============================================================
-- TRIGGERS PARA AUDITORÍA AUTOMÁTICA DE TABLAS CLAVE
-- ============================================================

-- Función genérica de trigger para auditoría
CREATE OR REPLACE FUNCTION audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_role text;
    v_broker_id uuid;
    v_action text;
    v_module text;
    v_old_data jsonb;
    v_new_data jsonb;
    v_changed_fields text[];
    v_entity_type text;
    v_entity_id uuid;
    v_entity_label text;
    v_request_id uuid := gen_random_uuid();
BEGIN
    -- Determinar usuario actual (desde session variable o auth.uid())
    v_user_id := COALESCE(
        current_setting('request.jwt.claims', true)::json->>'sub',
        auth.uid()
    )::uuid;
    
    -- Obtener rol y broker_id del perfil
    SELECT role, broker_id INTO v_role, v_broker_id
    FROM profiles WHERE id = v_user_id;
    
    -- Determinar acción
    v_action := CASE TG_OP
        WHEN 'INSERT' THEN 'create'
        WHEN 'UPDATE' THEN 'update'
        WHEN 'DELETE' THEN 'delete'
        ELSE TG_OP
    END;
    
    -- Determinar módulo basado en tabla
    v_module := CASE TG_TABLE_NAME
        WHEN 'properties' THEN 'properties'
        WHEN 'leads' THEN 'crm'
        WHEN 'visits' THEN 'agenda'
        WHEN 'agents' THEN 'brokers'
        WHEN 'owners' THEN 'owners'
        WHEN 'tasaciones' THEN 'tasaciones'
        WHEN 'ml_listings' THEN 'portales'
        WHEN 'site_content' THEN 'cms'
        WHEN 'profiles' THEN 'users'
        WHEN 'app_settings' THEN 'config'
        WHEN 'zernio_conversations' THEN 'chat'
        WHEN 'zernio_messages' THEN 'chat'
        WHEN 'zernio_accounts' THEN 'chat'
        WHEN 'ml_listings' THEN 'ml'
        WHEN 'ml_sync_queue' THEN 'ml'
        WHEN 'ml_sync_history' THEN 'ml'
        ELSE 'other'
    END;
    
    -- Preparar datos
    IF TG_OP = 'DELETE' THEN
        v_old_data := to_jsonb(OLD);
        v_new_data := NULL;
    ELSIF TG_OP = 'INSERT' THEN
        v_old_data := NULL;
        v_new_data := to_jsonb(NEW);
    ELSE
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);
    END IF;
    
    -- Determinar entity_type y entity_id
    v_entity_type := CASE TG_TABLE_NAME
        WHEN 'properties' THEN 'property'
        WHEN 'leads' THEN 'lead'
        WHEN 'visits' THEN 'visit'
        WHEN 'agents' THEN 'agent'
        WHEN 'owners' THEN 'owner'
        WHEN 'tasaciones' THEN 'tasacion'
        WHEN 'ml_listings' THEN 'ml_listing'
        WHEN 'zernio_conversations' THEN 'conversation'
        WHEN 'profiles' THEN 'user'
        WHEN 'app_settings' THEN 'setting'
        ELSE TG_TABLE_NAME
    END;
    
    v_entity_id := CASE 
        WHEN TG_TABLE_NAME = 'properties' THEN NEW.id
        WHEN TG_TABLE_NAME = 'leads' THEN NEW.id
        WHEN TG_TABLE_NAME = 'visits' THEN NEW.id
        WHEN TG_TABLE_NAME = 'agents' THEN NEW.id
        WHEN TG_TABLE_NAME = 'owners' THEN NEW.id
        WHEN TG_TABLE_NAME = 'tasaciones' THEN NEW.id
        WHEN TG_TABLE_NAME = 'ml_listings' THEN NEW.id
        WHEN TG_TABLE_NAME = 'zernio_conversations' THEN NEW.id
        WHEN TG_TABLE_NAME = 'profiles' THEN NEW.id
        ELSE NEW.id
    END;
    
    -- Label legible
    IF TG_TABLE_NAME = 'properties' THEN
        v_entity_label := COALESCE(NEW.code, NEW.title, NEW.id::text);
    ELSIF TG_TABLE_NAME = 'leads' THEN
        v_entity_label := COALESCE(NEW.full_name, NEW.id::text);
    ELSIF TG_TABLE_NAME = 'visits' THEN
        v_entity_label := COALESCE(NEW.client_name, NEW.id::text);
    ELSIF TG_TABLE_NAME = 'agents' THEN
        v_entity_label := COALESCE(NEW.full_name, NEW.code, NEW.id::text);
    ELSIF TG_TABLE_NAME = 'owners' THEN
        v_entity_label := COALESCE(NEW.full_name, NEW.id::text);
    ELSIF TG_TABLE_NAME = 'tasaciones' THEN
        v_entity_label := COALESCE(NEW.title, NEW.id::text);
    ELSE
        v_entity_label := COALESCE(NEW.id::text, OLD.id::text);
    END IF;
    
    -- Calcular campos cambiados para UPDATE
    IF TG_OP = 'UPDATE' THEN
        SELECT array_agg(key) INTO TG_TABLE_NAME
        FROM (
            SELECT key FROM jsonb_each(to_jsonb(NEW))
            EXCEPT
            SELECT key FROM jsonb_each(to_jsonb(OLD))
        ) t
        UNION
        SELECT array_agg(key) FROM (
            SELECT key FROM jsonb_each(to_jsonb(NEW)) new
            JOIN jsonb_each(to_jsonb(OLD)) old USING (key)
            WHERE new.value IS DISTINCT FROM old.value
        ) t;
    END IF;
    
    -- Insertar en audit_log
    PERFORM insert_audit_log(
        p_user_id := v_user_id,
        p_role_snapshot := v_role,
        p_broker_id := v_broker_id,
        p_action := v_action,
        p_module := v_module,
        p_table_name := TG_TABLE_NAME,
        p_record_id := COALESCE(NEW.id, OLD.id),
        p_entity_type := v_entity_type,
        p_entity_id := v_entity_id,
        p_entity_label := v_entity_label,
        p_old_data := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
        p_new_data := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
        p_changed_fields := NULL, -- se calcula dentro de insert_audit_log
        p_metadata := jsonb_build_object('trigger', true, 'operation', TG_OP),
        p_request_id := gen_random_uuid()
    );
    
    RETURN NULL; -- AFTER trigger
END;
$$;

-- Aplicar triggers a tablas clave
DO $$
DECLARE
    t text;
    tables_to_audit CONSTANT text[] := ARRAY[
        'properties', 'leads', 'visits', 'agents', 'owners', 
        'tasaciones', 'ml_listings', 'site_content', 'profiles', 
        'app_settings', 'zernio_conversations', 'zernio_messages',
        'zernio_accounts', 'ml_listings', 'ml_sync_queue', 'ml_sync_history',
        'portal_settings', 'owners'
    ];
BEGIN
    FOREACH t IN ARRAY tables_to_audit LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS audit_trigger ON %I;
            CREATE TRIGGER audit_trigger
            AFTER INSERT OR UPDATE OR DELETE ON %I
            FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
        ', t, t);
    END LOOP;
END $$;

-- ============================================================
-- TRIGGER ESPECIAL PARA PROFILES (cambios de rol/estado)
-- ============================================================

CREATE OR REPLACE FUNCTION profiles_audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_role text;
    v_broker_id uuid;
    v_action text;
    v_request_id uuid := gen_random_uuid();
BEGIN
    -- Solo auditar cambios sensibles
    IF TG_OP = 'UPDATE' AND (
        OLD.role IS DISTINCT FROM NEW.role OR
        OLD.is_active IS DISTINCT FROM NEW.is_active OR
        OLD.email IS DISTINCT FROM NEW.email
    ) THEN
        v_user_id := COALESCE(
            current_setting('request.jwt.claims', true)::json->>'sub',
            auth.uid()
        )::uuid;
        
        SELECT role, broker_id INTO v_role, v_broker_id FROM profiles WHERE id = v_user_id;
        
        PERFORM insert_audit_log(
            p_user_id := v_user_id,
            p_role_snapshot := v_role,
            p_broker_id := v_broker_id,
            p_action := 'update_sensitive',
            p_module := 'users',
            p_table_name := 'profiles',
            p_record_id := NEW.id,
            p_entity_type := 'user',
            p_entity_id := NEW.id,
            p_entity_label := COALESCE(NEW.full_name, NEW.email, NEW.id::text),
            p_old_data := to_jsonb(OLD),
            p_new_data := to_jsonb(NEW),
            p_metadata := jsonb_build_object('sensitive_fields_changed', 
                CASE WHEN OLD.role IS DISTINCT FROM NEW.role THEN ARRAY['role'] ELSE ARRAY[] END ||
                CASE WHEN OLD.is_active IS DISTINCT FROM NEW.is_active THEN ARRAY['is_active'] ELSE ARRAY[] END ||
                CASE WHEN OLD.email IS DISTINCT FROM NEW.email THEN ARRAY['email'] ELSE ARRAY[] END
            ),
            p_request_id := gen_random_uuid()
        );
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_sensitive_audit ON profiles;
CREATE TRIGGER profiles_sensitive_audit
AFTER UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION profiles_audit_trigger_fn();

-- ============================================================
-- COMENTARIOS FINALES
-- ============================================================
COMMENT ON SCHEMA public IS 'Esquema principal BIENENHAUS. Auditoría: tablas append-only, RLS estricto, solo super_admin.';