-- ============================================================
-- Notas internas de la propiedad (solo panel admin)
-- Historial append-only: los brokers/agentes agregan notas,
-- no se editan ni borran desde el panel.
--
-- CRÍTICO: igual que `property_documents`, las notas NO viven en
-- `properties` porque la policy `properties_public_read` expone la
-- fila completa al público (is_published = true OR auth.uid() IS
-- NOT NULL). Tabla separada con RLS authenticated-only.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tabla property_notes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.property_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES public.properties (id) ON DELETE CASCADE,
  note          text NOT NULL CHECK (length(btrim(note)) > 0),
  created_by    uuid,                     -- id del broker/agente (profiles.id)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS property_notes_property_idx
  ON public.property_notes (property_id, created_at DESC);

ALTER TABLE public.property_notes ENABLE ROW LEVEL SECURITY;

-- Solo usuarios autenticados del panel (brokers/agentes/super_admin).
-- El portal propietario opera con rol anon + token, así que no accede.
-- Append-only: SOLO SELECT e INSERT (sin UPDATE/DELETE).
CREATE POLICY property_notes_admin_select
  ON public.property_notes
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY property_notes_admin_insert
  ON public.property_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (true);