-- P0-2: Chat Zernio access para brokers
-- 1. Agregar broker_id a zernio_conversations y zernio_messages
-- 2. RLS restrictivo por broker (via agents.profile_id)
-- 3. UI guard: permitir role 'broker' además de 'super_admin'

-- ============================================
-- 1. COLUMNAS broker_id
-- ============================================

ALTER TABLE zernio_conversations
ADD COLUMN IF NOT EXISTS broker_id uuid REFERENCES agents(id);

ALTER TABLE zernio_messages
ADD COLUMN IF NOT EXISTS broker_id uuid REFERENCES agents(id);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_zernio_conversations_broker_id ON zernio_conversations(broker_id);
CREATE INDEX IF NOT EXISTS idx_zernio_messages_broker_id ON zernio_messages(broker_id);

-- ============================================
-- 2. RLS RESTRINGIDO POR BROKER
-- ============================================

-- Drop policies actuales (muy permisivas)
DROP POLICY IF EXISTS zernio_conv_select ON zernio_conversations;
DROP POLICY IF EXISTS zernio_conv_update ON zernio_conversations;
DROP POLICY IF EXISTS zernio_messages_select ON zernio_messages;

-- zernio_conversations: super_admin ve todo, broker ve solo sus asignadas
CREATE POLICY zernio_conv_select ON zernio_conversations
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = zernio_conversations.broker_id
      AND a.profile_id = auth.uid()
  )
);

CREATE POLICY zernio_conv_update ON zernio_conversations
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = zernio_conversations.broker_id
      AND a.profile_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = zernio_conversations.broker_id
      AND a.profile_id = auth.uid()
  )
);

-- zernio_messages: mismo patrón
CREATE POLICY zernio_messages_select ON zernio_messages
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = zernio_messages.broker_id
      AND a.profile_id = auth.uid()
  )
);

-- ============================================
-- 3. TRIGGER PARA AUTO-ASIGNAR broker_id EN CONVERSACIONES NUEVAS
--    (Opcional: se puede hacer en webhook, pero trigger es safety net)
-- ============================================

-- Función para inferir broker_id desde property_id o lead_id de la conversación
CREATE OR REPLACE FUNCTION zernio_set_broker_id()
RETURNS trigger AS $$
BEGIN
  -- Si ya tiene broker_id, no tocar
  IF NEW.broker_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Intentar vía property_id (si la conversación tiene propiedad vinculada)
  IF NEW.property_id IS NOT NULL THEN
    SELECT p.agent_id INTO NEW.broker_id
    FROM properties p
    WHERE p.id = NEW.property_id
      AND p.agent_id IS NOT NULL
    LIMIT 1;
  END IF;

  -- Fallback: vía lead_id
  IF NEW.broker_id IS NULL AND NEW.lead_id IS NOT NULL THEN
    SELECT l.broker_id INTO NEW.broker_id
    FROM leads l
    WHERE l.id = NEW.lead_id
      AND l.broker_id IS NOT NULL
    LIMIT 1;
  END IF;

  -- Fallback: vía account → propiedad más reciente del account
  IF NEW.broker_id IS NULL AND NEW.account_id IS NOT NULL THEN
    SELECT a.id INTO NEW.broker_id
    FROM agents a
    JOIN zernio_accounts za ON za.id = NEW.account_id
    JOIN properties p ON p.broker_id = a.id
    WHERE a.status = 'activo'
    ORDER BY p.created_at DESC
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger en INSERT
DROP TRIGGER IF EXISTS trg_zernio_conversations_broker ON zernio_conversations;
CREATE TRIGGER trg_zernio_conversations_broker
BEFORE INSERT ON zernio_conversations
FOR EACH ROW EXECUTE FUNCTION zernio_set_broker_id();

-- Trigger en zernio_messages: heredar broker_id de la conversación
CREATE OR REPLACE FUNCTION zernio_messages_set_broker_id()
RETURNS trigger AS $$
BEGIN
  IF NEW.broker_id IS NULL AND NEW.conversation_id IS NOT NULL THEN
    SELECT c.broker_id INTO NEW.broker_id
    FROM zernio_conversations c
    WHERE c.id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_zernio_messages_broker ON zernio_messages;
CREATE TRIGGER trg_zernio_messages_broker
BEFORE INSERT ON zernio_messages
FOR EACH ROW EXECUTE FUNCTION zernio_messages_set_broker_id();