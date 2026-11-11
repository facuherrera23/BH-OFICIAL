// ============================================================
// social-auth-tiktok — OAuth de TikTok (Login Kit v2).
//
// A diferencia de Facebook (page token que NO vence), el token de
// TikTok vive 2 HORAS y se renueva con un refresh token de 180 días
// ROTATIVO: cada refresh devuelve un refresh_token nuevo que
// invalida el anterior (la rotación la maneja _shared/social.ts con
// CAS + persistencia del refresh nuevo).
//
// POST  { action: 'start' }  → URL de consentimiento de TikTok
// GET   ?code=...&state=...  → callback: canjea el code por tokens,
//        lee /v2/user/info/, guarda UNA fila social_accounts
//        (platform 'tiktok', external_id = open_id) y cierra el
//        popup con postMessage (patrón ml-oauth/social-auth-*).
//
// Scopes: user.info.basic (perfil) + video.publish (Direct Post).
// Autorización: https://www.tiktok.com/v2/auth/authorize/
// Canje:        https://open.tiktokapis.com/v2/oauth/token/
// Requisitos previos (owner):
// - App en developers.tiktok.com con productos Login Kit + Content
//   Posting API (scope video.publish)
// - Redirect URI exacta registrada en la app
// - Credenciales: app_settings key 'social_tiktok' (o env
//   SOCIAL_TIKTOK_CLIENT_KEY/SECRET — TikTok llama client_key al
//   client_id de otras plataformas)
// verify_jwt OFF (callback de TikTok no trae JWT): NO_VERIFY.
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

const API_BASE = 'https://open.tiktokapis.com/v2';
const TT_SCOPES = ['user.info.basic', 'video.publish'].join(',');

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

interface TtState {
    nonce: string;
    admin: string;
    exp: number;
    sig: string;
}

async function buildState(adminId: string, clientSecret: string): Promise<string> {
    const payload = { nonce: crypto.randomUUID(), admin: adminId, exp: Date.now() + 10 * 60_000 };
    const sig = await hmac(`${payload.nonce}|${adminId}|${payload.exp}`, clientSecret);
    const full: TtState = { ...payload, sig };
    return b64UrlEncode(new TextEncoder().encode(JSON.stringify(full)));
}

async function readState(raw: string, clientSecret: string): Promise<TtState | null> {
    try {
        const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
        const json = atob(padded);
        const state = JSON.parse(json) as TtState;
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
        ? { type: 'SOCIAL_AUTH_SUCCESS', platform: 'tiktok', message }
        : { type: 'SOCIAL_AUTH_ERROR', platform: 'tiktok', error: message };
    const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');
    const title = ok ? 'Cuenta de TikTok conectada' : 'No se pudo conectar TikTok';
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

/* TikTok devuelve los errores del token endpoint como JSON plano
   {"error":"...","error_description":"..."} (distinto del Content Posting
   API que anida {"error":{"code","message"}}). */
function tokenErrorDesc(raw: string, status: number): string {
    let msg = '';
    try {
        const json = JSON.parse(raw) as { error?: string; error_description?: string; message?: string };
        msg = json.error_description || json.message || json.error || '';
    } catch {
        msg = raw.slice(0, 200);
    }
    return msg || `HTTP ${status}`;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    const rl = await rateLimitMiddleware('social-auth-tiktok', req);
    if (rl) return rl;

    const { clientId, clientSecret } = await getSocialCredentials(supabase, 'tiktok');
    const redirectUri = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/social-auth-tiktok`;

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
                error: 'Credenciales de TikTok no configuradas (app_settings social_tiktok).',
            });
        }

        const state = await buildState(adminId, clientSecret);
        const authUrl = `https://www.tiktok.com/v2/auth/authorize/?` + new URLSearchParams({
            client_key: clientId,
            scope: TT_SCOPES,
            response_type: 'code',
            redirect_uri: redirectUri,
            state,
        });
        return respond(200, { url: authUrl });
    }

    /* ------- GET: callback de TikTok (en el popup) ------- */
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const stateRaw = url.searchParams.get('state') ?? '';
        const errParam = url.searchParams.get('error_description') ?? url.searchParams.get('error');

        if (errParam) {
            return completionPage(false, `TikTok canceló la autorización: ${errParam}`);
        }
        if (!code) return respond(400, { error: 'Falta el código de autorización' });

        const state = await readState(stateRaw, clientSecret);
        if (!state) {
            return completionPage(false, 'La sesión de conexión expiró. Volvé al panel e intentá de nuevo.');
        }
        if (!clientId || !clientSecret) {
            return completionPage(false, 'Credenciales de TikTok no configuradas (app_settings social_tiktok).');
        }

        try {
            // 1. Canjear code por tokens (access 2h + refresh rotativo 180d)
            const tokenRes = await fetch(`${API_BASE}/oauth/token/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_key: clientId,
                    client_secret: clientSecret,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri,
                }),
            });
            if (!tokenRes.ok) {
                return completionPage(false, `TikTok rechazó el código: ${tokenErrorDesc(await tokenRes.text(), tokenRes.status)}`);
            }
            const tokenJson = (await tokenRes.json()) as {
                access_token?: string;
                expires_in?: number;
                refresh_token?: string;
                scope?: string;
                open_id?: string;
                error?: string;
                error_description?: string;
            };
            if (!tokenJson.access_token || !tokenJson.refresh_token) {
                const desc = tokenJson.error_description || tokenJson.error || 'sin tokens en la respuesta';
                return completionPage(false, `TikTok no devolvió los tokens: ${desc.slice(0, 200)}`);
            }
            const accessToken = tokenJson.access_token;
            const refreshToken = tokenJson.refresh_token;
            const expiresIn = tokenJson.expires_in ?? 7200; // 2 h (TikTok)

            // 2. Perfil del usuario (display_name + avatar para la tarjeta)
            let displayName = 'Cuenta de TikTok';
            let avatarUrl: string | null = null;
            try {
                const userRes = await fetch(
                    `${API_BASE}/user/info/?fields=open_id,union_id,display_name,avatar_url&access_token=${accessToken}`,
                );
                if (userRes.ok) {
                    const userJson = (await userRes.json()) as {
                        data?: { user?: { display_name?: string; avatar_url?: string } };
                    };
                    displayName = userJson.data?.user?.display_name || displayName;
                    avatarUrl = userJson.data?.user?.avatar_url ?? null;
                }
            } catch (_) { /* best-effort: el perfil no bloquea la conexión */ }

            // 3. Guardar UNA fila (UNIQUE plataforma+external_id, external_id = open_id).
            //    token_expires_at refleja el ACCESS token (2 h): getSocialAccessToken
            //    refresca cuando falten <5 min (la rotación del refresh la hace la shared).
            const encAccess = await encrypt(accessToken);
            const encRefresh = await encrypt(refreshToken);
            const row = {
                platform: 'tiktok' as const,
                external_id: tokenJson.open_id || 'tiktok-user',
                display_name: displayName,
                avatar_url: avatarUrl,
                access_token_encrypted: encAccess.data,
                access_token_iv: encAccess.iv,
                refresh_token_encrypted: encRefresh.data,
                refresh_token_iv: encRefresh.iv,
                token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
                scope: tokenJson.scope || TT_SCOPES,
                status: 'active' as const,
                updated_at: new Date().toISOString(),
            };
            const { error: upErr } = await supabase
                .from('social_accounts')
                .upsert(row, { onConflict: 'platform,external_id' });
            if (upErr) {
                return completionPage(false, `No se pudo guardar la conexión: ${upErr.message}`);
            }

            return completionPage(true, `Cuenta conectada: ${displayName}.`);
        } catch (err) {
            return completionPage(false, (err as Error).message.slice(0, 200));
        }
    }

    return respond(405, { error: 'Método no permitido' });
});
