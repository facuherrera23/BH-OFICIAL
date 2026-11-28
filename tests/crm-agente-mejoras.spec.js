// Guard de las mejoras 1 y 3 de la Capa A (28/11/2026), pedidas por el dueño:
//   1) Bandeja "Siguiente acción": la misma lógica de la ficha (siguientesAccionesDe)
//      aplicada a los leads de mi_dia(), en un overlay con un botón nuevo.
//   3) Mini-KPIs del agente: 4 chips compactos con los `conteos` de mi_dia(),
//      marcados como "míos" en el Dashboard (p_solo_propio=true).
//
// No hay RPC ni migración nueva: se reutiliza mi_dia() y el delegado único
// bindSiguientesAcciones(). El behavioral corre el admin-crm.js REAL contra el
// harness con Supabase falso (tests/helpers/crm-lead-panel-harness.html).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const crmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

test.describe('CRM — mejoras del agente (Capa A)', () => {
  test('botón "Siguiente acción" en admin.html y binding en init()', () => {
    expect(adminHtml).toContain('id="crmSiguienteBtn"');
    expect(crmSrc).toContain("$id('crmSiguienteBtn')");
    expect(crmSrc).toContain('addEventListener(\'click\', openSiguienteAccion)');
    expect(crmSrc).toMatch(/openSiguienteAccion:\s*openSiguienteAccion/);
  });

  test('la bandeja reutiliza mi_dia(), sus datos y el delegado de la ficha', () => {
    expect(crmSrc).toContain("db().rpc('mi_dia', {})");
    expect(crmSrc).toContain('siguientesAccionesDe(lead, propRows');
    expect(crmSrc).toContain('siguientesAccionesHtml(f.acciones, f.lead)');
    expect(crmSrc).toContain('bindSiguientesAcciones(wrap, lead.lead)');
    // Descarta que alguien haya clonado los handlers de la ficha dentro del overlay.
    const overlay = crmSrc.slice(crmSrc.indexOf('async function openSiguienteAccion'), crmSrc.indexOf('/* Panel embebido en el Dashboard'));
    expect(overlay).not.toContain("data-sig-accion === 'whatsapp'");
    expect(overlay).not.toContain("data-sig-accion === 'tarea'");
  });

  test('mini-KPIs: 4 chips de los conteos de mi_dia, sin segunda query', () => {
    expect(crmSrc).toContain('miniKpisHtml(d.conteos, soloPropio, body)');
    for (const k of ['tareas', 'seguimientos', 'sin_contacto', 'visitas_semana']) {
      expect(crmSrc).toContain("k: '" + k + "'");
    }
    expect(crmSrc).toContain("closest('[data-midia-kpi]')");
    // Se dibujan en el MISMO render de miDiaRender (no hay un rpc extra).
    const render = crmSrc.slice(crmSrc.indexOf('async function miDiaRender'), crmSrc.indexOf('async function openMiDia'));
    expect((render.match(/db\(\)\.rpc\(/g) || []).length).toBe(1);
  });

  test('behavioral: mini-KPIs y bandeja renderizan con el harness', async ({ page }) => {
    const errores = [];
    page.on('pageerror', e => errores.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
    await page.goto('/tests/helpers/crm-lead-panel-harness.html');
    await page.waitForFunction(() => window.__HARNESS_READY === true);
    await page.evaluate(() => window.initCrm());

    // Dashboard: p_solo_propio=true → 4 chips + etiqueta "mis pendientes".
    await page.evaluate(async () => {
      await window.BH_CRM.mountMiDiaPanel(document.getElementById('dashMiDiaBody'));
    });
    const dash = await page.evaluate(() => {
      const b = document.getElementById('dashMiDiaBody');
      return {
        chips: b.querySelectorAll('[data-midia-kpi]').length,
        texto: b.textContent,
        rpcParams: (window.__HARNESS_LOG || []).filter(x => x && x.name === 'mi_dia').map(x => x.params)
      };
    });
    expect(dash.chips).toBe(4);
    expect(dash.texto).toContain('mis pendientes');
    // Los chips muestran el número y la etiqueta en nodos separados: exigimos
    // el valor por atributo (el texto concatena "1sin contacto", sin espacio).
    const valores = await page.evaluate(() => Array.from(
      document.querySelectorAll('#dashMiDiaBody [data-midia-kpi]')
    ).map(x => x.getAttribute('data-midia-kpi') + '=' + x.querySelector('span').textContent.trim()));
    expect(valores).toEqual(['tareas=2', 'seguimientos=2', 'sin_contacto=1', 'visitas_semana=0']);

    // Overlay de la bandeja: agrupa por lead y usa la tarjeta de la ficha.
    await page.evaluate(() => window.BH_CRM.openSiguienteAccion());
    await page.waitForFunction(() => {
      const o = document.querySelector('[data-sig-body]');
      return !!o && o.textContent.indexOf('Lead Sin Sugerencias') !== -1;
    }, { timeout: 10000 });
    const bandeja = await page.evaluate(() => {
      const b = document.querySelector('[data-sig-body]');
      return {
        leads: b.querySelectorAll('.crm-sig-bandeja-lead').length,
        tarjetas: b.querySelectorAll('.crm-sig-accion').length,
        botones: b.querySelectorAll('[data-sig-accion]').length,
        sub: document.querySelector('[data-sig-sub]').textContent
      };
    });
    expect(bandeja.leads).toBe(2);
    expect(bandeja.tarjetas).toBeGreaterThan(0);
    expect(bandeja.botones).toBeGreaterThan(0);
    expect(bandeja.sub).toContain('2');
    // El delegado de la ficha tiene que estar vinculado ANTES del primer
    // click: si se vincula dentro del handler, el primer clic no hace nada.
    const bound = await page.evaluate(() => Array.from(
      document.querySelectorAll('[data-sig-body] .crm-sig-accion')
    ).map(x => x.dataset.sigBound || ''));
    expect(bound).toEqual(['1', '1']);
    expect(errores).toEqual([]);
  });
});
