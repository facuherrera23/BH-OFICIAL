-- Publicación realtime del CRM (drift de la auditoría 2026-10-15): las 4 tablas
-- del fix realtime del 2026-10-14 (commit 7ecc2aa) se agregaron directo a
-- supabase_realtime via MCP sin migración versionada — un rebuild desde cero
-- habría quedado sin estos eventos y el CRM no refrescaría en vivo
-- (lead_properties/lead_tasks/lead_activities/owner_tasks + debounce del panel).
-- Idempotente: en producción ya están (no-op); en un rebuild las agrega.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'lead_properties'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE lead_properties;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'lead_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE lead_tasks;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'lead_activities'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE lead_activities;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'owner_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE owner_tasks;
  END IF;
END $$;
