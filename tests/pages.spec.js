// Smoke test de las 5 páginas del sistema.
// Cada test navega, verifica título + elemento clave + 0 errores de consola no permitidos.
// Los errores esperados (406 por token TEST en páginas token-based) se permiten por regex.
const { test, expect } = require('@playwright/test');
const { trackConsoleErrors } = require('./helpers/console');

const ALLOWED_406 = [/status of 406/i];

test.describe('Smoke: páginas del sistema', () => {
  test('index.html — landing pública', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page).toHaveTitle(/Bienenhaus|BIENENHAUS/);
    await expect(page.locator('#hero')).toBeVisible();
    const console = trackConsoleErrors(page, ALLOWED_406);
    console.assertClean();
    expect(await page.evaluate(() => document.readyState)).toBe('complete');
  });

  test('admin.html — login screen visible sin sesión', async ({ page }) => {
    await page.goto('/admin.html');
    const console = trackConsoleErrors(page, ALLOWED_406);
    await expect(page.locator('#loginScreen')).toBeVisible();
    await expect(page.locator('#loginForm')).toBeVisible();
    await expect(page.locator('#loginEmail')).toBeVisible();
    await expect(page.locator('#loginPassword')).toBeVisible();
    await expect(page.locator('#btnLoginSubmit')).toBeVisible();
    console.assertClean();
    expect(await page.evaluate(() => document.readyState)).toBe('complete');
  });

  test('tasacion.html — ACM maneja id inexistente sin crash', async ({ page }) => {
    await page.goto('/tasacion.html?id=00000000-0000-0000-0000-000000000000');
    const console = trackConsoleErrors(page, ALLOWED_406);
    // El 406/400 de la query con id inexistente es esperado y manejado (addComparable + no bloquear).
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('#formFieldset')).toBeVisible();
    await expect(page).toHaveTitle(/Tasaci|Análisis/);
    // pageerror = crash JS real, nunca permitido.
    expect(console.pageErrors).toEqual([]);
    console.assertClean();
  });

  test('portal-propietario.html — token inválido muestra error', async ({ page }) => {
    await page.goto('/portal-propietario.html?token=TEST');
    const console = trackConsoleErrors(page, ALLOWED_406);
    // showError muestra el h2 "Link inválido o expirado".
    await expect(page.locator('h2', { hasText: 'Link inválido o expirado' })).toBeVisible();
    expect(console.pageErrors).toEqual([]);
    console.assertClean();
  });

  test('confirmar-visita.html — token inválido muestra error', async ({ page }) => {
    await page.goto('/confirmar-visita.html?token=TEST');
    const console = trackConsoleErrors(page, ALLOWED_406);
    // showError setea #confirmTitle a "Error".
    await expect(page.locator('#confirmTitle')).toHaveText('Error');
    expect(console.pageErrors).toEqual([]);
    console.assertClean();
  });
});