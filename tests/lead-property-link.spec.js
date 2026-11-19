// Contrato del alta de lead con propiedad vinculada (19/11/2026).
//
// El modal "Nuevo Prospecto / Lead" no tenía selector de propiedad aunque el
// submit Ya mandaba `property_id`. Ahora el formulario ofrece la propiedad y
// se escriben DOS vínculos, que conviven en producción:
//   - `leads.property_id`  → propiedad principal (22 leads reales)
//   - `lead_properties`    → relación completa del panel CRM (81 filas reales)
//
// Guards estáticos + behavioral del helper de vínculo con cliente falso.
// NO toca la base real ni producción.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260905000002_crm_leads_revamp.sql'), 'utf8');

/* Extractor: copia la función REAL del fuente, nunca la reescribe. */
function extractFunction(src, name) {
  const m = new RegExp('async function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('No se encontró la función ' + name);
  const open = src.indexOf('{', m.index);
  let depth = 0, quote = null, line = false, block = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (line) { if (ch === '\n') line = false; continue; }
    if (block) { if (ch === '*' && nx === '/') { block = false; i++; } continue; }
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '/' && nx === '/') { line = true; i++; continue; }
    if (ch === '/' && nx === '*') { block = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error('No se pudo balancear ' + name);
}

test.describe('Alta de lead — vínculo con propiedad desde el formulario', () => {
  test('el modal tiene el selector dentro de #leadForm', async ({ page }) => {
    const start = htmlSrc.indexOf('<div class="admin-modal" id="leadModal">');
    expect(start).toBeGreaterThan(-1);
    const end = htmlSrc.indexOf('<!-- MODAL VISITA -->', start);
    expect(end).toBeGreaterThan(start);
    await page.setContent(htmlSrc.slice(start, end));

    const sel = page.locator('#leadForm select[name="property_id"]#leadPropertySelect');
    await expect(sel).toHaveCount(1);
    await expect(sel.locator('option').first()).toHaveAttribute('value', '');
    expect((await sel.locator('option').first().innerText()).toLowerCase()).toContain('sin propiedad');
  });

  test('el selector se puebla al abrir el modal (botón y quick action) y al editar', () => {
    const loader = "loadPropertySelect($('#leadPropertySelect')";
    expect(appSrc.split(loader).length - 1).toBeGreaterThanOrEqual(2); // btnNewLead + quick action
    expect(appSrc).toContain("await loadPropertySelect($('#leadPropertySelect'), lead.property_id || '')");
  });

  test('el payload guarda null explícito cuando no se elige propiedad', () => {
    expect(appSrc).toContain('property_id: validated.property_id ?? null');
  });

  test('el alta captura el id insertado para poder vincular la propiedad', () => {
    expect(appSrc).toContain(".insert([data]).select('id').single()");
    expect(appSrc).toContain('savedLeadId = inserted?.id || null');
  });

  test('las 3 ramas de escritura vinculan la propiedad (recuperar, editar, crear)', () => {
    const calls = appSrc.split('linkLeadProperty(').length - 1;
    // 1 declaración + 2 llamadas: recuperar (early-return) y el path común
    // compartido por alta y edición.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(appSrc).toContain('await linkLeadProperty(r2.data.id, data.property_id)');
    expect(appSrc).toContain('await linkLeadProperty(savedLeadId, data.property_id)');
  });

  test('el helper usa la PUENTE real con upsert idempotente y es best-effort', () => {
    expect(appSrc).toContain(".from('lead_properties')");
    expect(appSrc).toContain("onConflict: 'lead_id,property_id'");
    expect(appSrc).toContain('ignoreDuplicates: true');
    const fn = extractFunction(appSrc, 'linkLeadProperty');
    expect(fn).toContain('try {');
    expect(fn).toContain('catch (e)');
    expect(fn).toContain('console.warn'); // nunca tumba el alta del lead
  });

  test('la migración define la puente con su PK compuesta', () => {
    expect(migration).toMatch(/create table if not exists (public\.)?lead_properties/i);
    expect(migration).toMatch(/primary key\s*\(lead_id,\s*property_id\)/i);
  });

  test('behavioral: el helper escribe la fila exacta y no propaga errores', async () => {
    const writes = [];
    const warns = [];
    const fakeClient = {
      from(table) {
        return {
          upsert(rows, opts) {
            writes.push({ table, rows, opts });
            return Promise.resolve({ error: null });
          }
        };
      }
    };
    const sandbox = {
      window: { supabaseClient: fakeClient },
      console: { warn: (...a) => warns.push(a.join(' ')) },
      mutate: async (_table, fn) => fn()
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(appSrc, 'linkLeadProperty'), sandbox);

    await sandbox.linkLeadProperty(null, 'prop-1');
    expect(writes).toHaveLength(0);

    await sandbox.linkLeadProperty('lead-1', 'prop-1');
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe('lead_properties');
    expect(writes[0].rows).toEqual([{ lead_id: 'lead-1', property_id: 'prop-1' }]);
    expect(writes[0].opts).toEqual({ onConflict: 'lead_id,property_id', ignoreDuplicates: true });

    sandbox.window.supabaseClient = {
      from: () => ({ upsert: () => Promise.resolve({ error: new Error('RLS/red caída') }) })
    };
    await sandbox.linkLeadProperty('lead-2', 'prop-2'); // no debe lanzar
    expect(warns.join(' ')).toContain('RLS/red caída');
  });
});
