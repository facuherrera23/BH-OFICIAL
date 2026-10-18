// Sidebar Fase 3 — acciones rápidas y orden del menú:
// #9 (+), #10 (context menu), #11 (badges), #12 (Alt+N), #13 (Ctrl+K búsqueda global),
// #14 (recientes), #15 (favoritos), #29 (orden por rol), #30 (tag NUEVO).
const { test, expect } = require('@playwright/test');

test.describe('Sidebar F3 — acciones rápidas y orden', () => {
  test('admin.html: búsqueda global en el topbar (#13)', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('id="globalSearchInput"');
    expect(html).toContain('id="globalSearchResults"');
    expect(html).toContain('globalSearchWrap');
    // Nota: con #globalSearchResults en el DOM, el IIFE de resultados ya no
    // retorna temprano — attachNavListeners (hashchange de F1) revive.
  });

  test('admin-app.js: motor de orden — favoritos, recientes, rol (#14/#15/#29)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain("'bh_sidebar_pins'");
    expect(js).toContain("'bh_recent_tabs'");
    expect(js).toContain('function applyMenuOrder');
    expect(js).toContain('ROLE_PRIORITY');
    expect(js).toContain('is-pinned');
    expect(js).toContain('trackRecent(section)');
  });

  test('admin-app.js: botón + con chips del dashboard como disparadores (#9)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('PLUS_BY_TAB');
    expect(js).toContain("openPropertyModal");
    expect(js).toContain('function injectPlusButtons');
    expect(js).toContain('dataset.plusAction');
    expect(js).toContain('triggerQuickAction');
  });

  test('admin-app.js: menú contextual con favorito + altas + atajos (#10/#12)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('navContextMenu');
    expect(js).toContain("addEventListener('contextmenu'");
    expect(js).toContain('Fijar arriba (favorito)');
    expect(js).toContain('Ver padrón de propietarios');
    // Alt+N:
    expect(js).toContain("if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;");
    // Ctrl+K:
    expect(js).toContain("e.key === 'k' || e.key === 'K'");
  });

  test('admin-app.js: badges clickeables + tag NUEVO (#11/#30)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('function injectBadgeTips');
    expect(js).toContain("'Ir a ' + label.textContent.trim()");
    expect(js).toContain('nav-new-tag');
    expect(js).toContain('data-sidebar-new');
    expect(js).toContain("'bh_new_seen'");
  });

  test('admin-app.js: orden se aplica al cargar el perfil (rol) y al bootear', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('injectPlusButtons();');
    expect(js).toContain('applyMenuOrder();');
    expect(js).toContain('refreshNewTags();');
    expect(js).toContain('injectBadgeTips();');
    expect(js).toContain("loadProfile().then(() => { updateUserInfo(); applyMenuOrder(); })");
  });

  test('admin.css: estilos F3 — plus, pin, NUEVO, context menu, búsqueda', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    expect(css).toContain('.nav-plus');
    expect(css).toContain('.nav-item.is-pinned::after');
    expect(css).toContain('.nav-new-tag');
    expect(css).toContain('.nav-context-menu');
    expect(css).toContain('.nav-ctx-item');
    expect(css).toContain('.topbar-search');
    expect(css).toContain('.gs-results');
    expect(css).toContain('.gs-result.is-active');
  });
});
