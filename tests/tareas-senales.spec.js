// Sidebar + CRM — tareas vencidas y próximas 24h: sistema de 3 señales
// (pedido del empleador: "que el botón se ponga en rojo cuando hay tareas vencidas,
//  y que informe lo próximo a vencer para que el agente sepa qué le falta")
const { test, expect } = require('@playwright/test');

test.describe('Tareas vencidas / próximas 24h — sistema de señales', () => {
  test('admin.html: KPIs nuevos (Vencidas + Vencen 24h) y filtro owners vencen_24', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('id="crmKpiVenc"');
    expect(html).toContain('id="crmKpiSoon"');
    expect(html).toContain('crm-kpi--venc');
    expect(html).toContain('crm-kpi--soon');
    expect(html).toContain('<option value="vencen_24">');
  });

  test('admin-crm.js: botón toggle del modo con señal de la OTRA vista', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain('bc.lead_tasks_overdue');
    expect(js).toContain('bc.owner_tasks_overdue');
    expect(js).toContain('crm-toggle--alert');
    expect(js).toContain("venc.' : (otherSoon > 0 ? ' · ' + otherSoon + ' próx.' : '')");
    // Tooltip del botón:
    expect(js).toContain("tareas de leads vencidas");
  });

  test('admin-crm.js: KPIs con conteo de tareas vencidas y próximas 24h (leads + owners)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    // Leads: 7 queries (5 original + vencidas + soon):
    expect(js).toContain("'Tareas vencidas', 'Vencen en 24h'");
    expect(js).toContain("counts[5].count");
    expect(js).toContain("counts[6].count");
    // Owners: 6 queries con vencidas + soon + pendientes:
    expect(js).toContain("'Vencidas', 'Vencen en 24h', 'Tareas pendientes'");
    // Colores por slot según el modo:
    expect(js).toContain("function setKpiColors");
  });

  test('admin-crm.js: filtro KPI tasksOverdue/tasksSoon — server-side con lead_ids', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain("_kpiTaskIds");
    expect(js).toContain("'tasksOverdue'");
    expect(js).toContain("'tasksSoon'");
    expect(js).toContain('KPI_CARD_BINDINGS');
    expect(js).toContain("crmKpiVenc: 'tasksOverdue'");
    expect(js).toContain("crmKpiSoon: 'tasksSoon'");
  });

  test('admin-crm.js: fila de lead con chip rojo de vencida + owners con próximas', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    // Fila de lead: overdue = rojo (nueva clase), soon = ámbar (la vieja --due):
    expect(js).toContain('crm-next-action--overdue');
    // Fila de owner: agrega próximas 24h al chip:
    expect(js).toContain("prox24 + ' próx.)");
    // Filtro de owners vencen_24:
    expect(js).toContain("=== 'vencen_24'");
  });

  test('admin-app.js: badge del sidebar + widget Hoy con señales', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    // Badge "Leads & CRM": vencidas rojo, próximas ámbar:
    expect(js).toContain('nav-badge-venc');
    expect(js).toContain('nav-badge-soon');
    // Widget Hoy: título de Tareas con estado en color:
    expect(js).toContain("' vencida'");
    expect(js).toContain("' en 24h</span>'");
  });

  test('admin.css: 3 señales — danger, warning, y sus clases', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    expect(css).toContain('.nav-badge-venc');
    expect(css).toContain('.nav-badge-soon');
    expect(css).toContain('.crm-kpi--venc');
    expect(css).toContain('.crm-kpi--soon');
    expect(css).toContain('.crm-toggle--alert');
    expect(css).toContain('.crm-toggle--soon');
    expect(css).toContain('.crm-next-action--overdue');
  });

  test('RPC v3 en el repo: vencidas + próximas 24h por tipo', async () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'supabase', 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.includes('tasks_soon'));
    expect(files.length).toBeGreaterThan(0);
    const sql = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8');
    expect(sql).toContain('lead_tasks_soon');
    expect(sql).toContain('owner_tasks_soon');
    expect(sql).toContain("interval '24 hours'");
  });
});
