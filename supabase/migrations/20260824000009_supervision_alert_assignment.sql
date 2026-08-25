-- ============================================================
-- BIENENHAUS - Asignación de alertas + notas de investigación
-- ============================================================

-- 1. Agregar columnas faltantes a supervision_alerts
ALTER TABLE supervision_alerts
    ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
    ADD COLUMN IF NOT EXISTS notes text;

-- 2. Extender status para incluir 'investigando'
ALTER TABLE supervision_alerts
    DROP CONSTRAINT IF EXISTS supervision_alerts_status_check,
    ADD CONSTRAINT supervision_alerts_status_check
        CHECK (status IN ('open', 'assigned', 'investigating', 'acknowledged', 'resolved', 'dismissed'));

-- 3. Índices para consultas de asignación
CREATE INDEX IF NOT EXISTS idx_supervision_alerts_assigned_to
    ON supervision_alerts (assigned_to, status, created_at DESC)
    WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supervision_alerts_assigned_open
    ON supervision_alerts (assigned_to, created_at DESC)
    WHERE status IN ('assigned', 'investigating');

-- 4. Trigger para auto-setear assigned_at al asignar
CREATE OR REPLACE FUNCTION set_assigned_at_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
        IF NEW.assigned_to IS NOT NULL THEN
            NEW.assigned_at := now();
            NEW.assigned_by := auth.uid();
            -- Cambiar status a 'assigned' si estaba 'open'
            IF NEW.status = 'open' THEN
                NEW.status := 'assigned';
            END IF;
        ELSE
            NEW.assigned_at := NULL;
            NEW.assigned_by := NULL;
            -- Volver a 'open' si se desasigna
            IF NEW.status = 'assigned' THEN
                NEW.status := 'open';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_assigned_at_trigger ON supervision_alerts;
CREATE TRIGGER set_assigned_at_trigger
    BEFORE UPDATE ON supervision_alerts
    FOR EACH ROW EXECUTE FUNCTION set_assigned_at_fn();

-- 5. RLS ya cubre todo via "supervision_alerts_super_admin_all"
--    (solo super_admin gestiona alertas, ver migración 008)

-- 6. Comentarios
COMMENT ON COLUMN supervision_alerts.assigned_to IS 'Usuario asignado para investigar la alerta';
COMMENT ON COLUMN supervision_alerts.assigned_by IS 'Super admin que asignó la alerta';
COMMENT ON COLUMN supervision_alerts.assigned_at IS 'Timestamp de la asignación';
COMMENT ON COLUMN supervision_alerts.notes IS 'Notas de investigación / resolución';

-- ============================================================
-- 7. EDGE FUNCTION: supervision-notify (email + webhook)
-- ============================================================
-- Se implementa en supabase/functions/supervision-notify/index.ts
-- Esta migración solo prepara la DB. La function se deploya aparte.

-- ============================================================
-- 8. VISTA: alertas asignadas a usuario (para dashboard personal)
-- ============================================================
CREATE OR REPLACE VIEW my_assigned_alerts AS
SELECT
    a.id,
    a.severity,
    a.alert_type,
    a.title,
    a.description,
    a.module,
    a.evidence,
    a.status,
    a.created_at,
    a.assigned_at,
    a.acknowledged_at,
    a.resolved_at,
    u.email AS assigned_by_email,
    u.full_name AS assigned_by_name
FROM supervision_alerts a
LEFT JOIN profiles u ON a.assigned_by = u.id
WHERE a.assigned_to = auth.uid()
  AND a.status IN ('assigned', 'investigating', 'acknowledged')
ORDER BY a.created_at DESC;