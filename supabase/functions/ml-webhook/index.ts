import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    getActiveTemplate,
    getMlAccessToken,
    sendOrderMessage,
    sendQuestionAnswer,
} from '../_shared/auto_reply.ts';
import { ML_API, getMlCredentials } from '../_shared/ml.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import {
    MlOrderSchema,
    MlWebhookPayloadSchema,
    parseMlResponse,
} from '../_shared/ml.schemas.ts';
import type { MlWebhookPayload, MlOrder } from '../_shared/ml.schemas.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

const RATE_LIMIT_FN = 'ml-webhook';

function timingSafeEqual(a: string, b: string): boolean {
    const ba = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

interface LogEntry {
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    function: string;
    topic?: string;
    resource?: string;
    user_id?: number;
    status:
        | 'received'
        | 'processed'
        | 'failed'
        | 'deduplicated'
        | 'auto_reply_sent'
        | 'unhandled'
        | number;
    duration_ms?: number;
    error?: string;
    question_id?: string;
    order_id?: string;
    trigger?: string;
    attempts?: number;
}

function log(entry: Omit<LogEntry, 'timestamp' | 'level'>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', ...entry }));
}
function logWarn(entry: Omit<LogEntry, 'timestamp' | 'level'>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', ...entry }));
}
function logError(entry: Omit<LogEntry, 'timestamp' | 'level'>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', ...entry }));
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
    const secret = (await getMlCredentials(supabase)).webhookSecret;
    // Sin secreto configurado no hay nada contra qué comparar: la barrera real es
    // validateNotificationBinding (el user_id debe ser el de la cuenta conectada).
    if (!secret) return true;
    const signature = req.headers.get('x-meli-signature');
    // ML (marketplace) no firma las notificaciones de tópicos de usuario: no hay
    // header de firma documentado y la autenticidad se valida re-consultando el
    // recurso con el token del vendedor. Sin header se confía en binding + rate
    // limit. La versión anterior rechazaba todo lo sin firma Y comparaba el HMAC
    // contra el secreto en plano (matemáticamente imposible): mataba toda
    // notificación real de ML.
    if (!signature) return true;
    // Si ML empieza a firmar algún día (formato ts=...,v1=...): verificar el
    // HMAC-SHA256 correcto sobre los bytes crudos del body — nunca contra el secreto.
    const match = signature.match(/ts=(\d+),v1=([a-f0-9]+)/);
    if (!match) return false;
    const tsHmac = await hmacSha256Hex(secret, match[1] + rawBody);
    if (timingSafeEqual(match[2], tsHmac)) return true;
    const bodyHmac = await hmacSha256Hex(secret, rawBody);
    return timingSafeEqual(match[2], bodyHmac);
}

async function logWebhookEvent(
    payload: MlWebhookPayload,
    status: 'received' | 'processed' | 'failed' | 'deduplicated',
    error?: string,
): Promise<void> {
    const { data: existing } = await supabase
        .from('ml_webhook_events')
        .select('id')
        .eq('user_id', payload.user_id)
        .eq('resource', payload.resource)
        .eq('topic', payload.topic)
        .eq('sent_at', payload.sent)
        .maybeSingle();
    const row = {
        user_id: payload.user_id,
        resource: payload.resource,
        topic: payload.topic,
        application_id: payload.application_id,
        attempts: payload.attempts,
        sent_at: payload.sent,
        received_at: payload.received,
        status,
        error: error ?? null,
        payload: JSON.stringify(payload),
    };
    if (existing?.id) {
        await supabase
            .from('ml_webhook_events')
            .update({
                status,
                error: error ?? null,
                payload: JSON.stringify(payload),
                attempts: payload.attempts,
            })
            .eq('id', existing.id);
    } else {
        await supabase.from('ml_webhook_events').insert(row);
    }
}

async function validateNotificationBinding(payload: MlWebhookPayload): Promise<boolean> {
    const clientId = (await getMlCredentials(supabase)).clientId;
    if (clientId && String(payload.application_id) !== clientId) return false;
    const { data: connection } = await supabase
        .from('ml_connection')
        .select('user_id')
        .eq('provider', 'mercadolibre')
        .eq('is_active', true)
        .eq('user_id', payload.user_id)
        .maybeSingle();
    return !!connection;
}

async function handleQuestions(payload: MlWebhookPayload): Promise<void> {
    const questionId = payload.resource.split('/').pop();
    if (!questionId) return;

    const template = await getActiveTemplate(supabase, 'new_question');

    // Resolver item_id (string) y datos de la pregunta desde ML.
    // El resource del webhook es el ID de la pregunta, NO el del item.
    let token: string | null = null;
    try {
        token = await getMlAccessToken(supabase);
    } catch (err) {
        // Sin token no se puede procesar nada: el evento queda 'failed' (visible)
        // en ml_webhook_events en vez de 'processed' mentiroso.
        throw new Error(`ML token: ${(err as Error).message}`);
    }

    if (!token) throw new Error('ML token: no hay conexión ML activa');

    let q: { item_id?: unknown; text?: unknown; from?: { user_id?: unknown; nickname?: unknown }; date_created?: unknown } | null = null;
    try {
        const res = await fetch(`${ML_API}/questions/${questionId}?api_version=4`, {
            headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
            // Pregunta eliminada/bloqueada por moderación antes del fetch: el evento
            // queda 'failed' (visible) en vez de 'processed' mentiroso.
            throw new Error(`ML question ${questionId} HTTP ${res.status}`);
        }
        q = await res.json();
    } catch (err) {
        throw new Error(`ML question fetch: ${(err as Error).message}`);
    }

    const itemId: unknown = q?.item_id;
    let propertyId: string | null = null;
    let mlPermalink: string | null = null;
    const mlItemId: string | null = typeof itemId === 'string' ? itemId : null;

    if (itemId != null) {
        const { data: meta } = await supabase
            .from('property_ml_meta')
            .select('property_id, ml_item_id, permalink')
            .eq('ml_item_id', itemId)
            .maybeSingle();
        if (meta) {
            propertyId = meta.property_id;
            mlPermalink = typeof meta.permalink === 'string' ? meta.permalink : null;
        }
        // Fallback: si la publicación se hizo a mano en ML y no está en property_ml_meta
        if (!propertyId) {
            const { data: listing } = await supabase
                .from('ml_listings')
                .select('property_id')
                .eq('ml_item_id', itemId)
                .maybeSingle();
            if (listing?.property_id) propertyId = listing.property_id;
        }
    }

    /* property_ml_meta.permalink viene NULL en las filas actuales: el link real
       del aviso se resuelve contra la API de items con el token del vendedor
       (mismo acceso que usa ml-metrics). Fail-soft: sin link el lead sigue
       sirviendo con pregunta + propiedad + perfil. */
    if (!mlPermalink && mlItemId && token) {
        try {
            const itemRes = await fetch(`${ML_API}/items/${mlItemId}`, {
                headers: { authorization: `Bearer ${token}` },
            });
            if (itemRes.ok) {
                const item = (await itemRes.json()) as { permalink?: string };
                if (typeof item.permalink === 'string' && item.permalink) mlPermalink = item.permalink;
            }
        } catch {
            /* sin link al aviso: el lead conserva el resto del contexto */
        }
    }

    /* Contexto de conversión para el broker: código y nombre de la propiedad,
       link directo al aviso de ML y perfil público del interesado (reputación). */
    let propContext = '';
    const fromNickname = typeof q?.from?.nickname === 'string' ? q.from.nickname : '';
    if (propertyId) {
        const { data: prop } = await supabase
            .from('properties')
            .select('property_code, title')
            .eq('id', propertyId)
            .maybeSingle();
        if (prop?.property_code) {
            propContext += `\nPropiedad: ${prop.property_code}${prop.title ? ' · ' + prop.title : ''}`;
        }
    }
    if (mlPermalink) propContext += `\nAviso ML: ${mlPermalink}`;
    if (fromNickname) {
        propContext += `\nPerfil del interesado: https://www.mercadolibre.com.ar/perfil/${encodeURIComponent(fromNickname)}`;
    }

    // Cada pregunta nueva en ML crea un lead en el CRM. El dedupe por question_id
    // lo protege de los reenvíos de webhook que ML a veces hace.
    try {
        const { data: existing } = await supabase
            .from('ml_questions')
            .select('lead_id')
            .eq('question_id', questionId)
            .maybeSingle();

        if (!existing?.lead_id) {
            const questionText = typeof q?.text === 'string' ? q.text : '';
            const fromName =
                typeof q?.from?.nickname === 'string' && q.from.nickname
                    ? q.from.nickname
                    : `Interesado ML (user ${typeof q?.from?.user_id === 'number' ? q.from.user_id : 'desconocido'})`;

            const { data: newLead, error: leadErr } = await supabase
                .from('leads')
                .insert({
                    full_name: fromName,
                    source: 'ml',
                    stage: 'nuevo',
                    property_id: propertyId,
                    /* El lead nace con TODO el contexto de conversión: pregunta +
                       propiedad vinculada + link al aviso + perfil del interesado. */
                    notes: `[Pregunta Mercado Libre] ${questionText || 'Consulta desde Mercado Libre'}${propContext}`,
                })
                .select('id')
                .single();

            if (!leadErr && newLead?.id) {
                await supabase
                    .from('ml_questions')
                    .update({ lead_id: newLead.id })
                    .eq('question_id', questionId);
            }
        }
    } catch (err) {
        logWarn({ function: 'ml-webhook', topic: 'questions', question_id: questionId, error: 'lead_create: ' + (err as Error).message });
    }

    if (!template) {
        // Sin plantilla activa: solo registrar como no respondida
        if (propertyId) {
            await supabase.from('ml_questions').upsert(
                {
                    question_id: questionId,
                    property_id: propertyId,
                    ml_item_id: mlItemId,
                    status: 'unanswered',
                    received_at: new Date().toISOString(),
                },
                { onConflict: 'question_id' },
            );
        }
        return;
    }

    await supabase.from('ml_questions').upsert(
        {
            question_id: questionId,
            property_id: propertyId,
            ml_item_id: mlItemId,
            received_at: new Date().toISOString(),
            question_text: typeof q?.text === 'string' ? q.text : null,
            from_user_id: typeof q?.from?.user_id === 'number' ? q.from.user_id : null,
            from_user_nickname: typeof q?.from?.nickname === 'string' ? q.from.nickname : null,
            date_created: typeof q?.date_created === 'string' ? q.date_created : null,
            status: 'answered',
            answer_text: template.message,
            date_updated: new Date().toISOString(),
        },
        { onConflict: 'question_id' },
    );

    try {
        await sendQuestionAnswer(supabase, questionId, template.message, token);
    } catch (err) {
        await supabase
            .from('ml_questions')
            .update({ status: 'unanswered', answer_text: null })
            .eq('question_id', questionId);
        logWarn({
            function: 'ml-webhook',
            topic: 'questions',
            question_id: questionId,
            error: (err as Error).message,
        });
    }
}

const ORDER_STATUS_TRIGGER: Record<string, string> = {
    paid: 'order_paid',
    shipped: 'order_shipped',
    delivered: 'order_delivered',
    confirmed: 'new_order',
};

function deriveOrderStatus(order: MlOrderSchema | null): string {
    if (!order || order.status === 'cancelled') return 'cancelled';
    if (order.status === 'payment_in_process') return 'new';

    const shippingStatus = order.shipping?.status;
    if (shippingStatus === 'delivered') return 'delivered';
    if (shippingStatus === 'shipped' || shippingStatus === 'sent') return 'shipped';

    const approved = (order.payments ?? []).some((p) => p?.status === 'approved');
    if (approved) return 'paid';

    const pending = (order.payments ?? []).some((p) => p?.status === 'pending');
    if (pending) return 'new';

    if (order.status === 'confirmed' || order.status === 'paid') return 'confirmed';
    return 'new';
}

async function handleOrders(payload: MlWebhookPayload): Promise<void> {
    const orderId = payload.resource.split('/').pop();
    if (!orderId) return;

    let token: string | null = null;
    try {
        token = await getMlAccessToken(supabase);
    } catch (err) {
        logWarn({ function: 'ml-webhook', topic: 'orders', error: (err as Error).message });
    }

    let order: MlOrder | null = null;
    if (token) {
        try {
            const res = await fetch(`${ML_API}/orders/${orderId}`, {
                headers: { authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                try {
                    const data = await res.json();
                    order = parseMlResponse(MlOrderSchema, data, 'mlOrder');
                } catch {
                    order = null;
                }
            } else {
                logWarn({
                    function: 'ml-webhook',
                    topic: 'orders',
                    order_id: orderId,
                    status: res.status,
                });
            }
        } catch (err) {
            logWarn({
                function: 'ml-webhook',
                topic: 'orders',
                order_id: orderId,
                error: (err as Error).message,
            });
        }
    }

    const status = deriveOrderStatus(order);

    const itemId: unknown = order?.order_items?.[0]?.item?.id;
    let propertyId: string | null = null;
    const mlItemId: string | null = typeof itemId === 'string' ? itemId : null;
    if (itemId != null) {
        const { data: meta } = await supabase
            .from('property_ml_meta')
            .select('property_id, ml_item_id')
            .eq('ml_item_id', itemId)
            .maybeSingle();
        if (meta) {
            propertyId = meta.property_id;
        }
    }

    const { data: existing } = await supabase
        .from('ml_orders')
        .select('status')
        .eq('order_id', orderId)
        .maybeSingle();
    const prevStatus = existing?.status ?? null;

    const orderPayload: Record<string, unknown> = {
        order_id: orderId,
        ml_item_id: mlItemId,
        status,
        received_at: new Date().toISOString(),
    };
    if (propertyId) orderPayload.property_id = propertyId;
    if (order) {
        if (typeof order.buyer?.id === 'number') orderPayload.buyer_id = order.buyer.id;
        if (typeof order.buyer?.nickname === 'string')
            orderPayload.buyer_nickname = order.buyer.nickname;
        if (typeof order.total_amount === 'number') orderPayload.total_amount = order.total_amount;
        if (typeof order.currency_id === 'string') orderPayload.currency = order.currency_id;
        if (typeof order.date_created === 'string') orderPayload.date_created = order.date_created;
        if (typeof order.date_closed === 'string') orderPayload.date_closed = order.date_closed;
    }

    await supabase.from('ml_orders').upsert(orderPayload, { onConflict: 'order_id' });

    const trigger = ORDER_STATUS_TRIGGER[status];
    if (trigger && token && prevStatus !== status) {
        const template = await getActiveTemplate(supabase, trigger);
        if (template) {
            try {
                await sendOrderMessage(supabase, orderId, template.message, token);
                log({
                    function: 'ml-webhook',
                    topic: 'orders',
                    order_id: orderId,
                    trigger,
                    status: 'auto_reply_sent',
                });
            } catch (err) {
                logWarn({
                    function: 'ml-webhook',
                    topic: 'orders',
                    order_id: orderId,
                    trigger,
                    error: (err as Error).message,
                });
            }
        }
    }
}

async function handleItems(payload: MlWebhookPayload): Promise<void> {
    const itemId = payload.resource.split('/').pop();
    if (!itemId) return;

    const { data: meta } = await supabase
        .from('property_ml_meta')
        .select('property_id, ml_item_id')
        .eq('ml_item_id', itemId)
        .maybeSingle();

    if (meta) {
        const { error: enqueueErr } = await supabase.rpc('ml_enqueue', {
            p_property_id: meta.property_id,
            p_operation: 'update',
            p_ml_item_id: meta.ml_item_id,
        });
        /* Se lanza para que el evento quede 'failed' (visible): antes se pasaba
           un parámetro inexistente (p_internal) y el error de PostgREST se
           tragaba en silencio con el evento marcado 'processed'. */
        if (enqueueErr) throw new Error(`ml_enqueue: ${enqueueErr.message}`);
    }
}

async function handlePayments(payload: MlWebhookPayload): Promise<void> {
    const paymentId = payload.resource.split('/').pop();
    if (!paymentId) return;

    await supabase.from('ml_payments').upsert({
        payment_id: paymentId,
        status: 'pending',
        received_at: new Date().toISOString(),
        payload: JSON.stringify(payload),
    });
}

async function handleShipments(payload: MlWebhookPayload): Promise<void> {
    const shipmentId = payload.resource.split('/').pop();
    if (!shipmentId) return;

    await supabase.from('ml_shipments').upsert({
        shipment_id: shipmentId,
        status: 'pending',
        received_at: new Date().toISOString(),
        payload: JSON.stringify(payload),
    });
}

Deno.serve(async (req) => {
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);

    if (req.method === 'OPTIONS') return optionsResponse(req);
    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });

    // Rate Limiting
    const clientIp =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        'unknown';
    const rlResult = await checkRateLimit('ml-webhook', clientIp);
    if (!rlResult.allowed) {
        return respond(429, { error: 'Rate limited', retry_after: rlResult.retryAfter });
    }

    // Body crudo leído UNA sola vez antes de verificar: la firma (si viene) se
    // computa sobre exactamente los bytes recibidos.
    let rawBody = '';
    try {
        rawBody = await req.text();
    } catch {
        return respond(400, { error: 'Invalid body' });
    }

    // Verify signature (secret se lee dinamicamente en verifySignature)
    const verified = await verifySignature(req, rawBody);
    if (!verified) return respond(401, { error: 'Invalid signature' });

    let payload: MlWebhookPayload;
    try {
        payload = parseMlResponse(MlWebhookPayloadSchema, JSON.parse(rawBody), 'ml-webhook');
    } catch {
        return respond(400, { error: 'Invalid JSON' });
    }

    const start = Date.now();

    if (!(await validateNotificationBinding(payload))) {
        return respond(401, {
            error: 'Notificacion no perteneciente a la aplicacion/cuenta conectada',
        });
    }

    // Deduplication check
    const { data: existingEvent } = await supabase
        .from('ml_webhook_events')
        .select('status')
        .eq('resource', payload.resource)
        .eq('topic', payload.topic)
        .eq('sent_at', payload.sent)
        .maybeSingle();

    if (existingEvent && existingEvent.status === 'processed') {
        log({
            function: 'ml-webhook',
            topic: payload.topic,
            resource: payload.resource,
            attempts: payload.attempts,
            status: 'deduplicated',
        });
        return respond(200, { ok: true, deduplicated: true });
    }

    // ML desactiva los tópicos ("fall back") si el callback no responde 200 en
    // ~500ms, y reintenta 5 veces durante 1 hora antes de darla por perdida. El
    // procesamiento (fetch a la API de ML + upserts) tarda más que ese margen:
    // se responde 200 inmediatamente y se procesa en background con
    // EdgeRuntime.waitUntil. Los errores de procesamiento quedan como
    // status='failed' en ml_webhook_events (ya no hay retry de ML — el trade-off
    // que recomienda la propia doc de notificaciones de ML).
    const task = (async () => {
        await logWebhookEvent(payload, 'received');
        try {
            switch (payload.topic) {
                case 'questions':
                    await handleQuestions(payload);
                    break;
                case 'orders':
                case 'orders_v2':
                    await handleOrders(payload);
                    break;
                case 'items':
                    await handleItems(payload);
                    break;
                case 'payments':
                    await handlePayments(payload);
                    break;
                case 'shipments':
                    await handleShipments(payload);
                    break;
                default:
                    logWarn({ function: 'ml-webhook', topic: payload.topic, status: 'unhandled' });
            }
            await logWebhookEvent(payload, 'processed');
            log({
                function: 'ml-webhook',
                topic: payload.topic,
                resource: payload.resource,
                duration_ms: Date.now() - start,
                status: 'processed',
            });
        } catch (err) {
            logError({
                function: 'ml-webhook',
                topic: payload.topic,
                resource: payload.resource,
                duration_ms: Date.now() - start,
                status: 'failed',
                error: (err as Error).message,
            });
            await logWebhookEvent(payload, 'failed', (err as Error).message);
        }
    })();

    const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
        .EdgeRuntime;
    if (edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(task);
    } else {
        await task; // fuera del edge runtime (tests locales): procesar sincrónico
    }
    return respond(200, { ok: true });
});
