// Sidebar Fase 1 — infraestructura: delegación de nav (#47), bus de badges (#48),
// RPC extendida (#50), tooltips premium (#45) y estado de navegación (#26/27/28/41).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.describe('Sidebar F1 — infraestructura', () => {
  test('admin-app.js: delegación de nav (sin bind por ítem)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // #47: un solo listener delegado:
    expect(js).toContain("e.target.closest('#sidebar .nav-item[data-tab]')");
    // El doble-bind histórico por ítem desapareció:
    expect(js).not.toContain('bhNavBound');
  });

  test('admin-app.js: bus de badges con debounce + RPC extendida', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // #48: scheduler con debounce expuesto en __BH:
    expect(js).toContain('scheduleBadgeRefresh');
    expect(js).toContain('BADGE_REFRESH_MS');
    expect(js).toContain('scheduleBadgeRefresh, invalidateSearchCache');
    // #50: cache de conteos para desgloses/quick-stats (Fase 3):
    expect(js).toContain('lastBadgeCounts');
    // El realtime ya no llama directo (la ráfaga pasa por el bus):
    expect(js).not.toContain('debouncedCRMRefresh();\n              updateSidebarBadges');
  });

  test('admin-app.js: estado de navegación — último módulo, sub-vistas, historial', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // #26: persistir + restaurar el último módulo:
    expect(js).toContain("'bh_last_tab'");
    expect(js).toContain('localStorage.getItem(\'bh_last_tab\')');
    // #28/#41: pushState (back/forward real) + sub-vistas en el hash:
    expect(js).toContain('history.pushState');
    expect(js).toContain('targetHash');
    expect(js).toContain('handleSubView');
    // Guard de rol en la restauración (tabs de sistema solo super_admin):
    expect(js).toContain("currentProfile?.role !== 'super_admin'");
  });

  test('admin-app.js: tooltips premium (data-bh-tip)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('bhTooltip');
    expect(js).toContain("[data-bh-tip]");
    expect(js).toContain('dataset.bhTip');
    // El colapso ya no usa title nativo para los labels:
    expect(js).toContain('delete item.dataset.bhTip');
  });

  test('admin-crm.js: modo persistido + carga por modo + sub-vista owners', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain("'bh_crm_viewmode'");
    expect(js).toContain('_loadSeq');
    expect(js).toContain('seqAtInit !== _loadSeq');
    // Re-entrada carga la vista correcta (antes forzaba leads):
    expect(js).toContain("if (__initialized) { if (_viewMode === 'owners') loadOwners(); else loadLeads(); return; }");
    // Sub-vista registrada:
    expect(js).toContain('handleSubView');
    expect(js).toContain("sub === 'owners'");
  });

  test('admin.css: estilo del tooltip', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    expect(css).toContain('#bhTooltip');
    expect(css).toContain('#bhTooltip.is-visible');
  });

  test('migración RPC v2 presente en el repo', async () => {
    const dir = path.join(__dirname, '..', 'supabase', 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.includes('sidebar_badge_counts'));
    expect(files.length).toBeGreaterThan(0);
    const sql = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8');
    expect(sql).toContain('tasks_overdue_total');
    expect(sql).toContain('chat_unread_total');
    expect(sql).toContain('properties_stale');
    expect(sql).toContain('ml_failed_24h');
  });
});
