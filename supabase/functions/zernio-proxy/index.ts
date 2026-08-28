// ============================================================
// zernio-proxy — Proxy autenticado para la Inbox API de Zernio.
//
// DEPLOY: supabase functions deploy zernio-proxy --verify-jwt
// Se requiere JWT válido de usuario super_admin (via header Authorization: Bearer <jwt>).
//
// Acciones (body.action):
//   - send_message:     { conversationId, text }
//   - mark_read:        { conversationId }
//   - list_accounts:    (sync espejo cuentas)
//   - backfill_conversations
//   - backfill_messages: { conversationId? }
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
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...options.headers,
    };

    const res = await fetch(url, {
        ...options,
        headers,
    });

    // Manejo 429 con Retry-After y límite de reintentos
    if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
        
        // Retry con backoff exponencial, máximo 3 intentos
        for (let attempt = 1; attempt <= 3; attempt++) {
            await new Promise(r => setTimeout(r, wait * attempt));
            const retryRes = await fetch(url, { ...options, headers });
            if (retryRes.status !== 429) {
                return retryRes;
            }
            // Si sigue 429, esperar más tiempo y reintentar
            const nextWait = res.headers.get('retry-after') ? parseInt(res.headers.get('retry-after')!, 10) * 1000 : wait * 2;
            await new Promise(r => setTimeout(r, wait * attempt));
        }
        // Si todos los reintentos fallan, lanzar error
        throw new Error('Zernio API rate limit exceeded after 3 retries');
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

    // Cargar conversación para validar ventana 24h WhatsApp
    const { data: conv } = await supabase
        .from('zernio_conversations')
        .select('id, account_id, platform, last_message_at')
        .eq('id', conversationId)
        .maybeSingle();

    if (!conv) throw new Error('Conversación no encontrada');

    // Verificar ventana 24h para WhatsApp (solo aviso, no bloqueo)
    let windowClosed = false;
    if (conv.platform === 'whatsapp' && conv.last_message_at) {
        const lastIn = new Date(conv.last_message_at).getTime();
        if (Date.now() - lastIn > 24 * 60 * 60 * 1000) {
            windowClosed = true;
        }
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
        throw new Error(`Zernio send failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    const zData = await res.json();
    const platformMsgId = zData.id ?? zData.message_id ?? null;

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
    if (error) console.warn('insert out message:', error.message);

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

    return { ok: true, platform_message_id: platformMsgId, window_closed: windowClosed };
}

async function actMarkRead(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = String(body.conversationId ?? '');
    if (!conversationId) throw new Error('conversationId requerido');

    const res = await zernioRequest(`/inbox/conversations/${conversationId}/read`, {
        method: 'POST',
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Zernio mark_read failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    // Actualizar local
    await supabase
        .from('zernio_conversations')
        .update({ unread_count: 0 })
        .eq('id', conversationId);

    return { ok: true };
}

// Configuración de plataformas válidas - extensible via env var
    const PLATFORMS_CONFIG = Deno.env.get('ZERNIO_VALID_PLATFORMS');
    const VALID_PLATFORMS = PLATFORMS_CONFIG
        ? PLATFORMS_CONFIG.split(',').map(p => p.trim().toLowerCase())
        : ['instagram', 'facebook', 'whatsapp', 'telegram', 'twitter', 'bluesky', 'reddit', 'slack'];

    async function actListAccounts(): Promise<unknown> {
        const res = await zernioRequest('/accounts');
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Zernio accounts failed (${res.status}): ${errText.slice(0, 300)}`);
        }
        const data = await res.json();
        const accounts = Array.isArray(data) ? data : (data.data ?? []);

        // Upsert espejo — batch para evitar await en loop
        const now = new Date().toISOString();
        const validAccounts = accounts
            .map(acc => {
                const platform = String(acc.platform ?? '').toLowerCase();
                if (!VALID_PLATFORMS.includes(platform)) return null;
                return {
                    zernio_account_id: String(acc.id ?? ''),
                    platform,
                    username: String(acc.username ?? acc.name ?? ''),
                    status: 'connected',
                    raw: acc,
                    last_synced_at: now,
                };
            })
            .filter((a): a is NonNullable<typeof a> => a !== null);

    if (validAccounts.length > 0) {
        await supabase.from('zernio_accounts').upsert(validAccounts, { onConflict: 'zernio_account_id' });
    }
    return { ok: true, count: validAccounts.length };
}

async function actBackfillConversations(): Promise<unknown> {
    // Paginación simple: 50 por página, max 200 — batch upserts para evitar await en loop
    let cursor: string | null = null;
    let total = 0;
    const validPlatforms = ['instagram','facebook','whatsapp','telegram','twitter','bluesky','reddit','slack'];
    for (let page = 0; page < 4; page++) {
        const url = `/inbox/conversations${cursor ? `?cursor=${cursor}` : ''}`;
        const res = await zernioRequest(url);
        if (!res.ok) break;
        const data = await res.json();
        const items = data.data ?? data ?? [];
        if (!Array.isArray(items) || items.length === 0) break;

        // Batch accounts
        const accountsToUpsert = items
            .map(c => {
                const platform = String(c.platform ?? '');
                if (!validPlatforms.includes(platform)) return null;
                return {
                    zernio_account_id: String(c.account_id ?? ''),
                    platform,
                    username: String(c.username ?? ''),
                    status: 'connected',
                };
            })
            .filter((a): a is NonNullable<typeof a> => a !== null);

        // Batch conversations
        const conversationsToUpsert = items
            .map(c => {
                const platform = String(c.platform ?? '');
                if (!validPlatforms.includes(platform)) return null;
                return {
                    id: String(c.id ?? ''),
                    account_id: String(c.account_id ?? ''),
                    contact_name: String(c.contact_name ?? c.name ?? ''),
                    contact_handle: String(c.contact_handle ?? c.handle ?? ''),
                    platform,
                    last_message_at: c.last_message_at ? new Date(c.last_message_at).toISOString() : null,
                    last_message_preview: String(c.last_message_preview ?? ''),
                    unread_count: c.unread_count ?? 0,
                    status: c.status ?? 'open',
                    raw: c,
                };
            })
            .filter((a): a is NonNullable<typeof a> => a !== null);

        if (accountsToUpsert.length > 0) {
            await supabase.from('zernio_accounts').upsert(accountsToUpsert, { onConflict: 'zernio_account_id' });
        }
        if (conversationsToUpsert.length > 0) {
            await supabase.from('zernio_conversations').upsert(conversationsToUpsert, { onConflict: 'id' });
        }
        total += conversationsToUpsert.length;

        cursor = data.next_cursor ?? data.cursor ?? null;
        if (!cursor) break;
    }
    return { ok: true, total };
}

async function actBackfillMessages(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = String(body.conversationId ?? '');
    if (!conversationId) throw new Error('conversationId requerido');

    // `id` es uuid autogenerado (no lo mandamos), así que un upsert con onConflict:'id'
    // nunca detecta colisiones y duplica todo en cada backfill. Deduplicamos nosotros
    // contra lo ya guardado por platform_message_id antes de insertar.
    const { data: existingRows } = await supabase
        .from('zernio_messages')
        .select('platform_message_id')
        .eq('conversation_id', conversationId)
        .not('platform_message_id', 'is', null);
    const existingIds = new Set((existingRows ?? []).map(r => r.platform_message_id));

    let cursor: string | null = null;
    let total = 0;
    for (let page = 0; page < 10; page++) {
        const url = `/inbox/conversations/${conversationId}/messages${cursor ? `?cursor=${cursor}&sortOrder=asc` : '?sortOrder=asc'}`;
        const res = await zernioRequest(url);
        if (!res.ok) break;
        const data = await res.json();
        const items = data.data ?? data ?? [];
        if (!Array.isArray(items) || items.length === 0) break;

        // Batch messages — single pass reduce to avoid chained filter+map
        const messagesToInsert: Array<{
            conversation_id: string;
            direction: string;
            platform_message_id: string;
            body: string;
            attachment: { url: string; type: string; name?: string; size?: number } | null;
            status: string;
            zernio_event_id: null;
            occurred_at: string;
        }> = [];
        for (const m of items) {
            const pid = String(m.id ?? '');
            if (!pid || existingIds.has(pid)) continue;
            existingIds.add(pid);
            messagesToInsert.push({
                conversation_id: conversationId,
                direction: String(m.direction ?? (m.from_me ? 'out' : 'in')),
                platform_message_id: pid,
                body: String(m.text ?? m.body ?? ''),
                attachment: m.attachment ?? null,
                status: String(m.status ?? 'received'),
                zernio_event_id: null,
                occurred_at: m.created_at ? new Date(m.created_at).toISOString() : new Date().toISOString(),
            });
        }

        if (messagesToInsert.length > 0) {
            // Upsert con onConflict en platform_message_id + conversation_id para evitar duplicados
            // El id es autogenerado, pero platform_message_id + conversation_id es único
            await supabase.from('zernio_messages').upsert(messagesToInsert, {
                onConflict: 'platform_message_id,conversation_id',
                ignoreDuplicates: false
            });
        }
        total += messagesToInsert.length;

        cursor = data.next_cursor ?? data.cursor ?? null;
        if (!cursor) break;
    }
    return { ok: true, total };
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
            default:
                return respond(400, { error: `Acción desconocida: ${action}` }, req);
        }
    } catch (err) {
        return respond(500, { error: (err as Error).message }, req);
    }
});