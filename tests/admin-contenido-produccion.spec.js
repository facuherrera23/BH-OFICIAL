// Smoke test de PRODUCCIÓN del módulo CONTENIDO (YouTube).
//
// El módulo se deploya como assets estáticos (Cloudflare Pages) + scripts que
// admin.html enlaza con cache-busters. Este test verifica contra el sitio
// REAL que:
//   1) admin.html enlaza el CSS/JS propios del módulo con los ?v= que espera,
//   2) Cloudflare sirve el CSS nuevo (200 + text/css) con las clases clave,
//   3) las hojas de estilo del panel (incluida la del módulo) se APLICAN de
//      verdad en el navegador (CSSOM, no un fetch: el fetch violaría la CSP),
//   4) no hay errores de JS ni requests fallidos de /assets/.
//
// No necesita credenciales ni toca datos: es lectura pura.
const { test, expect } = require('@playwright/test');

const PROD = 'https://bienenhaus.com.ar';

test('produccion: el modulo de contenido se sirve y se aplica en admin.html', async ({ page }) => {
  const jsErrors = [];
  const failedAssets = [];
  page.on('pageerror', (e) => jsErrors.push(String(e && e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Los errores de red/CSP de terceros (analytics, fonts, insights) no son
    // de este módulo: solo nos interesan los de JS.
    if (/TypeError|ReferenceError|SyntaxError|Uncaught/i.test(t)) jsErrors.push(t);
  });
  page.on('requestfailed', (r) => {
    if (r.url().includes('/assets/')) failedAssets.push(r.url());
  });

  await page.goto(PROD + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  // 1) HTML con los assets del módulo
  const html = await (await page.request.get(PROD + '/admin.html')).text();
  expect(html).toContain('assets/css/admin-contenido.css');
  expect(html).toContain('assets/js/admin-contenido.js');
  expect(html).toContain('assets/js/yt-seo-score.js');

  // 2) el CSS del módulo se sirve con las clases que usa el JS
  const css = await page.request.get(PROD + '/assets/css/admin-contenido.css?v=1');
  expect(css.status()).toBe(200);
  expect(css.headers()['content-type']).toContain('text/css');
  const cssText = await css.text();
  for (const cls of ['.yt-video-card', '.yt-account-card', '.yt-modal', '.yt-tabs', '.yt-kpi', '.yt-dropzone']) {
    expect(cssText).toContain(cls);
  }

  // 3) las hojas de estilo se APLICAN (CSSOM: >1400 reglas como exige el
  //    spec de estructura del panel + el CSS del módulo contributes reglas)
  const sheets = await page.evaluate(() => {
    const out = { hrefs: [], rules: 0, moduleRules: 0, hasPanel: false };
    for (const s of Array.from(document.styleSheets)) {
      out.hrefs.push(s.href || 'inline');
      let n = 0;
      try { n = s.cssRules ? s.cssRules.length : 0; } catch (_) { n = 0; }
      out.rules += n;
      if (s.href && s.href.includes('admin-contenido.css')) out.moduleRules = n;
      if (s.href && s.href.includes('admin.css')) out.hasPanel = true;
    }
    return out;
  });
  expect(sheets.hrefs.some((h) => h.includes('admin-contenido.css'))).toBe(true);
  expect(sheets.hasPanel).toBe(true);
  expect(sheets.moduleRules).toBeGreaterThan(50);
  expect(sheets.rules).toBeGreaterThan(1400);

  // 4) sin errores de JS ni assets caídos
  expect(failedAssets).toEqual([]);
  expect(jsErrors).toEqual([]);
});
