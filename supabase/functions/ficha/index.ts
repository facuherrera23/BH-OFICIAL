// ============================================================
// ficha — Página pública de propiedad (verify_jwt OFF)
// Sirve HTML estático con Open Graph para que WhatsApp/Telegram/etc.
// rendericen el preview (esos crawlers NO ejecutan JS).
// URL: /functions/v1/ficha?code=PR-P0001  (o ?id=<uuid>)
// Solo sirve propiedades is_published=true y no borradas.
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
  oficina: 'Oficina', galpon: 'Galpón', quinta: 'Quinta', otro: 'Otro',
};
const STATUS_LABELS: Record<string, string> = {
  venta: 'Venta', alquiler: 'Alquiler', vendido: 'Vendido', alquilado: 'Alquilado', pausado: 'Pausado',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const id = url.searchParams.get('id');
  if (!code && !id) return new Response('Falta code o id', { status: 400 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let q = supabase
    .from('properties')
    .select('id, property_code, title, description, property_type, status, zone, address, price_usd, price_currency, area_m2, surface_covered, surface_total, rooms, bedrooms, bathrooms, garage_spaces, image_urls, video_url')
    .eq('is_published', true)
    .is('deleted_at', null);
  q = code ? q.eq('property_code', code) : q.eq('id', id);
  const { data: p } = await q.maybeSingle();

  if (!p) {
    return new Response(renderError(), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const imgs = (p.image_urls || []).filter((u: string) => /^https?:\/\//.test(u));
  const hero = imgs[0] ?? '';
  // Urls absolutas completas para OG
  const ogImage = hero;
  const price = p.price_usd
    ? `${p.price_currency === 'ARS' ? '$' : 'U$S'} ${Number(p.price_usd).toLocaleString('es-AR')}`
    : 'Consultar';
  const siteUrl = 'https://bienenhaus.com.ar';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(p.title)} | Bienenhaus Propiedades</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bienenhaus Propiedades">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc((p.description || '').slice(0, 200))}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:secure_url" content="${esc(ogImage)}">
<meta property="og:image:type" content="image/jpeg">
<meta name="twitter:card" content="summary_large_image">` : ''}
<meta property="og:url" content="${esc(url.href)}">
<style>
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0e0e10;color:#eee}
  .wrap{max-width:880px;margin:0 auto;padding:24px}
  img.hero{width:100%;border-radius:18px;display:block;object-fit:cover;max-height:480px}
  .badge{display:inline-block;background:#c9a96e;color:#111;font-weight:700;border-radius:999px;padding:4px 14px;font-size:13px}
  h1{font-size:28px;margin:18px 0 4px}
  .loc{color:#999;margin:0 0 14px}
  .price{font-size:26px;font-weight:800;color:#c9a96e;margin:14px 0}
  .grid{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
  .chip{background:#1c1c20;border:1px solid #2a2a30;border-radius:10px;padding:8px 14px;font-size:14px}
  .desc{line-height:1.7;color:#ccc;white-space:pre-line}
  .cta{display:inline-block;margin-top:20px;background:#25d366;color:#052e16;font-weight:700;padding:14px 26px;border-radius:12px;text-decoration:none}
  footer{color:#666;font-size:12px;margin-top:34px}
</style>
</head>
<body>
<div class="wrap">
  <span class="badge">${esc(STATUS_LABELS[p.status] ?? p.status)}</span>
  <h1>${esc(p.title)}</h1>
  <p class="loc">${esc([p.zone, p.address].filter(Boolean).join(' · '))}${p.property_code ? ` · Código ${esc(p.property_code)}` : ''}</p>
  ${hero ? `<img class="hero" src="${esc(hero)}" alt="${esc(p.title)}">` : ''}
  <div class="price">${esc(price)}</div>
  <div class="grid">
    ${p.property_type ? `<span class="chip">${esc(TYPE_LABELS[p.property_type] ?? p.property_type)}</span>` : ''}
    ${p.rooms ? `<span class="chip">${p.rooms} ambientes</span>` : ''}
    ${p.bedrooms ? `<span class="chip">${p.bedrooms} dormitorios</span>` : ''}
    ${p.bathrooms ? `<span class="chip">${p.bathrooms} baños</span>` : ''}
    ${(p.surface_total ?? p.surface_covered ?? p.area_m2) ? `<span class="chip">${p.surface_total ?? p.surface_covered ?? p.area_m2} m²</span>` : ''}
    ${p.garage_spaces ? `<span class="chip">${p.garage_spaces} cochera${p.garage_spaces === 1 ? '' : 's'}</span>` : ''}
  </div>
  <p class="desc">${esc(p.description || '')}</p>
  <a class="cta" href="${siteUrl}">Ver más en bienenhaus.com.ar</a>
  <footer>Bienenhaus Propiedades — CPI 1834</footer>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

function renderError(): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Propiedad no disponible</title></head><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;"><p>Propiedad no encontrada o no publicada.</p></body></html>';
}
