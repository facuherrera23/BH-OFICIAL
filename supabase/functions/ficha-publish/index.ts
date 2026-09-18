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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

  const chips: string[] = [];
  if (p.property_type) chips.push(TYPE_LABELS[p.property_type] ?? p.property_type);
  if (p.rooms) chips.push(`${p.rooms} amb.`);
  if (p.bedrooms) chips.push(`${p.bedrooms} dorm.`);
  if (p.bathrooms) chips.push(`${p.bathrooms} baño${p.bathrooms === 1 ? '' : 's'}`);
  const sup = p.surface_total && p.surface_total > 0 ? p.surface_total : (p.surface_covered ?? p.area_m2);
  if (sup) chips.push(`${sup} m²`);
  if (p.garage_spaces) chips.push(`${p.garage_spaces} coch.`);

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
      <h1>${esc(rawTitle)}</h1>
      <p class="loc">${esc([rawZone, p.address].filter(Boolean).join(' - '))}</p>
      <div class="price">${esc(price)}</div>
    </div>
  </header>
  <main class="sheet">
    ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${String(p.description || '').trim() ? `<h2>Descripción</h2><p class="desc">${esc(p.description)}</p>` : ''}
    <a class="cta" href="${siteUrl}" target="_blank" rel="noopener">Ver más en bienenhaus.com.ar</a>
  </main>
  <footer>Bienenhaus Propiedades - CPI 1834</footer>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'No autorizado' }, 401);
  const { data: userData } = await supabase.auth.getUser(auth.slice(7));
  if (!userData.user) return json({ error: 'No autorizado' }, 401);

  const { property_id } = (await req.json().catch(() => ({}))) as { property_id?: string };
  if (!property_id) return json({ error: 'Falta property_id' }, 400);

  const { data: p } = await supabase
    .from('properties')
    .select('*')
    .eq('id', property_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!p) return json({ error: 'Propiedad no encontrada' }, 404);
  if (!p.is_published) return json({ error: 'La propiedad no está publicada en el sitio' }, 400);
  if (!p.property_code) return json({ error: 'La propiedad no tiene código' }, 400);

  await ensureBucket(supabase);

  const html = buildFichaHtml(p);
  const path = `${p.property_code}.html`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, new TextEncoder().encode(html), {
    contentType: 'text/html',
    upsert: true,
    cacheControl: '300',
  });
  if (upErr) return json({ error: 'No se pudo subir la ficha: ' + upErr.message }, 500);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return json({ ok: true, url: pub.publicUrl, code: p.property_code });
});
