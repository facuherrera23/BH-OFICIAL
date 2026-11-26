// La Voz — behavioral del modal "Marcar publicado" (2026-11-22).
// Reproduce el flujo completo del empleador contra el JS REAL del panel con
// un cliente Supabase/fetch falsos: el modal no toca la DB ni la red.
const { test, expect } = require('@playwright/test');

const URL_AVISO = 'https://clasificados.lavoz.com.ar/avisos/inmuebles/terreno/5680772/terreno-de-prueba';

test.describe('La Voz — marcar publicado guarda el link', () => {
  test('el click envía confirm con property_id + ad_url + dias/plan y cierra el modal', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e)));
    await page.goto('/tests/helpers/lavoz-confirm-harness.html');
    await expect.poll(() => page.evaluate(() => !!window.__HARNESS_READY)).toBe(true);
    expect(errores).toEqual([]);

    await page.evaluate(() => window.adminApp.lavozPrepare('prop-1'));
    await expect(page.locator('#lavozModal')).toHaveClass(/is-open/);
    await expect(page.locator('#lavozAdUrl')).toBeVisible();
    await expect(page.locator('#lavozAdUrl')).toHaveValue(URL_AVISO);
    await expect(page.locator('[data-lavoz-confirm]')).toHaveAttribute('data-lavoz-confirm', 'prop-1');

    await expect(page.locator('#lavozConfirmDias')).toHaveValue('30');
    await page.locator('#lavozConfirmDias').selectOption('10');
    await page.locator('#lavozConfirmPlan').selectOption('premium');
    await expect(page.locator('#lavozPlanWarn')).toBeVisible();

    /* Fecha real de vencimiento (la que muestra La Voz: "Finaliza dd/mm/aaaa") */
    await expect(page.locator('#lavozVenceEl')).toBeVisible();
    await expect(page.locator('#lavozVenceEl')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await page.locator('#lavozVenceEl').fill('2099-12-31');

    await page.locator('[data-lavoz-confirm]').click();

    await expect.poll(() => page.evaluate(() => window.__FETCH_CALLS.some((c) => c.action === 'confirm'))).toBe(true);
    const confirmCall = await page.evaluate(() => window.__FETCH_CALLS.find((c) => c.action === 'confirm'));
    expect(confirmCall.body.property_id).toBe('prop-1');
    expect(confirmCall.body.ad_url).toBe(URL_AVISO);
    expect(confirmCall.body.dias).toBe(10);
    expect(confirmCall.body.plan).toBe('premium');
    /* La fecha escrita manda: se manda al server como 'YYYY-MM-DD'. */
    expect(confirmCall.body.expires_at).toBe('2099-12-31');

    await expect(page.locator('#lavozModal')).not.toHaveClass(/is-open/);
    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some((t) => /Aviso publicado/.test(String(t.msg || '')))).toBe(true);
    expect(errores).toEqual([]);
  });

  test('una URL inválida NO se guarda', async ({ page }) => {
    await page.goto('/tests/helpers/lavoz-confirm-harness.html');
    await expect.poll(() => page.evaluate(() => !!window.__HARNESS_READY)).toBe(true);
    await page.evaluate(() => window.adminApp.lavozPrepare('prop-1'));
    await expect(page.locator('#lavozAdUrl')).toBeVisible();

    await page.locator('#lavozAdUrl').fill('no-es-una-url');
    await page.locator('[data-lavoz-confirm]').click();
    expect(await page.evaluate(() => window.__FETCH_CALLS.some((c) => c.action === 'confirm'))).toBe(false);
    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some((t) => /no es válida/.test(t.msg))).toBe(true);
  });

  /* BUG real 2026-11-22: un regex de sufijo /lavoz\.com\.ar$/ acepta
     dominios AJENOS (notlavoz.com.ar) y el wizard /publicar/inmuebles también
     es de La Voz. Ninguno es un aviso publicado: marcarlos como tal deja un
     link muerto en el panel y el asistente NO reintentará la publicación. */
  for (const [nombre, url] of [
    ['dominio ajeno', 'https://notlavoz.com.ar/avisos/inmuebles/terreno/5680772/aviso'],
    ['el wizard', 'https://clasificados.lavoz.com.ar/publicar/inmuebles'],
    ['sin id de aviso', 'https://clasificados.lavoz.com.ar/avisos/inmuebles/terreno/'],
  ]) {
    test(`rechaza ${nombre} como URL de aviso publicado`, async ({ page }) => {
      await page.goto('/tests/helpers/lavoz-confirm-harness.html');
      await expect.poll(() => page.evaluate(() => !!window.__HARNESS_READY)).toBe(true);
      await page.evaluate(() => window.adminApp.lavozPrepare('prop-1'));
      await expect(page.locator('#lavozAdUrl')).toBeVisible();

      await page.locator('#lavozAdUrl').fill(url);
      await page.locator('[data-lavoz-confirm]').click();
      expect(await page.evaluate(() => window.__FETCH_CALLS.some((c) => c.action === 'confirm'))).toBe(false);
      const toasts = await page.evaluate(() => window.__TOASTS);
      expect(toasts.some((t) => /no es válida/.test(t.msg))).toBe(true);
    });
  }

  test('una fecha de vencimiento ya pasada NO se guarda', async ({ page }) => {
    await page.goto('/tests/helpers/lavoz-confirm-harness.html');
    await expect.poll(() => page.evaluate(() => !!window.__HARNESS_READY)).toBe(true);
    await page.evaluate(() => window.adminApp.lavozPrepare('prop-1'));
    await expect(page.locator('#lavozAdUrl')).toBeVisible();

    await page.locator('#lavozAdUrl').fill(URL_AVISO);
    await page.locator('#lavozVenceEl').fill('2020-01-01');
    await page.locator('[data-lavoz-confirm]').click();

    expect(await page.evaluate(() => window.__FETCH_CALLS.some((c) => c.action === 'confirm'))).toBe(false);
    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some((t) => /anterior a hoy/.test(t.msg))).toBe(true);
  });

  test('si el server falla, el modal queda abierto y el error se ve', async ({ page }) => {
    await page.goto('/tests/helpers/lavoz-confirm-harness.html');
    await expect.poll(() => page.evaluate(() => !!window.__HARNESS_READY)).toBe(true);
    await page.evaluate(() => { window.__FAIL_CONFIRM = true; });
    await page.evaluate(() => window.adminApp.lavozPrepare('prop-1'));
    await expect(page.locator('#lavozAdUrl')).toBeVisible();

    await page.locator('#lavozAdUrl').fill(URL_AVISO);
    await page.locator('[data-lavoz-confirm]').click();

    await expect.poll(() => page.evaluate(() => window.__FETCH_CALLS.some((c) => c.action === 'confirm'))).toBe(true);
    await expect(page.locator('#lavozModal')).toHaveClass(/is-open/);
    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some((t) => /No se pudo guardar el link/.test(t.msg))).toBe(true);
    expect((await page.evaluate(() => window.__HARNESS_LOG)).some((l) => /lavoz confirm/.test(l))).toBe(true);
  });
});
