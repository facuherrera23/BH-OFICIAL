// ============================================================
// ficha-publish — DEPRECADO (2026-10-11).
// Las fichas públicas son páginas estáticas generadas por
// scripts/generate-ficha.mjs (workflow ficha-generate.yml, cada
// 30 min) y servidas desde bienenhaus.com.ar/fichas/<code>.html.
// Este endpoint duplicaba esa generación hacia Supabase Storage
// con un template inferior (sin mapa/broker/JSON-LD) que ningún
// consumidor usaba, y divergía del canónico. El bucket "fichas"
// fue vaciado. Responde 410 Gone ante cualquier caller residual.
// ============================================================

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': 'https://bienenhaus.com.ar',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }
  return new Response(
    JSON.stringify({
      error: 'ficha-publish deprecado: las fichas se generan como páginas estáticas desde la CI (bienenhaus.com.ar/fichas/<code>.html)',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } }
  );
});
