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
    // El 406/PGRST116 de la query con id inexistente es esperado y manejado (addComparable + no bloquear).
    const console = trackConsoleErrors(page, [/status of 406/i, /PGRST116/i]);
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

  test('encuesta.html — token inválido muestra error', async ({ page }) => {
    await page.goto('/encuesta.html?token=TEST');
    const console = trackConsoleErrors(page, ALLOWED_406);
    // survey_get_by_token responde available:false → showError con título específico.
    await expect(page.locator('#errorTitle')).toHaveText('Link inválido o expirado');
    await expect(page.locator('#formState')).toBeHidden();
    expect(console.pageErrors).toEqual([]);
    console.assertClean();
  });

  test('encuesta.html — autoguardado: pagehide dispara el flush keepalive', async ({ page }) => {
    // Mock del RPC de carga: la página renderiza el formulario sin tocar producción.
    await page.route('**/rest/v1/rpc/survey_get_by_token', route => {
      return route.fulfill({
        json: {
          available: true,
          property: { title: 'Depto Test', zone: 'Palermo', address: 'Calle Falsa 123', property_code: 'TS-0001' },
          client_first_name: 'Test',
          survey: { answers: {}, finalized: false, submitted_at: null },
        },
      });
    });

    // Captura del flush: el request de keepalive contra survey_submit_by_token.
    const flushPromise = page
      .waitForRequest(r => r.url().includes('/rest/v1/rpc/survey_submit_by_token'), { timeout: 5000 })
      .then(r => ({ url: r.url(), body: r.postData() }));

    await page.goto('/encuesta.html?token=00000000-0000-0000-0000-000000000001');
    await expect(page.locator('#formState')).toBeVisible();

    // El visitante responde algo y cierra la pestaña sin apretar "Enviar".
    await page.evaluate(() => {
      const gen = document.getElementById('s_general');
      gen.value = '8';
      gen.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('t_por_que').value = 'Me gustó la ubicación';
      document.getElementById('t_por_que').dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Simula el cierre de pestaña ANTES de que dispare el debounce de 900ms.
    await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });

    const flush = await flushPromise;
    expect(flush.url).toContain('survey_submit_by_token');
    const body = JSON.parse(flush.body);
    expect(body.p_token).toBe('00000000-0000-0000-0000-000000000001');
    expect(body.p_finalize).toBe(false);
    expect(body.p_answers.general).toBe(8);
    expect(body.p_answers.por_que).toBe('Me gustó la ubicación');
  });
});