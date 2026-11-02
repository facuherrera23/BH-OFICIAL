// Circuito "Iniciar tasación" desde el CRM (2026-11-02): los leads
// source='tasacion' esperan que un agente realice el análisis. El botón del
// panel del lead abre tasacion.html?lead=<uuid> y el wizard precarga los
// datos. Guards ESTÁTICOS (sin BD ni red): los comportamientos finos del
// wizard ya los cubren tests/pages.spec.js (fake session + moneda).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pageSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'pages', 'tasacion-page.js'), 'utf8');
const crmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm.js'), 'utf8');

test.describe('tasación desde lead — estáticos', () => {
  test('tasacion-page.js: LEAD_ID + prefill con guard (solo agente y sin ?id=)', () => {
    expect(pageSrc).toContain("const LEAD_ID = urlParams.get('lead');");
    expect(pageSrc).toContain('function prefillTasacionFromLead(lead){');
    // El parser usa el template fijo que escribe tasacion-submit.
    expect(pageSrc).toContain('Solicitud de tasación web — ');
    // No pisa la edición de una tasación existente (?id= manda).
    expect(pageSrc).toContain('if (LEAD_ID && !TASACION_ID) {');
    // Lectura del lead embarca las columnas que el prefill usa (regla schema real).
    expect(pageSrc).toContain(".select('full_name, phone, whatsapp, notes, source')");
  });

  test('tasacion-page.js: la tasación creada queda vinculada y trazada', () => {
    // tasaciones no tiene columna lead_id (verificado contra information_schema)
    // — el vínculo vive en el JSONB data.lead_id, solo en el insert path.
    expect(pageSrc).toContain('if (LEAD_ID && !TASACION_ID) formData.lead_id = LEAD_ID;');
    expect(pageSrc).toContain("title: 'Tasación creada: ' + (title || 'sin título'),");
  });

  test('admin-crm.js: botón solo para leads source tasacion, por listener (CSP-safe)', () => {
    expect(crmSrc).toContain('id="crmTasacionBtn"');
    expect(crmSrc).toContain("lead.source === 'tasacion'");
    expect(crmSrc).toContain("'/tasacion.html?lead='");
    expect(crmSrc).toContain("encodeURIComponent(String(lead.id || ''))");
    // Sin onclick inline (la CSP del admin no tiene unsafe-inline).
    const section = crmSrc.slice(crmSrc.indexOf('id="crmTasacionBtn"') - 600, crmSrc.indexOf('id="crmTasacionBtn"') + 300);
    expect(section).not.toContain('onclick=');
  });
});
