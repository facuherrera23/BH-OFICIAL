-- ============================================================
-- 20260903000006_add_properties_locality.sql
-- ============================================================
-- Add locality column to properties for separating neighborhood (zone)
-- from city/town (localidad). The admin form had two identical
-- "Zona / Barrio" fields; the second one now maps to locality.
-- ============================================================

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS locality text;
