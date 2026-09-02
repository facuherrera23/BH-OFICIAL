// CORS compartido para todas las Edge Functions.
//
// Reglas:
// - Sin header Origin (cron, webhooks server-to-server): methods + headers, sin ACAO.
// - Origin en allowlist: ACAO con el origin exacto + Vary: Origin.
// - Origin fuera de allowlist: solo Vary: Origin (el browser bloquea la lectura).

export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
    'https://bienenhaus.com.ar',
    'https://www.bienenhaus.com.ar',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
]);

const METHODS_HEADERS: Readonly<Record<string, string>> = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers':
        'authorization, x-client-info, apikey, content-type, x-sync-secret, x-meli-signature',
};

export function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('origin');
    if (!origin) return { ...METHODS_HEADERS };
    if (ALLOWED_ORIGINS.has(origin)) {
        return { ...METHODS_HEADERS, 'access-control-allow-origin': origin, vary: 'Origin' };
    }
    return { vary: 'Origin' };
}

export function jsonResponse(status: number, body: unknown, req: Request): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(req), 'content-type': 'application/json' },
    });
}

export function optionsResponse(req: Request): Response {
    return new Response('ok', { headers: corsHeaders(req) });
}
