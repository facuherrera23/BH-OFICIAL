-- Fix RLS policies for visits table
-- Current policies use `agent_id = auth.uid()` but visits.agent_id references agents.id (not profiles.id)
-- Need to join agents table to match agents.profile_id = auth.uid()

-- Drop existing policies
DROP POLICY IF EXISTS visits_select ON visits;
DROP POLICY IF EXISTS visits_update ON visits;
DROP POLICY IF EXISTS visits_insert ON visits;
DROP POLICY IF EXISTS visits_delete ON visits;

-- Create fixed policies
-- SELECT: super_admin OR created_by = auth.uid() OR visit's agent profile matches auth.uid()
CREATE POLICY visits_select ON visits
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR created_by = auth.uid()
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = visits.agent_id
      AND a.profile_id = auth.uid()
  )
);

-- UPDATE: same logic
CREATE POLICY visits_update ON visits
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR created_by = auth.uid()
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = visits.agent_id
      AND a.profile_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
  OR created_by = auth.uid()
  OR EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = visits.agent_id
      AND a.profile_id = auth.uid()
  )
);

-- INSERT: any authenticated user can create visits
CREATE POLICY visits_insert ON visits
FOR INSERT TO authenticated
WITH CHECK (auth.uid() IS NOT NULL);

-- DELETE: only super_admin
CREATE POLICY visits_delete ON visits
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin'
  )
);