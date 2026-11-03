// Cartel de la propiedad (lote captación 2026-11-03): el artefacto que
// capta COMPRADORES — QR colgado en la propiedad → ficha pública con
// UTMs (?utm_source=cartel&utm_campaign=CODE) y contacto del agente
// (?de=&tel=, helper agentAttribution compartido con sharePropertyWhatsApp).
// Statics + behavioral (la página con su server local, sin tocar la DB).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cartelHtml = fs.readFileSync(path.join(ROOT, 'qr-propiedad.html'), 'utf8');
const cartelPageJs = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'pages', 'qr-propiedad-page.js'), 'utf8');
const propiedadesSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-propiedades.js'), 'utf8');
const tasacionesSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-tasaciones.js'), 'utf8');
const faCss = fs.readFileSync(path.join(ROOT, 'assets', 'vendor', 'fontawesome', 'css', 'all.min.css'), 'utf8');

test.describe('Cartel de la propiedad — estáticos', () => {
  test('qr-propiedad.html: CSP permite qrserver, noindex, estructura del cartel', () => {
    expect(cartelHtml).toContain("content=\"noindex, nofollow\"");
    expect(cartelHtml).toMatch(/img-src[^;]*api\.qrserver\.com/);
    // Sin supabase-js en la página (no lee la DB) y sin scripts inline.
    expect(cartelHtml).not.toMatch(/<script[^>]*supabase/);
    expect(cartelHtml).not.toMatch(/<script>[^<]*<\/script>/);
    expect(cartelHtml).toContain('assets/js/pages/qr-propiedad-page.js?v=1');
    expect(cartelHtml).toContain('id="qrImg"');
    expect(cartelHtml).toContain('id="printBtn"');
    expect(cartelHtml).toContain('id="refCode"');
    expect(cartelHtml).toContain('id="ctaEl"');
    expect(cartelHtml).toContain('Ley 25.326');
  });

  test('qr-propiedad-page.js: arma el QR a la FICHA con UTMs y contacto del agente', () => {
    // Destino: la ficha pública del código (mismo patrón de share WhatsApp).
    expect(cartelPageJs).toContain("location.origin + '/fichas/' + encodeURIComponent(code) + '.html'");
    expect(cartelPageJs).toContain('utm_source=cartel');
    expect(cartelPageJs).toContain('utm_medium=qr');
    // La campaña es el CÓDIGO de la propiedad (atribución por cartel físico).
    expect(cartelPageJs).toContain("'&utm_campaign=' + encodeURIComponent(code)");
    // El contacto del agente viaja por query (?de=&tel=) — la ficha lo muestra.
    expect(cartelPageJs).toContain("'&de=' + encodeURIComponent(de)");
    expect(cartelPageJs).toContain("'&tel=' + encodeURIComponent(tel)");
    // Botón por listener (cero handler inline) y sin código → estado inválido.
    expect(cartelPageJs).toContain('printBtn.addEventListener');
    expect(cartelPageJs).not.toMatch(/onclick\s*=/);
    expect(cartelPageJs).toContain("if (!code) {");
  });

  test('panel: helper agentAttribution ÚNICO y compartido (no duplicar la feature)', () => {
    // El helper vive una sola vez y lo consumen WhatsApp compartido y el cartel.
    expect(tasacionesSrc).toContain('window.adminApp.agentAttribution');
    const llamadas = (tasacionesSrc.match(/await window\.adminApp\.agentAttribution\(\)/g) || []).length;
    expect(llamadas).toBeGreaterThanOrEqual(2);
    // El cartel usa ese helper: su bloque No tiene query propia (si mañana
    // cambia el pattern del agente, se arregla en UN lado).
    const iOpen = tasacionesSrc.indexOf('window.adminApp.openPropertyQrCartel');
    const iEnd = tasacionesSrc.indexOf("on($('#imagePreviewGrid')", iOpen);
    expect(iOpen).toBeGreaterThan(-1);
    expect(iEnd).toBeGreaterThan(iOpen);
    expect(tasacionesSrc.slice(iOpen, iEnd)).not.toContain('.from(');
  });

  test('panel: botón con data-qr-propiedad, delegación y el ícono existe en FA', () => {
    expect(propiedadesSrc).toMatch(/data-qr-propiedad="\$\{esc\(p\.property_code\)\}"/);
    expect(propiedadesSrc).toContain('fa-house-circle-check');
    expect(propiedadesSrc).toMatch(/title="[^"]*ficha de la propiedad[^"]*"/);
    expect(propiedadesSrc).toMatch(/window\.adminApp\.openPropertyQrCartel\(qrProp\.dataset\.qrPropiedad\)/);
    // El ícono viene de la FA vendida localmente (no la CDN).
    expect(faCss).toContain('house-circle-check');
  });
});

test.describe('Cartel de la propiedad — página servida (local, sin DB)', () => {
  test('con code+agente el QR lleva UTMs y contacto; sin code es estado inválido', async ({ page }) => {
    await page.goto('/qr-propiedad.html?code=DA-P0026&de=Facundo%20P%C3%A9rez&tel=3515550009');
    await expect(page.locator('.brand')).toContainText(/BIENENHAUS/i);
    await expect(page.locator('#printBtn')).toBeVisible();
    const src = await page.locator('#qrImg').getAttribute('src');
    expect(src).toContain('api.qrserver.com');
    // El QR codifica /fichas/DA-P0026.html con UTMs + agente (el data= va
    // urlencodeado entero: '/' → %2F, '=' → %3D).
    expect(src).toContain('fichas%2FDA-P0026.html');
    expect(src).toContain('utm_campaign%3DDA-P0026');
    expect(src).toContain('de%3DFacundo');
    expect(src).toContain('tel%3D3515550009');
    // Y la referencia del código impresa en el cartel.
    await expect(page.locator('#refCode')).toContainText('DA-P0026');
  });

  test('sin code= el cartel no miente (enlace inválido, sin QR ni CTA)', async ({ page }) => {
    await page.goto('/qr-propiedad.html');
    await expect(page.locator('#askEl')).toContainText('Enlace inválido');
    await expect(page.locator('#qrImg')).toBeHidden();
    await expect(page.locator('#ctaEl')).toBeHidden();
    await expect(page.locator('#refCode')).toBeHidden();
  });
});
