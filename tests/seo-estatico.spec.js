// ============================================================
// SEO estático — Fase 3 (2026-11-18)
// ============================================================
// CONTEXTO: la auditoría de captación encontró que la home NO tenía
// ni un link a las fichas en el HTML inicial (el catálogo se arma por
// JS) → un crawler que no ejecuta JS no descubría nada y las 27
// fichas quedaban huérfanas para el link juice interno. Además las
// fichas y la home tenían 0 links tel: (el teléfono existía en el
// JSON-LD y en la rotación A/B, pero no era clickeable ni
// "llamable" desde Google).
//
// Estos guards fijan el contrato:
//   1. Hub estático /propiedades.html generado por el MISMO generador
//      que las fichas (CI), con un <a href> por propiedad.
//   2. La home enlaza ese hub en HTML estático.
//   3. Teléfono visible con tel: en fichas, home y hub.
//   4. El sitemap incluye el hub y usa lastmod REAL por ficha.
//
// NO tocan red ni escriben en fichas/ (sandbox con el generador real).
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { buildSample } = require('./helpers/ficha-sample');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const indexHtml = read('index.html');
const landingApp = read('assets/js/landing-app.js');
const generateFicha = read('scripts/generate-ficha.mjs');

test.describe('SEO estático — hub de propiedades', () => {
  test('el generador produce /propiedades.html con un link por propiedad', () => {
    const { index, props } = buildSample();

    expect(index).toContain('<title>');
    expect(index).toContain('Propiedades en venta y alquiler en <em>Córdoba</em>');
    // Un <a href> por cada ficha (HTML real, no JS).
    for (const p of props) {
      expect(index).toContain(`href="https://bienenhaus.com.ar/fichas/${p.property_code}.html"`);
    }
    expect((index.match(/<a class="card-link" href="https:\/\/bienenhaus\.com\.ar\/fichas\/ML-TEST\d?\.html"/g) || []).length).toBe(props.length);
  });

  test('el hub agrupa por zona (ancla por zona)', () => {
    const { index } = buildSample();
    expect(index).toContain('id="zona-el-cedron"');
    expect(index).toContain('id="zona-nueva-cordoba"');
    // El nav de zonas apunta a esas anclas.
    expect(index).toContain('href="#zona-el-cedron"');
    // La zona con más propiedades va primero (El Cedrón concentra 12 de 27).
    expect(index.indexOf('zona-el-cedron')).toBeLessThan(index.indexOf('zona-nueva-cordoba'));
  });

  test('el hub tiene canonical, robots indexable y JSON-LD ItemList', () => {
    const { index } = buildSample();
    expect(index).toContain('<link rel="canonical" href="https://bienenhaus.com.ar/propiedades.html">');
    expect(index).toContain('content="index, follow');
    expect(index).toContain('"@type":"ItemList"');
    expect(index).toContain('"@type":"BreadcrumbList"');
    expect(index).toContain('"numberOfItems":4');
  });

  test('el hub tiene el tracking, el handoff y el opt-out (igual que las fichas)', () => {
    const { index } = buildSample();
    expect(index).toContain('assets/js/tracking.js?v=');
    expect(index).toContain('assets/js/wa-handoff.js?v=');
    expect(index).toContain('assets/js/analytics.js?v=');
    expect(index).toContain('data-bh-track-optout');
    // CSP: sin connect-src de Supabase el tracking y el handoff mueren en silencio.
    const csp = index.slice(index.indexOf('Content-Security-Policy'));
    const linea = csp.slice(0, csp.indexOf('">'));
    expect(linea).toContain('connect-src');
    expect(linea).toContain('https://*.supabase.co');
  });

  test('el hub lo escribe el MISMO generador que las fichas (nunca queda viejo)', () => {
    expect(generateFicha).toContain("writeFileSync('propiedades.html', buildIndexHtml(published), 'utf8')");
    // Sólo en regeneración completa: con ONLY_CODE el set sería de 1 y
    // dejaría el hub con una sola propiedad.
    const main = generateFicha.slice(generateFicha.indexOf('if (!onlyCode) {'));
    expect(main).toContain("writeFileSync('propiedades.html'");
  });

  test('el CI commitea el hub (si no, nunca se publica)', () => {
    const wf = read('.github/workflows/ficha-generate.yml');
    expect(wf).toContain('propiedades.html');
    // Junto con las fichas y el sitemap, en el mismo git add.
    expect(wf).toMatch(/git add .*fichas\/.*sitemap\.xml.*propiedades\.html/);
  });
});

test.describe('SEO estático — la home enlaza el hub', () => {
  test('la home tiene un link estático al hub (HTML inicial, no JS)', () => {
    expect(indexHtml).toContain('href="/propiedades.html"');
    // Y el catálogo sigue siendo el de la home (no se reemplaza).
    expect(indexHtml).toContain('id="propertyGrid"');
  });

  test('la home y el hub están enlazados entre sí y el hub vuelve a la home', () => {
    const { index } = buildSample();
    expect(index).toContain('href="https://bienenhaus.com.ar/"');
    expect(index).toContain('href="https://bienenhaus.com.ar/tasacion.html"');
  });
});

test.describe('SEO estático — teléfono visible (tel:)', () => {
  test('la home tiene el teléfono como link de llamada', () => {
    expect(indexHtml).toContain('href="tel:+5493516379651"');
    // El texto del link debe ser el número (visible, no un icono).
    expect(indexHtml).toMatch(/<a href="tel:\+5493516379651"[^>]*>\s*\+54 9 3516 37-9651\s*<\/a>/);
  });

  test('la ficha tiene el teléfono como link de llamada', () => {
    const { withoutVideo } = buildSample();
    expect(withoutVideo).toContain('href="tel:+5493516379651"');
    expect(withoutVideo).toContain('+54 9 3516 37-9651');
  });

  test('el hub tiene el teléfono como link de llamada', () => {
    const { index } = buildSample();
    expect(index).toContain('href="tel:+5493516379651"');
  });

  test('la rotación A/B NO desincroniza el texto del link tel:', () => {
    // La rotación es para WhatsApp. Si cambiara el texto de un <a href="tel:">
    // quedaría "+54 9 3512 00-1437" con el href del canónico.
    const fn = landingApp.slice(landingApp.indexOf('function applyRotatingPhone'));
    expect(fn.slice(0, 2000)).toContain("startsWith('tel:')");
  });

  test('el CMS NO rompe el link de llamada (reconstruye el bloque del footer)', () => {
    // El CMS (site_content) reconstruye el .footer-contact-item con innerHTML
    // → si dejara un <span>, el <a href="tel:"> del HTML inicial se perdía y
    // el texto quedaba a merced de la rotación A/B (texto ≠ href).
    const fn = landingApp.slice(landingApp.indexOf('function setFooterValue'));
    expect(fn.slice(0, 1200)).toContain("iconClass === '.fa-phone'");
    expect(fn.slice(0, 1200)).toContain('telHref(value)');
    expect(fn.slice(0, 1200)).toContain('href="\' + escAttr(href)');
    // Y el contacto actualiza el href cuando el CMS cambia el teléfono.
    const cfn = landingApp.slice(landingApp.indexOf('function setContactValue'));
    expect(cfn.slice(0, 1200)).toContain("val.setAttribute('href', href)");
    // El helper que arma el href de llamada:
    expect(landingApp).toContain('function telHref(value)');
  });
});

test.describe('SEO estático — Cloudflare Web Analytics (CSP)', () => {
  /* El beacon de Cloudflare (static.cloudflareinsights.com/beacon.min.js) lo
     inyecta Cloudflare en TODAS las páginas. Si la CSP no lo permite en
     script-src, el navegador lo bloquea con un error de consola y la
     medición NO existe en esa página (silenciosamente). Antes: la home,
     canal, encuesta, confirmar-visita, portal y admin lo permitían, pero
     las 27 fichas y el hub NO → se perdía la medición justo en las páginas
     que más tráfico reciben. */
  const cspDe = (html) => {
    const m = html.match(/Content-Security-Policy[^>]*content="([^"]+)"/);
    return m ? m[1] : '';
  };

  test('la ficha permite el beacon de Cloudflare Insights (script-src + connect-src)', () => {
    const { withoutVideo } = buildSample();
    const csp = cspDe(withoutVideo);
    expect(csp).toContain('https://static.cloudflareinsights.com');
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] || '';
    expect(scriptSrc).toContain('https://static.cloudflareinsights.com');
    const connectSrc = csp.match(/connect-src[^;]*/)?.[0] || '';
    expect(connectSrc).toContain('https://static.cloudflareinsights.com');
    expect(connectSrc).toContain('https://api.cloudflareinsights.com');
    /* El beacon NO postea a api.cloudflareinsights.com: postea a
       /cdn-cgi/rum en el MISMO origen (bienenhaus.com.ar) → sin 'self' en
       connect-src el POST se bloquea y la medición no llega. */
    expect(connectSrc).toContain("'self'");
  });

  test('el hub permite el beacon de Cloudflare Insights (script-src + connect-src)', () => {
    const { index } = buildSample();
    const csp = cspDe(index);
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] || '';
    expect(scriptSrc).toContain('https://static.cloudflareinsights.com');
    const connectSrc = csp.match(/connect-src[^;]*/)?.[0] || '';
    expect(connectSrc).toContain('https://static.cloudflareinsights.com');
    expect(connectSrc).toContain('https://api.cloudflareinsights.com');
    expect(connectSrc).toContain("'self'");
  });

  test('la home ya lo permitía (referencia: el hub y las fichas copian su forma)', () => {
    const csp = cspDe(indexHtml);
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] || '';
    const connectSrc = csp.match(/connect-src[^;]*/)?.[0] || '';
    expect(scriptSrc).toContain('https://static.cloudflareinsights.com');
    expect(connectSrc).toContain('https://api.cloudflareinsights.com');
  });

  /* Auditoría 28/11/2026: tasacion, política de privacidad, qr-visita y
     alquileres cargaban tracking.js pero su CSP bloqueaba el beacon; y
     términos/403/404 no tenían CSP. El beacon se inyecta en TODAS las
     páginas → sin este guard cada página nueva puede perder medición
     silenciosamente (error de consola, cero datos). */
  const PAGINAS_PUBLICAS = [
    'index.html', 'propiedades.html', 'canal.html', 'tasacion.html',
    'encuesta.html', 'portal-propietario.html', 'confirmar-visita.html',
    'politica-de-privacidad.html', 'terminos-y-condiciones.html',
    'qr-visita.html', 'qr-tasacion.html', 'qr-propiedad.html',
    'admin.html', 'alquileres.html', '403.html', '404.html',
  ];

  test('todas las páginas HTML tienen CSP y permiten el beacon de Cloudflare', () => {
    for (const pagina of PAGINAS_PUBLICAS) {
      const csp = cspDe(read(pagina));
      expect(csp, `${pagina} no tiene CSP`).not.toBe('');

      const scriptSrc = csp.match(/script-src[^;]*/)?.[0] || '';
      expect(scriptSrc, `${pagina}: script-src sin beacon`).toContain('https://static.cloudflareinsights.com');

      const connectSrc = csp.match(/connect-src[^;]*/)?.[0] || '';
      expect(connectSrc, `${pagina}: connect-src sin beacon`).toContain('https://static.cloudflareinsights.com');
      expect(connectSrc, `${pagina}: connect-src sin api`).toContain('https://api.cloudflareinsights.com');
      // El beacon postea a /cdn-cgi/rum en el MISMO origen, no a api.
      expect(connectSrc, `${pagina}: connect-src sin 'self'`).toContain("'self'");
    }
  });
});

test.describe('SEO estático — sitemap', () => {
  test('el sitemap incluye el hub con prioridad alta', () => {
    const { sitemap } = buildSample();
    expect(sitemap).toContain('<loc>https://bienenhaus.com.ar/propiedades.html</loc>');
    // Antes era la fecha de generación para TODAS las urls → Google lo ignora.
    expect(sitemap).toContain('<priority>0.9</priority>');
  });

  test('el sitemap usa lastmod REAL por ficha (updated_at)', () => {
    const { sitemap } = buildSample();
    // La ficha de muestra tiene updated_at 2026-11-10 → ese date va en su lastmod.
    expect(sitemap).toContain('<loc>https://bienenhaus.com.ar/fichas/ML-TEST2.html</loc>');
    expect(sitemap).toContain('<lastmod>2026-11-10</lastmod>');
    expect(sitemap).toContain('<lastmod>2026-11-15</lastmod>');
    // Y el generador pide updated_at en el select.
    expect(generateFicha).toContain('updated_at,agents(');
  });
});
