-- ============================================================
-- 20260827_zernio_chat_completo.sql
-- Módulo Chat Zernio 100% funcional — schema versionado + fixes.
--
-- Espejo del schema live (2026-08-27) + correcciones:
--   1. zernio_conversations.platform  (columna faltante: rompía send_message)
--   2. UNIQUE (platform_message_id, conversation_id)  (rompía backfill_messages)
--   3. FK conversations.account_id -> accounts, messages.conversation_id -> conversations
--      (PostgREST no puede hacer embed `account:zernio_accounts(...)` sin FK real)
--   4. RLS zernio_config: policies para api_key (UI Config), webhook_secret queda
--      accesible SOLO via service_role (seguridad).
--   5. Idempotente: aplica en entorno limpio y sobre live.
-- ============================================================

-- ---------- 1. zernio_config ----------
CREATE TABLE IF NOT EXISTS zernio_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- 2. zernio_accounts ----------
CREATE TABLE IF NOT EXISTS zernio_accounts (
  zernio_account_id text PRIMARY KEY,
  platform           text NOT NULL,
  username           text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'connected',
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at     timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------- 3. zernio_conversations ----------
CREATE TABLE IF NOT EXISTS zernio_conversations (
  id                   text PRIMARY KEY,
  account_id           text NOT NULL,
  contact_name         text NOT NULL DEFAULT '',
  contact_handle       text NOT NULL DEFAULT '',
  platform             text NOT NULL DEFAULT '',
  last_message_at      timestamptz,
  last_message_preview text NOT NULL DEFAULT '',
  unread_count         integer NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'open',
  raw                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Fix 1: columna platform (falta en live)
ALTER TABLE zernio_conversations ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT '';

-- ---------- 4. zernio_messages ----------
CREATE TABLE IF NOT EXISTS zernio_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     text NOT NULL,
  direction           text NOT NULL,
  platform_message_id text,
  body                text NOT NULL DEFAULT '',
  attachment          jsonb,
  status              text NOT NULL DEFAULT 'received',
  error               jsonb,
  sent_by             uuid,
  zernio_event_id     text,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------- 5. zernio_webhook_events (dedup) ----------
CREATE TABLE IF NOT EXISTS zernio_webhook_events (
  id          text PRIMARY KEY,
  event       text NOT NULL DEFAULT '',
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Índices (espejo live) ----------
CREATE INDEX IF NOT EXISTS idx_zernio_conv_order   ON zernio_conversations (status, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_zernio_conv_account ON zernio_conversations (account_id);
CREATE INDEX IF NOT EXISTS idx_zernio_msg_conv_time ON zernio_messages (conversation_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_zernio_msg_platform_id ON zernio_messages (platform_message_id) WHERE platform_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS zernio_messages_zernio_event_id_key ON zernio_messages (zernio_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS zernio_messages_platform_message_id_key ON zernio_messages (platform_message_id) WHERE platform_message_id IS NOT NULL;

-- Fix 2: UNIQUE compuesto para el upsert onConflict de backfill_messages.
-- NO parcial: Postgres no infiere índices parciales sin predicado en ON CONFLICT,
-- y PostgREST no lo agrega. Con platform_message_id NULL nunca hay colisión
-- (los NULLs son distintos en índices únicos), así que es seguro.
CREATE UNIQUE INDEX IF NOT EXISTS zernio_messages_platform_conv_key
  ON zernio_messages (platform_message_id, conversation_id);

-- ---------- FKs (Fix 3: required para embed PostgREST) ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zernio_conversations_account_id_fkey') THEN
    ALTER TABLE zernio_conversations
      ADD CONSTRAINT zernio_conversations_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES zernio_accounts(zernio_account_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zernio_messages_conversation_id_fkey') THEN
    ALTER TABLE zernio_messages
      ADD CONSTRAINT zernio_messages_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES zernio_conversations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ---------- RLS ----------
ALTER TABLE zernio_config        ENABLE ROW LEVEL SECURITY;
ALTER TABLE zernio_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE zernio_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE zernio_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE zernio_webhook_events ENABLE ROW LEVEL SECURITY;

-- Policies: drop + create idempotente

-- zernio_accounts: SELECT authenticated (espejo live)
DROP POLICY IF EXISTS zernio_accounts_select ON zernio_accounts;
CREATE POLICY zernio_accounts_select ON zernio_accounts
  FOR SELECT TO authenticated USING (true);

-- zernio_conversations: SELECT + UPDATE authenticated (espejo live + with check)
DROP POLICY IF EXISTS zernio_conv_select ON zernio_conversations;
CREATE POLICY zernio_conv_select ON zernio_conversations
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS zernio_conv_update ON zernio_conversations;
CREATE POLICY zernio_conv_update ON zernio_conversations
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- zernio_messages: SELECT authenticated (espejo live). Escritura solo service_role
-- (edge functions). El INSERT de mensajes salientes lo hace el proxy con service_role.
DROP POLICY IF EXISTS zernio_messages_select ON zernio_messages;
CREATE POLICY zernio_messages_select ON zernio_messages
  FOR SELECT TO authenticated USING (true);

-- Fix 4: zernio_config — la UI Config (solo super_admin) lee/guarda la API key.
-- webhook_secret queda exclusivo de service_role (webhook edge function).
-- Restringida a super_admin: la API key es un secreto (patrón settings_admin_write).
DROP POLICY IF EXISTS zernio_config_api_key_select ON zernio_config;
CREATE POLICY zernio_config_api_key_select ON zernio_config
  FOR SELECT TO authenticated USING (
    key = 'api_key'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  );
DROP POLICY IF EXISTS zernio_config_api_key_write ON zernio_config;
CREATE POLICY zernio_config_api_key_write ON zernio_config
  FOR INSERT TO authenticated WITH CHECK (
    key = 'api_key'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  );
DROP POLICY IF EXISTS zernio_config_api_key_update ON zernio_config;
CREATE POLICY zernio_config_api_key_update ON zernio_config
  FOR UPDATE TO authenticated USING (
    key = 'api_key'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  ) WITH CHECK (
    key = 'api_key'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  );

-- zernio_webhook_events: sin policies (solo service_role, dedup interno)