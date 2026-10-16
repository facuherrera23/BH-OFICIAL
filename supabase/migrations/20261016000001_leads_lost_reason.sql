-- Razón de pérdida estructurada para leads (mejora crítica #3 de la auditoría).
-- Problema: 36 leads en 'cerrado_perdido' sin UN registro de por qué se perdieron.
-- Sin esto el dueño no puede saber si el problema es precio, ubicación, competencia
-- o si los agentes simplemente no están siguiendo los leads.
--
-- El frontend presenta opciones predefinidas (Presupuesto, Ubicación, Encontró otra,
-- No responde, Financiamiento, Otro) y guarda la selección en esta columna.
-- Al recuperar un lead (cambiar stage fuera de cerrado_perdido), el frontend
-- limpia el lost_reason.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS lost_reason text;

-- Comentario documental
COMMENT ON COLUMN public.leads.lost_reason IS 'Razón estructurada de pérdida: presupuesto|ubicacion|encontro_otra|no_responde|financiamiento|otro. Se limpia al recuperar el lead.';
