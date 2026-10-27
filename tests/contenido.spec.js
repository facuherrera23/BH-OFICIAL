// Tests del módulo CONTENIDO (redes sociales) — read-only contra producción.
// El flujo completo de publicación exige OAuth real de YouTube: estos tests
// validan la estructura (tab, sección, módulo, edge functions) y que el
// boot no rompa el admin. La conexión real se prueba manualmente con las
// credenciales del dueño.
const { test, expect } = require('@playwright/test');

test.describe('Módulo Contenido (redes sociales)', () => {
  test('admin.html: sección, nav y script del módulo registrados', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('<section class="tab-module" id="tab-contenido">');
    expect(html).toContain('data-tab="tab-contenido"');
    expect(html).toMatch(/admin-contenido\.js\?v=\d+/);
    // Carga DESPUÉS de admin-app.js: el módulo destructurea window.__BH al parsear
    const appIdx = html.search(/admin-app\.js\?v=\d+/);
    const modIdx = html.search(/admin-contenido\.js\?v=\d+/);
    expect(modIdx).toBeGreaterThan(appIdx);
  });

  test('admin-app.js: loader y título del módulo registrados', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain("'tab-contenido': () => window.__BH.loadContenido?.()");
    expect(js).toContain("'tab-contenido': 'Contenido & Redes'");
  });

  test('admin-contenido.js: exposición y estructuras clave del módulo', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-contenido.js')).text();
    // Exposición del loader con el patrón de los demás módulos
    expect(js).toContain('window.__BH.loadContenido');
    // OAuth por popup + postMessage (patrón ML)
    expect(js).toContain('SOCIAL_AUTH_SUCCESS');
    expect(js).toContain('window.open');
    // Subida directa a Google (los bytes no pasan por Supabase)
    expect(js).toContain('xhrUploadToGoogle');
    // Escapado de todo contenido dinámico en innerHTML
    const raw = (js.match(/innerHTML\s*=[^;]+;/g) || []).length;
    const escaped = (js.match(/esc\(/g) || []).length;
    expect(escaped).toBeGreaterThanOrEqual(raw);
    // Sin handlers inline (CSP sin unsafe-inline)
    expect(js).not.toMatch(/onclick\s*=/);
  });

  test('edge functions de publicación: rechazan requests sin autenticación', async ({ request }) => {
    // social-publish-youtube: verify_jwt ON — sin Bearer debe dar 401/403.
    // 404 = la función es nueva y el pipeline todavía no la deployó (los
    // tests corren ANTES del job de deploy en el mismo CI) — estado de
    // transición válido SOLO en el primer deploy.
    const publish = await request.post(
      'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/social-publish-youtube',
      { data: { action: 'init' } },
    );
    expect([401, 403, 404]).toContain(publish.status());
    // social-auth-youtube: NO_VERIFY (el callback de Google no trae JWT) —
    // el POST 'start' sin sesión valida por requireAdmin (400/401)
    const auth = await request.post(
      'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/social-auth-youtube',
      { data: { action: 'start' } },
    );
    expect([400, 401, 403, 404]).toContain(auth.status());
  });
});
