-- Chat Zernio nunca emitía eventos Realtime: las tablas no estaban en la
-- publicación supabase_realtime, aunque el panel se suscribe a postgres_changes.
-- Sin este ALTER, los mensajes nuevos no aparecen en la UI hasta un reload manual.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'zernio_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE zernio_conversations;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'zernio_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE zernio_messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'zernio_accounts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE zernio_accounts;
  END IF;
END $$;
