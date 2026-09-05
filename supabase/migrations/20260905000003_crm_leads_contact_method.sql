-- CRM revamp — parte 3: canal preferido y tipo de operación del lead.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS preferred_contact_method text
  CHECK (preferred_contact_method IS NULL OR preferred_contact_method IN ('phone','whatsapp','email'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS operation_type text
  CHECK (operation_type IS NULL OR operation_type IN ('compra','venta','alquiler'));
CREATE INDEX IF NOT EXISTS idx_leads_operation_type ON leads (operation_type);
