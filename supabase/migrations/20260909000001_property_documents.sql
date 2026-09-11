-- ============================================================
-- Documentación de la propiedad (solo panel admin)
-- Checklist fija de 10 tipos: DNI frente/dorso, escritura,
-- rentas provincial, tasa municipal, planos aprobados,
-- facturas luz/gas/agua, expensas.
--
-- CRÍTICO: los documentos NO viven en `properties` porque la
-- policy `properties_public_read` expone la fila completa al
-- público (is_published = true OR auth.uid() IS NOT NULL).
-- Tabla separada con RLS authenticated-only + bucket PRIVADO
-- (el bucket `documents` existente es público en prod).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tabla property_documents
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.property_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES public.properties (id) ON DELETE CASCADE,
  document_key  text NOT NULL,            -- dni_frente | dni_dorso | escritura | rentas_provincial | tasa_municipal | planos_aprobados | factura_luz | factura_gas | factura_agua | expensas
  name          text NOT NULL,            -- nombre original del archivo
  type          text NOT NULL DEFAULT 'application/octet-stream',
  size          bigint NOT NULL DEFAULT 0,
  storage_path  text NOT NULL,            -- path dentro del bucket property-documents
  created_by    uuid,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_documents_key_unique UNIQUE (property_id, document_key)
);

CREATE INDEX IF NOT EXISTS property_documents_property_idx
  ON public.property_documents (property_id);

ALTER TABLE public.property_documents ENABLE ROW LEVEL SECURITY;

-- Solo usuarios autenticados del panel (brokers/agentes/super_admin).
-- El portal propietario opera con rol anon + token, así que no accede.
CREATE POLICY property_documents_admin_all
  ON public.property_documents
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------
-- 2) Bucket PRIVADO property-documents
--    (public: false -> las URLs NO son públicas; se lee vía
--    URLs firmadas creadas por el cliente autenticado)
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-documents',
  'property-documents',
  false,
  10485760, -- 10 MB
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Política de acceso a objetos del bucket (mismo patrón que
-- `documents_auth_all` para el bucket público `documents`).
CREATE POLICY property_documents_auth_all
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (bucket_id = 'property-documents')
  WITH CHECK (bucket_id = 'property-documents');