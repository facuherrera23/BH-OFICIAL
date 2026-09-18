// Tests de las páginas indexables de propiedades (fichas/), el sitemap generado
// y la rotación de teléfono/WhatsApp por visita. Read-only contra producción.
const { test, expect } = require('@playwright/test');
const { trackConsoleErrors } = require('./helpers/console');

const PHONES = ['5493516379651', '5493512001437'];

test.describe('Fichas indexables + sitemap', () => {
  test('sitemap incluye home, legales y fichas', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).toContain('https://bienenhaus.com.ar/');
    expect(xml).toContain('politica-de-privacidad.html');
    expect(xml).toContain('terminos-y-condiciones.html');
    const fichaUrls = xml.match(/<loc>https:\/\/bienenhaus\.com\.ar\/fichas\//g) || [];
    expect(fichaUrls.length).toBeGreaterThan(10);
  });

  test('ficha del sitemap: canonical, meta description, JSON-LD válido y sin redirect', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    const firstFicha = (xml.match(/<loc>(https:\/\/bienenhaus\.com\.ar\/fichas\/[^<]+\.html)<\/loc>/) || [])[1];
    expect(firstFicha).toBeTruthy();

    const fileName = firstFicha.split('/').pop();
    const html = await (await request.get(`/fichas/${fileName}`)).text();

    expect(html).not.toContain('window.location.replace');
    expect(html).toMatch(/<link rel="canonical" href="https:\/\/bienenhaus\.com\.ar\/fichas\/[^"]+\.html">/);
    expect(html).toMatch(/<meta name="description" content="[^"]+"/);
    expect(html).toContain('| Bienenhaus Propiedades');

    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(ld).toBeTruthy();
    const parsed = JSON.parse(ld);
    expect(parsed['@type']).toBe('RealEstateListing');
    expect(parsed.url).toContain('/fichas/');
  });

  test('index.html: rotación consistente de teléfono/WhatsApp por visita', async ({ page }) => {
    await page.goto('/index.html');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#propertyGrid [data-property-id]').first()).toBeVisible({ timeout: 20000 });

    const state = await page.evaluate(() => {
      const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
      const wa = document.querySelector('a[href*="wa.me"]')?.getAttribute('href') || '';
      const waFloat = document.querySelector('.whatsapp-float')?.getAttribute('href') || '';
      const contactPhone = document.querySelector('.contact-phone')?.textContent || '';
      const footerPhone = document.querySelector('.footer-phone')?.textContent || '';
      return {
        wa: digits(wa),
        waFloat: digits(waFloat),
        contact: digits(contactPhone).replace(/^54/, '54'),
        footer: digits(footerPhone).replace(/^54/, '54'),
      };
    });

    const valid = PHONES.includes(state.wa);
    expect(valid, `wa.me apunta a un número no configurado: ${state.wa}`).toBe(true);
    expect(state.waFloat).toBe(state.wa);
    expect(state.contact).toBe(state.wa);
    expect(state.footer).toBe(state.wa);
    console.assertClean();
  });

  test('index.html: catálogo paginado de a 9, sin link de ficha en cards', async ({ page }) => {
    await page.goto('/index.html');
    const console = trackConsoleErrors(page);
    await expect(page.locator('#propertyGrid [data-property-id]').first()).toBeVisible({ timeout: 20000 });

    const cards = await page.locator('#propertyGrid .property-card').count();
    expect(cards).toBeLessThanOrEqual(9);

    expect(await page.locator('#propertyGrid').getByText('Ficha completa').count()).toBe(0);

    const total = Number((await page.locator('#resultsCount').textContent() || '').match(/\d+/)?.[0] || 0);
    const pagination = page.locator('#catalogPagination');
    if (total > 9) {
      await expect(pagination).toBeVisible();
      const firstCardPage1 = await page.locator('#propertyGrid [data-property-id]').first().getAttribute('data-property-id');
      await pagination.locator('.page-btn[data-page="2"]:not(.page-btn--nav)').click();
      const firstCardPage2 = await page.locator('#propertyGrid [data-property-id]').first().getAttribute('data-property-id');
      expect(firstCardPage2).not.toBe(firstCardPage1);
      expect(await page.locator('#propertyGrid .property-card').count()).toBeLessThanOrEqual(9);
    } else {
      await expect(pagination).toBeHidden();
    }
    console.assertClean();
  });
});
