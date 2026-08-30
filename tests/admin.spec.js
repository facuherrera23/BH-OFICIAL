// Smoke del admin autenticado — GATED por variables de entorno.
// Sin BH_TEST_ADMIN_EMAIL/BH_TEST_ADMIN_PASSWORD la suite se salta (CI pasa igual).
// Con credenciales: login real, dashboard, navegación read-only entre tabs.
// NUNCA crea/edita/elimina datos.
const { test, expect } = require('@playwright/test');
const { trackConsoleErrors } = require('./helpers/console');

const email = process.env.BH_TEST_ADMIN_EMAIL;
const password = process.env.BH_TEST_ADMIN_PASSWORD;

test.describe('Admin — flujo autenticado (read-only)', () => {
  // Sin credenciales en el entorno: todos los tests de este describe se marcan skipped.
  test.skip(!email || !password, 'Requiere BH_TEST_ADMIN_EMAIL y BH_TEST_ADMIN_PASSWORD en el entorno (por seguridad, no se hardcodean)');

  test('login + dashboard + navegación por tabs sin errores', async ({ page }) => {
    await page.goto('/admin.html');
    const console = trackConsoleErrors(page);

    // Login
    await expect(page.locator('#loginScreen')).toBeVisible();
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    page.once('dialog', async (d) => d.dismiss()); // red de seguridad ante cualquier dialog inesperado
    await page.locator('#btnLoginSubmit').click();

    // showApp() agrega is-hidden a loginScreen y muestra appLayout
    await expect(page.locator('#appLayout')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('[data-tab="tab-dashboard"]')).toBeVisible();
    await expect(page.locator('[data-tab="tab-propiedades"]')).toBeVisible();

    // Navegación read-only a un tab con datos (Propiedades)
    await page.locator('[data-tab="tab-propiedades"]').click();
    await expect(page.locator('#tab-propiedades.is-active')).toBeVisible({ timeout: 15000 });

    console.assertClean();
  });

  test('sesión activa persiste en reload (storage del context)', async ({ page }) => {
    await page.goto('/admin.html');
    const console = trackConsoleErrors(page);

    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#btnLoginSubmit').click();
    await expect(page.locator('#appLayout')).toBeVisible({ timeout: 20000 });

    // Reload: la sesión de GoTrue se restaura del storage → la app aparece sin re-login.
    await page.reload();
    await expect(page.locator('#appLayout')).toBeVisible({ timeout: 20000 });
    console.assertClean();
  });
});