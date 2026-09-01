// Cloudflare Pages (advanced mode): intercepta /ficha/<CODE> y proxea la
// Edge Function de Supabase que sirve la ficha HTML con Open Graph.
// Todo lo demas lo sirve estatico igual que antes.
const FICHA_FUNCTION = 'https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/ficha';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ficha' || url.pathname.startsWith('/ficha/')) {
      const code = url.searchParams.get('code') ?? (url.pathname.split('/').filter(Boolean)[1] ?? '');
      if (!code) return new Response('Falta codigo', { status: 400 });
      const res = await fetch(`${FICHA_FUNCTION}?code=${encodeURIComponent(code)}`);
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
