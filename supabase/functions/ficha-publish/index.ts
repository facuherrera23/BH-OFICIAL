// ============================================================
// ficha-publish — Genera la ficha HTML publica de una propiedad y la
// sube a Supabase Storage (bucket publico "fichas"). Storage si sirve
// text/html; las Edge Functions de Supabase fuerzan text/plain por
// politica anti-abuso, por eso el HTML vive en Storage.
//
// POST { property_id } -> { ok, url }  (verify_jwt ON, roles del panel)
// Idempotente: re-subir actualiza el archivo (upsert).
//
// FUENTE RECUPERADA del deploy v3 (estaba desplegada sin versionado).
// Ajustes sobre el original: canonical a la ficha del sitio (evita
// contenido duplicado storage vs bienenhaus.com.ar), meta description,
// Ref. en el title y typos corregidos (Descripción, m², baño, Galpón).
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const BUCKET = 'fichas';

// Entidades construidas por concatenación para evitar escapes del origen
const ENT_AMP = '&' + 'amp;';
const ENT_LT = '&' + 'lt;';
const ENT_GT = '&' + 'gt;';
const ENT_QUOT = '&' + 'quot;';
const ENT_APOS = '&' + '#39;';

const ALLOWED_ORIGINS = [
  'https://bienenhaus.com.ar',
  'https://www.bienenhaus.com.ar',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

function corsOrigin(req: Request): string {
  const origin = req.headers.get('origin') ?? '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function json(body: unknown, status = 200, req?: Request): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req) {
    headers['Access-Control-Allow-Origin'] = corsOrigin(req);
    headers['Access-Control-Allow-Headers'] = 'authorization, content-type, x-client-info, apikey';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, ENT_AMP).replace(/</g, ENT_LT).replace(/>/g, ENT_GT)
    .replace(/"/g, ENT_QUOT).replace(/'/g, ENT_APOS);
}

function buildMetaDescription(text: unknown): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Propiedad en venta y alquiler en Córdoba. Consultá con Bienenhaus Propiedades.';
  if (clean.length <= 155) return clean;
  const cut = clean.slice(0, 155);
  const lastSpace = cut.lastIndexOf(' ');
  return cut.slice(0, lastSpace > 100 ? lastSpace : 155).trim() + '…';
}

const TYPE_LABELS: Record<string, string> = {
  casa: 'Casa', departamento: 'Departamento', terreno: 'Terreno', local: 'Local',
  oficina: 'Oficina', galpon: 'Galpón', quinta: 'Quinta', otro: 'Otro',
};
const STATUS_LABELS: Record<string, string> = {
  venta: 'Venta', alquiler: 'Alquiler', vendido: 'Vendido', alquilado: 'Alquilado', pausado: 'Pausado',
};

async function ensureBucket(supabase: ReturnType<typeof createClient>) {
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    allowedMimeTypes: ['text/html'],
    fileSizeLimit: '1MB',
  });
  if (error && !/already exists/i.test(error.message ?? '')) {
    throw new Error('No se pudo crear el bucket fichas: ' + error.message);
  }
}

function buildFichaHtml(p: Record<string, any>): string {
  const imgs = (p.image_urls || []).filter((u: string) => /^https?:\/\//.test(u));
  const hero = imgs[0] ?? '';
  const ogThumb = hero.includes('res.cloudinary.com') && hero.includes('/upload/')
    ? hero.replace('/upload/', '/upload/w_1200,h_630,c_fill,f_jpg,q_75/')
    : hero;
  const price = p.price_usd
    ? `${p.price_currency === 'ARS' ? '$' : 'USD'} ${Number(p.price_usd).toLocaleString('es-AR')}`
    : 'Consultar';
  const siteUrl = 'https://bienenhaus.com.ar';
  const rawTitle = String(p.title || '').trim();
  const rawZone = String(p.zone || '').trim();
  const zonePart = rawZone && !rawTitle.toLowerCase().includes(rawZone.toLowerCase()) ? rawZone : '';
  const metaDescription = buildMetaDescription(p.description);

  const TYPE_ICONS: Record<string, string> = {
    casa: 'fa-house', departamento: 'fa-building', terreno: 'fa-map', local: 'fa-store',
    oficina: 'fa-briefcase', galpon: 'fa-warehouse', quinta: 'fa-tree', otro: 'fa-building',
  };
  const sup = p.surface_total && p.surface_total > 0 ? p.surface_total : (p.surface_covered ?? p.area_m2);
  const supCub = p.surface_covered && p.surface_covered > 0 ? p.surface_covered : null;

  /* Ficha premium: grilla de características con íconos (reemplaza a los chips) */
  const specs: Array<{ icon: string; label: string; value: string }> = [];
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
  const pricePerM2 = p.price_usd && sup
    ? `${p.price_currency === 'ARS' ? '$' : 'USD'} ${Math.round(p.price_usd / sup).toLocaleString('es-AR')}/m²`
    : '';
  const descBlocks = String(p.description || '').trim()
    ? String(p.description).trim().split(/\n{2,}/).map((b: string) => b.trim()).filter(Boolean)
    : [];
  const WHATSAPP_CANONICAL = '5493516379651';
  const waText = encodeURIComponent(`Hola, me interesa la propiedad ${p.property_code ?? ''} (${p.title}) que vi en bienenhaus.com.ar`);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(rawTitle)}${zonePart ? ` — ${esc(zonePart)}` : ''} | Bienenhaus Propiedades · ${esc(p.property_code ?? '')}</title>
<meta name="description" content="${esc(metaDescription)}">
<link rel="canonical" href="${siteUrl}/fichas/${esc(p.property_code ?? '')}.html">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bienenhaus Propiedades">
<meta property="og:title" content="${esc(rawTitle)}">
<meta property="og:description" content="${esc(metaDescription)}">
${ogThumb ? `<meta property="og:image" content="${esc(ogThumb)}">
<meta property="og:image:secure_url" content="${esc(ogThumb)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
  /* Ficha v3 con la identidad visual del sitio (landing.css) — espejo del
     generador scripts/generate-ficha.mjs para evitar drift entre templates. */
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
  h1 { font-family:'Playfair Display', Georgia, serif; font-size:clamp(30px, 4.8vw, 46px); font-weight:700; line-height:1.12; margin:18px 0 10px; color:var(--text); text-wrap:balance; }
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
    .cta { width:100%; justify-content:center; }
    .lb-btn { width:42px; height:42px; }
  }
</style>
</head>
<body>
  <header class="hero" style="background-image:url('${esc(hero)}')" data-zoom="${esc(hero)}">
    <div class="hero-top">
      <span class="glass brand-pill"><b>BIENENHAUS</b> PROPIEDADES</span>
      ${p.property_code ? `<span class="glass ref-chip">Ref. ${esc(p.property_code)}</span>` : ''}
    </div>
    <div class="hero-foot">
      <span class="badge">${esc(STATUS_LABELS[p.status] ?? p.status)}</span>
      <h1>${esc(rawTitle)}</h1>
      ${[rawZone, p.address].some(Boolean) ? `<p class="loc"><i class="fas fa-location-dot" aria-hidden="true"></i>${esc([rawZone, p.address].filter(Boolean).join(' · '))}</p>` : ''}
      <div class="price-block">
        <span class="price-label">Precio de ${p.status === 'alquiler' ? 'alquiler' : 'venta'}</span>
        <span class="price">${esc(price)}</span>
        ${pricePerM2 ? `<span class="price-m2">≈ ${esc(pricePerM2)}</span>` : ''}
      </div>
    </div>
  </header>
  <main class="sheet">
    <nav class="crumbs" aria-label="Ruta">
      <a href="${siteUrl}/">Inicio</a><span class="sep">/</span>
      <a href="${siteUrl}/#propiedades">Propiedades</a><span class="sep">/</span>
      <span>Ref. ${esc(p.property_code ?? '')}</span>
    </nav>
    ${gallery.length ? `<div class="gallery">${gallery.map((g: string, i: number) => {
      const isLastWithMore = remaining > 0 && i === gallery.length - 1;
      const img = isLastWithMore
        ? `<img class="gallery-item" src="${esc(g)}" alt="${esc(rawTitle)}" loading="lazy">`
        : `<img class="gallery-item" src="${esc(g)}" alt="${esc(rawTitle)}" loading="lazy" data-zoom="${esc(g)}">`;
      return isLastWithMore
        ? `<a class="gallery-more" href="${siteUrl}/#prop=${encodeURIComponent(p.property_code ?? '')}" target="_blank" rel="noopener">${img}<span class="more-badge">+${remaining} fotos <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></span></a>`
        : img;
    }).join('')}</div>` : ''}
    ${specs.length ? `<section class="sec">
      <h2><i class="fas fa-list-check" aria-hidden="true"></i>Características</h2>
      <div class="specs">${specs.map((s) => `<div class="spec"><span class="spec-icon"><i class="fas ${s.icon}" aria-hidden="true"></i></span><span class="spec-body"><span class="spec-label">${s.label}</span><span class="spec-value">${esc(s.value)}</span></span></div>`).join('')}</div>
    </section>` : ''}
    ${descBlocks.length ? `<section class="sec">
      <h2><i class="fas fa-align-left" aria-hidden="true"></i>Sobre esta propiedad</h2>
      ${descBlocks.map((b: string, i: number) => `<p class="desc${i === 0 && descBlocks.length > 1 ? ' desc--lead' : ''}">${esc(b)}</p>`).join('')}
    </section>` : ''}
    <div class="contact-strip">
      <div class="contact-copy">
        <strong>¿Te interesa esta propiedad?</strong>
        <span>Respondemos en el día por WhatsApp.</span>
      </div>
      <div class="cta-row">
        <a class="cta" href="https://wa.me/${WHATSAPP_CANONICAL}?text=${waText}" target="_blank" rel="noopener"><i class="fab fa-whatsapp" aria-hidden="true"></i>Consultar por WhatsApp</a>
        <button type="button" class="cta cta--outline" data-copy="${esc(`${siteUrl}/fichas/${esc(p.property_code ?? '')}.html`)}"><i class="fas fa-link" aria-hidden="true"></i><span>Copiar link</span></button>
        <a class="cta cta--outline" href="${siteUrl}/#prop=${encodeURIComponent(p.property_code ?? '')}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>Ver en el sitio</a>
      </div>
    </div>
  </main>
  <footer class="foot">
    <div class="foot-brand"><b>BIENENHAUS</b> PROPIEDADES</div>
    <div class="foot-meta">CPI 1834 · <a href="${siteUrl}/" rel="noopener">bienenhaus.com.ar</a></div>
  </footer>
  <dialog id="lb" class="lb">
    <img id="lbImg" alt="">
    <button type="button" id="lbClose" class="lb-btn lb-close" aria-label="Cerrar"><i class="fas fa-xmark" aria-hidden="true"></i></button>
    <button type="button" id="lbPrev" class="lb-btn lb-prev" aria-label="Foto anterior"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
    <button type="button" id="lbNext" class="lb-btn lb-next" aria-label="Foto siguiente"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
  </dialog>
  <script>
  (function () {
    var items = [].map.call(document.querySelectorAll('[data-zoom]'), function (el) { return el.getAttribute('data-zoom'); });
    var dlg = document.getElementById('lb'), lbImg = document.getElementById('lbImg');
    var cur = 0;
    function openLb(i) {
      if (!items.length) return;
      cur = (i + items.length) % items.length;
      lbImg.src = items[cur];
      dlg.showModal();
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest('#lbClose')) { dlg.close(); return; }
      var zoom = e.target.closest('[data-zoom]');
      if (zoom) { e.preventDefault(); openLb(items.indexOf(zoom.getAttribute('data-zoom'))); return; }
      if (e.target.closest('#lbPrev')) { openLb(cur - 1); return; }
      if (e.target.closest('#lbNext')) { openLb(cur + 1); }
    });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
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
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin(req),
        'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin',
      },
    });
  }
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405, req);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'No autorizado' }, 401, req);
  const { data: userData } = await supabase.auth.getUser(auth.slice(7));
  if (!userData.user) return json({ error: 'No autorizado' }, 401, req);

  const { property_id } = (await req.json().catch(() => ({}))) as { property_id?: string };
  if (!property_id) return json({ error: 'Falta property_id' }, 400, req);

  const { data: p } = await supabase
    .from('properties')
    .select('*')
    .eq('id', property_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!p) return json({ error: 'Propiedad no encontrada' }, 404, req);
  if (!p.is_published) return json({ error: 'La propiedad no está publicada en el sitio' }, 400, req);
  if (!p.property_code) return json({ error: 'La propiedad no tiene código' }, 400, req);

  await ensureBucket(supabase);

  const html = buildFichaHtml(p);
  const path = `${p.property_code}.html`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, new TextEncoder().encode(html), {
    contentType: 'text/html',
    upsert: true,
    cacheControl: '300',
  });
  if (upErr) return json({ error: 'No se pudo subir la ficha: ' + upErr.message }, 500, req);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return json({ ok: true, url: pub.publicUrl, code: p.property_code }, 200, req);
});
