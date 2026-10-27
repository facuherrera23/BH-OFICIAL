// Sanidad ESTRUCTURAL de admin.css — incidente real 2026-10-27: un @media
// sin cerrar (commit de fixes mobile) sepultó 18KB de reglas dentro de un
// mediaquery; .pf-map quedó invisible una semana y los tests de "la clase
// existe en el archivo" no lo detectaron porque la clase EXISTÍA — solo que
// su regla jamás aplicaba. Este test valida la ESTRUCTURA, no el texto:
// 1. Balance de llaves (ignorando strings y comentarios)
// 2. Ninguna llave cierra un scope que no estaba abierto (depth nunca < 0)
// 3. El CSSOM real del browser parsea la regla de .pf-map
const { test, expect } = require('@playwright/test');

function scanBalance(css) {
  let depth = 0, minDepth = 0;
  let enCom = false, enStr = false, sc = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i], n = css[i + 1];
    if (enCom) { if (c === '*' && n === '/') { enCom = false; i++; } continue; }
    if (enStr) { if (c === '\\') { i++; continue; } if (c === sc) enStr = false; continue; }
    if (c === '/' && n === '*') { enCom = true; i++; continue; }
    if (c === '"' || c === "'") { enStr = true; sc = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth < minDepth) minDepth = depth; }
  }
  return { final: depth, min: minDepth, comentarioAbierto: enCom, stringAbierta: enStr };
}

test.describe('admin.css: sanidad estructural', () => {
  test('llaves balanceadas — sin strings ni comentarios abiertos', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    const r = scanBalance(css);
    // Incidente real: final -1 y llaves sueltas sepultaron 18KB de reglas
    expect(r.final, 'balance de llaves').toBe(0);
    expect(r.min, 'nunca cierra un scope que no estaba abierto').toBeGreaterThanOrEqual(0);
    expect(r.comentarioAbierto, 'sin /* sin cerrar').toBe(false);
    expect(r.stringAbierta, 'sin comillas sin cerrar').toBe(false);
  });

  test('.pf-map queda a nivel top (fuera de todo mediaquery)', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    const idx = css.indexOf('.pf-map {');
    expect(idx).toBeGreaterThan(0);
    const r = scanBalance(css.substring(0, idx));
    expect(r.final, 'depth antes de .pf-map').toBe(0);
  });

  test('el CSSOM del browser parsea la regla del mapa (no basta que exista en el texto)', async ({ page }) => {
    await page.goto('/admin.html');
    const parsed = await page.evaluate(async () => {
      // Esperar el stylesheet del admin
      for (let i = 0; i < 40; i++) {
        const s = [...document.styleSheets].find(x => (x.href || '').includes('admin.css'));
        if (s && s.cssRules.length) return { ok: true, reglas: s.cssRules.length };
        await new Promise(r => setTimeout(r, 250));
      }
      return { ok: false };
    });
    expect(parsed.ok).toBe(true);
    // En el incidente el parser murió en 1362 reglas (de 1493+ actuales)
    expect(parsed.reglas).toBeGreaterThan(1400);
    // Y computar la altura de .pf-map como elemento suelto (sin abrir el modal)
    const h = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'pf-map';
      document.body.appendChild(probe);
      const hh = getComputedStyle(probe).height;
      probe.remove();
      return hh;
    });
    expect(h).toBe('240px');
  });
});
