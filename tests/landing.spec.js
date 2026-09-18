// Tests funcionales read-only del landing público (index.html).
// NUNCA se envía el formulario de contacto (insertaría un lead en producción).
const { test, expect } = require('@playwright/test');
const { trackConsoleErrors } = require('./helpers/console');

test.describe('Landing — funcionalidad read-only', () => {
  test('catálogo renderiza propiedades publicadas', async ({ page }) => {
    await page.goto('/index.html');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#propertyGrid')).toBeVisible();
    // El grid se llena async desde Supabase; esperar a que aparezca al menos una card.
    await expect(page.locator('#propertyGrid [data-property-id]').first()).toBeVisible({
      timeout: 20000,
    });
    const cardCount = await page.locator('#propertyGrid [data-property-id]').count();
    expect(cardCount).toBeGreaterThan(0);
    console.assertClean();
  });

  test('búsqueda por texto es interactiva sin errores', async ({ page }) => {
    await page.goto('/index.html');
    const console = trackConsoleErrors(page);
    const search = page.locator('#catalogSearchInput');
    await expect(search).toBeVisible();
    await search.fill('la');
    await page.waitForTimeout(800); // debounce del filtro
    console.assertClean();
  });

  test('sección de contacto y formulario presentes', async ({ page }) => {
    await page.goto('/index.html');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#contacto')).toBeVisible();
    await expect(page.locator('#contactForm')).toBeVisible();
    // Sin submit: escribir en producción está fuera de alcance (read-only).
    console.assertClean();
  });

  test('CSP: index.html con script-src estricto, sin nonce', async ({ page }) => {
    const html = await (await page.request.get('/index.html')).text();
    const cspMeta = html.match(/<meta[^>]*Content-Security-Policy[^>]*>/)?.[0] || '';
    const scriptSrc = cspMeta.match(/script-src[^;]*/)?.[0] || '';
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toMatch(/nonce-/);
  });

  test('pills de interés: selección única funcional', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#propertyGrid [data-property-id]').first()).toBeVisible({ timeout: 20000 });

    const pills = page.locator('.form-options .form-pill');
    await expect(pills).toHaveCount(4);

    const comprar = pills.filter({ hasText: 'Comprar' });
    const alquilar = pills.filter({ hasText: 'Alquilar' });
    await comprar.click();
    await expect(comprar).toHaveClass(/active/);
    await alquilar.click();
    await expect(alquilar).toHaveClass(/active/);
    await expect(comprar).not.toHaveClass(/active/);
  });

  test('H2 del catálogo incluye Córdoba', async ({ page }) => {
    await page.goto('/index.html');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#propertyGrid [data-property-id]').first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.catalog-title')).toContainText('Córdoba');
    console.assertClean();
  });

  test('sección Nosotros: misión, visión y valores presentes', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#nosotros')).toBeVisible();
    await expect(page.locator('#nosotros')).toContainText('Nuestra Misión');
    await expect(page.locator('#nosotros')).toContainText('Nuestra Visión');
    await expect(page.locator('#nosotros .mvv-value')).toHaveCount(3);
    await expect(page.locator('#nosotros')).toContainText('Córdoba');
  });
});
