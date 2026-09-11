-- ============================================================
-- Links sociales de la propiedad (opcionales)
-- facebook_url / tiktok_url: URLs públicas para redes sociales.
-- Mismo tratamiento que video_url: las columnas son text nullable
-- y no requieren policy extra porque properties_public_read ya
-- expone la fila completa cuando is_published = true.
-- ============================================================

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS facebook_url text,
  ADD COLUMN IF NOT EXISTS tiktok_url text;

COMMENT ON COLUMN public.properties.facebook_url IS 'URL pública de Facebook de la propiedad (opcional)';
COMMENT ON COLUMN public.properties.tiktok_url IS 'URL pública de TikTok de la propiedad (opcional)';