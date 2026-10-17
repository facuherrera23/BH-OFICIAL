// Propietarios — guards de regresión.
// 2026-10-17: el tab Propietarios se retiró del sidebar (duplicaba el CRM) y el
// padrón vive 100% en el modo "Propietarios" del CRM. El engine de edición
// (modales, CUIT, dedupe, papelera, exports) sigue en admin-propietarios.js.
const { test, expect } = require('@playwright/test');

test.describe('Propietarios — padrón dentro del CRM (post-migración)', () => {
  test('admin.html: sin tab ni item de sidebar duplicado; acceso por CRM completo', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    // Lo que ya NO existe (migración al CRM):
    expect(html).not.toContain('data-tab="tab-propietarios"');
    expect(html).not.toContain('id="tab-propietarios"');
    expect(html).not.toContain('id="sideBadgeOwners"');
    expect(html).not.toContain('id="ownersTableBody"');
    expect(html).not.toContain('id="ownerSearchInput"');
    // El acceso por CRM sigue completo:
    expect(html).toContain('id="crmModeToggle"');
    expect(html).toContain('id="btnNewOwnerCrm"');
    expect(html).toContain('id="btnGenerateTokenCrm"');
    expect(html).toContain('id="btnExportOwnersCsvCrm"');
    expect(html).toContain('id="btnExportOwnersPdfCrm"');
    expect(html).toContain('id="crmOwnerAlerts"');
    // El editor (modales) sobrevive fuera del tab removido:
    expect(html).toContain('id="ownerModal"');
    expect(html).toContain('id="portalLinkModal"');
  });

  test('admin-propietarios.js: engine intacto — soft-delete, restore, dedupe y validación CUIT', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-propietarios.js')).text();
    expect(js).toContain('toggleOwnersTrash');
    expect(js).toContain('restoreOwner');
    expect(js).toContain("ilike('dni_cuit'");
    // dígito verificador CUIT (11 dígitos, algoritmo módulo 11):
    expect(js).toContain('dígito verificador');
    // nul-safe tras la remoción del tab: su loadOwners debe cortar si el DOM viejo no existe
    expect(js).toContain("$('#ownersTableBody')");
    expect(js).toContain('if (!tbody) return');
    // exports reutilizados por los botones del CRM:
    expect(js).toContain('window.adminApp.exportOwnersCSV');
    expect(js).toContain('window.adminApp.exportOwnersPDF');
  });

  test('admin-propietarios.js: dedupe de tareas de propietario y tags de documentos', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-propietarios.js')).text();
    expect(js).toContain('existingTask');
    expect(js).toContain('autoKey');
  });

  test('portal-propietario: normalización AR de teléfono (no concatena 549 crudo)', async ({ request }) => {
    const js = await (await request.get('/assets/js/pages/portal-propietario-page.js')).text();
    expect(js).toContain('portalWaNumber');
    expect(js).toContain("indexOf('549')");
    expect(js).not.toContain("'https://wa.me/549' +");
  });

  test('admin-crm.js: vista Propietarios del CRM — papelera, alertas y acceso externo', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain('loadOwners');
    expect(js).toContain('renderOwnerList');
    // Modo papelera propio del CRM (antes solo existía en el tab):
    expect(js).toContain('_ownerTrash');
    expect(js).toContain('data-action="restoreOwner"');
    // Banner de alertas del padrón (exclusividad, DNI/CUIT):
    expect(js).toContain('renderOwnerAlerts');
    expect(js).toContain('crmOwnerAlerts');
    // Apertura externa (búsqueda global redirige al CRM):
    expect(js).toContain('openOwners');
  });

  test('admin-app.js: sin referencias al tab removido; búsqueda global redirige al CRM', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).not.toContain("'tab-propietarios'");
    expect(js).not.toContain('sideBadgeOwners');
    expect(js).toContain('openOwners(o.id)');
    // Sidebar colapsable (desktop):
    expect(js).toContain('bh_sidebar_collapsed');
    expect(js).toContain('sidebarCollapseToggle');
  });
});
