-- P1-1: Unificar modelo IDs — properties.agent_id y leads.assigned_to → agents.id
-- Versión completa con manejo de dependencias (owners_select policy)

-- ============================================
-- 0. DROP POLICIES DEPENDIENTES
-- ============================================

DROP POLICY IF EXISTS owners_select ON owners;
DROP POLICY IF EXISTS properties_admin_update ON properties;
DROP POLICY IF EXISTS properties_admin_insert ON properties;
DROP POLICY IF EXISTS properties_admin_delete ON properties;
DROP POLICY IF EXISTS properties_public_read ON properties;
DROP POLICY IF EXISTS leads_select ON leads;
DROP POLICY IF EXISTS leads_update ON leads;
DROP POLICY IF EXISTS leads_insert ON leads;
DROP POLICY IF EXISTS leads_delete ON leads;

-- ============================================
-- 1. DATA MIGRATION: properties.agent_id (profile_id → agent_id)
-- ============================================

ALTER TABLE properties ADD COLUMN IF NOT EXISTS agent_id_new uuid REFERENCES agents(id);

UPDATE properties p
SET agent_id_new = a.id
FROM agents a
WHERE a.profile_id = p.agent_id;

-- ============================================
-- 2. DATA MIGRATION: leads.assigned_to (profile_id → agent_id)
-- ============================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_agent_id uuid REFERENCES agents(id);

UPDATE leads l
SET assigned_agent_id = a.id
FROM agents a
WHERE a.profile_id = l.assigned_to;

-- ============================================
-- 3. RECREAR FKS Y LIMPIAR COLUMNAS ANTIGUAS
-- ============================================

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_agent_id_fkey;
ALTER TABLE properties DROP COLUMN IF EXISTS agent_id;
ALTER TABLE properties RENAME COLUMN agent_id_new TO agent_id;

ALTER TABLE properties ADD CONSTRAINT properties_agent_id_fkey
FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_assigned_to_fkey;
ALTER TABLE leads DROP COLUMN IF EXISTS assigned_to;
ALTER TABLE leads RENAME COLUMN assigned_agent_id TO assigned_to;

ALTER TABLE leads ADD CONSTRAINT leads_assigned_to_fkey
FOREIGN KEY (assigned_to) REFERENCES agents(id) ON DELETE SET NULL;

-- ============================================
-- 4. ACTUALIZAR RLS PROPERTIES (agent_id ahora → agents.id)
-- ============================================

CREATE POLICY properties_admin_insert ON properties
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.profile_id = auth.uid()
  )
);

CREATE POLICY properties_admin_update ON properties
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = properties.agent_id
      AND a.profile_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = properties.agent_id
      AND a.profile_id = auth.uid()
  )
);

CREATE POLICY properties_admin_delete ON properties
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
);

CREATE POLICY properties_public_read ON properties
FOR SELECT TO authenticated
USING (
  is_published = true
  OR auth.uid() IS NOT NULL
);

-- ============================================
-- 5. LEADS RLS (assigned_to ahora → agents.id)
-- ============================================

CREATE POLICY leads_select ON leads
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = leads.assigned_to
      AND a.profile_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = leads.created_by
      AND a.profile_id = auth.uid()
  )
);

CREATE POLICY leads_update ON leads
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = leads.assigned_to
      AND a.profile_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = leads.created_by
      AND a.profile_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = leads.assigned_to
      AND a.profile_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = leads.created_by
      AND a.profile_id = auth.uid()
  )
);

CREATE POLICY leads_insert ON leads
FOR INSERT TO authenticated
WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY leads_delete ON leads
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
);

-- ============================================
-- 6. RECREAR OWNERS_SELECT CON NUEVA LÓGICA
-- ============================================

CREATE POLICY owners_select ON owners
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR EXISTS (
    SELECT 1 FROM properties pr
    JOIN agents a ON a.id = pr.agent_id
    WHERE pr.owner_id = owners.id
      AND (a.profile_id = auth.uid() OR pr.created_by = auth.uid())
  )
);

-- ============================================
-- 7. REINDEX
-- ============================================

REINDEX TABLE properties;
REINDEX TABLE leads;