-- ============================================================
-- FIX RLS PROPERTIES - Lectura pública de propiedades publicadas
-- ============================================================
-- El problema: properties_public_read se creó FOR SELECT TO authenticated,
-- por lo que el rol anon (visitante de la landing, anon key) recibe 0 filas.
-- Resultado: el catálogo público mostraba "No se encontraron propiedades"
-- pese a haber 16 propiedades con is_published = true.
-- Fix: usar TO public (anon + authenticated), igual que agents_select
-- y site_content_public_read, que sí funcionan para el visitante.
-- ============================================================

DROP POLICY IF EXISTS properties_public_read ON properties;

CREATE POLICY properties_public_read ON properties
FOR SELECT TO public
USING (
  is_published = true
  OR auth.uid() IS NOT NULL
);