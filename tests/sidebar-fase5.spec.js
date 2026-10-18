// Sidebar Fase 5 — estética & pulido (cierre del plan de 50):
// #31 bounce, #32 skeleton, #33 compacto, #34 acento, #35 separadores, #37 scroll,
// #38 activo reforzado, #39 stagger móvil, #40 ripple, #42 sub-nav chat,
// #46 breadcrumb, #49 handle del borde.
const { test, expect } = require('@playwright/test');

test.describe('Sidebar F5 — estética & pulido', () => {
  test('admin-app.js: skeleton de badges + preferencias (#32/#33/#34)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('setBadgesSkeleton');
    expect(js).toContain('is-skeleton');
    expect(js).toContain("SKELETON_BADGES.forEach(id => { const sk = document.getElementById(id); if (sk) sk.classList.remove('is-skeleton'); })");
    // Compacto y acento en el context menu + boot:
    expect(js).toContain("'bh_sidebar_dense'");
    expect(js).toContain('menú compacto');
    expect(js).toContain("'bh_accent'");
    expect(js).toContain('cycleAccent');
    expect(js).toContain('applyDense(isDense())');
    expect(js).toContain('applyAccent(getAccent())');
  });

  test('admin-app.js: scroll bar + ripple + sub-nav (#37/#40/#42)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('sidebar-menu-scroll');
    expect(js).toContain('function navRipple');
    expect(js).toContain('nav-ripple');
    expect(js).toContain('CHAT_SUBS');
    expect(js).toContain('injectSubNav');
    expect(js).toContain('nav-sub-toggle');
    // El sub-item navega y aplica el filtro del chat:
    expect(js).toContain(".filter-chip[data-platform=");
  });

  test('admin-app.js: breadcrumb + handle del borde (#46/#49)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('setTopbarContext');
    expect(js).toContain("setContext: setTopbarContext");
    // El breadcrumb se limpia al navegar:
    expect(js).toContain("window.__BH.setContext(null)");
    expect(js).toContain('sidebar-edge');
    expect(js).toContain('Contraer / expandir menú');
  });

  test('admin-crm.js: breadcrumb del CRM — modo y lead abierto (#46)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain("window.__BH.setContext(lead.full_name || 'Lead')");
    expect(js).toContain("setContext(ownersMode ? 'Propietarios' : null)");
    expect(js).toContain("setContext(_viewMode === 'owners' ? 'Propietarios' : null)");
  });

  test('admin-app.js: desgloses hover, quick-stats y badge dashboard (#3/#16/#24)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // #3: desglose en hover de badges (consume lastBadgeCounts):
    expect(js).toContain("leadsEl.dataset.bhTip = (counts.leads || 0) + ' activos'");
    expect(js).toContain("' tareas vencidas'");
    expect(js).toContain("' estancadas'");
    // #16: quick-stats al hover del ítem:
    expect(js).toContain('NAV_STAT_TIPS');
    expect(js).toContain('refreshNavStatTips');
    // Al expandir el colapso se restauran los stats (2+ llamadas: badges + expand):
    expect((js.match(/refreshNavStatTips\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
    // #24: badge de recomendaciones en Dashboard:
    expect(js).toContain('sideBadgeDash');
    expect(js).toContain('acciones requieren atención');
  });

  test('admin-app.js: popover de canales — la flechita EXCLUIDA del "clic afuera" (regresión: se re-abría sola)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // Ambos listeners viven en document: sin la exclusión, el click de la
    // flechita cae en el handler de afuera (cierra) y el toggle la re-abre.
    expect(js).toContain("&& !e.target.closest('.nav-sub-toggle')) hideSubPopover()");
  });

  test('admin.css: todos los estilos de F5', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    // #31 bounce:
    expect(css).toContain('.nav-item:hover .nav-item-left i { transform:');
    // #32 skeleton:
    expect(css).toContain('@keyframes badgeShimmer');
    expect(css).toContain('.nav-badge.is-skeleton');
    // #33 compacto:
    expect(css).toContain('body.sidebar-dense .nav-item');
    // #34 acento:
    expect(css).toContain("body[data-accent='violeta'] .sidebar");
    expect(css).toContain("body[data-accent='ambar'] .sidebar");
    // #35 separadores:
    expect(css).toContain('.menu-category::after');
    // #37 scroll:
    expect(css).toContain('.sidebar-menu-scroll');
    // #38 activo:
    expect(css).toContain('.nav-item.is-active i { filter: drop-shadow');
    // #39 stagger móvil:
    expect(css).toContain('@keyframes navItemIn');
    expect(css).toContain('.sidebar.is-open .nav-item:nth-child');
    // #40 ripple:
    expect(css).toContain('@keyframes navRippleAnim');
    expect(css).toContain('.nav-ripple');
    // #42 sub-nav:
    expect(css).toContain('.nav-sub-item');
    // #46 breadcrumb:
    expect(css).toContain('.topbar-context');
    // #49 borde:
    expect(css).toContain('.sidebar-edge');
    // El glow del activo compatible con el ripple (overflow hidden):
    expect(css).toContain('box-shadow: 4px 0 10px -2px rgba(31, 200, 195, 0.55)');
  });
});
