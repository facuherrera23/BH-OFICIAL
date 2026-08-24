-- ============================================================
-- BIENENHAUS - Migración correctiva del sistema de supervisión
-- Reconcilia las migraciones 20260824000001-004 (registradas como
-- aplicadas pero con objetos faltantes/bugs en la DB real).
-- Idempotente: re-aplicar es seguro.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. TABLAS FALTANTES
-- ============================================================

CREATE TABLE IF NOT EXISTS usage_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    role_snapshot text,
    broker_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    module text NOT NULL,
    event_type text NOT NULL,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    metadata jsonb DEFAULT '{}',
    status text DEFAULT 'success',
    duration_ms integer,
    request_id uuid DEFAULT gen_random_uuid(),
    session_id uuid,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_module_created ON usage_events (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_action_created ON usage_events (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_entity ON usage_events (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_event_type ON usage_events (event_type, created_at DESC);

COMMENT ON TABLE usage_events IS 'Métricas de utilización del sistema. Append-only, lectura solo super_admin.';

CREATE TABLE IF NOT EXISTS supervision_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    module text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    alert_type text NOT NULL,
    title text NOT NULL,
    description text,
    evidence jsonb DEFAULT '{}',
    status text DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    acknowledged_at timestamptz,
    resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    resolved_at timestamptz,
    dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    dismissed_at timestamptz,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supervision_alerts_status_severity ON supervision_alerts (status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_user ON supervision_alerts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_module ON supervision_alerts (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_user_status_created ON supervision_alerts (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_open ON supervision_alerts (user_id, module, created_at DESC) WHERE status = 'open';

COMMENT ON TABLE supervision_alerts IS 'Alertas de supervisión operativa generadas por reglas configurables.';

CREATE TABLE IF NOT EXISTS supervision_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    description text,
    module text,
    action text,
    event_type text,
    condition jsonb NOT NULL,
    severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    enabled boolean DEFAULT true,
    cooldown_minutes integer DEFAULT 60,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supervision_rules_enabled ON supervision_rules (enabled, module, action);

COMMENT ON TABLE supervision_rules IS 'Reglas configurables de detección de anomalías. Solo super_admin puede gestionarlas.';

-- rate_limit_logs: usada por _shared/rate-limit.ts (fail-open si falta)
CREATE TABLE IF NOT EXISTS rate_limit_logs (
    id bigserial PRIMARY KEY,
    key text NOT NULL,
    created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_logs_key_created ON rate_limit_logs (key, created_at DESC);

-- Índices audit_log (la tabla ya existe; creada por migración previa)
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_module_created ON audit_log (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_created ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_request ON audit_log (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_status_created ON audit_log (status, created_at DESC);

-- ============================================================
-- 2. FUNCIONES CORE (faltaban en la DB)
-- ============================================================

CREATE OR REPLACE FUNCTION is_super_admin(user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM profiles
        WHERE id = user_id AND role = 'super_admin' AND is_active IS DISTINCT FROM false
    );
$$;

CREATE OR REPLACE FUNCTION sanitize_audit_payload(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    sensitive_keys CONSTANT text[] := ARRAY[
        'password', 'password_hash', 'api_key', 'api_secret', 'access_token',
        'refresh_token', 'client_secret', 'secret', 'encryption_key', 'authorization',
        'cookie', 'session_token', 'jwt', 'bearer', 'private_key',
        'service_role_key', 'anon_key', 'signing_secret', 'webhook_secret',
        'api_key_enc', 'confirmation_token'
    ];
BEGIN
    IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
        RETURN payload;
    END IF;

    RETURN (
        SELECT jsonb_object_agg(k, v_out)
        FROM (
            SELECT
                j.key AS k,
                CASE
                    WHEN lower(j.key) = ANY(sensitive_keys) THEN '"[REDACTED]"'::jsonb
                    WHEN jsonb_typeof(j.value) = 'object' THEN sanitize_audit_payload(j.value)
                    ELSE j.value
                END AS v_out
            FROM jsonb_each(payload) AS j
        ) sub
    );
END;
$$;

CREATE OR REPLACE FUNCTION gen_request_id()
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT gen_random_uuid();
$$;

CREATE OR REPLACE FUNCTION insert_audit_log(
    p_user_id uuid DEFAULT NULL,
    p_role_snapshot text DEFAULT NULL,
    p_broker_id uuid DEFAULT NULL,
    p_action text DEFAULT NULL,
    p_module text DEFAULT NULL,
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
SET search_path = public
AS $$
DECLARE
    v_id uuid;
    v_changed_fields text[];
BEGIN
    -- Calcular campos modificados si no se pasaron (diff top-level de claves
    -- nuevas/eliminadas + valor distinto en claves comunes)
    IF p_changed_fields IS NULL AND p_old_data IS NOT NULL AND p_new_data IS NOT NULL THEN
        SELECT array_agg(DISTINCT key ORDER BY key) INTO v_changed_fields
        FROM (
            SELECT key FROM jsonb_each(p_new_data)
            EXCEPT
            SELECT key FROM jsonb_each(p_old_data)
            UNION
            SELECT old.key FROM jsonb_each(p_old_data) old
            EXCEPT
            SELECT new.key FROM jsonb_each(p_new_data) new
            UNION
            SELECT n.key
            FROM jsonb_each(p_new_data) n
            JOIN jsonb_each(p_old_data) o USING (key)
            WHERE n.value IS DISTINCT FROM o.value
        ) diffs;
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
        sanitize_audit_payload(p_old_data), sanitize_audit_payload(p_new_data),
        v_changed_fields, p_metadata,
        p_status, p_error_code, p_ip, p_user_agent, p_session_id,
        COALESCE(p_request_id, gen_random_uuid())
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION insert_usage_event(
    p_user_id uuid DEFAULT NULL,
    p_role_snapshot text DEFAULT NULL,
    p_broker_id uuid DEFAULT NULL,
    p_module text DEFAULT NULL,
    p_event_type text DEFAULT NULL,
    p_action text DEFAULT NULL,
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
SET search_path = public
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
        p_entity_type, p_entity_id, sanitize_audit_payload(p_metadata), p_status, p_duration_ms,
        p_session_id, COALESCE(p_request_id, gen_random_uuid())
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- Solo el sistema (SECURITY DEFINER) y service_role pueden invocarlas
REVOKE ALL ON FUNCTION insert_audit_log(uuid, text, uuid, text, text, text, uuid, text, uuid, text, jsonb, jsonb, text[], jsonb, text, text, inet, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION insert_usage_event(uuid, text, uuid, text, text, text, text, uuid, jsonb, text, integer, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insert_audit_log(uuid, text, uuid, text, text, text, uuid, text, uuid, text, jsonb, jsonb, text[], jsonb, text, text, inet, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION insert_usage_event(uuid, text, uuid, text, text, text, text, uuid, jsonb, text, integer, uuid, uuid) TO service_role;

-- ============================================================
-- 3. TRIGGERS DE AUDITORÍA (versión corregida)
-- ============================================================

CREATE OR REPLACE FUNCTION audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id uuid := auth.uid();  -- NULL para escrituras service_role (Edge Functions auditan aparte)
    v_role text;
    v_broker_id uuid;
    v_row jsonb;
    v_old_row jsonb;
    v_record_id uuid;
    v_entity_label text;
    v_module text;
BEGIN
    -- La fila relevante según operación (NEW no existe en DELETE)
    IF TG_OP = 'DELETE' THEN
        v_row := to_jsonb(OLD);
        v_old_row := v_row;
    ELSE
        v_row := to_jsonb(NEW);
        v_old_row := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
    END IF;

    -- record_id solo si la tabla tiene PK uuid nombrada 'id'
    BEGIN
        v_record_id := NULLIF(v_row->>'id', '')::uuid;
    EXCEPTION WHEN others THEN
        v_record_id := NULL;
    END;

    -- rol y broker del actor (vínculo real: agents.profile_id)
    IF v_user_id IS NOT NULL THEN
        SELECT p.role::text INTO v_role FROM profiles p WHERE p.id = v_user_id;
        SELECT a.id INTO v_broker_id FROM agents a WHERE a.profile_id = v_user_id;
    END IF;

    v_module := CASE TG_TABLE_NAME
        WHEN 'properties' THEN 'properties'
        WHEN 'leads' THEN 'crm'
        WHEN 'visits' THEN 'agenda'
        WHEN 'agents' THEN 'brokers'
        WHEN 'owners' THEN 'owners'
        WHEN 'tasaciones' THEN 'tasaciones'
        WHEN 'ml_listings' THEN 'portales'
        WHEN 'site_content' THEN 'cms'
        WHEN 'app_settings' THEN 'config'
        ELSE TG_TABLE_NAME
    END;

    v_entity_label := COALESCE(
        v_row->>'property_code',
        v_row->>'title',
        v_row->>'full_name',
        v_row->>'client_name',
        v_row->>'key',
        v_row->>'id'
    );

    PERFORM insert_audit_log(
        p_user_id := v_user_id,
        p_role_snapshot := v_role,
        p_broker_id := v_broker_id,
        p_action := lower(TG_OP),
        p_module := v_module,
        p_table_name := TG_TABLE_NAME,
        p_record_id := v_record_id,
        p_entity_type := TG_TABLE_NAME,
        p_entity_id := v_record_id,
        p_entity_label := v_entity_label,
        p_old_data := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE v_old_row END,
        p_new_data := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE v_row END,
        p_changed_fields := NULL,
        p_metadata := jsonb_build_object('trigger', TG_TABLE_NAME, 'op', TG_OP)
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
    t text;
    audited_tables CONSTANT text[] := ARRAY[
        'properties', 'leads', 'visits', 'agents', 'owners',
        'tasaciones', 'ml_listings', 'site_content', 'app_settings'
    ];
BEGIN
    FOREACH t IN ARRAY audited_tables LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS audit_trigger ON %I', t);
        EXECUTE format(
            'CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON %I
             FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()', t);
    END LOOP;
END $$;

-- Cambios sensibles en profiles (rol / activación). profiles.broker_id no existe:
-- el vínculo usuario→broker es agents.profile_id.
CREATE OR REPLACE FUNCTION profiles_sensitive_audit_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_role text;
    v_broker_id uuid;
    v_changed text[] := ARRAY[]::text[];
BEGIN
    IF OLD.role IS DISTINCT FROM NEW.role THEN v_changed := v_changed || 'role'; END IF;
    IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN v_changed := v_changed || 'is_active'; END IF;
    IF OLD.email IS DISTINCT FROM NEW.email THEN v_changed := v_changed || 'email'; END IF;

    IF array_length(v_changed, 1) IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_user_id IS NOT NULL THEN
        SELECT p.role::text INTO v_role FROM profiles p WHERE p.id = v_user_id;
        SELECT a.id INTO v_broker_id FROM agents a WHERE a.profile_id = v_user_id;
    END IF;

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
        p_entity_label := COALESCE(NULLIF(NEW.full_name, ''), NULLIF(NEW.email, ''), NEW.id::text),
        p_old_data := to_jsonb(OLD),
        p_new_data := to_jsonb(NEW),
        p_changed_fields := v_changed,
        p_metadata := jsonb_build_object(
            'sensitive_fields_changed', to_jsonb(v_changed),
            'privilege_escalation', (NEW.role = 'super_admin' AND OLD.role IS DISTINCT FROM NEW.role)
        )
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_sensitive_audit ON profiles;
CREATE TRIGGER profiles_sensitive_audit
AFTER UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION profiles_sensitive_audit_fn();

-- ============================================================
-- 4. RLS (audit_log estaba con RLS DESACTIVADO)
-- ============================================================

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervision_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervision_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_logs ENABLE ROW LEVEL SECURITY;

-- audit_log: lectura solo super_admin; append-only (insert solo SECURITY DEFINER/service_role)
DROP POLICY IF EXISTS "audit_log_super_admin_select" ON audit_log;
CREATE POLICY "audit_log_super_admin_select" ON audit_log
    FOR SELECT TO authenticated USING (is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "audit_log_no_insert" ON audit_log;
CREATE POLICY "audit_log_no_insert" ON audit_log
    FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS "audit_log_no_update" ON audit_log;
CREATE POLICY "audit_log_no_update" ON audit_log
    FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS "audit_log_no_delete" ON audit_log;
CREATE POLICY "audit_log_no_delete" ON audit_log
    FOR DELETE TO authenticated USING (false);

-- usage_events
DROP POLICY IF EXISTS "usage_events_super_admin_select" ON usage_events;
CREATE POLICY "usage_events_super_admin_select" ON usage_events
    FOR SELECT TO authenticated USING (is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "usage_events_no_insert" ON usage_events;
CREATE POLICY "usage_events_no_insert" ON usage_events
    FOR INSERT TO authenticated WITH CHECK (false);

-- supervision_alerts: super_admin gestiona el ciclo de vida
DROP POLICY IF EXISTS "supervision_alerts_super_admin_all" ON supervision_alerts;
CREATE POLICY "supervision_alerts_super_admin_all" ON supervision_alerts
    FOR ALL TO authenticated
    USING (is_super_admin(auth.uid()))
    WITH CHECK (is_super_admin(auth.uid()));

-- supervision_rules
DROP POLICY IF EXISTS "supervision_rules_super_admin_all" ON supervision_rules;
CREATE POLICY "supervision_rules_super_admin_all" ON supervision_rules
    FOR ALL TO authenticated
    USING (is_super_admin(auth.uid()))
    WITH CHECK (is_super_admin(auth.uid()));

-- rate_limit_logs: solo sistema
DROP POLICY IF EXISTS "rate_limit_logs_system_only" ON rate_limit_logs;
CREATE POLICY "rate_limit_logs_system_only" ON rate_limit_logs
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- ============================================================
-- 5. MOTOR DE REGLAS + REGLAS POR DEFECTO (idempotentes)
-- ============================================================

CREATE OR REPLACE FUNCTION evaluate_supervision_rules()
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
    v_changed_field text;
BEGIN
    FOR v_rule IN SELECT * FROM supervision_rules WHERE enabled LOOP
        v_window := COALESCE(v_rule.condition->>'window', '1 hour')::interval;
        v_threshold := COALESCE((v_rule.condition->>'threshold')::numeric, 0);
        v_filter := v_rule.condition->'filter';

        -- Reglas basadas en changed_fields (role_change, price_change, etc.)
        IF v_filter ? 'contains' THEN
            v_changed_field := v_filter->>'contains';
            FOR v_hit IN
                SELECT user_id, count(*) AS c
                FROM audit_log
                WHERE created_at > now() - v_window
                  AND (v_rule.module IS NULL OR module = v_rule.module)
                  AND (v_rule.action IS NULL OR action = v_rule.action)
                  AND changed_fields @> ARRAY[v_changed_field]
                  AND user_id IS NOT NULL
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
                        jsonb_build_object('count', v_hit.c, 'threshold', v_threshold, 'window', v_rule.condition->>'window', 'field', v_changed_field)
                    );
                END IF;
            END LOOP;
        ELSE
            -- Reglas basadas en conteo simple (exports, deletes, errores, etc.)
            FOR v_hit IN
                SELECT user_id, count(*) AS c
                FROM audit_log
                WHERE created_at > now() - v_window
                  AND (v_rule.module IS NULL OR module = v_rule.module)
                  AND (v_rule.action IS NULL OR action = v_rule.action)
                  AND user_id IS NOT NULL
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
                        jsonb_build_object('count', v_hit.c, 'threshold', v_threshold, 'window', v_rule.condition->>'window')
                    );
                END IF;
            END LOOP;
        END IF;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION evaluate_supervision_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluate_supervision_rules() TO service_role;

-- Reglas iniciales (ON CONFLICT por name: seguro re-aplicar)
INSERT INTO supervision_rules (name, description, module, action, event_type, condition, severity, enabled, cooldown_minutes)
VALUES
('bulk_export_detection', 'Más de 30 exportaciones en 1 hora', NULL, 'export', 'tool_usage',
 '{"metric":"count","operator":">","threshold":30,"window":"1 hour"}', 'medium', true, 60),
('bulk_delete_detection', 'Más de 10 eliminaciones en 10 minutos', NULL, 'delete', NULL,
 '{"metric":"count","operator":">","threshold":10,"window":"10 minutes"}', 'high', true, 30),
('bulk_publish_ml_detection', 'Publicaciones masivas en Mercado Libre', 'portales', 'publish', NULL,
 '{"metric":"count","operator":">","threshold":20,"window":"1 hour"}', 'medium', true, 60),
('bulk_price_change_detection', 'Más de 15 cambios de precio en 1 hora', 'properties', 'update', NULL,
 '{"metric":"count","operator":">","threshold":15,"window":"1 hour","filter":{"field":"changed_fields","contains":"price_usd"}}',
 'medium', true, 60),
('role_change_detection', 'Cambio de rol de usuario', 'users', 'update_sensitive', NULL,
 '{"metric":"count","operator":">","threshold":0,"window":"1 hour","filter":{"field":"changed_fields","contains":"role"}}',
 'high', true, 0),
('user_deactivation_detection', 'Desactivación de usuarios', 'users', 'update_sensitive', NULL,
 '{"metric":"count","operator":">","threshold":0,"window":"1 hour","filter":{"field":"changed_fields","contains":"is_active"}}',
 'high', true, 0),
('privilege_escalation_attempt', 'Elevación a super_admin', 'users', 'update_sensitive', NULL,
 '{"metric":"count","operator":">","threshold":0,"window":"1 hour","filter":{"field":"changed_fields","contains":"role"}}',
 'critical', true, 0),
('repeated_errors_detection', 'Más de 5 errores del mismo usuario en 15 minutos', NULL, NULL, NULL,
 '{"metric":"count","operator":">","threshold":5,"window":"15 minutes","filter":{"field":"status","equals":"error"}}',
 'medium', true, 30),
('sensitive_config_change', 'Cambio en app_settings (USD, feature flags, integraciones)', 'config', 'update', NULL,
 '{"metric":"count","operator":">","threshold":0,"window":"1 hour","filter":{"field":"table_name","equals":"app_settings"}}',
 'high', true, 60)
ON CONFLICT (name) DO NOTHING;

-- El cron job 'evaluate-supervision-rules' ya existe (migración 003);
-- ahora la función existe y el job deja de fallar.

-- ============================================================
-- 6. VISTAS DE AGREGADO
-- ============================================================

CREATE OR REPLACE VIEW daily_user_activity AS
SELECT
    user_id,
    DATE(created_at) AS activity_date,
    COUNT(*) AS total_events,
    COUNT(*) FILTER (WHERE status = 'success') AS success_events,
    COUNT(*) FILTER (WHERE status = 'error') AS error_events,
    COUNT(*) FILTER (WHERE action = 'export') AS exports,
    COUNT(*) FILTER (WHERE action = 'delete') AS deletions,
    COUNT(*) FILTER (WHERE action IN ('insert', 'update', 'publish')) AS modifications,
    COUNT(DISTINCT module) AS modules_used
FROM audit_log
GROUP BY user_id, DATE(created_at);

CREATE OR REPLACE VIEW daily_module_activity AS
SELECT
    module,
    DATE(created_at) AS activity_date,
    COUNT(*) AS total_events,
    COUNT(DISTINCT user_id) AS active_users,
    COUNT(*) FILTER (WHERE status = 'error') AS errors
FROM audit_log
GROUP BY module, DATE(created_at);

CREATE OR REPLACE VIEW open_alerts_by_user AS
SELECT
    user_id,
    severity,
    COUNT(*) AS count,
    MAX(created_at) AS latest_alert
FROM supervision_alerts
WHERE status = 'open'
GROUP BY user_id, severity;
