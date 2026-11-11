// ============================================================
// social-webhook-meta — Webhook de Meta (Facebook Pages + Instagram).
//
// ÚNICO callback para la MISMA app de Meta que conecta las dos redes
// (Instagram API with Facebook Login + Pages API). Trae los
// comentarios de los posts publicados desde el CRM:
//
//   GET  → verificación del endpoint (Meta la hace al guardar la URL):
//          hub.mode=subscribe & hub.verify_token & hub.challenge
//          → responde 200 con el challenge EN TEXTO PLANO (si el
//          verify_token matchea) o 403 (si no).
//          El verify_token vive en app_settings key
//          'social_meta_webhook' (lo genera y muestra el panel,
//          action webhook_info de social-comments).
//
//   POST → notificaciones firmadas con X-Hub-Signature-256:
//          hex(HMAC-SHA256(rawBody, app_secret)). El app secret sale
//          de app_settings social_facebook / social_instagram (la
//          MISMA app → mismo secret; probamos ambos, timing-safe).
//          Sin firma válida NO se procesa nada (401).
//
//   object=page       field=feed      value.item='comment' & verb='add'
//   object=instagram  field=comments  value = {id, from{id,username},
//                                             text, media{id}} (objeto o array)
//
// Qué hace con un comentario:
//   1. Matchea el post en social_posts (IG: media.id == external_post_id;
//      FB: post_id "PAGEID_MEDIAID" → igualdad o sufijo _MEDIAID, porque
//      el CRM guarda el id de la foto/video).
//   2. INSERT en social_comments como CLAIM (UNIQUE external_id,
//      ignoreDuplicates): Meta re-entrega y el sync re-pasa — el que
//      pierde no duplica.
//   3. NUNCA crea el lead acá: el lead nace desde la bandeja del panel
//      (admin-initiated, con consent_at — patrón de YouTube, no el
//      automático de ML: los comentarios sociales son chatter, no
//      consultas formales).
//
// verify_jwt OFF (está en NO_VERIFY del CI): Meta no manda JWT y la
// autenticación real es la firma HMAC.
//
// Responde 200 SIEMPRE que la firma sea válida (Meta reintenta 5 veces
// si no; un insert duplicado no es error). Errores internos no tumbar
// la entrega: el comentario perdido lo recupera la action `sync`.
// ============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';
import { getSocialCredentials } from '../_shared/social.ts';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

const WEBHOOK_KEY = 'social_meta_webhook';

/* ------------------------------------------------------------
   Crypto helpers
   ------------------------------------------------------------ */

/** Comparación timing-safe sobre strings (patrón ml-webhook: XOR
    acumulado — sin early-return por byte distinto). */
function timingSafeEqual(a: string, b: string): boolean {
    const ba = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------
   app_settings: verify_token compartido FB/IG (la misma app de Meta
   configura UN solo webhook en el dashboard).
   ------------------------------------------------------------ */

async function getVerifyToken(): Promise<string | null> {
    const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', WEBHOOK_KEY)
        .maybeSingle();
    const token = data?.value?.verify_token;
    return typeof token === 'string' && token.length > 10 ? token : null;
}

/* ------------------------------------------------------------
   Parseo tolerante de la notificación → comentarios normalizados
   ------------------------------------------------------------ */

interface WebhookComment {
    platform: 'facebook' | 'instagram';
    externalId: string;
    externalPostId: string;
    authorName: string | null;
    authorHandle: string | null;
    body: string;
    parentExternalId: string | null;
    commentedAt: string | null;
    metadata: Record<string, unknown>;
}

function clip(s: unknown, max: number): string {
    return String(s ?? '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
        .trim()
        .slice(0, max);
}

/** FB manda unix-seconds; IG a veces ISO, a veces nada. */
function toIso(t: unknown): string | null {
    if (t == null) return null;
    if (typeof t === 'number' && isFinite(t) && t > 0) {
        const ms = t < 1e12 ? t * 1000 : t;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof t === 'string') {
        const n = Number(t);
        if (isFinite(n) && n > 0 && !t.includes('-')) return toIso(n);
        const d = new Date(t);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
}

function collectComments(payload: any): WebhookComment[] {
    const out: WebhookComment[] = [];
    const object = String(payload?.object ?? '');
    const entries = Array.isArray(payload?.entry) ? payload.entry : [];
    for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
            const field = String(change?.field ?? '');
            const values = Array.isArray(change?.value) ? change.value : [change?.value];
            for (const value of values) {
                if (!value || typeof value !== 'object') continue;
                /* Facebook: field 'feed', item 'comment', verb 'add'
                   (verb 'remove'/'edit' y items 'post'/'like' → ignora). */
                if (object === 'page' && field === 'feed') {
                    if (String(value.item ?? '') !== 'comment') continue;
                    if (String(value.verb ?? 'add') !== 'add') continue;
                    const externalId = clip(value.comment_id, 80);
                    if (!externalId) continue;
                    out.push({
                        platform: 'facebook',
                        externalId,
                        externalPostId: clip(value.post_id, 120),
                        authorName: clip(value.from?.name, 120) || null,
                        authorHandle: null,
                        body: clip(value.message, 3000),
                        parentExternalId: value.parent_id ? clip(value.parent_id, 120) : null,
                        commentedAt: toIso(value.created_time),
                        metadata: { source: 'webhook', from_id: clip(value.from?.id, 60), is_hidden: !!value.is_hidden },
                    });
                    continue;
                }
                /* Instagram: field 'comments' → id, from{id,username},
                   text, media{id} (docs marcan value como objeto o array). */
                if (object === 'instagram' && field === 'comments') {
                    const externalId = clip(value.id, 80);
                    if (!externalId) continue;
                    out.push({
                        platform: 'instagram',
                        externalId,
                        externalPostId: clip(value.media?.id, 120),
                        authorName: clip(value.from?.username, 120) || null,
                        authorHandle: clip(value.from?.username, 120) || null,
                        body: clip(value.text, 3000),
                        parentExternalId: value.parent_id ? clip(value.parent_id, 120) : null,
                        commentedAt: toIso(value.created_time ?? value.timestamp),
                        metadata: {
                            source: 'webhook',
                            from_id: clip(value.from?.id, 60),
                            media_product_type: clip(value.media?.media_product_type, 30),
                        },
                    });
                }
            }
        }
    }
    return out;
}

/* ------------------------------------------------------------
   Match del post comentado (id del webhook → social_posts)
   ------------------------------------------------------------ */

interface PostMatch {
    id: string;
    property_id: string | null;
    account_id: string | null;
}

async function findPost(platform: string, externalPostId: string): Promise<PostMatch | null> {
    if (!externalPostId) return null;
    const cols = 'id, property_id, account_id';
    const { data: exact } = await supabase
        .from('social_posts')
        .select(cols)
        .eq('platform', platform)
        .eq('external_post_id', externalPostId)
        .limit(1)
        .maybeSingle();
    if (exact) return exact as PostMatch;
    /* FB: el CRM guarda el id de la foto/video; el webhook trae
       post_id "PAGEID_MEDIAID" → match por sufijo _MEDIAID. Los ids
       son numéricos (sin % ni _ adentro): el LIKE es seguro. */
    const tail = externalPostId.includes('_') ? String(externalPostId.split('_').pop() ?? '') : '';
    if (tail && tail !== externalPostId) {
        const { data: suf } = await supabase
            .from('social_posts')
            .select(cols)
            .eq('platform', platform)
            .like('external_post_id', '%_' + tail)
            .limit(1)
            .maybeSingle();
        if (suf) return suf as PostMatch;
    }
    return null;
}

/** ¿Es un comentario PROPIO (hecho desde la cuenta/page que publicó)?
    Los replies que dejamos nosotros vuelven por el webhook igual que
    cualquier comentario — si entraran a la triage ensuciarían la
    bandeja. Se insertan igual (queda la traza del diálogo) pero como
    dismissed + metadata.self, fuera de los "nuevos". */
async function isSelfComment(accountId: string | null, fromId: string): Promise<boolean> {
    if (!accountId || !fromId) return false;
    const { data } = await supabase
        .from('social_accounts')
        .select('external_id')
        .eq('id', accountId)
        .limit(1)
        .maybeSingle();
    return !!data && String((data as { external_id?: string }).external_id ?? '') === String(fromId);
}

/** Error de insert ≠ duplicado → traza en audit_log (user_id NULL es
    válido: la escritura es del server, no de un usuario). Sin esto un
    fallo de PostgREST invisibiliza comentarios sin rastro (la clase de
    bug de ml-webhook pre-logRejectedPayload). */
async function auditInsertError(platform: string, externalId: string, error: { code?: string; message?: string }) {
    try {
        await supabase.from('audit_log').insert({
            action: 'meta_webhook_error',
            module: 'contenido',
            table_name: 'social_comments',
            status: 'error',
            error_code: clip(error.code ?? '', 40),
            metadata: {
                platform,
                external_id: externalId,
                message: clip(error.message ?? '', 300),
            },
        });
    } catch (_) { /* best-effort: no tumba la entrega */ }
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);

    const url = new URL(req.url);

    /* ---- Verificación del endpoint (GET, la hace Meta 1 vez) ---- */
    if (req.method === 'GET') {
        const mode = url.searchParams.get('hub.mode') ?? '';
        const token = url.searchParams.get('hub.verify_token') ?? '';
        const challenge = url.searchParams.get('hub.challenge') ?? '';
        if (mode !== 'subscribe' || !challenge) {
            return jsonResponse(400, { error: 'Faltan parámetros de verificación' }, req);
        }
        const expected = await getVerifyToken();
        if (!expected) {
            console.error('[social-webhook-meta] sin verify_token en app_settings (el panel lo genera con webhook_info)');
            return jsonResponse(403, { error: 'Webhook no configurado' }, req);
        }
        if (!timingSafeEqual(token, expected)) {
            return jsonResponse(403, { error: 'verify_token inválido' }, req);
        }
        /* Meta exige el challenge EN TEXTO PLANO, no JSON. */
        return new Response(challenge, {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
    }

    if (req.method !== 'POST') return jsonResponse(405, { error: 'Método no permitido' }, req);

    const rl = await rateLimitMiddleware('social-webhook-meta', req);
    if (rl) return rl;

    /* ---- Firma X-Hub-Signature-256 ---- */
    const raw = await req.text();
    const sigHeader = req.headers.get('x-hub-signature-256') ?? '';
    const m = sigHeader.match(/^sha256=([0-9a-fA-F]+)$/);
    if (!m) return jsonResponse(401, { error: 'Sin firma' }, req);

    /* El app secret vive en app_settings social_facebook (la MISMA app
       de Meta sirve IG y FB — mismo secret; fallback a social_instagram
       por si algún día se separan). */
    let secret = '';
    try {
        const fb = await getSocialCredentials(supabase, 'facebook');
        secret = fb.clientSecret || '';
        if (!secret) {
            const ig = await getSocialCredentials(supabase, 'instagram');
            secret = ig.clientSecret || '';
        }
    } catch (err) {
        console.error('[social-webhook-meta] error leyendo credenciales:', err);
    }
    if (!secret) {
        /* Sin app configurada no hay webhook registrado en Meta — esta
           request no puede ser legítima (o el owner borró la config). */
        return jsonResponse(401, { error: 'App de Meta sin configurar' }, req);
    }

    const expectedSig = await hmacSha256Hex(secret, raw);
    if (!timingSafeEqual(m[1].toLowerCase(), expectedSig)) {
        return jsonResponse(403, { error: 'Firma inválida' }, req);
    }

    /* ---- Proceso ---- */
    let payload: any;
    try {
        payload = JSON.parse(raw);
    } catch (_) {
        /* Body corrupto con firma válida = imposible en la práctica;
           200 para no entrar en loop de reintentos de Meta. */
        return jsonResponse(200, { ok: true, note: 'body no-JSON ignorado' }, req);
    }

    const comments = collectComments(payload);
    let inserted = 0;
    let selfRows = 0;
    for (const c of comments) {
        try {
            const post = await findPost(c.platform, c.externalPostId);
            const fromId = String(c.metadata.from_id ?? '');
            const self = await isSelfComment(post?.account_id ?? null, fromId);
            const { error } = await supabase.from('social_comments').upsert(
                {
                    platform: c.platform,
                    external_id: c.externalId,
                    external_post_id: c.externalPostId || null,
                    social_post_id: post?.id ?? null,
                    property_id: post?.property_id ?? null,
                    account_id: post?.account_id ?? null,
                    author_name: c.authorName,
                    author_handle: c.authorHandle,
                    body: c.body || null,
                    parent_external_id: c.parentExternalId,
                    commented_at: c.commentedAt ?? new Date().toISOString(),
                    status: self ? 'dismissed' : 'new',
                    metadata: self ? { ...c.metadata, self: true } : c.metadata,
                },
                { onConflict: 'external_id', ignoreDuplicates: true },
            );
            /* 23505 (duplicado reclamado por ignoreDuplicates) NO es error:
               el comentario ya está. Un error real se audita y sigue — la
               entrega no se tumba por un comentario fallado. */
            if (error && error.code !== '23505') {
                console.error('[social-webhook-meta] insert error:', error);
                await auditInsertError(c.platform, c.externalId, error as { code?: string; message?: string });
            } else if (!error) {
                if (self) selfRows++;
                else inserted++;
            }
        } catch (err) {
            console.error('[social-webhook-meta] procesando comentario:', err);
        }
    }

    return jsonResponse(200, { ok: true, received: comments.length, inserted, self: selfRows }, req);
});
