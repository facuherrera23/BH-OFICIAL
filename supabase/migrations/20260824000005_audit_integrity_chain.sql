-- ============================================================
-- BIENENHAUS - Integrity Chain para Audit Log
-- Cadena de integridad: previous_hash / event_hash
-- ============================================================

-- Crear audit_log si no existe (debería existir desde migración 0001)
CREATE TABLE IF NOT EXISTS audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    role_snapshot text,
    broker_id uuid REFERENCES agents(id) ON DELETE SET NULL,
    action text NOT NULL,
    module text NOT NULL,
    table_name text,
    record_id uuid,
    entity_type text,
    entity_id uuid,
    entity_label text,
    old_data jsonb,
    new_data jsonb,
    changed_fields text[],
    metadata jsonb DEFAULT '{}',
    status text DEFAULT 'success',
    error_code text,
    ip inet,
    user_agent text,
    session_id uuid,
    request_id uuid DEFAULT gen_random_uuid(),
    created_at timestamptz DEFAULT now(),
    event_hash text,
    previous_hash text
);

-- RLS para audit_log (si se crea aquí)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_log_super_admin_select" ON audit_log;
CREATE POLICY "audit_log_super_admin_select" ON audit_log
    FOR SELECT USING (is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "audit_log_system_insert" ON audit_log;
CREATE POLICY "audit_log_system_insert" ON audit_log
    FOR INSERT WITH CHECK (false); -- Solo triggers/funciones SECURITY DEFINER

DROP POLICY IF EXISTS "audit_log_no_update" ON audit_log;
CREATE POLICY "audit_log_no_update" ON audit_log
    FOR UPDATE USING (false);

DROP POLICY IF EXISTS "audit_log_no_delete" ON audit_log;
CREATE POLICY "audit_log_no_delete" ON audit_log
    FOR DELETE USING (false);

-- Índices para verificación de cadena
CREATE INDEX IF NOT EXISTS idx_audit_log_event_hash ON audit_log (event_hash);
CREATE INDEX IF NOT EXISTS idx_audit_log_previous_hash ON audit_log (previous_hash);

-- Función para calcular hash de un evento
CREATE OR REPLACE FUNCTION calculate_event_hash(
    p_id uuid,
    p_user_id uuid,
    p_action text,
    p_module text,
    p_entity_type text,
    p_entity_id uuid,
    p_old_data jsonb,
    p_new_data jsonb,
    p_previous_hash text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_input text;
    v_hash text;
BEGIN
    -- Construir string determinístico para hashear
    v_input := p_id::text || '|' || 
               COALESCE(p_user_id::text, 'null') || '|' || 
               p_action || '|' || 
               p_module || '|' || 
               COALESCE(p_entity_type, 'null') || '|' || 
               COALESCE(p_entity_id::text, 'null') || '|' || 
               COALESCE(p_old_data::text, 'null') || '|' || 
               COALESCE(p_new_data::text, 'null') || '|' || 
               COALESCE(p_previous_hash, 'genesis');
    
    -- SHA-256 via pgcrypto
    v_hash := encode(digest(v_input, 'sha256'), 'hex');
    
    RETURN v_hash;
END;
$$;

-- Función para actualizar hash de un evento existente
CREATE OR REPLACE FUNCTION update_audit_log_hash(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_row audit_log%ROWTYPE;
    v_previous_hash text;
    v_event_hash text;
BEGIN
    SELECT * INTO v_row FROM audit_log WHERE id = p_id;
    
    -- Obtener previous_hash del evento anterior del mismo usuario
    SELECT event_hash INTO v_previous_hash
    FROM audit_log
    WHERE user_id = v_row.user_id
      AND created_at < v_row.created_at
      AND id != p_id
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Calcular hash
    v_event_hash := calculate_event_hash(
        v_row.id,
        v_row.user_id,
        v_row.action,
        v_row.module,
        v_row.entity_type,
        v_row.entity_id,
        v_row.old_data,
        v_row.new_data,
        v_previous_hash
    );
    
    -- Actualizar
    UPDATE audit_log
    SET event_hash = v_event_hash,
        previous_hash = v_previous_hash
    WHERE id = p_id;
END;
$$;

-- Trigger para calcular hash automáticamente en INSERT
CREATE OR REPLACE FUNCTION audit_log_integrity_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_previous_hash text;
    v_event_hash text;
BEGIN
    -- Obtener hash del evento anterior del mismo usuario
    SELECT event_hash INTO v_previous_hash
    FROM audit_log
    WHERE user_id = NEW.user_id
      AND created_at < NEW.created_at
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Calcular hash del nuevo evento
    v_event_hash := calculate_event_hash(
        NEW.id,
        NEW.user_id,
        NEW.action,
        NEW.module,
        NEW.entity_type,
        NEW.entity_id,
        NEW.old_data,
        NEW.new_data,
        v_previous_hash
    );
    
    NEW.event_hash := v_event_hash;
    NEW.previous_hash := v_previous_hash;
    
    RETURN NEW;
END;
$$;

-- Aplicar trigger
DROP TRIGGER IF EXISTS audit_log_integrity ON audit_log;
CREATE TRIGGER audit_log_integrity
BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_integrity_fn();

-- Backfill hashes para eventos existentes (ejecutar una vez)
CREATE OR REPLACE FUNCTION backfill_audit_log_hashes()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_row audit_log%ROWTYPE;
    v_count integer := 0;
BEGIN
    FOR v_row IN 
        SELECT * FROM audit_log 
        WHERE event_hash IS NULL
        ORDER BY user_id, created_at
    LOOP
        PERFORM update_audit_log_hash(v_row.id);
        v_count := v_count + 1;
    END LOOP;
    
    RAISE NOTICE 'Backfilled % audit log hashes', v_count;
END;
$$;

-- Función para verificar integridad de la cadena
CREATE OR REPLACE FUNCTION verify_audit_log_integrity(
    p_user_id uuid DEFAULT NULL,
    p_start_date timestamptz DEFAULT NULL,
    p_end_date timestamptz DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    user_id uuid,
    expected_hash text,
    actual_hash text,
    matches boolean,
    broken_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_row RECORD;
    v_expected_hash text;
    v_previous_hash text;
BEGIN
    FOR v_row IN 
        SELECT * FROM audit_log
        WHERE (p_user_id IS NULL OR user_id = p_user_id)
          AND (p_start_date IS NULL OR created_at >= p_start_date)
          AND (p_end_date IS NULL OR created_at <= p_end_date)
        ORDER BY user_id, created_at
    LOOP
        -- Calcular hash esperado
        SELECT event_hash INTO v_previous_hash
        FROM audit_log
        WHERE user_id = v_row.user_id
          AND created_at < v_row.created_at
        ORDER BY created_at DESC
        LIMIT 1;
        
        v_expected_hash := calculate_event_hash(
            v_row.id,
            v_row.user_id,
            v_row.action,
            v_row.module,
            v_row.entity_type,
            v_row.entity_id,
            v_row.old_data,
            v_row.new_data,
            v_previous_hash
        );
        
        IF v_row.event_hash IS NULL OR v_row.event_hash != v_expected_hash THEN
            RETURN QUERY SELECT v_row.id, v_row.user_id, v_expected_hash, v_row.event_hash, false, v_row.created_at;
        ELSE
            RETURN QUERY SELECT v_row.id, v_row.user_id, v_expected_hash, v_row.event_hash, true, v_row.created_at;
        END IF;
    END LOOP;
END;
$$;

-- Comentarios
COMMENT ON COLUMN audit_log.event_hash IS 'SHA-256 hash del evento para integridad. Calculado automáticamente.';
COMMENT ON COLUMN audit_log.previous_hash IS 'Hash del evento anterior del mismo usuario. Forma cadena de integridad.';
COMMENT ON FUNCTION calculate_event_hash IS 'Calcula SHA-256 determinístico de un evento de auditoría.';
COMMENT ON FUNCTION verify_audit_log_integrity IS 'Verifica integridad de la cadena de auditoría. Retorna filas con mismatch.';
COMMENT ON FUNCTION backfill_audit_log_hashes IS 'Calcula hashes para eventos existentes sin hash. Ejecutar una vez tras migración.';

-- Índices para verificación
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created_hash ON audit_log (user_id, created_at, event_hash);