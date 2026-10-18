// Sidebar Fase 4 — contexto del negocio: sección "Hoy" colapsable (#17/#18/#19/#20),
// build en footer (#22), hover card de chat (#23), ítems por rol (#25),
// dirty check (#43) y prefetch con throttle (#44).
const { test, expect } = require('@playwright/test');

test.describe('Sidebar F4 — contexto, roles, dirty check', () => {
  test('admin-app.js: sección "Hoy" — citas, tareas, servicios (#17/#18/#19/#20)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('sidebarToday');
    expect(js).toContain('loadTodayWidget');
    expect(js).toContain('bh_today_open');
    expect(js).toContain("data-st-visit");
    expect(js).toContain("data-st-task");
    // Render unificado: el body completo, secciones solo con contenido:
    expect(js).toContain("getElementById('stBody')");
    expect(js).toContain('Día despejado');
    expect(js).toContain('fmtAgoMins');
    // Citas y tareas del día respetan RLS (la query va sin bypass — el rol filtra):
    expect(js).toContain(".eq('status', 'pendiente')");
    expect(js).toContain("from('lead_tasks')");
    // Zernio: última sync desde el último mensaje, formato legible (días/h):
    expect(js).toContain("from('zernio_conversations')");
    expect(js).toContain('last_message_at');
  });

  test('admin-app.js: build del footer + hover card de chat (#22/#23)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('paintSidebarBuild');
    expect(js).toContain("admin-app\\.js\\?v=(\\d+)"); // versión real del propio script
    expect(js).toContain('bhHoverCard');
    expect(js).toContain("data-bh-hover-card");
    expect(js).toContain("bhHoverCard = 'chat'");
    // El card solo aparece si hay unread (no molesta al chat al día):
    expect(js).toContain('chat_unread_total');
  });

  test('admin-app.js: ítems por rol — sistema solo super_admin (#25)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('function applyRoleVisibility');
    expect(js).toContain("'tab-usuarios', 'tab-supervision'");
    expect(js).toContain('applyRoleVisibility();');
  });

  test('admin-app.js: dirty check con lista blanca de 5 forms (#43)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain("const DIRTY_FORMS = ['propertyForm', 'leadForm', 'visitForm', 'ownerForm', 'newTasacionForm']");
    expect(js).toContain('function pendingDirtyForm');
    expect(js).toContain('bhDirty');
    // El guard pregunta con confirm (promise) y re-invoca con force:
    expect(js).toContain('Cambios sin guardar');
    expect(js).toContain("{ force: true }");
    // Limpieza: MO sobre class de los modales + submit delegado:
    expect(js).toContain('dirtyMO');
    expect(js).toContain("attributeFilter: ['class']");
  });

  test('admin-app.js: prefetch de la caché de búsqueda con throttle (#44)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('_prefetchAt');
    expect(js).toContain('getSearchCache()');
    // Los loaders renderizan — el prefetch es de datos, no de módulos:
    expect(js).toContain('Los loaders RENDERIZAN al llamarse');
  });

  test('admin-app.js: el widget refresca con el bus de badges (si está abierto)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('loadTodayWidget(false)');
  });

  test('admin.html + admin.css: DOM y estilos de F4', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('id="sidebarBuild"');
    const css = await (await request.get('/assets/css/admin.css')).text();
    expect(css).toContain('.sidebar-today');
    expect(css).toContain('.st-item');
    expect(css).toContain('.st-dot.is-ok');
    expect(css).toContain('.sidebar-build');
    expect(css).toContain('#bhHoverCard');
    expect(css).toContain('.hc-row');
    // El sidebar colapsado oculta la sección Hoy Y no desborda el user-card:
    expect(css).toContain('.sidebar.is-collapsed .sidebar-today { display: none; }');
    expect(css).toContain('.sidebar.is-collapsed .user-card button { display: none; }');
    expect(css).toContain('.sidebar.is-collapsed .sidebar-build { display: none; }');
    // Rediseño integrado: sin caja flotante, guía vertical:
    expect(css).toContain('.st-body');
    expect(css).toContain('.st-clear');
  });
});
