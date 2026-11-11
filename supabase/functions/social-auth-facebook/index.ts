// ============================================================
// social-auth-facebook — OAuth de Facebook (via Meta Graph API).
//
// La API de Facebook publica en PÁGINAS (no en perfiles personales):
// el usuario autoriza con su cuenta de Meta y conectamos TODAS las
// páginas que administra (una fila social_accounts por página con
// UNIQUE platform+external_id — el dueño desconecta desde Cuentas
// las que no quiera).
//
// POST  { action: 'start' }  → URL de consentimiento de Meta
// GET   ?code=...&state=...  → callback: canjea el code por un
//        long-lived token, lee /me/accounts, guarda cada página
//        (page access token) y cierra el popup con postMessage
//        (patrón ml-oauth/social-auth-instagram).
//
// Requisitos previos (verificados al conectar):
// - Ser admin de al menos una página de Facebook
// - App de Meta con los permisos de páginas (Development sirve sin
//   review para el admin de la app)
// - El redirect URI social-auth-facebook agregado a la app
//
// Credenciales: app_settings key 'social_facebook' (o env
// SOCIAL_FACEBOOK_CLIENT_ID/SECRET) — mismo patrón que YouTube/IG.
// verify_jwt OFF (callback de Meta no trae JWT): NO_VERIFY.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import { encrypt } from '../_shared/crypto.ts';
import { getSocialCredentials } from '../_shared/social.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const FB_SCOPES = [
    'pages_show_list',
    'pages_manage_posts',
    'pages_read_engagement',
    /* Webhook de comentarios (subscribed_apps field feed) — exige
       pages_manage_metadata. Sin él, la action `subscribe` de
       social-comments rechaza con error de permiso y los comentarios
       solo llegan por sync manual. */
    'pages_manage_metadata',
    /* Ocultar/mostrar y eliminar comentarios desde la bandeja
       Consultas. Las cuentas conectadas ANTES hay que reconectarlas. */
    'pages_manage_engagement',
].join(',');

/* ------- state firmado (patrón ml-oauth/social-auth-*) ------- */
function b64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmac(value: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return b64UrlEncode(
        new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))),
    );
}

function timingSafeEqual(a: string, b: string): boolean {
    const ba = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

interface FbState {
    nonce: string;
    admin: string;
    exp: number;
    sig: string;
}

async function buildState(adminId: string, clientSecret: string): Promise<string> {
    const payload = { nonce: crypto.randomUUID(), admin: adminId, exp: Date.now() + 10 * 60_000 };
    const sig = await hmac(`${payload.nonce}|${adminId}|${payload.exp}`, clientSecret);
    const full: FbState = { ...payload, sig };
    return b64UrlEncode(new TextEncoder().encode(JSON.stringify(full)));
}

async function readState(raw: string, clientSecret: string): Promise<FbState | null> {
    try {
        const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
        const json = atob(padded);
        const state = JSON.parse(json) as FbState;
        if (!state?.nonce || !state.admin || !state.exp) return null;
        if (Date.now() > state.exp) return null;
        const expected = await hmac(`${state.nonce}|${state.admin}|${state.exp}`, clientSecret);
        if (!timingSafeEqual(state.sig, expected)) return null;
        return state;
    } catch {
        return null;
    }
}

function adminBase(): string {
    return Deno.env.get('ADMIN_BASE_URL') ?? 'https://bienenhaus.com.ar/admin.html';
}

function escHtml(s: string): string {
    return s
        .replace(/&/g, '\u0026amp;')
        .replace(/</g, '\u0026lt;')
        .replace(/>/g, '\u0026gt;')
        .replace(/"/g, '\u0026quot;')
        .replace(/'/g, '\u0026#39;');
}

function completionPage(ok: boolean, message: string): Response {
    const payload = ok
        ? { type: 'SOCIAL_AUTH_SUCCESS', platform: 'facebook', message }
        : { type: 'SOCIAL_AUTH_ERROR', platform: 'facebook', error: message };
    const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');
    const title = ok ? 'Cuenta de Facebook conectada' : 'No se pudo conectar Facebook';
    const html =
        `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="font-family:system-ui,sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;color:#111">` +
        `<div style="text-align:center;max-width:520px;padding:2rem">` +
        `<h2 style="margin-top:0">${title}</h2><p>${escHtml(message)}</p>` +
        `<p><a href="${escHtml(adminBase())}" target="_blank" rel="noopener">Abrir panel de control</a></p>` +
        `</div><script>window.opener&&window.opener.postMessage(${payloadJson},'*');setTimeout(function(){try{window.close()}catch(e){}},1200);</script>` +
        `</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('social-auth-facebook', req);
    if (rl) return rl;

    const { clientId, clientSecret } = await getSocialCredentials(supabase, 'facebook');
    const redirectUri = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/social-auth-facebook`;

    /* ------- POST: iniciar conexión ------- */
    if (req.method === 'POST') {
        let body: { action?: unknown };
        try {
            body = await req.json();
        } catch {
            return respond(400, { error: 'JSON inválido' });
        }
        if (body.action !== 'start') return respond(400, { error: 'Acción inválida' });

        const token = await requireAdmin(req, supabase);
        if (!token) return respond(401, { error: 'No autorizado' });
        const { data: userData } = await supabase.auth.getUser(token);
        const adminId = userData?.user?.id;
        if (!adminId) return respond(401, { error: 'No autorizado' });

        if (!clientId || !clientSecret) {
            return respond(400, {
                error: 'Credenciales de Facebook no configuradas (app_settings social_facebook).',
            });
        }

        const state = await buildState(adminId, clientSecret);
        const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?` + new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: FB_SCOPES,
            response_type: 'code',
            state,
        });
        return respond(200, { url: authUrl });
    }

    /* ------- GET: callback de Meta (en el popup) ------- */
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const stateRaw = url.searchParams.get('state') ?? '';
        const errParam = url.searchParams.get('error_description') ?? url.searchParams.get('error');

        if (errParam) {
            return completionPage(false, `Meta canceló la autorización: ${errParam}`);
        }
        if (!code) return respond(400, { error: 'Falta el código de autorización' });

        const state = await readState(stateRaw, clientSecret);
        if (!state) {
            return completionPage(false, 'La sesión de conexión expiró. Volvé al panel e intentá de nuevo.');
        }
        if (!clientId || !clientSecret) {
            return completionPage(false, 'Credenciales de Facebook no configuradas (app_settings social_facebook).');
        }

        try {
            // 1. Canjear code por token de corto plazo
            const tokenRes = await fetch(`${GRAPH_API}/oauth/access_token?` + new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                code,
            }));
            if (!tokenRes.ok) {
                const t = (await tokenRes.text()).slice(0, 200);
                return completionPage(false, `Meta rechazó el código: ${t}`);
            }
            const tokenJson = (await tokenRes.json()) as { access_token: string };
            const shortToken = tokenJson.access_token;

            // 2. Extender a token de larga duración
            const longRes = await fetch(`${GRAPH_API}/oauth/access_token?` + new URLSearchParams({
                grant_type: 'fb_exchange_token',
                client_id: clientId,
                client_secret: clientSecret,
                fb_exchange_token: shortToken,
            }));
            if (!longRes.ok) {
                const t = (await longRes.text()).slice(0, 200);
                return completionPage(false, `No se pudo extender el token: ${t}`);
            }
            const longJson = (await longRes.json()) as { access_token: string; expires_in?: number };
            const longToken = longJson.access_token;

            // 3. Leer las páginas que administra (con foto incluida).
            //    limit=100: el default de la API pagina a 25 — si el admin
            //    administra más páginas, la segunda tanda se perdería.
            const pagesRes = await fetch(
                `${GRAPH_API}/me/accounts?fields=id,name,access_token,picture.type(large)&limit=100&access_token=${longToken}`,
            );
            if (!pagesRes.ok) {
                const t = (await pagesRes.text()).slice(0, 200);
                return completionPage(false, `No se pudieron leer las páginas de Facebook: ${t}`);
            }
            const pagesJson = (await pagesRes.json()) as {
                data?: Array<{
                    id: string;
                    name: string;
                    access_token: string;
                    picture?: { data?: { url?: string } };
                }>;
            };
            const pages = pagesJson.data ?? [];

            if (!pages.length) {
                return completionPage(false,
                    'No administrás ninguna página de Facebook. La API no publica en perfiles personales — conectá desde una cuenta que administre una página.');
            }

            // 4. Guardar UNA fila por página (UNIQUE plataforma+external_id).
            //    El page token derivado de un user token largo no vence →
            //    token_expires_at lejos en el futuro (sin refresh).
            const farFuture = new Date(Date.now() + 10 * 365 * 86400 * 1000).toISOString();
            let saved = 0;
            let lastErr = '';
            for (const page of pages) {
                if (!page?.id || !page.access_token) continue;
                const encPageToken = await encrypt(page.access_token);
                const encUserToken = await encrypt(longToken);
                const row = {
                    platform: 'facebook' as const,
                    external_id: page.id,
                    display_name: page.name || 'Página de Facebook',
                    avatar_url: page.picture?.data?.url ?? null,
                    access_token_encrypted: encPageToken.data,
                    access_token_iv: encPageToken.iv,
                    refresh_token_encrypted: encUserToken.data,
                    refresh_token_iv: encUserToken.iv,
                    token_expires_at: farFuture,
                    scope: FB_SCOPES,
                    status: 'active' as const,
                    updated_at: new Date().toISOString(),
                };
                const { error: upErr } = await supabase
                    .from('social_accounts')
                    .upsert(row, { onConflict: 'platform,external_id' });
                if (upErr) {
                    lastErr = upErr.message;
                    continue;
                }
                saved++;
            }
            if (!saved) {
                return completionPage(false, `No se pudo guardar la conexión: ${lastErr || 'error desconocido'}`);
            }

            const names = pages.map((p) => p.name).filter(Boolean).join(', ');
            return completionPage(true, saved === 1
                ? `Página conectada: ${names || pages[0].name}.`
                : `${saved} páginas conectadas: ${names}.`);
        } catch (err) {
            return completionPage(false, (err as Error).message.slice(0, 200));
        }
    }

    return respond(405, { error: 'Método no permitido' });
});
