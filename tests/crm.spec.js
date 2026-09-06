// CRM revamp (v2): guards estáticos de la nueva vista de leads.
// Valida markup, carga del módulo y delegación correcta.
const { test, expect } = require('@playwright/test');

test.describe('CRM — estructura del módulo nuevo', () => {
  test('admin.html carga admin-crm.js y admin-crm-tasks.js', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('assets/js/admin-crm.js');
    expect(html).toContain('assets/js/admin-crm-tasks.js');
  });

  test('admin.html define IDs y contenedores del CRM nuevo', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    const ids = [
      'tab-leads', 'crmLeadList', 'crmSidePanel', 'crmSearch', 'crmStatusFilter',
      'crmOriginFilter', 'crmTipoOperacionFilter',
      'crmAgentFilter', 'crmFollowupWrap', 'crmKpiTotal', 'crmKpiNuevo',
      'crmKpiGanados', 'crmKpiPerdidos', 'btnNewLead'
    ];
    for (const id of ids) expect(html).toContain('id="' + id + '"');
    // Kanban viejo removido:
    expect(html).not.toContain('class="leads-pipeline"');
    expect(html).not.toContain('id="col-nuevos"');
  });

  test('admin-crm.js expone window.BH_CRM y toca las tablas correctas', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain('window.BH_CRM');
    expect(js).toContain('window.initCrm');
    for (const table of ['leads', 'lead_activities', 'lead_properties', 'visits']) {
      expect(js).toContain("from('" + table + "')");
    }
    // Soft-delete, nunca DELETE directo:
    expect(js).toContain('deleted_at');
    expect(js).not.toContain(".from('leads').delete(");
  });

  test('admin-crm-tasks.js expone window.CrmTasks', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm-tasks.js')).text();
    expect(js).toContain('window.CrmTasks');
    expect(js).toContain("from('lead_tasks')");
  });

  test('admin-app.js: loadCRM delega en BH_CRM (compat shim)', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('window.BH_CRM');
    expect(js).toContain("módulo nuevo vive en assets/js/admin-crm.js".replace('ó', 'ó'));
    // El schema Zod del modal ahora acepta los nuevos estados:
    expect(js).toContain("'cerrado_ganado'");
    expect(js).toContain("'visita_agendada'");
  });

  test('admin.css incluye estilos del CRM nuevo', async ({ request }) => {
    const css = await (await request.get('/assets/css/admin.css')).text();
    for (const sel of ['.crm-kpi', '.crm-side-panel', '.crm-status-badge', '.crm-task-card', '.crm-pagination']) {
      expect(css).toContain(sel);
    }
  });
});
