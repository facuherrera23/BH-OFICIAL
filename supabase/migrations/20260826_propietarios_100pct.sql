-- ============================================================
-- PROPIETARIOS 100% INMOBILIARIA - Tablas adicionales
-- ============================================================
-- Espeja el schema VERIFICADO en producción (2026-08-27).
-- Idempotente: seguro de aplicar en DB nueva o ya migrada
-- (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--  DROP POLICY IF EXISTS / DROP TRIGGER IF EXISTS / CREATE INDEX IF NOT EXISTS).
-- NOTA: las columnas ars NO son GENERATED (Postgres no permite
-- subconsultas en generated columns); se calculan en la app/edge functions.
-- ============================================================

-- 1. LIQUIDACIONES DE COMISIONES - Resumen mensual con retenciones
-- ============================================================
CREATE TABLE IF NOT EXISTS commission_liquidations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start date NOT NULL,
  period_end date NOT NULL,
  broker_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  gross_commission_usd numeric DEFAULT 0,
  gross_amount_ars numeric DEFAULT 0,
  iibb_retention_ars numeric DEFAULT 0,
  ganancias_retention_ars numeric DEFAULT 0,
  net_amount_ars numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'borrador', -- 'borrador' | 'confirmada' | 'pagada'
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_liquidations_broker ON commission_liquidations(broker_id);
CREATE INDEX IF NOT EXISTS idx_liquidations_owner ON commission_liquidations(owner_id);
CREATE INDEX IF NOT EXISTS idx_liquidations_period ON commission_liquidations(period_start, period_end);

-- 2. COMISIONES - Tracking de comisiones por operación
-- ============================================================
CREATE TABLE IF NOT EXISTS commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  broker_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
  liquidation_id uuid REFERENCES commission_liquidations(id) ON DELETE SET NULL,
  operation_type text NOT NULL DEFAULT 'venta', -- 'venta' | 'alquiler'
  commission_amount_usd numeric NOT NULL DEFAULT 0, -- monto calculado
  commission_amount_ars numeric NOT NULL DEFAULT 0, -- monto en ARS (usd_rate al momento)
  iibb_rate numeric DEFAULT 0,          -- % IIBB
  iibb_amount_ars numeric DEFAULT 0,    -- retención IIBB en ARS
  ganancias_rate numeric DEFAULT 0,     -- % Ganancias (0 si monotributista)
  ganancias_amount_ars numeric DEFAULT 0, -- retención Ganancias en ARS
  net_amount_ars numeric,               -- monto neto ARS
  status text NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'liquidada' | 'pagada'
  due_date date,                        -- fecha esperada de cobro
  paid_date date,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commissions_owner ON commissions(owner_id);
CREATE INDEX IF NOT EXISTS idx_commissions_broker ON commissions(broker_id);
CREATE INDEX IF NOT EXISTS idx_commissions_property ON commissions(property_id);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status);
CREATE INDEX IF NOT EXISTS idx_commissions_due_date ON commissions(due_date);

-- 3. PAGOS DE COMISIONES - Registro de pagos efectivos
-- ============================================================
CREATE TABLE IF NOT EXISTS commission_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  liquidation_id uuid REFERENCES commission_liquidations(id) ON DELETE SET NULL,
  commission_id uuid REFERENCES commissions(id) ON DELETE SET NULL,
  broker_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  amount_ars numeric NOT NULL,
  payment_method text NOT NULL DEFAULT 'transferencia', -- 'transferencia' | 'cheque' | 'efectivo' | 'mp'
  reference text,      -- N° comprobante, CBU destino, etc.
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  created_by uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_liquidation ON commission_payments(liquidation_id);
CREATE INDEX IF NOT EXISTS idx_payments_broker ON commission_payments(broker_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON commission_payments(payment_date);

-- 4. PORTAL DEL PROPIETARIO - Tokens de acceso mágico
-- ============================================================
CREATE TABLE IF NOT EXISTS owner_portal_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL UNIQUE REFERENCES owners(id) ON DELETE CASCADE, -- un token por propietario
  token text NOT NULL UNIQUE,          -- UUID v4
  expires_at timestamptz,              -- NULL = no expira
  scopes text[] DEFAULT '{}',          -- 'read_properties','read_commissions','read_documents'
  created_by uuid,                     -- admin que generó el link
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_tokens_owner ON owner_portal_tokens(owner_id);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_token ON owner_portal_tokens(token);

-- 5. REQUISITOS DOCUMENTALES - Checklist por tipo de operación
-- ============================================================
CREATE TABLE IF NOT EXISTS document_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type text NOT NULL, -- 'venta' | 'alquiler' | 'tasacion' | 'exclusividad'
  document_key text NOT NULL,   -- 'escritura', 'dni', 'servicios', 'planos', 'abl', 'certificado_dominio', 'inhibiciones', 'plano_mensura', 'reglamento_copropiedad', 'expensas', 'libre_deuda'
  label text NOT NULL,          -- nombre visible
  description text,
  is_mandatory boolean DEFAULT false,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE (operation_type, document_key)
);

-- Seed data para requisitos comunes
INSERT INTO document_requirements (operation_type, document_key, label, description, is_mandatory, sort_order) VALUES
  ('venta', 'escritura', 'Escritura / Título de Propiedad', 'Escritura traslativa de dominio inscripta', true, 1),
  ('venta', 'dni', 'DNI / CUIT del Titular', 'Documento de identidad vigente', true, 2),
  ('venta', 'servicios', 'Libre Deuda de Servicios', 'ABL, Agua, Gas, Luz al día', true, 3),
  ('venta', 'planos', 'Planos Aprobados', 'Planos municipales visados', false, 4),
  ('venta', 'certificado_dominio', 'Certificado de Dominio y Gravámenes', 'Emitido por Registro de la Propiedad (< 30 días)', true, 5),
  ('venta', 'inhibiciones', 'Certificado de Inhibiciones', 'Persona física/jurídica', true, 6),
  ('alquiler', 'dni', 'DNI / CUIT del Titular', 'Documento de identidad vigente', true, 1),
  ('alquiler', 'escritura', 'Escritura / Título de Propiedad', 'Acreditación de propiedad', true, 2),
  ('alquiler', 'servicios', 'Últimas 3 Facturas de Servicios', 'Comprobante de domicilio y estado de deudas', true, 3),
  ('alquiler', 'reglamento_copropiedad', 'Reglamento de Copropiedad', 'Si aplica (PH, barrios cerrados)', false, 4),
  ('tasacion', 'escritura', 'Escritura / Título', 'Para identificar inmueble', true, 1),
  ('tasacion', 'planos', 'Planos / Planimetría', 'Superficies cubiertas/descubiertas', true, 2),
  ('tasacion', 'plano_mensura', 'Plano de Mensura', 'Si disponible', false, 3),
  ('exclusividad', 'escritura', 'Escritura / Título', 'Para contrato de exclusividad', true, 1),
  ('exclusividad', 'dni', 'DNI / CUIT', 'Identificación del otorgante', true, 2)
ON CONFLICT (operation_type, document_key) DO NOTHING;

-- 6. TIMELINE DEL PROPIETARIO - Comunicaciones y eventos
-- ============================================================
CREATE TABLE IF NOT EXISTS owner_timeline_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'note', -- 'note' | 'alert' | 'commission' | 'document' | 'contact'
  text text NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_timeline_owner ON owner_timeline_entries(owner_id, created_at);

-- 7. EXTENDER owners: campos de expediente y exclusividad
-- ============================================================
ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS preferred_contact text DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS bank_name text DEFAULT '',
  ADD COLUMN IF NOT EXISTS cbu_cvu text DEFAULT '',
  ADD COLUMN IF NOT EXISTS alias_cbu text DEFAULT '',
  ADD COLUMN IF NOT EXISTS exclusive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exclusive_start date,
  ADD COLUMN IF NOT EXISTS exclusive_end date,
  ADD COLUMN IF NOT EXISTS commission_sale numeric,
  ADD COLUMN IF NOT EXISTS commission_rent numeric,
  ADD COLUMN IF NOT EXISTS commission_split jsonb,
  ADD COLUMN IF NOT EXISTS contract_notes text,
  ADD COLUMN IF NOT EXISTS dni_expiry date,
  ADD COLUMN IF NOT EXISTS cuit_expiry date,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS documents jsonb DEFAULT '[]'::jsonb; -- [{type, url, expiry, verified}]

-- 8. RLS - Política única por tabla (patrón verificado en producción)
-- ============================================================
ALTER TABLE commission_liquidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_timeline_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "commission_liquidations_auth" ON commission_liquidations;
CREATE POLICY "commission_liquidations_auth" ON commission_liquidations FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "commissions_auth" ON commissions;
CREATE POLICY "commissions_auth" ON commissions FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "commission_payments_auth" ON commission_payments;
CREATE POLICY "commission_payments_auth" ON commission_payments FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "owner_portal_tokens_auth" ON owner_portal_tokens;
CREATE POLICY "owner_portal_tokens_auth" ON owner_portal_tokens FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "document_requirements_auth" ON document_requirements;
CREATE POLICY "document_requirements_auth" ON document_requirements FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "owner_timeline_entries_auth" ON owner_timeline_entries;
CREATE POLICY "owner_timeline_entries_auth" ON owner_timeline_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 9. Triggers para updated_at: NO se usan en este proyecto
-- ============================================================
-- Nota: el proyecto mantiene updated_at desde la app/edge functions
-- (patrón consistente con el resto de tablas live). No hay triggers
-- de updated_at en ninguna tabla del schema public.