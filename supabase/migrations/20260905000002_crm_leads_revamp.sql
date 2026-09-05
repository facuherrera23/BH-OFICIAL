-- CRM Leads revamp — parte 2/2: mapeo de estados viejos, columnas nuevas y
-- tablas lead_activities / lead_tasks / lead_properties.
-- PRECONDICIÓN: 20260905000001 (enum extendido) aplicada y commiteada.

-- 1) Mapeo de estados legacy -> nuevos
UPDATE leads SET stage = 'cerrado_ganado'  WHERE stage = 'cerrado';
UPDATE leads SET stage = 'cerrado_perdido' WHERE stage = 'perdido';
UPDATE leads SET stage = 'visita_agendada' WHERE stage = 'visita';
UPDATE leads SET stage = 'negociacion'     WHERE stage = 'oferta';
-- 'nuevo' y 'contactado' se conservan tal cual.

-- 2) Columnas nuevas en leads (todas NULL-safe, sin defaults destructivos)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tipo_cliente text
  CHECK (tipo_cliente IS NULL OR tipo_cliente IN ('propietario','comprador','inversor'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_score integer
  CHECK (lead_score IS NULL OR (lead_score >= 0 AND lead_score <= 100));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS estimated_value numeric;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_campaign text;

CREATE INDEX IF NOT EXISTS idx_leads_next_followup ON leads (next_followup_at)
  WHERE next_followup_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads (stage);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads (assigned_to);

-- 3) Timeline de actividad por lead
CREATE TABLE IF NOT EXISTS lead_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  activity_type text NOT NULL CHECK (activity_type IN ('call','note','email','visit','followup','status_change','task')),
  title text NOT NULL DEFAULT '',
  description text DEFAULT '',
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities (lead_id, created_at DESC);

-- 4) Tareas por lead
CREATE TABLE IF NOT EXISTS lead_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text DEFAULT '',
  priority text NOT NULL DEFAULT 'media' CHECK (priority IN ('baja','media','alta','urgente')),
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','en_progreso','completada','cancelada')),
  due_at timestamptz,
  assigned_to uuid REFERENCES profiles(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead ON lead_tasks (lead_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_tasks_due ON lead_tasks (due_at) WHERE status IN ('pendiente','en_progreso');

-- 5) Vínculo muchos-a-muchos lead <-> propiedad (el leads.property_id simple queda
--    como "propiedad principal"; esta tabla es la relación completa)
CREATE TABLE IF NOT EXISTS lead_properties (
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, property_id)
);

-- Backfill: el property_id simple pasa a la tabla puente
INSERT INTO lead_properties (lead_id, property_id)
SELECT id, property_id FROM leads WHERE property_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 6) RLS: misma política de visibilidad que leads (super_admin, agente asignado, creador)
ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_activities_select ON lead_activities FOR SELECT USING (
  EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = l.assigned_to AND a.profile_id = auth.uid())
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = l.created_by AND a.profile_id = auth.uid())
  ))
);
CREATE POLICY lead_activities_insert ON lead_activities FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY lead_activities_delete ON lead_activities FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
);

CREATE POLICY lead_tasks_select ON lead_tasks FOR SELECT USING (
  EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_tasks.lead_id AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = l.assigned_to AND a.profile_id = auth.uid())
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = l.created_by AND a.profile_id = auth.uid())
  ))
);
CREATE POLICY lead_tasks_insert ON lead_tasks FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY lead_tasks_update ON lead_tasks FOR UPDATE USING (
  EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_tasks.lead_id AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = l.assigned_to AND a.profile_id = auth.uid())
  ))
);
CREATE POLICY lead_tasks_delete ON lead_tasks FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
);

CREATE POLICY lead_properties_select ON lead_properties FOR SELECT USING (
  EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_properties.lead_id AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = l.assigned_to AND a.profile_id = auth.uid())
    OR EXISTS (SELECT 1 FROM agents a WHERE a.id = l.created_by AND a.profile_id = auth.uid())
  ))
);
CREATE POLICY lead_properties_insert ON lead_properties FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY lead_properties_delete ON lead_properties FOR DELETE USING (auth.uid() IS NOT NULL);

-- 7) Grants: nada adicional a PUBLIC; el panel entra autenticado
REVOKE ALL ON lead_activities FROM PUBLIC, anon;
REVOKE ALL ON lead_tasks FROM PUBLIC, anon;
REVOKE ALL ON lead_properties FROM PUBLIC, anon;
GRANT SELECT, INSERT, DELETE ON lead_activities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_tasks TO authenticated;
GRANT SELECT, INSERT, DELETE ON lead_properties TO authenticated;
