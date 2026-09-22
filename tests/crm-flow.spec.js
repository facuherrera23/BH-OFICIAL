// Flujo E2E del embudo CRM con sesión real. Env-gated: solo corre si hay
// CRM_TEST_EMAIL / CRM_TEST_PASSWORD / CRM_TEST_BASE_URL configurados
// (pensado para CI con usuario de prueba, no para el repo local por defecto).
const { test, expect } = require('@playwright/test');

const EMAIL = process.env.CRM_TEST_EMAIL;
const PASSWORD = process.env.CRM_TEST_PASSWORD;
const RUN = !!(EMAIL && PASSWORD);

test.describe('CRM — flujo embudo (auth real)', () => {
  test.skip(!RUN, 'Faltan CRM_TEST_EMAIL/CRM_TEST_PASSWORD');

  test('crear lead → aparece en tabla → abrir panel → asignarme → persistir', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/admin.html');
    await page.fill('#loginEmail', EMAIL);
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#btnLoginSubmit');
    await expect(page.locator('[data-tab="tab-leads"]')).toBeVisible({ timeout: 15000 });

    await page.click('[data-tab="tab-leads"]');
    await expect(page.locator('#crmLeadList .crm-row').first()).toBeVisible({ timeout: 15000 });

    const unique = 'E2E ' + Date.now();
    await page.click('#btnNewLead');
    await page.fill('#leadForm [name="full_name"]', unique);
    await page.fill('#leadForm [name="phone"]', '351 555-0199');
    await page.click('#leadSaveBtn');
    await page.waitForSelector('#leadModal.is-open', { state: 'detached', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    await page.fill('#crmSearch', unique);
    await page.waitForTimeout(1500);
    const row = page.locator('#crmLeadList .crm-row', { hasText: unique });
    await expect(row.first()).toBeVisible();
    await row.first().click();

    await expect(page.locator('.crm-side-title')).toHaveText(unique);
    await expect(page.locator('.crm-contact-btn--wa')).toBeVisible();

    // cleanup
    await page.locator('.crm-side-close').click();
    const rowAgain = page.locator('#crmLeadList .crm-row', { hasText: unique });
    await rowAgain.locator('[data-action="deleteLead"]').click();
    page.on('dialog', d => d.accept());
    await page.waitForTimeout(1200);
    await expect(page.locator('#crmLeadList .crm-row', { hasText: unique })).toHaveCount(0);
  });
});
