// Catálogo público: badge "Tour" en las cards que tienen recorrido en video.
// El índice assets/data/property-videos.json lo genera scripts/generate-ficha.mjs
// (social_posts published + platform youtube). El test lo intercepta con un
// mock para no depender de que haya videos publicados en producción.
const { test, expect } = require('@playwright/test');
const { trackConsoleErrors } = require('./helpers/console');

test.describe('Catálogo: badge de tour en video', () => {
  test('la card de una propiedad con tour muestra el badge, y sin tour no', async ({ page }) => {
    // El catálogo no debe romper con errores de consola (salvo el 404/abort
    // del índice de videos, que es un caso esperado y degradado).
    const consoleErrors = trackConsoleErrors(page, [
      /Failed to load resource/i,
      /net::ERR_FAILED/i,
      /ERR_ABORTED/i,
    ]);

    // 1) Primera carga: descubro el código de una propiedad real del catálogo
    await page.goto('/index.html');
    await expect(page.locator('#propertyGrid [data-property-id]').first()).toBeVisible({ timeout: 20000 });
    const firstHref = await page.locator('#propertyGrid a[href*="/fichas/"]').first().getAttribute('href');
    expect(firstHref).toBeTruthy();
    const code = decodeURIComponent(firstHref.split('/fichas/')[1].replace('.html', ''));

    // 2) Intercepto el índice con un tour para ESA propiedad
    await page.route('**/assets/data/property-videos.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ code, video_id: 'TESTVIDEO123', title: 'Tour de prueba' }]),
      });
    });

    await page.reload();
    await expect(page.locator('#propertyGrid [data-property-id]').first()).toBeVisible({ timeout: 20000 });

    const card = page.locator(`.property-card:has(a[href*="/fichas/${code}.html"])`).first();
    await expect(card).toBeVisible({ timeout: 20000 });
    const badge = card.locator('.card-badge--tour');
    await expect(badge).toHaveCount(1);
    await expect(badge).toContainText('Tour');
    // El badge NO inyecta HTML: el texto es literal
    await expect(badge).toHaveText(/Tour/);

    // 3) Sin el índice (404 / red caída) el catálogo NO se rompe
    await page.unroute('**/assets/data/property-videos.json');
    await page.route('**/assets/data/property-videos.json', (route) => route.abort());
    await page.reload();
    await expect(page.locator('#propertyGrid [data-property-id]').first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.card-badge--tour')).toHaveCount(0);

    // El catálogo no debe romper con errores de consola (salvo el 404/abort
    // del índice de videos, que es un caso esperado y degradado).
    consoleErrors.assertClean();
  });
});
