// Smoke test de las 5 páginas del sistema.
// Cada test navega, verifica título + elemento clave + 0 errores de consola no permitidos.
// Los errores esperados (406 por token TEST en páginas token-based) se permiten por regex.
const { test, expect } = require('@playwright/test');
const { trackConsoleErrors } = require('./helpers/console');

const ALLOWED_406 = [/status of 406/i];

/* Sesión falsa para el UMD vendido de supabase-js (formato @supabase/auth-js:
   objeto session PLANO en sb-<ref>-auth-token) con un JWT cuyo exp está en
   futuro lejano — el cliente parsea el JWT del access_token en getSession()
   y intentaría refresh (con red) si estuviera vencido. La usa el test del
   ACM en modo agente; sin ella la página cae en modo público (decisión del
   dueño 2026-11-02: el visitante sin sesión PIDE la tasación, no la hace). */
function seedFakeAgentSession(page) {
  const exp = Math.floor(Date.now() / 1000) + 90 * 86400;
  const payload = Buffer.from(JSON.stringify({
    sub: '00000000-0000-0000-0000-000000000000',
    role: 'authenticated',
    aud: 'authenticated',
    exp,
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const session = JSON.stringify({
    access_token: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.fake-signature`,
    token_type: 'bearer',
    expires_in: 7776000,
    expires_at: exp,
    refresh_token: 'fake-refresh-token',
    user: {
      id: '00000000-0000-0000-0000-000000000000',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'agente-test@bienenhaus.test',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  });
  return page.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
  }, ['sb-rnldqiwwzhjnurkguihu-auth-token', session]);
}

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

  // MODO PÚBLICO (decisión del dueño 2026-11-02): sin sesión el visitante solo
  // PIDE la tasación. Este test usa ?id= a propósito: el boot sale temprano y
  // ya no queda NINGUNA query a 'tasaciones' (el 406/PGRST116 esperado del ACM
  // viejo desapareció de diseño — no hay nada que mockear).
  test('tasacion.html — sin sesión: formulario de solicitud público, ACM oculto', async ({ page }) => {
    await page.goto('/tasacion.html?id=00000000-0000-0000-0000-000000000000');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#publicRequestCard')).toBeVisible();
    await expect(page.locator('#formFieldset')).toBeHidden();
    await expect(page.locator('#statusBar')).toBeHidden();
    await expect(page).toHaveTitle(/Tasaci/);
    // pageerror = crash JS real, nunca permitido.
    expect(console.pageErrors).toEqual([]);
    console.assertClean();
  });

  test('tasacion.html — moneda por destino (agente con sesión): alquiler en $, venta en U$S', async ({ page }) => {
    seedFakeAgentSession(page);
    await page.goto('/tasacion.html');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#formFieldset')).toBeVisible();
    const comp = page.locator('.comp-block').first();
    await comp.locator('.c_precio').fill('100000');
    await comp.locator('.c_supCubierta').fill('100');
    await page.locator('#f_supConstruida').fill('100');
    await page.locator('#f_destino').selectOption('Venta');
    await expect(page.locator('#v_valorFinal')).toHaveText(/U\$S/);
    await expect(comp.locator('.c_precioM2')).toHaveValue(/U\$S/);
    await page.locator('#f_destino').selectOption('Alquiler');
    await expect(page.locator('#v_valorFinal')).toHaveText(/^\$/);
    await expect(page.locator('#v_precioPromedio')).toHaveText(/^\$/);
    await expect(comp.locator('.c_precioM2')).toHaveValue(/^\$/);
    await expect(page.locator('#ac_valMin')).toHaveText(/^\$/);
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