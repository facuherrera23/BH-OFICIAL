-- P1.1 (auditoría): re-encuesta para una segunda visita del mismo lead+propiedad.
-- La encuesta respondida se ARCHIVA (se conserva la opinión para el portal del dueño)
-- y el agente puede generar un token nuevo desde el panel.
-- Aplicada a producción como survey_archive_and_reset.

ALTER TABLE public.visit_surveys ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- El unique pasa a ser parcial: solo una encuesta ACTIVA por (lead, propiedad).
DROP INDEX IF EXISTS public.visit_surveys_lead_property_uq;
CREATE UNIQUE INDEX visit_surveys_lead_property_active_uq
  ON public.visit_surveys (lead_id, property_id)
  WHERE archived_at IS NULL;

-- El equipo puede archivar (update restringido al mismo criterio que insert).
CREATE POLICY visit_surveys_update ON public.visit_surveys
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid() AND p.role = 'super_admin'::user_role)
    OR EXISTS (SELECT 1 FROM public.leads l
                JOIN public.agents a ON a.profile_id = auth.uid()
               WHERE l.id = visit_surveys.lead_id
                 AND (l.assigned_to = a.id OR l.created_by = a.id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p
             WHERE p.id = auth.uid() AND p.role = 'super_admin'::user_role)
    OR EXISTS (SELECT 1 FROM public.leads l
                JOIN public.agents a ON a.profile_id = auth.uid()
               WHERE l.id = visit_surveys.lead_id
                 AND (l.assigned_to = a.id OR l.created_by = a.id))
  );
