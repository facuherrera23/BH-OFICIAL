// ============================================================
// social-auth-instagram — OAuth de Instagram (via Meta Graph API).
//
// La API de Instagram trabaja A TRAVÉS de una página de Facebook:
// el usuario autoriza con su cuenta de Meta, nosotros buscamos la
// página que tiene la cuenta de Instagram vinculada, y de ahí
// obtenemos el IG business user ID.
//
// POST  { action: 'start' }  → URL de consentimiento de Meta
// GET   ?code=...&state=...  → callback: canjea el code por un
//        long-lived token, busca la página con IG vinculado, guarda
//        la cuenta y cierra el popup con postMessage (patrón ML).
//
// Requisitos previos (verificados al conectar):
// - Cuenta IG tipo Business/Creator (las Personales NO funcionan)
// - IG vinculado a una página de Facebook (Meta Business Suite)
// - App de Meta con producto "Instagram Graph API" agregado
// - En modo Development funciona para el admin de la app SIN review
//
// Credenciales: app_settings key 'social_instagram' (o env
// SOCIAL_INSTAGRAM_CLIENT_ID/SECRET) — mismo patrón que YouTube.
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
const IG_SCOPES = [
    'instagram_basic',
    'instagram_content_publish',
    'pages_show_list',
].join(',');

/* ------- state firmado (patrón ml-oauth/social-auth-youtube) ------- */
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

interface IgState {
    nonce: string;
    admin: string;
    exp: number;
    sig: string;
}

async function buildState(adminId: string, clientSecret: string): Promise<string> {
    const payload = { nonce: crypto.randomUUID(), admin: adminId, exp: Date.now() + 10 * 60_000 };
    const sig = await hmac(`${payload.nonce}|${adminId}|${payload.exp}`, clientSecret);
    const full: IgState = { ...payload, sig };
    return b64UrlEncode(new TextEncoder().encode(JSON.stringify(full)));
}

async function readState(raw: string, clientSecret: string): Promise<IgState | null> {
    try {
        const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
        const json = atob(padded);
        const state = JSON.parse(json) as IgState;
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
        ? { type: 'SOCIAL_AUTH_SUCCESS', platform: 'instagram', message }
        : { type: 'SOCIAL_AUTH_ERROR', platform: 'instagram', error: message };
    const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');
    const title = ok ? 'Cuenta de Instagram conectada' : 'No se pudo conectar Instagram';
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

    const rl = await rateLimitMiddleware('social-auth-instagram', req);
    if (rl) return rl;

    const { clientId, clientSecret } = await getSocialCredentials(supabase, 'instagram');
    const redirectUri = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/social-auth-instagram`;

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
                error: 'Credenciales de Instagram no configuradas (app_settings social_instagram).',
            });
        }

        const state = await buildState(adminId, clientSecret);
        const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?` + new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: IG_SCOPES,
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
            return completionPage(false, 'Credenciales de Instagram no configuradas (app_settings social_instagram).');
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

            // 2. Extender a token de larga duración (~60 días, auto-renovable)
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

            // 3. Buscar las páginas del usuario
            const pagesRes = await fetch(`${GRAPH_API}/me/accounts?access_token=${longToken}`);
            if (!pagesRes.ok) {
                const t = (await pagesRes.text()).slice(0, 200);
                return completionPage(false, `No se pudieron leer las páginas de Facebook: ${t}`);
            }
            const pagesJson = (await pagesRes.json()) as {
                data?: Array<{ id: string; name: string; access_token: string; instagram_business_account?: { id: string } }>;
            };
            const pages = pagesJson.data ?? [];

            if (!pages.length) {
                return completionPage(false, 'No se encontró ninguna página de Facebook vinculada a tu cuenta. Instagram requiere una página de FB.');
            }

            // 4. Buscar la página que tiene Instagram vinculado
            let igAccount: { id: string; pageName: string; pageToken: string } | null = null;
            for (const page of pages) {
                const igRes = await fetch(`${GRAPH_API}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
                if (!igRes.ok) continue;
                const igJson = (await igRes.json()) as { instagram_business_account?: { id: string } };
                if (igJson.instagram_business_account?.id) {
                    igAccount = {
                        id: igJson.instagram_business_account.id,
                        pageName: page.name,
                        pageToken: page.access_token,
                    };
                    break;
                }
            }

            if (!igAccount) {
                return completionPage(false, 'Ninguna de tus páginas de Facebook tiene una cuenta de Instagram vinculada. Vinculá IG a una página desde Meta Business Suite → Configuración → Instagram.');
            }

            // 5. Datos del perfil IG
            const profileRes = await fetch(
                `${GRAPH_API}/${igAccount.id}?fields=username,profile_picture_url,followers_count,media_count&access_token=${igAccount.pageToken}`,
            );
            if (!profileRes.ok) {
                const t = (await profileRes.text()).slice(0, 200);
                return completionPage(false, `No se pudo leer el perfil de Instagram: ${t}`);
            }
            const profile = (await profileRes.json()) as {
                username?: string;
                profile_picture_url?: string;
                followers_count?: number;
                media_count?: number;
            };

            // 6. Cifrar + guardar (UNIQUE plataforma+external_id)
            const encToken = await encrypt(longToken);
            const encPageToken = await encrypt(igAccount.pageToken);
            const row = {
                platform: 'instagram' as const,
                external_id: igAccount.id,
                display_name: profile.username ?? '@bienenhaus.prop',
                avatar_url: profile.profile_picture_url ?? null,
                access_token_encrypted: encToken.data,
                access_token_iv: encToken.iv,
                refresh_token_encrypted: encPageToken.data,
                refresh_token_iv: encPageToken.iv,
                token_expires_at: new Date(Date.now() + (longJson.expires_in ?? 55 * 86400) * 1000).toISOString(),
                scope: IG_SCOPES,
                status: 'active' as const,
                updated_at: new Date().toISOString(),
            };
            const { error: upErr } = await supabase
                .from('social_accounts')
                .upsert(row, { onConflict: 'platform,external_id' });
            if (upErr) {
                return completionPage(false, `No se pudo guardar la conexión: ${upErr.message}`);
            }

            return completionPage(true, `@${profile.username} conectada (página: ${igAccount.pageName}).`);
        } catch (err) {
            return completionPage(false, (err as Error).message.slice(0, 200));
        }
    }

    return respond(405, { error: 'Método no permitido' });
});
