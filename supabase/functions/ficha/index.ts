// ============================================================
// ficha (verify_jwt OFF) — DEPRECADO como generador de HTML.
// Las fichas públicas ahora son páginas estáticas indexables
// generadas por scripts/generate-ficha.mjs (commiteadas a main
// por el workflow ficha-generate.yml y servidas por GitHub Pages).
// Esta función queda solo como redirector de compatibilidad
// hacia la ficha estática, para URLs legadas /ficha?code=X.
// ============================================================

const SITE_URL = 'https://bienenhaus.com.ar';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  const url = new URL(req.url);
  const code = url.searchParams.get('code') ?? url.pathname.split('/').filter(Boolean).pop();

  if (!code) return new Response('Falta code', { status: 400 });

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Location': `${SITE_URL}/fichas/${encodeURIComponent(code)}.html`,
    'Cache-Control': 'public, max-age=300',
  };
  return new Response(`Ficha: ${SITE_URL}/fichas/${encodeURIComponent(code)}.html`, { status: 301, headers });
});
