// Solicitud de tasación pública (2026-11-02, decisión del dueño): el visitante
// NO hace tasaciones — las PIDE. El tasacionero (ACM) es herramienta interna
// de los agentes. Este spec combina:
//  - Guards ESTÁTICOS (leen archivos, no red ni BD): frm público en el HTML,
//    módulo en tasacion-page.js, manejo actualizado del wizard, endpoint
//    que SOLO crea lead (+ actividad) y nunca inserta en `tasaciones`.
//  - Comportamiento con el endpoint MOCKEADO (page.route): envío feliz
//    (payload correcto, sin legacy `tasacion`) y bloqueo por validación.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { trackConsoleErrors } = require('./helpers/console');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tasacion.html'), 'utf8');
const pageSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'pages', 'tasacion-page.js'), 'utf8');
const fnSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'tasacion-submit', 'index.ts'), 'utf8');
const deploySrc = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');

test.describe('solicitud de tasación — estáticos', () => {
  test('tasacion.html: form de solicitud con contacto, propiedad, honeypot y consent', () => {
    expect(html).toContain('id="publicRequestCard"');
    expect(html).toContain('id="pr_nombre"');
    expect(html).toContain('id="pr_telefono"');
    expect(html).toContain('id="pr_direccion"');
    expect(html).toContain('id="pr_website"'); // honeypot anti-bots
    expect(html).toContain('id="pr_consent"'); // Ley 25.326
  });

  test('tasacion-page.js: módulo público nuevo y manejo del wizard ELIMINADO', () => {
    expect(pageSrc).toContain('function enterPublicRequestMode()');
    expect(pageSrc).toContain('async function submitTasacionRequest()');
    expect(pageSrc).toContain("window.bhTrack('tasacion_request_submit'");
    // Sin rastros del flujo público viejo (guardado público del wizard).
    for (const gone of ['savePublicTasacion', 'promptPublicContact', '_showNoSessionBanner', 'publicContactOverlay']) {
      expect(pageSrc.includes(gone), gone).toBe(false);
    }
  });

  test('tasacion-submit: SOLO crea el lead (+ actividad) — jamás inserta en tasaciones', () => {
    expect(fnSrc).toContain("from('leads')");
    expect(fnSrc).toContain("from('lead_activities')");
    // Clase de bug más cara del proyecto: código contra tablas imaginarias.
    expect(fnSrc.includes("from('tasaciones')"), 'no debe insertar tasaciones').toBe(false);
    // Tolerancia al payload legacy del JS cacheado (solo enriquece notas).
    expect(fnSrc).toContain("payload.tasacion && typeof payload.tasacion === 'object'");
    expect(fnSrc).toContain('{ ok: true, lead: !!leadId, duplicate }');
  });

  test('deploy.yml: tasacion-submit en NO_VERIFY (endpoint público pre-login)', () => {
    const nv = deploySrc.match(/NO_VERIFY=\(([\s\S]*?)\)/);
    expect(nv).toBeTruthy();
    expect(nv[1]).toContain('tasacion-submit');
  });
});

test.describe('solicitud de tasación — comportamiento (endpoint mockeado)', () => {
  test('envío feliz: manda contacto + solicitud (SIN legacy tasacion) y muestra confirmación', async ({ page }) => {
    const bodies = [];
    await page.route('**/functions/v1/tasacion-submit', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, lead: true, duplicate: false }),
      });
    });
    await page.goto('/tasacion.html');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#publicRequestCard')).toBeVisible();
    await page.locator('#pr_nombre').fill('Test Propietario');
    await page.locator('#pr_telefono').fill('+54 9 351 1234567');
    await page.locator('#pr_email').fill('test@ejemplo.com');
    await page.locator('#pr_direccion').fill('Av Test 123, Barrio Test, Córdoba');
    await page.locator('#pr_tipo').selectOption('Casa');
    await page.locator('#pr_operacion').selectOption('Vender');
    await page.locator('#pr_superficie').fill('80 m2');
    await page.locator('#pr_mensaje').fill('Una planta amplia.');
    await page.locator('#pr_consent').check();
    await page.locator('#pr_submit').click();
    await expect(page.locator('#publicRequestCard')).toContainText('¡Solicitud enviada!');
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.name).toBe('Test Propietario');
    expect(body.phone).toBe('+54 9 351 1234567');
    expect(body.consent).toBe(true);
    expect(body.website).toBe(''); // honeypot vacío
    expect(body.solicitud.direccion).toBe('Av Test 123, Barrio Test, Córdoba');
    expect(body.solicitud.tipo).toBe('Casa');
    expect(body.solicitud.operacion).toBe('Vender');
    // El wizard YA NO viaja en el payload.
    expect(body.tasacion).toBeUndefined();
    expect(console.pageErrors).toEqual([]);
    console.assertClean();
  });

  test('sin consentimiento: la validación bloquea el envío', async ({ page }) => {
    await page.goto('/tasacion.html');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#publicRequestCard')).toBeVisible();
    await page.locator('#pr_nombre').fill('Test Propietario');
    await page.locator('#pr_telefono').fill('+54 9 351 1234567');
    await page.locator('#pr_direccion').fill('Av Test 123, Córdoba');
    await page.locator('#pr_submit').click();
    await expect(page.locator('#pr_error')).toBeVisible();
    await expect(page.locator('#pr_error')).toContainText('política');
    expect(console.pageErrors).toEqual([]);
  });
});
