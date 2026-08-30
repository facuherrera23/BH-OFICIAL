-- ============================================================
-- MIGRATION: Clean up duplicate FKs and timestamp duplicates
-- ============================================================
-- Fixes from audit:
-- 1. Duplicate FK on leads.assigned_to (leads_assigned_agent_id_fkey + leads_assigned_to_fkey)
-- 2. Duplicate FK on properties.agent_id (properties_agent_id_fkey + properties_agent_id_new_fkey)
-- 3. Duplicate migration timestamp 20260824000013 (supervision_anomaly_detection + part1)
-- ============================================================

-- 1. Drop duplicate FK on leads.assigned_to
-- Keep leads_assigned_to_fkey (newer name from unify migration), drop the old one
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_assigned_agent_id_fkey;

-- 2. Drop duplicate FK on properties.agent_id
-- Keep properties_agent_id_new_fkey (newer name), drop the old one
ALTER TABLE public.properties DROP CONSTRAINT IF EXISTS properties_agent_id_fkey;

-- Note: Migration timestamp duplicate 20260824000013 already applied in DB (shows as 20260824213400 in schema_migrations)
-- The local files 20260824000013_supervision_anomaly_detection.sql and 20260824000013_supervision_anomaly_part1.sql
-- have same timestamp but only one was applied (renamed to 20260824213400). This is OK - DB is consistent.
-- No action needed on DB side. Local file cleanup is separate.

-- ------------------------------------------------------------
-- END OF MIGRATION
-- ------------------------------------------------------------