-- ============================================================
-- BIENENHAUS - API Key Audit + Session Tracking
-- ============================================================

-- ============================================================
-- 1. Tabla para audit de acceso a API Keys / Secrets
-- ============================================================
CREATE TABLE IF NOT EXISTS api_key_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key_name text NOT NULL,                    -- ej: 'BREVO_API_KEY', 'ML_CLIENT_SECRET', 'ZERNIO_API_KEY'
    key_type text NOT NULL,                    -- 'api_key', 'secret', 'token', 'webhook_secret'
    accessed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    accessed_by_role text,
    access_type text NOT NULL,                 -- 'read', 'write', 'rotate', 'delete'
    access_context text,                       -- 'edge_function', 'dashboard', 'api', 'migration'
    source_ip inet,
    user_agent text,
    request_id uuid,
    metadata jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_key_name ON api_key_audit (key_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_user ON api_key_audit (accessed_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_type ON api_key_audit (access_type, created_at DESC);

-- ============================================================
-- 2. Función para loggear acceso a API Keys (llamada desde Edge Functions)
-- ============================================================
CREATE OR REPLACE FUNCTION log_api_key_access(
    p_key_name text,
    p_key_type text,
    p_access_type text,
    p_access_context text DEFAULT 'edge_function',
    p_metadata jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO api_key_audit (
        key_name,
        key_type,
        accessed_by,
        accessed_by_role,
        access_type,
        access_context,
        source_ip,
        user_agent,
        request_id,
        metadata
    ) VALUES (
        p_key_name,
        p_key_type,
        auth.uid(),
        (SELECT role FROM profiles WHERE id = auth.uid()),
        p_access_type,
        p_access_context,
        (current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for')::inet,
        current_setting('request.headers', true)::jsonb ->> 'user-agent',
        current_setting('request.headers', true)::jsonb ->> 'x-request-id',
        p_metadata
    );
END;
$$;

REVOKE ALL ON FUNCTION log_api_key_access(text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_api_key_access(text, text, text, text, jsonb) TO service_role;

-- ============================================================
-- 3. Tabla de sesiones de usuario (login/logout tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,                    -- auth.session_id
    login_at timestamptz NOT NULL DEFAULT now(),
    logout_at timestamptz,
    login_ip inet,
    login_user_agent text,
    login_method text DEFAULT 'password',        -- 'password', 'magic_link', 'oauth', 'sso'
    logout_reason text,                          -- 'manual', 'timeout', 'revoked', 'concurrent'
    device_fingerprint text,
    location_country text,
    location_city text,
    is_active boolean GENERATED ALWAYS AS (logout_at IS NULL) STORED,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id, login_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON user_sessions (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_user_sessions_session_id ON user_sessions (session_id);

-- ============================================================
-- 4. Función para crear sesión al login
-- ============================================================
CREATE OR REPLACE FUNCTION create_user_session(
    p_session_id uuid,
    p_login_method text DEFAULT 'password',
    p_device_fingerprint text DEFAULT NULL,
    p_location_country text DEFAULT NULL,
    p_location_city text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO user_sessions (
        user_id,
        session_id,
        login_ip,
        login_user_agent,
        login_method,
        device_fingerprint,
        location_country,
        location_city
    ) VALUES (
        auth.uid(),
        p_session_id,
        (current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for')::inet,
        current_setting('request.headers', true)::jsonb ->> 'user-agent',
        p_login_method,
        p_device_fingerprint,
        p_location_country,
        p_location_city
    );
END;
$$;

REVOKE ALL ON FUNCTION create_user_session(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_user_session(uuid, text, text, text, text) TO service_role;

-- ============================================================
-- 5. Función para cerrar sesión
-- ============================================================
CREATE OR REPLACE FUNCTION close_user_session(
    p_session_id uuid,
    p_logout_reason text DEFAULT 'manual'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE user_sessions
    SET logout_at = now(),
        logout_reason = p_logout_reason,
        updated_at = now()
    WHERE session_id = p_session_id
      AND user_id = auth.uid()
      AND logout_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION close_user_session(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_user_session(uuid, text) TO service_role;

-- ============================================================
-- 6. Trigger en auth: auto-crear sesión al login (usando auth hook)
-- NOTA: Supabase Auth hooks requieren configuración en Dashboard
-- Esta función se llama desde Edge Function manage-users o similar
-- ============================================================

-- ============================================================
-- 7. RLS para tablas nuevas
-- ============================================================
ALTER TABLE api_key_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;

-- api_key_audit: solo super_admin
DROP POLICY IF EXISTS "api_key_audit_super_admin" ON api_key_audit;
CREATE POLICY "api_key_audit_super_admin" ON api_key_audit
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- user_sessions: usuario ve sus sesiones, super_admin ve todas
DROP POLICY IF EXISTS "user_sessions_own" ON user_sessions;
CREATE POLICY "user_sessions_own" ON user_sessions
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_sessions_super_admin" ON user_sessions;
CREATE POLICY "user_sessions_super_admin" ON user_sessions
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================================
-- 8. Función helper para loggear acceso a secretos desde Edge Functions
-- ============================================================
-- Uso desde Edge Function:
-- SELECT log_api_key_access('BREVO_API_KEY', 'api_key', 'read', 'edge_function', '{"purpose": "send_email"}');