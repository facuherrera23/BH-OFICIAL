// Red de seguridad contra regresiones de seguridad (FASE 1 + FASE 2):
// CSP por página, ausencia de handlers inline, delegación data-action, fix de scope.
// Read-only: solo fetches de HTML/JS crudos vía request.
const { test, expect } = require('@playwright/test');

const PAGES_NONCE = ['index.html', 'tasacion.html', 'portal-propietario.html', 'confirmar-visita.html'];

test.describe('Seguridad — CSP y delegación (regresión guards)', () => {
  test('admin.html: unsafe-inline SIN nonce y 0 handlers inline', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    // Admin necesita 'unsafe-inline' (handlers dinámicos de admin-app.js) sin nonce:
    // CSP3 ignora unsafe-inline cuando hay nonce presente, así que NO debe haber nonce.
    expect(html).toContain("script-src 'self' 'unsafe-inline'");
    expect(html).not.toContain('nonce-bienenhaus2024');
    // Los 15 onclick estáticos se migraron a data-action: no debe quedar ninguno.
    expect((html.match(/onclick\s*=/g) || []).length).toBe(0);
    expect((html.match(/on(error|change|submit)\s*=/g) || []).length).toBe(0);
    // 23 data-action (15 migrados + 8 quick-action chips).
    expect((html.match(/data-action=/g) || []).length).toBeGreaterThanOrEqual(20);
  });

  for (const pageFile of PAGES_NONCE) {
    test(`${pageFile}: CSP estricta con nonce (sin unsafe-inline)`, async ({ request }) => {
      const html = await (await request.get(`/${pageFile}`)).text();
      expect(html).toContain('nonce-bienenhaus2024');
      expect(html).toContain("script-src 'self'");
      expect(html).not.toContain("script-src 'self' 'unsafe-inline'");
    });
  }

  test('tasacion.html: font-src consolidada (una sola aparición)', async ({ request }) => {
    const html = await (await request.get('/tasacion.html')).text();
    const cspMeta = html.match(/<meta[^>]*Content-Security-Policy[^>]*>/)?.[0] || '';
    expect((cspMeta.match(/font-src/g) || []).length).toBe(1);
  });

  test('admin-app.js: fix de delegación data-action intacto', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // Export en la IIFE principal (fix de scope ReferenceError).
    expect(js).toContain('window.exportSupOverviewCSV = exportSupOverviewCSV');
    // Whitelist de acciones + listener delegado.
    expect(js).toContain('dataActionWhitelist');
    expect(js).toContain("document.addEventListener('click'");
  });

  test('config.js: sin secretos rastreados', async ({ request }) => {
    const js = await (await request.get('/assets/js/config.js')).text();
    // La anon key es pública por diseño; lo prohibido es service_role/secretos.
    expect(js).not.toMatch(/service_role/i);
    expect(js).not.toMatch(/eyJhbGciOiJIUzI1NiJ9\.[A-Za-z0-9_-]{20,}\.([A-Za-z0-9_-]{10,})/i);
  });
});