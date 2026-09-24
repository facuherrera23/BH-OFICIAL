// Genera fichas/<code>.html estáticas para GitHub Pages: páginas indexables
// (title/meta/canonical/JSON-LD) con OG para compartir en WhatsApp.
// También regenera sitemap.xml (home + legales + fichas publicadas).
// Se corre en CI (workflow ficha-generate.yml) con SUPABASE_URL y SERVICE_KEY/ANON_KEY.
import { writeFileSync, mkdirSync } from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const onlyCode = process.env.ONLY_CODE || '';
const SITE_URL = 'https://bienenhaus.com.ar';
const WHATSAPP_CANONICAL = '5493516379651';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY (o ANON para lectura pública)');
  process.exit(1);
}

// Entidades construidas por concatenación para evitar reemplazos en el origen
const ENT_AMP = '&' + 'amp;';
const ENT_LT = '&' + 'lt;';
const ENT_GT = '&' + 'gt;';
const ENT_QUOT = '&' + 'quot;';
const ENT_APOS = '&' + '#39;';
const esc = (s) => (s == null ? '' : String(s)
  .replace(/&/g, ENT_AMP)
  .replace(/</g, ENT_LT)
  .replace(/>/g, ENT_GT)
  .replace(/"/g, ENT_QUOT)
  .replace(/'/g, ENT_APOS));

const TYPE_LABELS = { casa: 'Casa', departamento: 'Departamento', terreno: 'Terreno', local: 'Local', oficina: 'Oficina', galpon: 'Galpón', quinta: 'Quinta', otro: 'Otro' };
const STATUS_LABELS = { venta: 'Venta', alquiler: 'Alquiler', vendido: 'Vendido', alquilado: 'Alquilado', pausado: 'Pausado' };

function buildMetaDescription(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Propiedad en venta y alquiler en Córdoba. Consultá con Bienenhaus Propiedades, tu inmobiliaria en Córdoba.';
  if (clean.length <= 155) return clean;
  const cut = clean.slice(0, 155);
  const lastSpace = cut.lastIndexOf(' ');
  return cut.slice(0, lastSpace > 100 ? lastSpace : 155).trim() + '…';
}

function buildHtml(p) {
  const imgs = (p.image_urls || []).filter((u) => /^https?:\/\//.test(u));
  const hero = imgs[0] || '';
  const ogThumb = hero.includes('res.cloudinary.com') && hero.includes('/upload/')
    ? hero.replace('/upload/', '/upload/w_1200,h_630,c_fill,f_jpg,q_75/')
    : hero;
  const currency = p.price_currency === 'ARS' ? 'ARS' : 'USD';
  const price = p.price_usd
    ? `${p.price_currency === 'ARS' ? '$' : 'USD'} ${Number(p.price_usd).toLocaleString('es-AR')}`
    : 'Consultar';
  const code = p.property_code || '';
  const fichaUrl = `${SITE_URL}/fichas/${code}.html`;
  const rawTitle = String(p.title || '').trim();
  const rawZone = (p.zone || '').trim();
  const zonePart = rawZone && !rawTitle.toLowerCase().includes(rawZone.toLowerCase()) ? rawZone : '';
  // El Ref. garantiza títulos únicos aunque el listado se duplique (evita canibalización SEO)
  const pageTitle = `${rawTitle}${zonePart ? ` — ${zonePart}` : ''} | Bienenhaus Propiedades · ${code}`;
  const metaDescription = buildMetaDescription(p.description);
  const waText = encodeURIComponent(`Hola, me interesa la propiedad ${code} (${p.title}) que vi en bienenhaus.com.ar`);
  const availability = (p.status === 'vendido' || p.status === 'alquilado')
    ? 'https://schema.org/SoldOut'
    : 'https://schema.org/InStock';

  const chips = [];
  if (p.property_type) chips.push(TYPE_LABELS[p.property_type] ?? p.property_type);
  if (p.rooms) chips.push(`${p.rooms} amb.`);
  if (p.bedrooms) chips.push(`${p.bedrooms} dorm.`);
  if (p.bathrooms) chips.push(`${p.bathrooms} baño${p.bathrooms === 1 ? '' : 's'}`);
  const sup = p.surface_total && p.surface_total > 0 ? p.surface_total : (p.surface_covered ?? p.area_m2);
  if (sup) chips.push(`${sup} m²`);
  if (p.garage_spaces) chips.push(`${p.garage_spaces} coch.`);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: p.title,
    url: fichaUrl,
    provider: {
      '@type': 'RealEstateAgent',
      '@id': 'https://bienenhaus.com.ar/#organization',
      name: 'Bienenhaus Propiedades',
      url: 'https://bienenhaus.com.ar/',
      telephone: '+54-9-3516-37-9651',
    },
    ...(metaDescription ? { description: buildMetaDescription(p.description) } : {}),
    ...(rawZone ? {
      address: { '@type': 'PostalAddress', addressLocality: rawZone, addressRegion: 'Córdoba', addressCountry: 'AR' },
    } : {}),
    ...(hero ? { image: [hero] } : {}),
    ...(p.price_usd ? {
      offers: {
        '@type': 'Offer',
        price: Number(p.price_usd),
        priceCurrency: currency,
        availability,
      },
    } : {}),
  };

  // En <script> el contenido es texto crudo (no se decodifican entidades):
  // escapar < como \u003c evita el cierre prematuro de la etiqueta y mantiene JSON válido.
  const jsonLdText = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(metaDescription)}">
<link rel="canonical" href="${esc(fichaUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bienenhaus Propiedades">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(buildMetaDescription(p.description))}">
${ogThumb ? `<meta property="og:image" content="${esc(ogThumb)}">
<meta property="og:image:secure_url" content="${esc(ogThumb)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ogThumb)}">` : ''}
<meta property="og:url" content="${esc(fichaUrl)}">
<script type="application/ld+json">${jsonLdText}</script>
<style>
  :root { --gold:#c9a96e; --bg:#0b0b0d; --card:#141417; --line:#26262c; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Segoe UI', system-ui, sans-serif; background:var(--bg); color:#f0ebe2; }
  .hero { position:relative; width:100%; height:46vh; min-height:280px; max-height:520px; background:#000 center/cover no-repeat; }
  .hero::after { content:''; position:absolute; inset:0; background:linear-gradient(to top, rgba(11,11,13,0.55) 0%, rgba(11,11,13,0.08) 45%, transparent); }
  .hero-head { position:absolute; top:0; left:0; right:0; display:flex; justify-content:space-between; align-items:center; padding:18px 6%; color:#fff; text-shadow:0 1px 4px rgba(0,0,0,0.6); }
  .brand { letter-spacing:3px; font-weight:300; font-size:13px; text-transform:uppercase; }
  .brand b { font-weight:700; }
  .code { font-size:12px; letter-spacing:1px; opacity:0.9; }
  .hero-badge { position:absolute; left:6%; bottom:18px; }
  .badge { display:inline-block; background:var(--gold); color:#131313; font-weight:700; font-size:12px; letter-spacing:2px; padding:7px 16px; border-radius:999px; text-transform:uppercase; }
  h1 { margin:4px 0 6px; font-size:26px; font-weight:600; line-height:1.2; color:#f4efe6; }
  .loc { color:#b9b3a6; margin:0 0 10px; font-size:14.5px; }
  .price { font-size:28px; color:var(--gold); font-weight:700; margin:8px 0 2px; }
  .sheet { margin:-22px auto 60px; background:var(--card); border:1px solid var(--line); border-radius:20px; padding:30px 6%; box-shadow:0 24px 60px rgba(0,0,0,0.5); position:relative; z-index:2; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0 4px; }
  .chip { border:1px solid var(--line); background:#1a1a1f; padding:9px 16px; border-radius:999px; font-size:13.5px; white-space:nowrap; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:2px; color:var(--gold); border-bottom:1px solid var(--line); padding-bottom:10px; margin:30px 0 16px; }
  .desc { line-height:1.75; color:#cfc9bd; white-space:pre-line; font-size:15.5px; }
  .cta-row { display:flex; flex-wrap:wrap; gap:12px; margin-top:26px; }
  .cta { display:inline-flex; align-items:center; gap:10px; background:linear-gradient(135deg, #d9c08a, #c9a96e); color:#141414; padding:15px 30px; border-radius:12px; font-weight:700; text-decoration:none; }
  .cta:hover { transform:translateY(-1px); }
  .cta--outline { background:transparent; border:1.5px solid var(--gold); color:var(--gold); }
  footer { text-align:center; color:#5d584f; font-size:12px; padding:34px 0 26px; }
  footer a { color:#8a8478; }
  @media (max-width:720px){ .hero{height:52vh} h1{font-size:26px} .sheet{margin:-24px 12px 48px; padding:26px 20px} .cta{width:100%; justify-content:center; } }
  @media print {
    @page { margin: 14mm; }
    body { background:#fff !important; color:#1f1c17 !important; }
    .hero { print-color-adjust:exact; -webkit-print-color-adjust:exact; height:9cm; min-height:0; max-height:none; border-radius:12px; overflow:hidden; border:1px solid #ddd; }
    .hero::after { display:none; }
    .badge { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    .sheet { background:#fff !important; border:1px solid #ddd !important; box-shadow:none !important; margin:-18px 0 0; border-radius:14px; }
    h1 { color:#1f1c17 !important; }
    .loc { color:#555349 !important; }
    .price { color:#8a6a2f !important; }
    .chip { background:#f6f3ec !important; border-color:#d9d2c4 !important; color:#3d382f !important; }
    h2 { color:#8a6a2f !important; border-bottom-color:#ddd !important; }
    .desc { color:#33302a !important; }
    .cta { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    .cta-row, .cta { break-inside:avoid; }
    footer { color:#6f6a5f !important; }
    footer a { color:#6f6a5f !important; }
  }
</style>
</head>
<body>
  <header class="hero" style="background-image:url('${esc(hero)}')">
    <div class="hero-head">
      <span class="brand"><b>BIENENHAUS</b> PROPIEDADES</span>
      ${code ? `<span class="code">${esc(code)}</span>` : ''}
    </div>
    <div class="hero-badge"><span class="badge">${esc(STATUS_LABELS[p.status] ?? p.status)}</span></div>
  </header>
  <main class="sheet">
    <h1>${esc(rawTitle)}</h1>
    <p class="loc">${esc([p.zone, p.address].filter(Boolean).join(' - '))}</p>
    <div class="price">${esc(price)}</div>
    ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${String(p.description || '').trim() ? `<h2>Descripción</h2><p class="desc">${esc(p.description)}</p>` : ''}
    <div class="cta-row">
      <a class="cta" href="https://wa.me/${WHATSAPP_CANONICAL}?text=${waText}" target="_blank" rel="noopener">Consultar por WhatsApp</a>
      <a class="cta cta--outline" href="${SITE_URL}/#prop=${encodeURIComponent(code)}" target="_blank" rel="noopener">Ver galería y más propiedades</a>
    </div>
  </main>
  <footer>Bienenhaus Propiedades · CPI 1834 · <a href="${SITE_URL}/" rel="noopener">bienenhaus.com.ar</a></footer>
  <script src="../assets/js/analytics.js" defer></script>
</body>
</html>`;
}

function buildSitemap(props) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE_URL}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${SITE_URL}/politica-de-privacidad.html`, changefreq: 'yearly', priority: '0.3' },
    { loc: `${SITE_URL}/terminos-y-condiciones.html`, changefreq: 'yearly', priority: '0.3' },
    ...props.map((p) => ({ loc: `${SITE_URL}/fichas/${p.property_code}.html`, changefreq: 'weekly', priority: '0.8' })),
  ];
  const body = urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

async function main() {
  const url = new URL(`${SUPABASE_URL}/rest/v1/properties`);
  url.searchParams.set('select', 'id,property_code,title,description,property_type,status,zone,address,price_usd,price_currency,area_m2,surface_covered,surface_total,rooms,bedrooms,bathrooms,garage_spaces,image_urls');
  url.searchParams.set('is_published', 'eq.true');
  url.searchParams.set('deleted_at', 'is.null');
  if (onlyCode) url.searchParams.set('property_code', `eq.${onlyCode}`);

  const res = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const props = await res.json();

  mkdirSync('fichas', { recursive: true });
  const published = props.filter((p) => p.property_code);
  let count = 0;
  for (const p of published) {
    writeFileSync(`fichas/${p.property_code}.html`, buildHtml(p), 'utf8');
    count++;
  }

  if (!onlyCode) {
    writeFileSync('sitemap.xml', buildSitemap(published), 'utf8');
    console.log(`sitemap.xml actualizado (${published.length} fichas)`);
  }
  console.log(`Fichas generadas: ${count}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
