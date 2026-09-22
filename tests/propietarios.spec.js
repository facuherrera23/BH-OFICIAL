// Propietarios — guards de regresión (5 rondas de mejoras del módulo).
const { test, expect } = require('@playwright/test');

test.describe('Propietarios — módulo (rondas 1-5)', () => {
  test('admin.html: sección de la pestaña, búsqueda, KPIs, papelera y botones', async ({ request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('id="tab-propietarios"');
    expect(html).toContain('id="ownersTableBody"');
    expect(html).toContain('id="ownerSearchInput"');
    expect(html).toContain('id="ownerKpiTotal"');
    expect(html).toContain('id="ownerTrashToggle"');
    expect(html).toContain('id="btnNewOwner"');
    expect(html).toContain('data-tab="tab-propietarios"');
  });

  test('admin-app.js: soft-delete, restore, dedupe y validación CUIT', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('toggleOwnersTrash');
    expect(js).toContain('restoreOwner');
    expect(js).toContain("ilike('dni_cuit'");
    // dígito verificador CUIT (11 dígitos, algoritmo módulo 11):
    expect(js).toContain('dígito verificador');
  });

  test('admin-app.js: dedupe de tareas de propietario y tags de documentos', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-app.js')).text();
    expect(js).toContain('existingTask');
    expect(js).toContain('autoKey');
  });

  test('portal-propietario: normalización AR de teléfono (no concatena 549 crudo)', async ({ request }) => {
    const js = await (await request.get('/assets/js/pages/portal-propietario-page.js')).text();
    expect(js).toContain('portalWaNumber');
    expect(js).toContain("indexOf('549')");
    expect(js).not.toContain("'https://wa.me/549' +");
  });

  test('admin-crm.js: owners view sigue funcional tras las rondas del módulo', async ({ request }) => {
    const js = await (await request.get('/assets/js/admin-crm.js')).text();
    expect(js).toContain('loadOwners');
    expect(js).toContain('renderOwnerList');
  });
});
