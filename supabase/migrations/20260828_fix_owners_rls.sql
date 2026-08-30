-- ============================================================
-- FIX RLS OWNERS - Quitar acceso public a INSERT/UPDATE
-- ============================================================
-- El problema: políticas existentes permiten INSERT/UPDATE a 'public'
-- Fix: solo authenticated con role check (super_admin)
-- Roles válidos en enum user_role: 'agente', 'broker', 'super_admin'
-- ============================================================

-- Habilitar RLS en owners (si no está)
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;

-- Eliminar políticas existentes que puedan permitir public
DROP POLICY IF EXISTS "owners_insert" ON owners;
DROP POLICY IF EXISTS "owners_update" ON owners;
DROP POLICY IF EXISTS "owners_delete" ON owners;
DROP POLICY IF EXISTS "owners_all" ON owners;
DROP POLICY IF EXISTS owners_insert ON owners;
DROP POLICY IF EXISTS owners_update ON owners;
DROP POLICY IF EXISTS owners_delete ON owners;
DROP POLICY IF EXISTS owners_all ON owners;

-- Política SELECT: super_admin ve todo; broker ve sus propietarios via propiedades
DROP POLICY IF EXISTS owners_select ON owners;
CREATE POLICY owners_select ON owners
FOR SELECT TO authenticated
USING (
  -- super_admin ve todo
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.role = 'super_admin' AND p.is_active IS NOT FALSE
  )
  -- broker ve propietarios de sus propiedades
  OR EXISTS (
    SELECT 1 FROM properties pr
    JOIN agents a ON a.id = pr.agent_id
    WHERE pr.owner_id = owners.id
      AND (a.profile_id = auth.uid() OR pr.created_by = auth.uid())
  )
);

-- Política INSERT: solo super_admin
CREATE POLICY owners_insert ON owners
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() 
      AND p.role = 'super_admin' 
      AND p.is_active IS NOT FALSE
  )
);

-- Política UPDATE: solo super_admin
CREATE POLICY owners_update ON owners
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() 
      AND p.role = 'super_admin' 
      AND p.is_active IS NOT FALSE
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() 
      AND p.role = 'super_admin' 
      AND p.is_active IS NOT FALSE
  )
);

-- Política DELETE: solo super_admin
CREATE POLICY owners_delete ON owners
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() 
      AND p.role = 'super_admin' 
      AND p.is_active IS NOT FALSE
  )
);

-- Comentario
COMMENT ON TABLE owners IS 'Propietarios. RLS: SELECT super_admin/broker(via propiedades), INSERT/UPDATE/DELETE super_admin.';