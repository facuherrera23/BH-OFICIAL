// Harness funcional del modo Propietarios del CRM (2026-10-30).
// Corre admin-crm.js REAL en el navegador contra un cliente Supabase falso:
// verifica el filtro de estado comercial, el chip DESACTIVADO, los botones
// de desactivar/reactivar y los KPIs. NO toca la base de datos.
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/helpers/crm-owners-harness.html';

async function boot(page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__HARNESS_READY === true);
  // initCrm() binds the filters; openOwners() switches the CRM to the
  // "Propietarios" mode (same entry point the app uses from the sidebar).
  await page.evaluate(() => { window.initCrm(); });
  await page.evaluate(() => { window.BH_CRM.openOwners(); });
  // Esperar el primer render del padrón.
  await page.waitForFunction(() => document.querySelectorAll('#crmLeadList .crm-row').length > 0);
}

test.describe('CRM — UI del propietario desactivado (harness local)', () => {
  test('el padrón arranca en "activos": no muestra al dueño desactivado', async ({ page }) => {
    await boot(page);
    const html = await page.locator('#crmLeadList').innerHTML();
    expect(html).toContain('Roberto Activo');
    expect(html).not.toContain('Mirta Desactivada');
    // El chip DESACTIVADO no aparece (no hay desactivados en la vista).
    expect(html).not.toContain('DESACTIVADO');
    await expect(page.locator('#crmSubtitle')).toHaveText('1 propietarios');
  });

  test('el filtro "desactivados" muestra al dueño inactivo con su chip y motivo', async ({ page }) => {
    await boot(page);
    await page.selectOption('#crmOwnerStatusFilter', 'inactivos');
    await page.waitForFunction(() => document.querySelector('#crmLeadList')?.textContent.includes('Mirta Desactivada'));

    const html = await page.locator('#crmLeadList').innerHTML();
    expect(html).toContain('Mirta Desactivada');
    expect(html).toContain('DESACTIVADO');
    // El motivo queda visible en el tooltip del chip.
    expect(html).toContain('Vendió ML-1234');
    // Y el botón es "Reactivar" (no "Desactivar").
    expect(html).toContain('data-action="reactivateOwner"');
    expect(html).not.toContain('data-action="deactivateOwner"');
    await expect(page.locator('#crmSubtitle')).toHaveText('1 propietarios (desactivados)');
  });

  test('el filtro "todos" muestra ambos, cada uno con su estado', async ({ page }) => {
    await boot(page);
    await page.selectOption('#crmOwnerStatusFilter', 'todos');
    await page.waitForFunction(() => document.querySelectorAll('#crmLeadList .crm-row').length === 2);
    const html = await page.locator('#crmLeadList').innerHTML();
    expect(html).toContain('Roberto Activo');
    expect(html).toContain('Mirta Desactivada');
    expect(html).toContain('DESACTIVADO');
    expect(html).toContain('EXCLUSIVO');
    await expect(page.locator('#crmSubtitle')).toHaveText('2 propietarios (todos)');
  });

  test('buscar ignora el filtro "activos" (el historial sigue siendo accesible)', async ({ page }) => {
    await boot(page);
    await page.fill('#crmSearch', 'Mirta');
    await page.waitForFunction(() => document.querySelector('#crmLeadList')?.textContent.includes('Mirta Desactivada'));
    const html = await page.locator('#crmLeadList').innerHTML();
    expect(html).toContain('Mirta Desactivada');
    expect(html).toContain('DESACTIVADO');
    await expect(page.locator('#crmSubtitle')).toHaveText('1 propietarios (filtro · incluye desactivados)');
  });

  test('el botón Desactivar delega en adminApp.setOwnerStatus(id, "inactivo")', async ({ page }) => {
    await boot(page);
    await page.click('#crmLeadList [data-action="deactivateOwner"]');
    await page.waitForFunction(() => window.__OWNER_STATUS_CALLS.length > 0);
    const calls = await page.evaluate(() => window.__OWNER_STATUS_CALLS);
    expect(calls[0].id).toBe('11111111-1111-1111-1111-111111111111');
    expect(calls[0].nextStatus).toBe('inactivo');
  });

  test('el botón Reactivar delega en adminApp.setOwnerStatus(id, "activo")', async ({ page }) => {
    await boot(page);
    await page.selectOption('#crmOwnerStatusFilter', 'inactivos');
    await page.waitForFunction(() => document.querySelector('#crmLeadList [data-action="reactivateOwner"]'));
    await page.click('#crmLeadList [data-action="reactivateOwner"]');
    await page.waitForFunction(() => window.__OWNER_STATUS_CALLS.length > 0);
    const calls = await page.evaluate(() => window.__OWNER_STATUS_CALLS);
    expect(calls[0].id).toBe('22222222-2222-2222-2222-222222222222');
    expect(calls[0].nextStatus).toBe('activo');
  });

  test('KPIs del padrón: 7 slots, "Desactivados" = 1 y solo activos en el resto', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(() => document.querySelector('#crmKpiPend')?.textContent !== '');

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('#tab-leads .crm-kpis .crm-kpi-label')].map(e => e.textContent)
    );
    expect(labels[0]).toBe('Propietarios');
    expect(labels[1]).toBe('Exclusivos');
    expect(labels[2]).toBe('Vencidas');
    expect(labels[3]).toBe('Vencen en 24h');
    expect(labels[4]).toBe('Tareas pendientes');
    expect(labels[5]).toBe('Propiedades');
    expect(labels[6]).toBe('Desactivados');
    // El 8to slot queda oculto en modo propietarios.
    const hidden = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#tab-leads .crm-kpis .crm-kpi')];
      return cards[7]?.style.display === 'none';
    });
    expect(hidden).toBe(true);

    // Propietarios = 1 (solo el activo), Desactivados = 1, Propiedades = 1
    // (la del dueño activo; la del desactivado no cuenta).
    await expect(page.locator('#crmKpiTotal')).toHaveText('1');
    await expect(page.locator('#crmKpiNuevo')).toHaveText('1'); // exclusivos
    await expect(page.locator('#crmKpiSoon')).toHaveText('1'); // propiedades de activos
    await expect(page.locator('#crmKpiPend')).toHaveText('1'); // desactivados
  });

  test('la card "Desactivados" filtra el padrón por estado (click = KPI)', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(() => document.querySelector('#crmKpiPend')?.textContent === '1');
    await page.click('#tab-leads .crm-kpis .crm-kpi:nth-child(7)');
    await page.waitForFunction(() => document.querySelector('#crmLeadList')?.textContent.includes('Mirta Desactivada'));
    await expect(page.locator('#crmOwnerStatusFilter')).toHaveValue('inactivos');
  });

  test('en modo propietarios solo la card "Desactivados" es clickeable', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(() => document.querySelector('#crmKpiPend')?.textContent !== '');
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('#tab-leads .crm-kpis .crm-kpi')].map(c => ({
        label: c.querySelector('.crm-kpi-label')?.textContent,
        btn: c.classList.contains('crm-kpi--btn'),
        active: c.classList.contains('is-active')
      }))
    );
    const clickable = cards.filter(c => c.btn).map(c => c.label);
    expect(clickable).toEqual(['Desactivados']);
    // Ninguna arranca "activa" (el filtro por defecto es activos).
    expect(cards.filter(c => c.active)).toHaveLength(0);
  });

  test('clickear una card sin binding en este modo no cambia el filtro', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(() => document.querySelector('#crmKpiPend')?.textContent !== '');
    // "Exclusivos" no es filtrable en modo propietarios.
    await page.click('#tab-leads .crm-kpis .crm-kpi:nth-child(2)');
    await page.waitForTimeout(200);
    await expect(page.locator('#crmOwnerStatusFilter')).toHaveValue('activos');
    const html = await page.locator('#crmLeadList').innerHTML();
    expect(html).toContain('Roberto Activo');
    expect(html).not.toContain('Mirta Desactivada');
  });

  test('el banner de alertas informa cuántos propietarios están desactivados', async ({ page }) => {
    await boot(page);
    await page.waitForFunction(() => (document.querySelector('#crmOwnerAlerts')?.textContent || '').length > 0);
    const txt = await page.locator('#crmOwnerAlerts').innerText();
    expect(txt).toContain('1 propietario desactivado');
    expect(txt).toContain('historial conservado');
  });

  test('sin super_admin no se muestran los botones de estado', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'currentProfile', {
        value: { role: 'broker' }, writable: true, configurable: true
      });
    });
    await page.goto(HARNESS);
    await page.waitForFunction(() => window.__HARNESS_READY === true);
    await page.evaluate(() => {
      window.currentProfile = { role: 'broker' };
      window.initCrm();
      window.BH_CRM.openOwners();
    });
    await page.waitForFunction(() => document.querySelectorAll('#crmLeadList .crm-row').length > 0);
    const html = await page.locator('#crmLeadList').innerHTML();
    expect(html).not.toContain('data-action="deactivateOwner"');
    expect(html).not.toContain('data-action="reactivateOwner"');
  });
});
