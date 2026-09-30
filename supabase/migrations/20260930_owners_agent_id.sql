-- owners.agent_id: agente a cargo del propietario aunque no tenga propiedad cargada.
-- Aplicada a producción vía MCP el 2026-09-30; este archivo versiona el cambio.

ALTER TABLE public.owners
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_owners_agent_id ON public.owners(agent_id);

COMMENT ON COLUMN public.owners.agent_id IS 'Agente a cargo del propietario (independiente de properties.agent_id)';

-- La visibilidad por RLS se extiende: un broker ve al propietario si está
-- asignado a alguna de sus propiedades O si es su agente a cargo directo.
DROP POLICY IF EXISTS owners_select ON public.owners;
CREATE POLICY owners_select ON public.owners
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid()
          AND p.role = 'super_admin'::public.user_role
          AND p.is_active IS NOT FALSE
      )
      OR EXISTS (
        SELECT 1 FROM public.properties pr
        JOIN public.agents a ON a.id = pr.agent_id
        WHERE pr.owner_id = owners.id
          AND pr.deleted_at IS NULL
          AND a.profile_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.agents a
        WHERE a.id = owners.agent_id
          AND a.profile_id = auth.uid()
      )
    )
  );
