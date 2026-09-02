-- ============================================================
-- 20260903000008_add_properties_is_vendida_reservada.sql
-- ============================================================
-- Add is_vendida and is_reservada boolean flags to properties.
-- These badges are mutually exclusive with is_published
-- (a property cannot be both Publicada and Vendida/Reservada).
-- The compatibility rule is enforced in admin-app.js on save.
-- ============================================================

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS is_vendida boolean NOT NULL DEFAULT false;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS is_reservada boolean NOT NULL DEFAULT false;
