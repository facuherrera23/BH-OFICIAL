-- ============================================================
-- BIENENHAUS - Preferencias de Notificación
-- Tabla para configurar cómo reciben alertas los super_admin
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email boolean DEFAULT true,
    push boolean DEFAULT true,
    slack boolean DEFAULT false,
    critical_only boolean DEFAULT false,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (user_id)
);

-- RLS
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notification_prefs_user_select" ON notification_preferences;
CREATE POLICY "notification_prefs_user_select" ON notification_preferences
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "notification_prefs_user_modify" ON notification_preferences;
CREATE POLICY "notification_prefs_user_modify" ON notification_preferences
    FOR ALL USING (auth.uid() = user_id);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION update_notification_prefs_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notification_prefs_updated_at ON notification_preferences;
CREATE TRIGGER notification_prefs_updated_at
BEFORE UPDATE ON notification_preferences
FOR EACH ROW EXECUTE FUNCTION update_notification_prefs_updated_at();

COMMENT ON TABLE notification_preferences IS 'Preferencias de notificación por usuario (email, push, slack). Solo super_admin usa esto.';