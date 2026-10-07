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
const TYPE_ICONS = { casa: 'fa-house', departamento: 'fa-building', terreno: 'fa-map', local: 'fa-store', oficina: 'fa-briefcase', galpon: 'fa-warehouse', quinta: 'fa-tree', otro: 'fa-building' };

function buildMetaDescription(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Propiedad en venta y alquiler en Córdoba. Consultá con Bienenhaus Propiedades, tu inmobiliaria en Córdoba.';
  if (clean.length <= 155) return clean;
  const cut = clean.slice(0, 155);
  const lastSpace = cut.lastIndexOf(' ');
  return cut.slice(0, lastSpace > 100 ? lastSpace : 155).trim() + '…';
}

function buildHtml(p, allProps) {
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

  /* Mapa: 27/29 propiedades tienen coordenadas */
  const hasCoords = typeof p.latitude === 'number' && typeof p.longitude === 'number';
  const mapBbox = hasCoords
    ? `${p.longitude - 0.008},${p.latitude - 0.004},${p.longitude + 0.008},${p.latitude + 0.004}`
    : '';
  const gmapsUrl = hasCoords ? `https://maps.google.com/?q=${p.latitude},${p.longitude}` : '';

  /* Broker asignado (si tiene nombre) */
  const broker = p.agents && p.agents.full_name
    ? { name: p.agents.full_name, phone: p.agents.phone || '', photo: p.agents.photo_url || '' }
    : null;

  /* Propiedades relacionadas: misma zona, con foto, hasta 3 */
  const related = (allProps || [])
    .filter((x) => x.id !== p.id && rawZone && x.zone === rawZone && (x.image_urls || []).some((u) => /^https?:\/\//.test(u)))
    .slice(0, 3)
    .map((x) => ({
      code: x.property_code,
      title: String(x.title || '').trim(),
      zone: (x.zone || '').trim(),
      price: x.price_usd ? `${x.price_currency === 'ARS' ? '$' : 'USD'} ${Number(x.price_usd).toLocaleString('es-AR')}` : 'Consultar',
      img: (x.image_urls || []).find((u) => /^https?:\/\//.test(u)) || '',
    }));

  const sup = p.surface_total && p.surface_total > 0 ? p.surface_total : (p.surface_covered ?? p.area_m2);
  const supCub = p.surface_covered && p.surface_covered > 0 ? p.surface_covered : null;

  /* Ficha premium: grilla de características con íconos (reemplaza a los chips) */
  const specs = [];
  specs.push({ icon: TYPE_ICONS[p.property_type] || 'fa-building', label: 'Tipo de propiedad', value: TYPE_LABELS[p.property_type] ?? p.property_type });
  if (p.rooms) specs.push({ icon: 'fa-door-open', label: 'Ambientes', value: String(p.rooms) });
  if (p.bedrooms) specs.push({ icon: 'fa-bed', label: 'Dormitorios', value: String(p.bedrooms) });
  if (p.bathrooms) specs.push({ icon: 'fa-bath', label: 'Baños', value: String(p.bathrooms) });
  if (sup) specs.push({ icon: 'fa-ruler-combined', label: 'Superficie total', value: `${sup} m²` });
  if (supCub) specs.push({ icon: 'fa-vector-square', label: 'Superficie cubierta', value: `${supCub} m²` });
  if (p.garage_spaces) specs.push({ icon: 'fa-car', label: 'Cocheras', value: String(p.garage_spaces) });
  if (p.year_built) specs.push({ icon: 'fa-calendar', label: 'Año de construcción', value: String(p.year_built) });

  /* Galería: hasta 6 fotos adicionales a la del hero; si sobran, el último tile
     linkea al sitio con "+N fotos" */
  const gallery = imgs.slice(1, 7);
  const remaining = Math.max(0, imgs.length - 7);

  /* Precio por m² (solo si hay precio y superficie) */
  const pricePerM2 = p.price_usd && sup
    ? `${currency === 'ARS' ? '$' : 'USD'} ${Math.round(p.price_usd / sup).toLocaleString('es-AR')}/m²`
    : '';

  /* Descripción en bloques: el primero lleva estilo lead (editorial) */
  const descBlocks = String(p.description || '').trim()
    ? String(p.description).trim().split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
    : [];

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
    ...(metaDescription ? { description: metaDescription } : {}),
    ...(rawZone ? {
      address: { '@type': 'PostalAddress', addressLocality: rawZone, addressRegion: 'Córdoba', addressCountry: 'AR' },
    } : {}),
    ...(hero ? { image: [hero] } : {}),
    ...(p.rooms ? { numberOfRooms: p.rooms } : {}),
    ...(sup ? { floorSize: { '@type': 'QuantitativeValue', value: sup, unitCode: 'MTK' } } : {}),
    ...(p.price_usd ? {
      offers: {
        '@type': 'Offer',
        price: Number(p.price_usd),
        priceCurrency: currency,
        availability,
      },
    } : {}),
  };
  const jsonLdBreadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: 'Propiedades', item: `${SITE_URL}/#propiedades` },
      { '@type': 'ListItem', position: 3, name: code || 'Ficha', item: fichaUrl },
    ],
  };

  // En <script> el contenido es texto crudo (no se decodifican entidades):
  // escapar < como \u003c evita el cierre prematuro de la etiqueta y mantiene JSON válido.
  const jsonLdText = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
  const jsonLdBreadcrumbText = JSON.stringify(jsonLdBreadcrumb).replace(/</g, '\\u003c');

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
<script type="application/ld+json">${jsonLdBreadcrumbText}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
  /* Ficha v3 con la identidad visual del sitio (landing.css): teal #1FC8C3,
     Playfair Display en títulos y Plus Jakarta Sans en el cuerpo. */
  :root { --bg:#020305; --bg2:#05070A; --card:rgba(13,17,23,0.94); --card2:#0A0D12; --line:rgba(255,255,255,0.08); --line-accent:rgba(31,200,195,0.38); --accent:#1FC8C3; --accent-deep:#159a95; --text:#F8FAFC; --text2:#CBD5E1; --text3:#94A3B8; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Plus Jakarta Sans', system-ui, sans-serif; background:
    radial-gradient(1100px 480px at 50% -120px, rgba(31,200,195,0.08), transparent 65%), var(--bg);
    color:var(--text); -webkit-font-smoothing:antialiased; }
  .hero { position:relative; width:100%; height:54vh; min-height:400px; max-height:640px; background:#000 center/cover no-repeat; cursor:zoom-in; }
  .hero::after { content:''; position:absolute; inset:0; background:linear-gradient(to top, var(--bg) 0%, rgba(2,3,5,0.62) 34%, rgba(2,3,5,0.16) 58%, rgba(2,3,5,0.42) 100%); }
  .hero-top { position:absolute; top:18px; left:4%; right:4%; display:flex; justify-content:space-between; align-items:center; gap:12px; z-index:2; pointer-events:none; }
  .glass { background:rgba(2,3,5,0.55); border:1px solid rgba(255,255,255,0.14); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); border-radius:999px; color:#fff; }
  .brand-pill { padding:10px 20px; font-size:12px; letter-spacing:2.5px; font-weight:300; text-transform:uppercase; white-space:nowrap; }
  .brand-pill b { font-weight:700; color:var(--accent); }
  .ref-chip { padding:10px 16px; font-size:12px; letter-spacing:1px; opacity:0.95; white-space:nowrap; }
  .hero-foot { pointer-events:none; position:absolute; left:6%; right:6%; bottom:28px; z-index:2; }
  .badge { display:inline-block; background:linear-gradient(135deg, var(--accent), var(--accent-deep)); color:#020305; font-weight:700; font-size:11.5px; letter-spacing:2.5px; padding:8px 18px; border-radius:999px; text-transform:uppercase; box-shadow:0 6px 20px rgba(31,200,195,0.35); }
  .kicker { display:flex; align-items:center; gap:9px; margin:16px 0 0; font-size:11.5px; letter-spacing:3px; text-transform:uppercase; color:var(--accent); font-weight:700; }
  .kicker::after { content:''; flex:none; width:32px; height:1.5px; background:linear-gradient(90deg, var(--accent), transparent); }
  h1 { font-family:'Playfair Display', Georgia, serif; font-size:clamp(30px, 4.8vw, 46px); font-weight:700; line-height:1.12; margin:8px 0 10px; color:var(--text); text-wrap:balance; }
  .loc { display:flex; align-items:center; gap:9px; color:var(--text2); font-size:15px; margin:0 0 22px; }
  .loc i { color:var(--accent); font-size:13px; }
  .price-block { display:flex; flex-direction:column; gap:3px; }
  .price-label { font-size:11px; letter-spacing:3px; text-transform:uppercase; color:var(--accent); font-weight:700; }
  .price { font-family:'Playfair Display', Georgia, serif; font-size:clamp(28px, 4vw, 38px); font-weight:700; color:var(--text); line-height:1.1; }
  .price-m2 { font-size:13px; color:var(--text2); font-weight:500; letter-spacing:.5px; margin-top:4px; }
  .sheet { max-width:1000px; margin:-36px auto 0; position:relative; z-index:3; background:var(--card); border:1px solid var(--line); border-radius:26px; padding:38px 6% 46px; box-shadow:0 30px 80px rgba(0,0,0,0.5); overflow:hidden; }
  .sheet::before { content:''; position:absolute; top:0; left:28px; right:28px; height:2px; background:linear-gradient(90deg, transparent, var(--accent), transparent); opacity:0.65; }
  .crumbs { display:flex; align-items:center; gap:10px; font-size:12px; letter-spacing:1px; color:var(--text3); margin-bottom:30px; flex-wrap:wrap; }
  .crumbs a { color:var(--accent); text-decoration:none; }
  .crumbs a:hover { text-decoration:underline; }
  .crumbs .sep { opacity:.5; }
  .gallery { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; }
  .gallery-item { width:100%; aspect-ratio:16/10; object-fit:cover; border-radius:16px; border:1px solid var(--line); cursor:zoom-in; display:block; transition:transform .25s ease, box-shadow .25s ease, border-color .25s ease; }
  .gallery-item:hover { transform:translateY(-2px); box-shadow:0 12px 28px rgba(0,0,0,0.4); border-color:var(--line-accent); }
  .gallery-more { position:relative; display:block; }
  .gallery-more img { cursor:pointer; }
  .gallery-more .more-badge { position:absolute; right:10px; bottom:10px; display:inline-flex; align-items:center; gap:6px; background:rgba(2,3,5,0.72); border:1px solid rgba(255,255,255,0.16); backdrop-filter:blur(8px); color:#fff; font-size:12px; font-weight:600; padding:6px 12px; border-radius:999px; text-decoration:none; }
  .sec { margin-top:38px; padding-top:38px; border-top:1px solid var(--line); }
  h2 { display:flex; align-items:center; gap:12px; font-size:13px; letter-spacing:3px; text-transform:uppercase; color:var(--text); font-weight:700; margin:0 0 22px; }
  h2 i { color:var(--accent); font-size:13px; }
  .specs { display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; }
  .spec { display:flex; align-items:center; gap:14px; padding:16px 18px; background:var(--card2); border:1px solid var(--line); border-radius:16px; transition:border-color .25s ease, transform .25s ease; }
  .spec:hover { border-color:var(--line-accent); transform:translateY(-2px); }
  .spec-icon { flex:none; width:44px; height:44px; display:flex; align-items:center; justify-content:center; border-radius:13px; background:rgba(31,200,195,0.12); color:var(--accent); font-size:17px; }
  .spec-body { display:flex; flex-direction:column; gap:3px; min-width:0; }
  .spec-label { font-size:10.5px; letter-spacing:1.5px; text-transform:uppercase; color:var(--text3); font-weight:600; }
  .spec-value { font-size:15.5px; font-weight:700; color:var(--text); }
  .desc { margin:0; line-height:1.85; color:var(--text2); white-space:pre-line; font-size:16px; }
  .desc + .desc { margin-top:18px; }
  .desc--lead { font-size:18px; line-height:1.7; color:var(--text); }
  .contact-strip { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:18px; background:var(--card2); border:1px solid var(--line); border-radius:22px; padding:26px 28px; margin-top:38px; }
  .contact-copy { display:flex; flex-direction:column; gap:4px; }
  .contact-copy strong { font-family:'Playfair Display', Georgia, serif; font-size:21px; color:var(--text); font-weight:700; }
  .contact-copy span { font-size:13.5px; color:var(--text2); }
  .cta-row { display:flex; flex-wrap:wrap; gap:14px; }
  .cta { display:inline-flex; align-items:center; gap:11px; background:linear-gradient(135deg, var(--accent), var(--accent-deep)); color:#020305; padding:15px 28px; border-radius:60px; font-weight:700; font-size:14.5px; text-decoration:none; border:0; cursor:pointer; box-shadow:0 10px 30px rgba(31,200,195,0.25); font-family:inherit; }
  .cta i { font-size:16px; }
  .cta:hover { transform:translateY(-1px); }
  .cta--outline { background:transparent; border:1.5px solid rgba(31,200,195,0.55); color:var(--accent); box-shadow:none; }
  .cta--outline:hover { background:rgba(31,200,195,0.08); }
  .cta.is-copied { background:linear-gradient(135deg, var(--accent-deep), var(--accent)); }
  .lb { border:0; padding:0; background:transparent; width:100vw; height:100vh; max-width:none; max-height:none; position:fixed; inset:0; }
  .lb::backdrop { background:rgba(2,3,5,0.92); backdrop-filter:blur(4px); }
  .lb img { position:absolute; inset:0; margin:auto; max-width:92vw; max-height:86vh; object-fit:contain; border-radius:12px; }
  .lb-btn { position:absolute; z-index:2; width:48px; height:48px; border-radius:999px; border:1px solid rgba(255,255,255,0.16); background:rgba(2,3,5,0.6); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; backdrop-filter:blur(6px); }
  .lb-btn:hover { border-color:var(--accent); color:var(--accent); }
  .lb-close { top:22px; right:22px; }
  .lb-prev { left:18px; top:50%; transform:translateY(-50%); }
  .lb-next { right:18px; top:50%; transform:translateY(-50%); }
  .lb-count { position:absolute; bottom:24px; left:50%; transform:translateX(-50%); background:rgba(2,3,5,0.6); border:1px solid rgba(255,255,255,0.16); backdrop-filter:blur(6px); color:#fff; font-size:13px; font-weight:600; padding:8px 18px; border-radius:999px; letter-spacing:1px; }
  .map-wrap { border:1px solid var(--line); border-radius:16px; overflow:hidden; }
  .map-wrap iframe { display:block; width:100%; height:340px; }
  .map-links { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; }
  .map-addr { display:flex; align-items:center; gap:9px; color:var(--text2); font-size:14px; }
  .map-addr i { color:var(--accent); font-size:13px; }
  .gmaps-chip { display:inline-flex; align-items:center; gap:9px; background:rgba(31,200,195,0.1); border:1px solid rgba(31,200,195,0.35); color:var(--accent); font-size:13.5px; font-weight:600; padding:11px 20px; border-radius:999px; text-decoration:none; transition:background .2s ease; }
  .gmaps-chip:hover { background:rgba(31,200,195,0.18); }
  .broker { display:flex; align-items:center; gap:16px; }
  .broker-avatar { flex:none; width:56px; height:56px; border-radius:999px; object-fit:cover; border:2px solid rgba(31,200,195,0.4); }
  .broker-avatar--init { display:flex; align-items:center; justify-content:center; background:rgba(31,200,195,0.14); color:var(--accent); font-family:'Playfair Display', Georgia, serif; font-size:24px; font-weight:700; }
  .broker-info strong { display:block; font-family:'Playfair Display', Georgia, serif; font-size:21px; color:var(--text); font-weight:700; }
  .rel-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; }
  .rel-card { display:flex; flex-direction:column; background:var(--card2); border:1px solid var(--line); border-radius:18px; overflow:hidden; text-decoration:none; transition:border-color .25s ease, transform .25s ease; }
  .rel-card:hover { border-color:var(--line-accent); transform:translateY(-3px); }
  .rel-img { width:100%; aspect-ratio:16/10; object-fit:cover; display:block; }
  .rel-body { display:flex; flex-direction:column; gap:6px; padding:16px 18px 18px; }
  .rel-title { font-size:14.5px; font-weight:600; color:var(--text); line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .rel-meta { font-size:12.5px; color:var(--text3); }
  .rel-meta b { color:var(--accent); font-weight:700; }
  .foot { text-align:center; padding:46px 20px 40px; }
  .foot-brand { font-size:13px; letter-spacing:3px; text-transform:uppercase; color:var(--text2); font-weight:300; margin-bottom:10px; }
  .foot-brand b { font-weight:700; color:var(--accent); }
  .foot-meta { font-size:12px; color:var(--text3); }
  .foot-meta a { color:var(--text3); text-decoration:none; border-bottom:1px solid rgba(148,163,184,0.4); }
  @media (max-width:720px){
    .hero { height:56vh; }
    .brand-pill { font-size:10px; padding:8px 14px; letter-spacing:2px; }
    .ref-chip { font-size:10.5px; padding:8px 12px; }
    .sheet { margin:-28px 12px 0; padding:28px 20px 36px; }
    .specs { grid-template-columns:1fr 1fr; }
    .gallery { gap:8px; }
    .gallery-item { aspect-ratio:4/3; border-radius:12px; }
    .contact-strip { flex-direction:column; align-items:stretch; text-align:center; }
    .broker { justify-content:center; }
    .cta { width:100%; justify-content:center; }
    .rel-grid { grid-template-columns:1fr; }
    .lb-btn { width:42px; height:42px; }
  }
  @media print {
    @page { margin: 12mm; }
    body { background:#fff !important; color:#1a1d21 !important; }
    .hero { cursor:default; print-color-adjust:exact; -webkit-print-color-adjust:exact; height:8cm; min-height:0; max-height:none; border-radius:14px; overflow:hidden; border:1px solid #ddd; }
    .hero::after { display:none; }
    .glass { background:transparent !important; border-color:#ddd !important; color:#1a1d21 !important; }
    .badge { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    .price-label { color:#0e7a76 !important; }
    .price, .price-m2 { color:#111 !important; }
    h1 { color:#1a1d21 !important; }
    .loc { color:#556070 !important; }
    .loc i { color:#0e7a76 !important; }
    .sheet { background:#fff !important; border:1px solid #ddd !important; box-shadow:none !important; margin:-14px 0 0; border-radius:14px; }
    .sheet::before { background:#0e7a76 !important; opacity:1 !important; }
    .crumbs { color:#6a7280 !important; }
    .crumbs a { color:#0e7a76 !important; }
    .gallery-item { border-color:#dfe5e5 !important; }
    .more-badge { border-color:#ddd !important; color:#1a1d21 !important; background:rgba(255,255,255,0.85) !important; }
    .sec { border-top-color:#e4e8e8 !important; }
    h2 { color:#1a1d21 !important; }
    h2 i { color:#0e7a76 !important; }
    .spec { background:#f6f8f8 !important; border-color:#dfe5e5 !important; }
    .spec-icon { background:rgba(14,122,118,0.12) !important; color:#0e7a76 !important; }
    .spec-label { color:#6a7280 !important; }
    .spec-value { color:#1a1d21 !important; }
    .desc, .desc--lead { color:#33383e !important; }
    .contact-strip { background:#f6f8f8 !important; border-color:#dfe5e5 !important; }
    .contact-copy strong { color:#1a1d21 !important; }
    .contact-copy span { color:#556070 !important; }
    .cta { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    .cta--outline { color:#0e7a76 !important; border-color:#0e7a76 !important; }
    .lb { display:none !important; }
    .map-wrap iframe { display:none !important; }
    .map-wrap { border-color:#dfe5e5 !important; }
    .gmaps-chip { color:#0e7a76 !important; border-color:#0e7a76 !important; background:transparent !important; }
    .map-addr { color:#556070 !important; }
    .map-addr i { color:#0e7a76 !important; }
    .broker-avatar { border-color:#0e7a76 !important; }
    .broker-avatar--init { background:rgba(14,122,118,0.12) !important; color:#0e7a76 !important; }
    .broker-info strong { color:#1a1d21 !important; }
    .rel-card { background:#f6f8f8 !important; border-color:#dfe5e5 !important; }
    .rel-title { color:#1a1d21 !important; }
    .rel-meta { color:#6a7280 !important; }
    .rel-meta b { color:#0e7a76 !important; }
    .cta-row, .cta, .spec, .gallery, .contact-strip, .rel-card, .map-wrap { break-inside:avoid; }
    .foot-brand, .foot-meta, .foot-meta a { color:#6a7280 !important; }
    .foot-meta a { border-bottom-color:#b8c0c8 !important; }
  }
</style>
</head>
<body>
  <header class="hero" style="background-image:url('${esc(hero)}')" data-zoom="${esc(hero)}" data-idx="0">
    <div class="hero-top">
      <span class="glass brand-pill"><b>BIENENHAUS</b> PROPIEDADES</span>
      <div style="display:flex; gap:8px; align-items:center;">
        ${code ? `<span class="glass ref-chip">Ref. ${esc(code)}</span>` : ''}
        ${imgs.length > 1 ? `<span class="glass ref-chip"><i class="fas fa-camera" aria-hidden="true" style="color:var(--accent); margin-right:6px;"></i>${imgs.length} fotos</span>` : ''}
      </div>
    </div>
    <div class="hero-foot">
      <span class="badge">${esc(STATUS_LABELS[p.status] ?? p.status)}</span>
      ${[TYPE_LABELS[p.property_type], rawZone].filter(Boolean).length ? `<p class="kicker">${esc([TYPE_LABELS[p.property_type], rawZone].filter(Boolean).join(' · '))}</p>` : ''}
      <h1>${esc(rawTitle)}</h1>
      ${[p.zone, p.address].some(Boolean) ? `<p class="loc"><i class="fas fa-location-dot" aria-hidden="true"></i>${esc([p.zone, p.address].filter(Boolean).join(' · '))}</p>` : ''}
      <div class="price-block">
        <span class="price-label">Precio de ${p.status === 'alquiler' ? 'alquiler' : 'venta'}</span>
        <span class="price">${esc(price)}</span>
        ${pricePerM2 ? `<span class="price-m2">≈ ${esc(pricePerM2)}</span>` : ''}
      </div>
    </div>
  </header>
  <main class="sheet">
    <nav class="crumbs" aria-label="Ruta">
      <a href="${SITE_URL}/">Inicio</a><span class="sep">/</span>
      <a href="${SITE_URL}/#propiedades">Propiedades</a><span class="sep">/</span>
      <span>Ref. ${esc(code)}</span>
    </nav>
    ${gallery.length ? `<div class="gallery">${gallery.map((g, i) => {
      const isLastWithMore = remaining > 0 && i === gallery.length - 1;
      const img = isLastWithMore
        ? `<img class="gallery-item" src="${esc(g)}" alt="${esc(rawTitle)}" loading="lazy">`
        : `<img class="gallery-item" src="${esc(g)}" alt="${esc(rawTitle)}" loading="lazy" data-idx="${i + 1}">`;
      return isLastWithMore
        ? `<a class="gallery-more" href="${SITE_URL}/#prop=${encodeURIComponent(code)}" target="_blank" rel="noopener">${img}<span class="more-badge">+${remaining} fotos <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></span></a>`
        : img;
    }).join('')}</div>` : ''}
    ${specs.length ? `<section class="sec">
      <h2><i class="fas fa-list-check" aria-hidden="true"></i>Características</h2>
      <div class="specs">${specs.map((s) => `<div class="spec"><span class="spec-icon"><i class="fas ${s.icon}" aria-hidden="true"></i></span><span class="spec-body"><span class="spec-label">${s.label}</span><span class="spec-value">${esc(s.value)}</span></span></div>`).join('')}</div>
    </section>` : ''}
    ${descBlocks.length ? `<section class="sec">
      <h2><i class="fas fa-align-left" aria-hidden="true"></i>Sobre esta propiedad</h2>
      ${descBlocks.map((b, i) => `<p class="desc${i === 0 && descBlocks.length > 1 ? ' desc--lead' : ''}">${esc(b)}</p>`).join('')}
    </section>` : ''}
    ${hasCoords ? `<section class="sec">
      <h2><i class="fas fa-map-location-dot" aria-hidden="true"></i>Ubicación</h2>
      <div class="map-wrap">
        <iframe src="https://www.openstreetmap.org/export/embed.html?bbox=${esc(mapBbox)}&layer=mapnik&marker=${esc(String(p.latitude))},${esc(String(p.longitude))}" loading="lazy" title="Mapa de la ubicación" style="border:0;"></iframe>
      </div>
      <div class="map-links">
        ${[p.zone, p.address].some(Boolean) ? `<span class="map-addr"><i class="fas fa-location-dot" aria-hidden="true"></i>${esc([p.zone, p.address].filter(Boolean).join(' · '))}</span>` : ''}
        <a class="gmaps-chip" href="${esc(gmapsUrl)}" target="_blank" rel="noopener"><i class="fas fa-diamond-turn-right" aria-hidden="true"></i>Abrir en Google Maps</a>
      </div>
    </section>` : ''}
    <div class="contact-strip">
      <div class="contact-copy">
        ${broker ? `<div class="broker">
          ${broker.photo ? `<img class="broker-avatar" src="${esc(broker.photo)}" alt="${esc(broker.name)}" loading="lazy">` : `<span class="broker-avatar broker-avatar--init">${esc(broker.name.trim().charAt(0).toUpperCase())}</span>`}
          <div class="broker-info">
            <strong>${esc(broker.name)}</strong>
            <span>${broker.phone ? `Broker asignado · ${esc(broker.phone)}` : 'Broker asignado'}</span>
          </div>
        </div>` : `<div>
          <strong>¿Te interesa esta propiedad?</strong>
          <span>Respondemos en el día por WhatsApp.</span>
        </div>`}
      </div>
      <div class="cta-row">
        <a class="cta" href="https://wa.me/${WHATSAPP_CANONICAL}?text=${waText}" target="_blank" rel="noopener"><i class="fab fa-whatsapp" aria-hidden="true"></i>Consultar por WhatsApp</a>
        <button type="button" class="cta cta--outline" data-copy="${esc(fichaUrl)}"><i class="fas fa-link" aria-hidden="true"></i><span>Copiar link</span></button>
        <button type="button" class="cta cta--outline" id="btnPrint"><i class="fas fa-file-pdf" aria-hidden="true"></i>Descargar PDF</button>
        <a class="cta cta--outline" href="${SITE_URL}/#prop=${encodeURIComponent(code)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>Ver en el sitio</a>
      </div>
    </div>
    ${related.length ? `<section class="sec">
      <h2><i class="fas fa-compass" aria-hidden="true"></i>Te puede interesar${rawZone ? ` en ${esc(rawZone)}` : ''}</h2>
      <div class="rel-grid">${related.map((r) => `<a class="rel-card" href="${SITE_URL}/fichas/${esc(r.code)}.html">
        <img class="rel-img" src="${esc(r.img)}" alt="${esc(r.title)}" loading="lazy">
        <div class="rel-body">
          <span class="rel-title">${esc(r.title)}</span>
          <span class="rel-meta">${esc(r.zone)} · <b>${esc(r.price)}</b></span>
        </div>
      </a>`).join('')}</div>
    </section>` : ''}
  </main>
  <footer class="foot">
    <div class="foot-brand"><b>BIENENHAUS</b> PROPIEDADES</div>
    <div class="foot-meta">CPI 1834 · <a href="${SITE_URL}/" rel="noopener">bienenhaus.com.ar</a></div>
  </footer>
  <dialog id="lb" class="lb">
    <img id="lbImg" alt="">
    <button type="button" id="lbClose" class="lb-btn lb-close" aria-label="Cerrar"><i class="fas fa-xmark" aria-hidden="true"></i></button>
    <button type="button" id="lbPrev" class="lb-btn lb-prev" aria-label="Foto anterior"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
    <button type="button" id="lbNext" class="lb-btn lb-next" aria-label="Foto siguiente"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
    <span class="lb-count" id="lbCount"></span>
  </dialog>
  <script>
  (function () {
    var allImgs = ${JSON.stringify(imgs.map(String))};
    var dlg = document.getElementById('lb'), lbImg = document.getElementById('lbImg'), lbCount = document.getElementById('lbCount');
    var cur = 0;
    function openLb(i) {
      if (!allImgs.length) return;
      cur = ((i + allImgs.length) % allImgs.length);
      lbImg.src = allImgs[cur];
      lbCount.textContent = (cur + 1) + ' / ' + allImgs.length;
      dlg.showModal();
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest('#lbClose')) { dlg.close(); return; }
      var zoom = e.target.closest('[data-idx]');
      if (zoom) { e.preventDefault(); openLb(parseInt(zoom.getAttribute('data-idx'), 10) || 0); return; }
      if (e.target.closest('#lbPrev')) { openLb(cur - 1); return; }
      if (e.target.closest('#lbNext')) { openLb(cur + 1); }
    });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    var printBtn = document.getElementById('btnPrint');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
    var copyBtn = document.querySelector('[data-copy]');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var url = copyBtn.getAttribute('data-copy');
        var label = copyBtn.querySelector('span');
        function done() {
          copyBtn.classList.add('is-copied');
          if (label) label.textContent = '¡Link copiado!';
          setTimeout(function () {
            copyBtn.classList.remove('is-copied');
            if (label) label.textContent = 'Copiar link';
          }, 2000);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, done);
        } else {
          var ta = document.createElement('textarea');
          ta.value = url; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); } catch (err) {}
          document.body.removeChild(ta); done();
        }
      });
    }
  })();
  </script>
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
  url.searchParams.set('select', 'id,property_code,title,description,property_type,status,zone,address,price_usd,price_currency,area_m2,surface_covered,surface_total,rooms,bedrooms,bathrooms,garage_spaces,year_built,latitude,longitude,image_urls,agents(full_name,phone,photo_url)');
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
    writeFileSync(`fichas/${p.property_code}.html`, buildHtml(p, published), 'utf8');
    count++;
  }

  if (!onlyCode) {
    writeFileSync('sitemap.xml', buildSitemap(published), 'utf8');
    console.log(`sitemap.xml actualizado (${published.length} fichas)`);
  }
  console.log(`Fichas generadas: ${count}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
