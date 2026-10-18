// Sidebar Fase 2 — señales & badges: chat sin leer (#1), tareas vencidas en Agenda (#2),
// estancadas en Propiedades (#4), count-up (#5), estado ML (#6), pulso Supervisión (#7),
// +N hoy en Leads (#8), modo offline (#21) y anillo del avatar (#36).
const { test, expect } = require('@playwright/test');

test.describe('Sidebar F2 — señales & badges', () => {
  test('admin-app.js: updateSidebarBadges consume la RPC v2 completa', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // #1 boot: el chat se pinta desde la RPC hasta que el módulo toma el relevo:
    expect(js).toContain('chat_unread_total');
    expect(js).toContain("nav-badge--unread', unread > 0");
    // #2: tareas vencidas totales en el badge de Agenda:
    expect(js).toContain('tasks_overdue_total');
    expect(js).toContain("' venc.'");
    // #4: estancadas en Propiedades:
    expect(js).toContain('properties_stale');
    expect(js).toContain("' estanc.'");
    // #8: +N hoy:
    expect(js).toContain('leads_new_24h');
    expect(js).toContain('nav-badge-plus');
  });

  test('admin-app.js: realtime core + ML arrancan en el boot (fix de wiring)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // El canal core existía solo al abrir Chat Redes — ahora también al bootear:
    expect(js).toContain('setupCoreRealtime();');
    // mlCheckStatus después del cache de badges (carrera del estado ML):
    expect(js).toContain("updateSidebarBadges().then(() => { mlCheckStatus()");
  });

  test('admin-app.js: count-up de badges (#5)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('function setBadgeAnimated');
    expect(js).toContain('dataset.num');
    expect(js).toContain('requestAnimationFrame');
  });

  test('admin-app.js: modo offline + anillo del avatar (#21/#36)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('function setRealtimeOnline');
    expect(js).toContain("handleRealtimeStatus(status)");
    expect(js).toContain(".subscribe(handleRealtimeStatus)");
    // El anillo y el tooltip del avatar reflejan el estado:
    expect(js).toContain("avatar.classList.toggle('is-live'");
    expect(js).toContain("'Conectado en tiempo real'");
    // El toast de recuperación solo cuando ya hubo conexión (no en boot):
    expect(js).toContain('_realtimeWasOnline');
    // Al reconectar, el bus refresca los badges:
    expect(js).toContain('scheduleBadgeRefresh(); /* traer lo que pasó');
  });

  test('admin-app.js: writer del chat con clase verde + tooltip (#1)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('function updateSidebarChatBadge');
    expect(js).toContain("badge.classList.toggle('nav-badge--unread', n > 0)");
    expect(js).toContain("' mensajes sin leer'");
  });

  test('admin-portales.js: salud real del webhook ML en el badge (#6)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-portales.js')).text();
    expect(js).toContain('ml_last_event_at');
    expect(js).toContain('ml_failed_24h');
    expect(js).toContain("' Live'");
    expect(js).toContain('lastBadgeCounts');
    // Tooltip con el detalle del estado:
    expect(js).toContain('el.dataset.bhTip = tip');
  });

  test('admin-supervision.js: pulso con alertas abiertas (#7)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-supervision.js')).text();
    expect(js).toContain("classList.add('nav-badge--pulse')");
    expect(js).toContain("classList.remove('nav-badge--pulse')");
  });

  test('admin.css: estilos de señal — unread, warn, plus, pulso, offline, anillo', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    expect(css).toContain('.nav-badge.nav-badge--unread');
    expect(css).toContain('.nav-badge.nav-badge--warn');
    expect(css).toContain('.nav-badge-plus');
    expect(css).toContain('@keyframes badgePulse');
    expect(css).toContain('.nav-badge--pulse');
    expect(css).toContain('#sidebarUserAvatar.is-live');
    expect(css).toContain('.bh-offline .nav-badge');
  });
});
