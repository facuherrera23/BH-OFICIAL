// ============================================================
// zernio-proxy — Proxy autenticado para la Inbox API de Zernio.
//
// DEPLOY: supabase functions deploy zernio-proxy --verify-jwt
// Se requiere JWT válido de usuario super_admin (via header Authorization: Bearer <jwt>).
//
// Acciones (body.action):
//   - send_message:        { conversationId, text }
//   - mark_read:           { conversationId }
//   - list_accounts:       (sync espejo cuentas)
//   - backfill_conversations
//   - backfill_messages:   { conversationId }
//
// API Key: variable de entorno ZERNIO_API_KEY con fallback a zernio_config (key='api_key').
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    auditEvent,
    auditSensitiveAction,
    trackToolUsage,
    auditError,
    getClientIp,
    getUserAgent,
} from '../_shared/audit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const ZERNIO_BASE = 'https://zernio.com/api/v1';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const ALLOWED_ORIGINS = new Set([
    'https://bienenhaus.com.ar',
    'https://www.bienenhaus.com.ar',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
]);

const VALID_PLATFORMS = ['instagram', 'facebook', 'whatsapp', 'telegram', 'twitter', 'bluesky', 'reddit', 'slack'];

// ---------- Utilidades ----------

function log(level: string, entry: Record<string, unknown>): void {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        function: 'zernio-proxy',
        ...entry,
    }));
}

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('origin');
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        return {
            'access-control-allow-origin': origin,
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type',
            vary: 'Origin',
        };
    }
    return {};
}

function respond(status: number, body: unknown, req: Request): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(req), 'content-type': 'application/json' },
    });
}

function optionsResponse(req: Request): Response {
    return new Response('ok', {
        headers: {
            ...corsHeaders(req),
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type',
        },
    });
}

function normalizeDirection(raw: string | undefined, fromMe?: boolean): 'in' | 'out' {
    // Zernio API uses 'outgoing'/'incoming'; DB uses 'out'/'in'
    const v = String(raw ?? '').toLowerCase();
    if (v === 'out' || v === 'outgoing') return 'out';
    if (v === 'in' || v === 'incoming') return 'in';
    // Fallback: infer from fromMe flag
    return fromMe ? 'out' : 'in';
}

function normalizePlatform(raw: unknown): string | null {
    const p = String(raw ?? '').toLowerCase();
    return VALID_PLATFORMS.includes(p) ? p : null;
}

function normalizeConvStatus(raw: unknown): string {
    // Zernio API: 'active' → DB: 'open'; 'closed'/'archived' → 'closed'
    const v = String(raw ?? '').toLowerCase();
    if (v === 'active' || v === 'open') return 'open';
    if (v === 'closed' || v === 'archived') return 'closed';
    return 'open';
}

function parseZernioError(rawBody: string, status: number): {
    code: string;
    status: number;
    user_message: string;
    remediation: string;
    zernio_error?: string;
} {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(rawBody); } catch {}

    const zernioType = String(parsed.type ?? '');
    const zernioCode = String(parsed.code ?? '');
    const platformErr = parsed.platformError as Record<string, unknown> | undefined;
    const platformCode = platformErr ? Number(platformErr.code ?? 0) : 0;

    if (zernioCode === 'missing_required_field' || platformCode === 190 || /has not authorized/i.test(rawBody)) {
        return {
            code: 'META_AUTH_REVOKED',
            status,
            user_message: 'Meta revocó la autorización de esta cuenta. La cuenta de Instagram/Facebook en Zernio no tiene los permisos necesarios para enviar mensajes.',
            remediation: '1) Abrí Zernio → Settings → Accounts → Instagram → Disconnect → Reconnect. ' +
                         '2) Durante el OAuth, seleccioná la página de Facebook vinculada y aceptá TODOS los permisos ' +
                         '(instagram_business_manage_messages, pages_messaging). ' +
                         '3) Verificá que la cuenta de Instagram esté vinculada a una página de Facebook desde la app de Instagram.',
            zernio_error: rawBody.slice(0, 300),
        };
    }

    if (status === 429) {
        return {
            code: 'RATE_LIMITED',
            status,
            user_message: 'Rate limit de Zernio alcanzado. Esperá unos segundos.',
            remediation: 'Reintentá automáticamente en unos segundos.',
            zernio_error: rawBody.slice(0, 200),
        };
    }

    if (/expired|access.token/i.test(rawBody)) {
        return {
            code: 'TOKEN_EXPIRED',
            status,
            user_message: 'El token de Zernio expiró o fue revocado.',
            remediation: 'Refrescá la API key en Zernio → Settings → API Keys y actualizá zernio_config o ZERNIO_API_KEY.',
            zernio_error: rawBody.slice(0, 300),
        };
    }

    if (zernioCode === 'invalid_request_error' || zernioType === 'invalid_request_error') {
        return {
            code: 'INVALID_REQUEST',
            status,
            user_message: 'Zernio rechazó la solicitud por formato inválido.',
            remediation: 'Verificá que la conversación tenga account_id válido y que el texto no esté vacío.',
            zernio_error: rawBody.slice(0, 300),
        };
    }

    const platformErrType = platformErr ? String(platformErr.type ?? '') : '';
    if (platformErrType === 'IGApiException' || /outside of allowed window/i.test(rawBody)) {
        return {
            code: 'OUTSIDE_WINDOW',
            status,
            user_message: 'Instagram rechaza mensajes fuera de la ventana de 24h. Esperá a que el contacto te escriba o usá una plantilla aprobada.',
            remediation: 'Pedí al contacto que te envíe un mensaje primero (abrirá la ventana de 24h) o configurá una plantilla aprobada en Meta Business Suite.',
            zernio_error: rawBody.slice(0, 300),
        };
    }

    return {
        code: 'ZERNIO_API_ERROR',
        status,
        user_message: `Zernio respondió con error ${status}.`,
        remediation: 'Revisá los logs de Zernio o contactá soporte.',
        zernio_error: rawBody.slice(0, 300),
    };
}

async function getZernioApiKey(): Promise<string> {
    const envKey = Deno.env.get('ZERNIO_API_KEY');
    if (envKey) return envKey;
    const { data } = await supabase
        .from('zernio_config')
        .select('value')
        .eq('key', 'api_key')
        .maybeSingle();
    const key = data?.value?.key;
    return typeof key === 'string' ? key : '';
}

async function requireSuperAdmin(req: Request): Promise<{ token: string; userId: string } | null> {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;

    const { data: profile } = await supabase
        .from('profiles')
        .select('role, is_active')
        .eq('id', user.id)
        .maybeSingle();
    if (!profile || !profile.is_active || profile.role !== 'super_admin') return null;

    return { token, userId: user.id };
}

async function zernioRequest(path: string, options: RequestInit & { apiKey?: string } = {}): Promise<Response> {
    const apiKey = options.apiKey ?? await getZernioApiKey();
    if (!apiKey) throw new Error('ZERNIO_API_KEY no configurada');

    const url = `${ZERNIO_BASE}${path}`;
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(options.headers as Record<string, string> ?? {}),
    };

    const doFetch = () => fetch(url, { ...options, headers });

    let res = await doFetch();

    // Manejo 429 con Retry-After
    if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const baseWait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
        for (let attempt = 1; attempt <= 3; attempt++) {
            await new Promise(r => setTimeout(r, baseWait * attempt));
            res = await doFetch();
            if (res.status !== 429) break;
        }
        if (res.status === 429) {
            throw new Error('Zernio API rate limit exceeded after 3 retries');
        }
    }

    return res;
}

// ============================================================
// Acciones
// ============================================================

async function actSendMessage(body: Record<string, unknown>, userId: string): Promise<unknown> {
    const conversationId = String(body.conversationId ?? '');
    const text = String(body.text ?? '');
    if (!conversationId || !text) throw new Error('conversationId y text requeridos');

    // Cargar conversación para obtener account_id y validar ventana 24h WhatsApp
    const { data: conv, error: convErr } = await supabase
        .from('zernio_conversations')
        .select('id, account_id, platform, last_message_at')
        .eq('id', conversationId)
        .maybeSingle();

    if (convErr) throw new Error('Error cargando conversación: ' + convErr.message);
    if (!conv) throw new Error('Conversación no encontrada');
    if (!conv.account_id) throw new Error('Conversación sin account_id');

    let windowClosed = false;
    if ((conv.platform === 'whatsapp' || conv.platform === 'instagram') && conv.last_message_at) {
        const lastIn = new Date(conv.last_message_at).getTime();
        if (Date.now() - lastIn > 24 * 60 * 60 * 1000) {
            windowClosed = true;
        }
    }

    if (windowClosed && conv.platform === 'instagram') {
        log('warn', { action: 'send_message', conv_id: conversationId, error: 'instagram_outside_window', platform_message_id: null });
        await auditSensitiveAction(
            supabase,
            new Request('http://internal', { method: 'POST' }),
            'send_message',
            'chat',
            'conversation',
            null,
            `Conv ${conversationId}: IG window closed`,
            { platform: conv.platform, account_id: conv.account_id },
            { window_closed: true, blocked: true },
            { source: 'zernio-proxy', action: 'send_message' }
        );
        return { ok: false, window_closed: true, platform: conv.platform, code: 'OUTSIDE_WINDOW', user_message: 'Instagram rechaza mensajes fuera de la ventana de 24h. Esperá a que el contacto te escriba o usá una plantilla aprobada.' };
    }

    const res = await zernioRequest(`/inbox/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
            accountId: conv.account_id,
            message: text,
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        log('warn', { action: 'send_message', conv_id: conversationId, status: res.status, error: errText.slice(0, 300) });
        const structured = parseZernioError(errText, res.status);
        if (structured.code === 'OUTSIDE_WINDOW') {
            return { ok: false, window_closed: true, platform: 'instagram', ...structured };
        }
        throw new Error(JSON.stringify(structured));
    }

    const zData = await res.json();
    // Zernio puede devolver { data: {...} } o el objeto directo
    const msgData = zData.data ?? zData;
    const platformMsgId = msgData.id ?? msgData.message_id ?? null;

    // Registrar mensaje saliente en nuestra DB
    const { error } = await supabase.from('zernio_messages').insert({
        conversation_id: conversationId,
        direction: 'out',
        platform_message_id: platformMsgId,
        body: text,
        status: 'sent',
        sent_by: userId,
        occurred_at: new Date().toISOString(),
    });
    if (error) log('warn', { action: 'send_message', error: 'insert out message: ' + error.message });

    // Actualizar conversación: último mensaje + limpiar unread
    await supabase.from('zernio_conversations').update({
        last_message_at: new Date().toISOString(),
        last_message_preview: text.length > 120 ? text.slice(0, 119) + '…' : text,
        unread_count: 0,
    }).eq('id', conversationId);

    // Auditoría: envío de mensaje por Zernio
    await auditSensitiveAction(
        supabase,
        new Request('http://internal', { method: 'POST' }),
        'send_message',
        'chat',
        'conversation',
        null,
        `Conv ${conversationId}: Msg to ${conv.platform}`,
        { platform: conv.platform, account_id: conv.account_id },
        { platform_message_id: platformMsgId, window_closed },
        { source: 'zernio-proxy', action: 'send_message' }
    );

    return { ok: true, platform_message_id: platformMsgId, window_closed };
}

async function actMarkRead(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = String(body.conversationId ?? '');
    if (!conversationId) throw new Error('conversationId requerido');

    // Necesitamos el account_id para la API de Zernio
    const { data: conv } = await supabase
        .from('zernio_conversations')
        .select('account_id')
        .eq('id', conversationId)
        .maybeSingle();

    if (!conv?.account_id) throw new Error('Conversación sin account_id');

    const res = await zernioRequest(`/inbox/conversations/${conversationId}/read?accountId=${encodeURIComponent(conv.account_id)}`, {
        method: 'POST',
    });

    if (!res.ok) {
        const errText = await res.text();
        log('warn', { action: 'mark_read', conv_id: conversationId, status: res.status, error: errText.slice(0, 300) });
        throw new Error(`Zernio mark_read failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    // Actualizar local: limpiar unread
    await supabase
        .from('zernio_conversations')
        .update({ unread_count: 0 })
        .eq('id', conversationId);

    return { ok: true };
}

async function actListAccounts(): Promise<unknown> {
    const res = await zernioRequest('/accounts');
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Zernio accounts failed (${res.status}): ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const accounts = Array.isArray(data) ? data : (data.data ?? []);

    // Upsert espejo — batch
    const now = new Date().toISOString();
    const validAccounts = accounts
        .map((acc: Record<string, unknown>) => {
            const platform = normalizePlatform(acc.platform);
            const id = String(acc.id ?? '');
            if (!platform || !id) return null;
            return {
                zernio_account_id: id,
                platform,
                username: String(acc.username ?? acc.name ?? ''),
                status: 'connected',
                raw: acc,
                last_synced_at: now,
            };
        })
        .filter((a: unknown): a is Record<string, unknown> => a !== null);

    if (validAccounts.length > 0) {
        const { error } = await supabase.from('zernio_accounts').upsert(validAccounts, { onConflict: 'zernio_account_id' });
        if (error) throw new Error('upsert accounts: ' + error.message);
    }
    return { ok: true, count: validAccounts.length };
}

async function actBackfillConversations(): Promise<unknown> {
    // Paginación: max 4 páginas (200 conversaciones)
    let cursor: string | null = null;
    let total = 0;

    for (let page = 0; page < 4; page++) {
        const url = `/inbox/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await zernioRequest(url);
        if (!res.ok) break;
        const data = await res.json();
        const items = data.data ?? data ?? [];
        if (!Array.isArray(items) || items.length === 0) break;

        // Mapear campos camelCase de Zernio → snake_case de DB
        const accountsToUpsert: Array<Record<string, unknown>> = [];
        const conversationsToUpsert: Array<Record<string, unknown>> = [];
        const seenAccounts = new Set<string>();

        for (const c of items) {
            const platform = normalizePlatform(c.platform);
            const accountId = String(c.accountId ?? c.account_id ?? '');
            const convId = String(c.id ?? '');
            if (!platform || !accountId || !convId) continue;

            if (!seenAccounts.has(accountId)) {
                seenAccounts.add(accountId);
                accountsToUpsert.push({
                    zernio_account_id: accountId,
                    platform,
                    username: String(c.accountUsername ?? c.username ?? ''),
                    status: 'connected',
                });
            }

            conversationsToUpsert.push({
                id: convId,
                account_id: accountId,
                contact_name: String(c.participantName ?? c.contact_name ?? c.name ?? ''),
                contact_handle: String(c.participantUsername ?? c.contact_handle ?? c.handle ?? ''),
                platform,
                last_message_at: c.updatedTime ?? c.last_message_at ?? null,
                last_message_preview: String(c.lastMessage ?? c.last_message_preview ?? ''),
                unread_count: Number(c.unreadCount ?? c.unread_count ?? 0),
                status: normalizeConvStatus(c.status),
                raw: c,
            });
        }

        if (accountsToUpsert.length > 0) {
            await supabase.from('zernio_accounts').upsert(accountsToUpsert, { onConflict: 'zernio_account_id' });
        }
        if (conversationsToUpsert.length > 0) {
            const { error } = await supabase.from('zernio_conversations').upsert(conversationsToUpsert, { onConflict: 'id' });
            if (error) throw new Error('upsert conversations: ' + error.message);
        }
        total += conversationsToUpsert.length;

        cursor = data.pagination?.nextCursor ?? data.next_cursor ?? data.cursor ?? null;
        if (!cursor) break;
    }
    return { ok: true, total };
}

async function actBackfillMessages(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = String(body.conversationId ?? '');
    if (!conversationId) throw new Error('conversationId requerido');

    // Deduplicar contra lo ya guardado
    const { data: existingRows } = await supabase
        .from('zernio_messages')
        .select('platform_message_id')
        .eq('conversation_id', conversationId)
        .not('platform_message_id', 'is', null);
    const existingIds = new Set((existingRows ?? []).map(r => r.platform_message_id));

    let cursor: string | null = null;
    let total = 0;

    for (let page = 0; page < 10; page++) {
        // Zernio usa ?cursor= + &sortOrder=asc, y requiere accountId para conversaciones
        const { data: conv } = await supabase
            .from('zernio_conversations')
            .select('account_id')
            .eq('id', conversationId)
            .maybeSingle();

        const params = new URLSearchParams();
        if (cursor) params.set('cursor', cursor);
        params.set('sortOrder', 'asc');
        if (conv?.account_id) params.set('accountId', conv.account_id);

        const url = `/inbox/conversations/${conversationId}/messages?${params.toString()}`;
        const res = await zernioRequest(url);
        if (!res.ok) {
            const errText = await res.text();
            log('warn', { action: 'backfill_messages', conv_id: conversationId, status: res.status, error: errText.slice(0, 200) });
            break;
        }
        const data = await res.json();
        const items = data.messages ?? data.data ?? data ?? [];
        if (!Array.isArray(items) || items.length === 0) break;

        const messagesToInsert: Array<Record<string, unknown>> = [];
        for (const m of items) {
            // Zernio usa 'id' para el mensaje, 'message' para el texto, 'createdAt' para timestamp
            const pid = String(m.id ?? '');
            if (!pid || existingIds.has(pid)) continue;
            existingIds.add(pid);

            // attachments: array o object
            let attachment: Record<string, unknown> | null = null;
            if (Array.isArray(m.attachments) && m.attachments.length > 0) {
                attachment = m.attachments[0];
            } else if (m.attachment && typeof m.attachment === 'object') {
                attachment = m.attachment;
            }

            messagesToInsert.push({
                conversation_id: conversationId,
                direction: normalizeDirection(m.direction, m.fromMe ?? m.from_me),
                platform_message_id: pid,
                body: String(m.message ?? m.text ?? m.body ?? ''),
                attachment,
                status: m.isDeleted ? 'deleted' : 'received',
                zernio_event_id: null,
                occurred_at: m.createdAt ?? m.created_at ?? new Date().toISOString(),
            });
        }

        if (messagesToInsert.length > 0) {
            const { error } = await supabase.from('zernio_messages').upsert(messagesToInsert, {
                onConflict: 'platform_message_id,conversation_id',
                ignoreDuplicates: true,
            });
            if (error) log('warn', { action: 'backfill_messages', error: 'insert: ' + error.message });
        }
        total += messagesToInsert.length;

        cursor = data.pagination?.nextCursor ?? data.next_cursor ?? data.cursor ?? null;
        if (!cursor) break;
    }
    return { ok: true, total };
}

async function actDiagnose(): Promise<unknown> {
    const accountsRes = await zernioRequest('/accounts');
    if (!accountsRes.ok) {
        throw new Error(`Zernio accounts failed (${accountsRes.status})`);
    }
    const accountsData = await accountsRes.json();
    const accounts = Array.isArray(accountsData) ? accountsData : (accountsData.accounts ?? accountsData.data ?? []);

    const report: Array<{
        accountId: string;
        platform: string;
        username: string;
        isActive: boolean;
        enabled: boolean;
        health: Record<string, unknown> | null;
        facebookPage: Record<string, unknown> | string | null;
        issues: string[];
        ok: boolean;
    }> = [];

    for (const acc of accounts) {
        const accountId = String(acc._id ?? acc.id ?? '');
        const platform = String(acc.platform ?? '');
        if (!accountId) continue;

        const issues: string[] = [];

        const healthRes = await zernioRequest(`/accounts/${accountId}/health`);
        const health = healthRes.ok ? await healthRes.json() : null;

        let facebookPage: Record<string, unknown> | string | null = null;
        if (platform === 'instagram') {
            const fbPageRes = await zernioRequest(`/accounts/${accountId}/facebook-page`);
            if (fbPageRes.ok) {
                facebookPage = await fbPageRes.json();
                const errMsg = String((facebookPage as Record<string, unknown>)?.error ?? '');
                if (errMsg || !facebookPage) {
                    issues.push(`IG no vinculada a Facebook Page en Zernio: ${errMsg || 'sin page'}`);
                }
            }
        } else if (platform === 'facebook') {
            const fbPageRes = await zernioRequest(`/accounts/${accountId}/facebook-page`);
            if (fbPageRes.ok) {
                facebookPage = await fbPageRes.json();
                const pages = (facebookPage as Record<string, unknown>)?.pages as unknown[] | undefined;
                if (!pages || pages.length === 0) {
                    issues.push('FB account sin páginas disponibles');
                }
            }
        }

        if (health && health.status !== 'healthy') {
            issues.push(`Status: ${health.status}`);
        }
        if (health && health.permissions && Array.isArray((health.permissions as Record<string, unknown>).posting)) {
            for (const p of (health.permissions as Record<string, unknown>).posting as Array<Record<string, unknown>>) {
                if (p.required && !p.granted) {
                    issues.push(`Falta permiso requerido: ${p.scope}`);
                }
            }
        }

        report.push({
            accountId,
            platform,
            username: String(acc.username ?? acc.displayName ?? ''),
            isActive: Boolean(acc.isActive),
            enabled: Boolean(acc.enabled),
            health,
            facebookPage,
            issues,
            ok: issues.length === 0 && Boolean(acc.isActive) && Boolean(acc.enabled),
        });
    }

    return {
        ok: report.every(r => r.ok),
        total: report.length,
        healthy: report.filter(r => r.ok).length,
        with_issues: report.filter(r => !r.ok).length,
        accounts: report,
    };
}

async function actListFacebookPages(body: Record<string, unknown>): Promise<unknown> {
    const accountId = String(body.accountId ?? '');
    if (!accountId) throw new Error('accountId requerido');
    const res = await zernioRequest(`/accounts/${accountId}/facebook-page`);
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Zernio facebook-page failed (${res.status}): ${errText.slice(0, 300)}`);
    }
    return await res.json();
}

// ============================================================
// Entry point
// ============================================================

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);
    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' }, req);

    const auth = await requireSuperAdmin(req);
    if (!auth) return respond(401, { error: 'No autorizado (super_admin requerido)' }, req);

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' }, req);
    }

    const action = String(body.action ?? '');
    try {
        switch (action) {
            case 'send_message': {
                const result = await actSendMessage(body, auth.userId);
                return respond(200, result, req);
            }
            case 'mark_read': {
                const result = await actMarkRead(body);
                return respond(200, result, req);
            }
            case 'list_accounts': {
                const result = await actListAccounts();
                return respond(200, result, req);
            }
            case 'backfill_conversations': {
                const result = await actBackfillConversations();
                return respond(200, result, req);
            }
            case 'backfill_messages': {
                const result = await actBackfillMessages(body);
                return respond(200, result, req);
            }
            case 'diagnose': {
                const result = await actDiagnose();
                return respond(200, result, req);
            }
            case 'list_facebook_pages': {
                const result = await actListFacebookPages(body);
                return respond(200, result, req);
            }
            default:
                return respond(400, { error: `Acción desconocida: ${action}` }, req);
        }
    } catch (err) {
        log('error', { action, error: (err as Error).message });
        return respond(500, { error: (err as Error).message }, req);
    }
});
