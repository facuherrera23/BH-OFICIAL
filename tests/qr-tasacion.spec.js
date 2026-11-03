// Cartel QR de tasación (lote captación 2026-11-03).
// Cada propiedad se convierte en punto de captación 24/7: botón en el panel
// → cartel imprimible con QR → tasacion.html con UTMs que atribuyen el
// canal offline (utm_source=cartel + utm_campaign=<código propiedad>).
// Statics + behavioral (la página con su server local, sin tocar la DB).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cartelHtml = fs.readFileSync(path.join(ROOT, 'qr-tasacion.html'), 'utf8');
const cartelPageJs = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'pages', 'qr-tasacion-page.js'), 'utf8');
const propiedadesSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-propiedades.js'), 'utf8');
const faCss = fs.readFileSync(path.join(ROOT, 'assets', 'vendor', 'fontawesome', 'css', 'all.min.css'), 'utf8');
const tasacionHtml = fs.readFileSync(path.join(ROOT, 'tasacion.html'), 'utf8');

test.describe('Cartel QR de tasación — estáticos', () => {
  test('qr-tasacion.html: CSP permite qrserver, noindex, estructura del cartel', () => {
    expect(cartelHtml).toContain("content=\"noindex, nofollow\"");
    // El QR se genera con la MISA api que ya usa qr-visita (imagen externa).
    expect(cartelHtml).toMatch(/img-src[^;]*api\.qrserver\.com/);
    // Sin supabase-js en la página (no lee la DB) y sin scripts inline.
    expect(cartelHtml).not.toMatch(/<script[^>]*supabase/);
    expect(cartelHtml).not.toMatch(/<script>[^<]*<\/script>/);
    expect(cartelHtml).toContain('assets/js/pages/qr-tasacion-page.js?v=1');
    expect(cartelHtml).toContain('id="qrImg"');
    expect(cartelHtml).toContain('id="printBtn"');
    expect(cartelHtml).toContain('id="refCode"');
    // Footer legal Ley 25.326 (mismo patrón que qr-visita).
    expect(cartelHtml).toContain('Ley 25.326');
  });

  test('qr-tasacion-page.js: arma el QR con UTMs de atribución', () => {
    expect(cartelPageJs).toContain('utm_source=cartel');
    expect(cartelPageJs).toContain('utm_medium=qr');
    // La campaña es el CÓDIGO de la propiedad (atribución por cartel físico).
    expect(cartelPageJs).toContain("'&utm_campaign=' + encodeURIComponent(campaign)");
    // Es el destino el form público de tasación (la página PIDE, no HACE).
    expect(cartelPageJs).toContain("'/tasacion.html'");
    // QR con la misma API que ya usa qr-visita.
    expect(cartelPageJs).toContain('https://api.qrserver.com/v1/create-qr-code/');
    // Botón por listener (cero handler inline): la lección del fix 2026-10-15.
    expect(cartelPageJs).toContain("printBtn.addEventListener");
    expect(cartelPageJs).not.toMatch(/onclick\s*=/);
    // Sin codigo igual funciona (campania genérica 'cartel').
    expect(cartelPageJs).toContain("code || 'cartel'");
  });

  test('panel: botón con data-qr-tasacion, delegación y el ícono existe en FA', () => {
    // El botón vive en la MISMA template que el de WhatsApp (es su vecino).
    expect(propiedadesSrc).toMatch(/data-qr-tasacion="\$\{esc\(p\.property_code\)\}"/);
    expect(propiedadesSrc).toContain('fa-sign-hanging');
    expect(propiedadesSrc).toMatch(/title="[^"]*Cartel imprimible[^"]*"/);
    // Delegación: abre la página del cartel con el código como parámetro.
    expect(propiedadesSrc).toMatch(/qr-tasacion\.html\?code=' \+ encodeURIComponent\(qrCartel\.dataset\.qrTasacion\)/);
    // El ícono viene de la FA vendida localmente (si el ícono no está en el
    // css, el botón queda vacío — cheqeo contra el vendor, no la CDN).
    expect(faCss).toContain('sign-hanging');
  });

  test('el destino del QR es real: tasacion.html existe y persiste UTMs', () => {
    expect(tasacionHtml.length).toBeGreaterThan(1000);
    // La página pública persiste las UTMs desde URL (bhGetUtm) — así el
    // utm_source=cartel llega al lead vía tasacion-submit.
    expect(tasacionHtml).toMatch(/analytics\.js|bhGetUtm|bh_utm/u);
  });
});

test.describe('Cartel QR de tasación — página servida (local, sin DB)', () => {
  test('con ?code= el QR lleva la campaña del código y la referencia se muestra', async ({ page }) => {
    await page.goto('/qr-tasacion.html?code=ML-1234');
    await expect(page.locator('.brand')).toContainText(/BIENENHAUS/i);
    await expect(page.locator('#printBtn')).toBeVisible();
    // El QR codifica el destino con las UTMs (urlencodeado en el data=).
    const src = await page.locator('#qrImg').getAttribute('src');
    expect(src).toContain('api.qrserver.com');
    expect(src).toContain('utm_source%3Dcartel');
    expect(src).toContain('utm_campaign%3DML-1234');
    // Y la referencia impresa en el cartel.
    await expect(page.locator('#refCode')).toContainText('ML-1234');
  });

  test('sin code= el cartel igual sirve (campaña genérica, referencia oculta)', async ({ page }) => {
    await page.goto('/qr-tasacion.html');
    const src = await page.locator('#qrImg').getAttribute('src');
    expect(src).toContain('utm_campaign%3Dcartel');
    await expect(page.locator('#refCode')).toBeHidden();
  });
});
