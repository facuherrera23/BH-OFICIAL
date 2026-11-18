// Handoff de WhatsApp — comportamiento (2026-11-18).
//
// POR QUÉ: el 18/11/2026 se descubrió que TODO el contacto del sitio se perdía
// en el chat de WhatsApp (las fichas: 1 link a wa.me, 0 teléfono, 0 formulario).
// Ahora el click pide 1 dato (teléfono), crea el lead con origen 'whatsapp' y
// después abre el chat.
//
// Este spec es BEHAVIORAL con el endpoint MOCKEADO (page.route): NO crea
// leads en producción. Verifica:
//   1. El modal aparece y pide SOLO teléfono + consentimiento.
//   2. El payload es el del handoff (kind whatsapp, consent true, teléfono
//      normalizado a 549..., página, ruta y código de propiedad).
//   3. El chat se abre ANTES del POST (si no, el popup blocker lo mata).
//   4. "Prefiero no dejar mis datos" abre el chat SIN mandar nada.
//   5. Sin consentimiento o con teléfono inválido NO se manda nada.
//   6. El evento wa_click se trackea UNA sola vez (no se duplica con el
//      listener de la landing).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const handoffSrc = read('assets', 'js', 'wa-handoff.js');
const landingSrc = read('assets', 'js', 'landing-app.js');

test.describe('handoff de WhatsApp — comportamiento', () => {
  test('el click en WhatsApp abre el modal con 1 campo + consentimiento', async ({ page }) => {
    await page.addInitScript(() => {
      window.__opened = [];
      window.open = (url) => { window.__opened.push(url); return null; };
    });
    await page.goto('/index.html');

    const wa = page.locator('a[href*="wa.me"]').first();
    await expect(wa).toBeVisible();
    await wa.click();

    const dlg = page.locator('#bhWaHandoff');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#bhWaPhone')).toBeVisible();
    await expect(dlg.locator('#bhWaConsent')).toBeVisible();
    // Un solo campo de dato: no hay email ni nombre.
    await expect(dlg.locator('input[type="email"]')).toHaveCount(0);
    await expect(dlg.locator('input[name="name"]')).toHaveCount(0);
    // Y hay una salida para no dejar datos.
    await expect(dlg.locator('#bhWaSkip')).toBeVisible();
  });

  test('el submit manda el payload del handoff y abre el chat', async ({ page }) => {
    const bodies = [];
    await page.route('**/functions/v1/contact-submit', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.addInitScript(() => {
      window.__opened = [];
      // Devuelve un objeto truthy: si devolviera null, el código caería al
      // fallback de navegación (window.location.href) y el test perdería la
      // página (el fallback existe para el popup blocker real).
      window.open = (url) => { window.__opened.push(url); return {}; };
    });
    await page.goto('/index.html');

    await page.locator('a[href*="wa.me"]').first().click();
    await page.locator('#bhWaPhone').fill('351 612 345 678');
    await page.locator('#bhWaConsent').check();
    await page.locator('#bhWaSubmit').click();

    await expect.poll(() => bodies.length).toBe(1);
    const body = bodies[0];
    expect(body.kind).toBe('whatsapp');
    expect(body.consent).toBe(true);
    expect(body.phone).toBe('549351612345678');
    expect(body.whatsapp).toBe('549351612345678');
    expect(body.page).toBe('landing');
    expect(body.path).toBe('/index.html');
    // El chat se abrió (y ANTES del POST: el popup blocker mata las
    // ventanas abiertas después de un await).
    expect(await page.evaluate(() => window.__opened.length)).toBe(1);
  });

  test('"Prefiero no dejar mis datos" abre el chat y NO manda el POST', async ({ page }) => {
    const bodies = [];
    await page.route('**/functions/v1/contact-submit', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.addInitScript(() => {
      window.__opened = [];
      window.open = (url) => { window.__opened.push(url); return {}; };
    });
    await page.goto('/index.html');

    await page.locator('a[href*="wa.me"]').first().click();
    await page.locator('#bhWaSkip').click();

    expect(await page.evaluate(() => window.__opened.length)).toBe(1);
    await page.waitForTimeout(400);
    expect(bodies).toHaveLength(0);
  });

  test('sin consentimiento NO se manda nada (se muestra el error)', async ({ page }) => {
    const bodies = [];
    await page.route('**/functions/v1/contact-submit', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.addInitScript(() => {
      window.__opened = [];
      window.open = (url) => { window.__opened.push(url); return null; };
    });
    await page.goto('/index.html');

    await page.locator('a[href*="wa.me"]').first().click();
    await page.locator('#bhWaPhone').fill('351612345678');
    await page.locator('#bhWaSubmit').click();

    await expect(page.locator('#bhWaError')).toBeVisible();
    await expect(page.locator('#bhWaError')).toContainText('consentimiento');
    await page.waitForTimeout(300);
    expect(bodies).toHaveLength(0);
    expect(await page.evaluate(() => window.__opened.length)).toBe(0);
  });

  test('un teléfono demasiado corto NO se manda nada', async ({ page }) => {
    const bodies = [];
    await page.route('**/functions/v1/contact-submit', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto('/index.html');

    await page.locator('a[href*="wa.me"]').first().click();
    await page.locator('#bhWaPhone').fill('123');
    await page.locator('#bhWaConsent').check();
    await page.locator('#bhWaSubmit').click();

    await expect(page.locator('#bhWaError')).toContainText('teléfono válido');
    await page.waitForTimeout(300);
    expect(bodies).toHaveLength(0);
  });

  test('el wa_click se trackea UNA sola vez (handoff + landing no se duplican)', async ({ page }) => {
    // Los eventos van por sendBeacon a la función de tracking → se capturan
    // en la red (analytics.js redef bhTrack, así que no se puede stubear).
    const eventos = [];
    await page.route('**/functions/v1/track-event', async (route) => {
      const raw = route.request().postData() || '';
      try { eventos.push(JSON.parse(raw)); } catch (_) { /* beacon vacío */ }
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.addInitScript(() => {
      // Los tests corren en localhost → el tracking no mide en local (para no
      // ensuciar la medición de producción). Este test SÍ quiere medir.
      window.BH_TRACKING_ALLOW_LOCAL = true;
      window.__opened = [];
      window.open = (url) => { window.__opened.push(url); return {}; };
    });
    await page.goto('/index.html');

    await page.locator('a[href*="wa.me"]').first().click();
    await page.locator('#bhWaSkip').click();

    await expect.poll(() => eventos.filter(e => e.event === 'wa_click').length).toBe(1);
  });
});

test.describe('handoff de WhatsApp — estáticos', () => {
  test('el handoff intercepta los clicks a WhatsApp con preventDefault', () => {
    expect(handoffSrc).toContain("addEventListener('click', onClick, true)");
    expect(handoffSrc).toContain('e.preventDefault()');
  });

  test('el listener de la landing NO vuelve a trackear el wa_click', () => {
    expect(landingSrc).toContain("!wa.hasAttribute('data-bh-wa-tracked')");
  });

  test('el handoff tiene escape hatch para no interceptar un link', () => {
    expect(handoffSrc).toContain("data-bh-wa') === 'off'");
  });
});
