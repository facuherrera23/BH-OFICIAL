// ============================================================
// social-auth-youtube — OAuth de Google para el módulo CONTENIDO.
//
// POST  { action: 'start' }  → devuelve la URL de consentimiento
//        de Google (el panel la abre en popup). Requiere admin.
// GET   ?code=...&state=... → callback de Google: valida el state
//        firmado (HMAC, anti-CSRF), canjea el code por tokens,
//        cifra con _shared/crypto.ts y upsertea social_accounts
//        (UNIQUE plataforma+canal: reconectar no duplica), y
//        redirige al panel con el resultado en el hash.
//
// Credenciales: app_settings key 'social_youtube' (o env
// SOCIAL_YOUTUBE_CLIENT_ID/SECRET) — ver _shared/social.ts.
// verify_jwt OFF (el callback llega desde Google sin JWT):
// en NO_VERIFY del deploy.yml; el POST valida admin y el GET
// valida el state firmado.
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

const YT_SCOPES = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
    /* STUDIO 2026-10-27: edición/borrado de videos (videos.update/videos.delete)
       exige youtube.force-ssl — sin él el panel es solo lectura. Al cambiar
       scopes el dueño reconecta una vez y el upsert renueva los tokens. */
    'https://www.googleapis.com/auth/youtube.force-ssl',
    /* MEJORA 2026-10-30: métricas reales del canal (vistas 28d, minutos vistos,
       prom. duración, CTR del video) vía YouTube Analytics API v2. Solo lectura;
       las conexiones viejas seguirán funcionando sin él — la UI muestra
       "reconectá la cuenta" hasta que el dueño refresque el consentimiento. */
    'https://www.googleapis.com/auth/yt-analytics.readonly',
].join(' ');

/* ------- state firmado (patrón ml-oauth) ------- */
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

interface YtState {
    nonce: string;
    admin: string;
    exp: number;
    sig: string;
}

async function buildState(adminId: string, clientSecret: string): Promise<string> {
    const payload = { nonce: crypto.randomUUID(), admin: adminId, exp: Date.now() + 10 * 60_000 };
    const sig = await hmac(`${payload.nonce}|${adminId}|${payload.exp}`, clientSecret);
    const full: YtState = { ...payload, sig };
    return b64UrlEncode(new TextEncoder().encode(JSON.stringify(full)));
}

async function readState(raw: string, clientSecret: string): Promise<YtState | null> {
    try {
        const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
        const json = atob(padded);
        const state = JSON.parse(json) as YtState;
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

/** Página de cierre del popup: avisa a la ventana principal vía postMessage
 *  (patrón ml-oauth) y se cierra sola. */
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
        ? { type: 'SOCIAL_AUTH_SUCCESS', platform: 'youtube', message }
        : { type: 'SOCIAL_AUTH_ERROR', platform: 'youtube', error: message };
    const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');
    const title = ok ? 'Canal de YouTube conectado' : 'No se pudo conectar YouTube';
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

    const rl = await rateLimitMiddleware('social-auth-youtube', req);
    if (rl) return rl;

    const { clientId, clientSecret } = await getSocialCredentials(supabase, 'youtube');
    const redirectUri = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/social-auth-youtube`;

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
                error: 'Credenciales de YouTube no configuradas (app_settings social_youtube).',
            });
        }

        const state = await buildState(adminId, clientSecret);
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: YT_SCOPES,
            access_type: 'offline',
            prompt: 'consent',
            state,
        });
        return respond(200, { url: authUrl });
    }

    /* ------- GET: callback de Google (en el popup) ------- */
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const stateRaw = url.searchParams.get('state') ?? '';
        const errParam = url.searchParams.get('error');

        if (errParam) {
            return completionPage(false, `Google canceló la autorización (${errParam}).`);
        }
        if (!code) return respond(400, { error: 'Falta el código de autorización' });

        const state = await readState(stateRaw, clientSecret);
        if (!state) {
            return completionPage(false, 'La sesión de conexión expiró. Volvé al panel e intentá de nuevo.');
        }
        if (!clientId || !clientSecret) {
            return completionPage(false, 'Credenciales de YouTube no configuradas (app_settings social_youtube).');
        }

        try {
            // 1. Canjear code por tokens
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code,
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: redirectUri,
                    grant_type: 'authorization_code',
                }),
            });
            if (!tokenRes.ok) {
                const t = (await tokenRes.text()).slice(0, 200);
                return completionPage(false, `Google rechazó el código: ${t}`);
            }
            const tokens = (await tokenRes.json()) as {
                access_token: string;
                refresh_token?: string;
                expires_in?: number;
                scope?: string;
            };

            // 2. Datos del canal
            const chRes = await fetch(
                'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
                { headers: { Authorization: `Bearer ${tokens.access_token}` } },
            );
            if (!chRes.ok) {
                const t = (await chRes.text()).slice(0, 200);
                return completionPage(false, `No se pudo leer el canal de YouTube: ${t}`);
            }
            const chJson = (await chRes.json()) as {
                items?: Array<{
                    id?: string;
                    snippet?: { title?: string; thumbnails?: { default?: { url?: string } } };
                }>;
            };
            const channel = chJson.items?.[0];
            if (!channel?.id) {
                return completionPage(false, 'Esta cuenta de Google no tiene un canal de YouTube.');
            }

            // 3. Cifrar + upsert (UNIQUE plataforma+canal)
            const encAccess = await encrypt(tokens.access_token);
            const encRefresh = tokens.refresh_token ? await encrypt(tokens.refresh_token) : null;
            const row = {
                platform: 'youtube' as const,
                external_id: channel.id,
                display_name: channel.snippet?.title ?? 'Canal de YouTube',
                avatar_url: channel.snippet?.thumbnails?.default?.url ?? null,
                access_token_encrypted: encAccess.data,
                access_token_iv: encAccess.iv,
                refresh_token_encrypted: encRefresh?.data ?? null,
                refresh_token_iv: encRefresh?.iv ?? null,
                token_expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
                scope: tokens.scope ?? null,
                status: 'active' as const,
                updated_at: new Date().toISOString(),
            };
            const { error: upErr } = await supabase
                .from('social_accounts')
                .upsert(row, { onConflict: 'platform,external_id' });
            if (upErr) {
                return completionPage(false, `No se pudo guardar la conexión: ${upErr.message}`);
            }

            return completionPage(true, `Canal "${row.display_name}" conectado.`);
        } catch (err) {
            const msg = (err as Error).message.slice(0, 200);
            return completionPage(false, msg);
        }
    }

    return respond(405, { error: 'Método no permitido' });
});
