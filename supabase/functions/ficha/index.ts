// ============================================================
// ficha - Pagina publica de propiedad (verify_jwt OFF)
// Sirve HTML estatico con Open Graph para previews (WhatsApp/Telegram).
// URL canonica: https://bienenhaus.com.ar/ficha/<CODE> via _worker.js.
// Solo propiedades is_published=true y no borradas.
// OJO: los textos del template van SIN acentos para evitar problemas
// de encoding del bundler; los datos vienen de la DB y viajan bien.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const TYPE_LABELS: Record<string, string> = {
  casa: 'Casa', departamento: 'Departamento', terreno: 'Terreno', local: 'Local',
  oficina: 'Oficina', galpon: 'Galpon', quinta: 'Quinta', otro: 'Otro',
};
const STATUS_LABELS: Record<string, string> = {
  venta: 'Venta', alquiler: 'Alquiler', vendido: 'Vendido', alquilado: 'Alquilado', pausado: 'Pausado',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  const url = new URL(req.url);
  const code = url.searchParams.get('code') ?? url.pathname.split('/').filter(Boolean).pop();
  const id = url.searchParams.get('id');
  if (!code && !id) return new Response('Falta code o id', { status: 400 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let q = supabase
    .from('properties')
    .select('id, property_code, title, description, property_type, status, zone, address, price_usd, price_currency, area_m2, surface_covered, surface_total, rooms, bedrooms, bathrooms, garage_spaces, image_urls')
    .eq('is_published', true)
    .is('deleted_at', null);
  q = code ? q.eq('property_code', code) : q.eq('id', id!);
  const { data: p } = await q.maybeSingle();

  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' };

  if (!p) {
    return new Response(renderError(), { status: 404, headers });
  }

  const imgs = (p.image_urls || []).filter((u: string) => /^https?:\/\//.test(u));
  const hero = imgs[0] ?? '';
  const price = p.price_usd
    ? `${p.price_currency === 'ARS' ? '$' : 'USD'} ${Number(p.price_usd).toLocaleString('es-AR')}`
    : 'Consultar';
  const siteUrl = 'https://bienenhaus.com.ar';

  const chips: string[] = [];
  if (p.property_type) chips.push(TYPE_LABELS[p.property_type] ?? p.property_type);
  if (p.rooms) chips.push(`${p.rooms} amb.`);
  if (p.bedrooms) chips.push(`${p.bedrooms} dorm.`);
  if (p.bathrooms) chips.push(`${p.bathrooms} bano${p.bathrooms === 1 ? '' : 's'}`);
  const sup = p.surface_total && p.surface_total > 0 ? p.surface_total : (p.surface_covered ?? p.area_m2);
  if (sup) chips.push(`${sup} m2`);
  if (p.garage_spaces) chips.push(`${p.garage_spaces} coch.`);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(p.title)} | Bienenhaus Propiedades</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bienenhaus Propiedades">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc((p.description || '').replace(/\s+/g, ' ').slice(0, 180))}">
${hero ? `<meta property="og:image" content="${esc(hero)}">
<meta property="og:image:secure_url" content="${esc(hero)}">
<meta name="twitter:card" content="summary_large_image">` : ''}
<meta property="og:url" content="${esc(url.href)}">
<style>
  :root { --gold:#c9a96e; --bg:#0b0b0d; --card:#141417; --line:#26262c; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Segoe UI', system-ui, sans-serif; background:var(--bg); color:#f0ebe2; }
  .hero { position:relative; width:100%; height:62vh; min-height:340px; background:#000 center/cover no-repeat; }
  .hero::after { content:''; position:absolute; inset:0; background:linear-gradient(to top, rgba(11,11,13,0.94) 0%, rgba(11,11,13,0.25) 55%, transparent); }
  .hero-head { position:absolute; top:0; left:0; right:0; display:flex; justify-content:space-between; align-items:center; padding:22px 8%; color:#fff; }
  .brand { letter-spacing:3px; font-weight:300; font-size:13px; text-transform:uppercase; }
  .brand b { font-weight:700; }
  .code { font-size:12px; letter-spacing:1px; opacity:0.8; }
  .hero-foot { position:absolute; left:8%; right:8%; bottom:26px; }
  .badge { display:inline-block; background:var(--gold); color:#131313; font-weight:700; font-size:12px; letter-spacing:2px; padding:7px 16px; border-radius:999px; text-transform:uppercase; }
  h1 { margin:14px 0 6px; font-size:34px; font-weight:600; line-height:1.15; }
  .loc { color:#b9b3a6; margin:0 0 10px; font-size:15px; }
  .price { font-size:32px; color:var(--gold); font-weight:700; margin-top:6px; }
  .sheet { max-width:960px; margin:-30px auto 60px; background:var(--card); border:1px solid var(--line); border-radius:20px; padding:34px 6%; box-shadow:0 24px 60px rgba(0,0,0,0.5); position:relative; z-index:2; }
  .chips { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:22px; }
  .chip { border:1px solid var(--line); background:#1a1a1f; padding:9px 18px; border-radius:999px; font-size:14px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:2px; color:var(--gold); border-bottom:1px solid var(--line); padding-bottom:10px; margin:30px 0 16px; }
  .desc { line-height:1.75; color:#cfc9bd; white-space:pre-line; font-size:15.5px; }
  .cta { display:inline-flex; align-items:center; gap:10px; margin-top:26px; background:linear-gradient(135deg, #d9c08a, #c9a96e); color:#141414; padding:15px 30px; border-radius:12px; font-weight:700; text-decoration:none; }
  footer { text-align:center; color:#5d584f; font-size:12px; padding:34px 0 26px; }
  @media (max-width:720px){ .hero{height:52vh} h1{font-size:26px} .sheet{margin:-24px 12px 48px; padding:26px 20px} }
</style>
</head>
<body>
  <header class="hero" style="background-image:url('${esc(hero)}')">
    <div class="hero-head">
      <span class="brand"><b>BIENENHAUS</b> PROPIEDADES</span>
      ${p.property_code ? `<span class="code">${esc(p.property_code)}</span>` : ''}
    </div>
    <div class="hero-foot">
      <span class="badge">${esc(STATUS_LABELS[p.status] ?? p.status)}</span>
      <h1>${esc(p.title)}</h1>
      <p class="loc">${esc([p.zone, p.address].filter(Boolean).join(' - '))}</p>
      <div class="price">${esc(price)}</div>
    </div>
  </header>
  <main class="sheet">
    ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${(p.description || '').trim() ? `<h2>Descripcion</h2><p class="desc">${esc(p.description)}</p>` : ''}
    <a class="cta" href="${siteUrl}" target="_blank" rel="noopener">Ver mas en bienenhaus.com.ar</a>
  </main>
  <footer>Bienenhaus Propiedades - CPI 1834</footer>
</body>
</html>`;

  return new Response(html, { status: 200, headers });
});

function renderError(): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Propiedad no disponible</title></head><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;"><p>Propiedad no encontrada o no publicada.</p></body></html>';
}
