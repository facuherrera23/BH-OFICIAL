import { createClient } from 'npm:@supabase/supabase-js@2';
import {
    ML_API,
    fetchWithTimeout,
    getAccessToken,
    getMlCooldown,
    mlCloseItem,
    mlCreateItem,
    mlGetItem,
    mlSetDescription,
    mlUpdateItem,
    mlUploadPictures,
    setMlCooldown,
    type MlConnectionRow,
    type MlItem,
} from '../_shared/ml.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { MlItemSchema, type MlItemPayload, parseMlResponse } from '../_shared/ml.schemas.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

// ============================================================
// Structured Logging
// ============================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    function: string;
    job_id?: number;
    property_id?: string;
    ml_item_id?: string | null;
    operation?: string;
    duration_ms?: number;
    ml_api_latency_ms?: number;
    status?:
        | 'success'
        | 'failed'
        | 'rate_limited'
        | 'retry'
        | 'dead_letter'
        | 'cooldown_active'
        | 'claim_failed'
        | 'requeue_failed'
        | 'requeued_stuck_jobs'
        | 'batch_aborted_rate_limited';
    error?: string;
    metadata?: Record<string, unknown>;
    property_image?: string;
    retry_after?: number;
    question_id?: string;
    order_id?: string;
    trigger?: string;
}

function log(level: LogLevel, entry: Omit<LogEntry, 'timestamp' | 'level'>): void {
    const out: LogEntry = { timestamp: new Date().toISOString(), level, ...entry };
    console.log(JSON.stringify(out));
}

const logger = {
    debug: (e: Omit<LogEntry, 'timestamp' | 'level'>) => log('debug', e),
    info: (e: Omit<LogEntry, 'timestamp' | 'level'>) => log('info', e),
    warn: (e: Omit<LogEntry, 'timestamp' | 'level'>) => log('warn', e),
    error: (e: Omit<LogEntry, 'timestamp' | 'level'>) => log('error', e),
};

// ============================================================
// Auth
// ============================================================

function timingSafeEqual(a: string, b: string): boolean {
    const ba = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

async function isAuthorized(req: Request): Promise<boolean> {
    // x-sync-secret bypasses JWT for server-to-server sync triggers.
    const secret = Deno.env.get('ML_SYNC_SECRET');
    if (secret) {
        const headerSecret = req.headers.get('x-sync-secret');
        if (headerSecret && timingSafeEqual(headerSecret, secret)) return true;
    }

    return (await requireAdmin(req, supabase)) !== null;
}

// ============================================================
// Types
// ============================================================

interface PropertyRow {
    id: string;
    title: string;
    description: string | null;
    listing_type: string;
    price: number | null;
    currency: string;
    address: string | null;
    area_total: number | null;
    area_covered: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    garages: number | null;
    property_type: string | null;
    rooms: number | null;
    full_bathrooms: number | null;
    pets_allowed: boolean | null;
    has_storage: boolean | null;
    furnished: boolean | null;
    maintenance_fee: number | null;
    inscription_number: string | null;
    images: { url: string; storage_path?: string }[];
}

interface QueueJob {
    id: number;
    property_id: string;
    operation: string;
    ml_item_id: string | null;
    attempts: number;
    max_attempts: number;
}

// ============================================================
// Config (from env)
// ============================================================

const BATCH_SIZE = Number(Deno.env.get('ML_SYNC_BATCH_SIZE') ?? '10');
const MAX_CONCURRENT_JOBS = Number(Deno.env.get('ML_SYNC_MAX_CONCURRENT') ?? '3');
const RATE_LIMIT_FN = 'ml-sync';
const ML_COOLDOWN_MS = Number(Deno.env.get('ML_SYNC_COOLDOWN_MS') ?? '60000');

// ============================================================
// Helpers
// ============================================================

async function fetchProperty(id: string): Promise<PropertyRow | null> {
    const { data } = await supabase
        .from('properties')
        .select(
            'id, title, description, listing_type, price, currency, address, area_total, area_covered, bedrooms, bathrooms, garages, property_type, rooms, full_bathrooms, pets_allowed, has_storage, furnished, maintenance_fee, inscription_number, images:property_images(url, storage_path)',
        )
        .eq('id', id)
        .maybeSingle();
    return data ?? null;
}

async function fetchDefaults(): Promise<{
    category_id: string;
    listing_type_id: string;
    condition: string;
}> {
    const { data } = await supabase
        .from('site_settings')
        .select('value')
        .eq('key', 'ml_defaults')
        .maybeSingle();
    const value = data?.value ?? {};
    return {
        category_id: String(value.category_id ?? ''),
        listing_type_id: String(value.listing_type_id ?? 'silver'),
        condition: String(value.condition ?? 'not_specified'),
    };
}

// ============================================================
// Parallel Image Upload
// ============================================================

async function prepareImagesForML(
    accessToken: string,
    images: { url: string; storage_path?: string }[],
): Promise<string[]> {
    const validImages = images
        .slice(0, 12)
        .filter((i): i is { url: string; storage_path: string } => !!i.storage_path);
    if (validImages.length === 0) return [];

    const downloadUpload = async (img: { storage_path: string }) => {
        try {
            const { data: fileData, error } = await supabase.storage
                .from('property-images')
                .download(img.storage_path);

            if (error || !fileData) {
                logger.warn({
                    function: 'ml-sync',
                    property_image: img.storage_path,
                    error: error?.message,
                });
                return null;
            }

            const arrayBuffer = await fileData.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            const ext = img.storage_path.split('.').pop()?.toLowerCase();
            const contentType =
                ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

            const formData = new FormData();
            const blob = new Blob([uint8Array], { type: contentType });
            const safeName = `image_${crypto.randomUUID()}.${ext || 'jpg'}`;
            formData.append('file', blob, safeName);

            const uploadRes = await fetchWithTimeout(`${ML_API}/pictures`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
                body: formData,
            });

            if (!uploadRes.ok) {
                const errText = await uploadRes.text();
                logger.warn({
                    function: 'ml-sync',
                    property_image: img.storage_path,
                    error: errText,
                });
                return null;
            }

            const uploadData = await uploadRes.json();
            const variations = (uploadData as { variations?: Array<{ id?: string; url?: string }> }).variations ?? [];
            const mainVariation =
                variations.find((v) => v.id === 'original') ?? variations[0];
            return mainVariation?.url ?? null;
        } catch (err) {
            logger.error({
                function: 'ml-sync',
                property_image: img.storage_path,
                error: (err as Error).message,
            });
            return null;
        }
    };

    const results = await Promise.allSettled(validImages.map(downloadUpload));

    const urls: string[] = [];
    results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) urls.push(r.value);
        else
            logger.warn({
                function: 'ml-sync',
                property_image: validImages[i].storage_path,
                error: r.status === 'rejected' ? r.reason : 'no url',
            });
    });
    return urls;
}

// ============================================================
// ML API Calls with Zod Validation
// ============================================================

async function mlCreateItemValidated(
    accessToken: string,
    payload: MlItemPayload,
    idempotencyKey?: string,
): Promise<MlItem> {
    const start = Date.now();
    const res = await fetchWithTimeout(`${ML_API}/items`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
    });
    const latency = Date.now() - start;
    const text = await res.text();
    if (!res.ok) throw new Error(`ML createItem failed (${res.status}): ${text.slice(0, 300)}`);
    const parsed = parseMlResponse(MlItemSchema, JSON.parse(text), 'mlCreateItem');
    logger.debug({ function: 'ml-sync', ml_api_latency_ms: latency });
    return parsed;
}

async function mlUpdateItemValidated(
    accessToken: string,
    itemId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
): Promise<MlItem> {
    const start = Date.now();
    const res = await fetchWithTimeout(`${ML_API}/items/${itemId}`, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
    });
    const latency = Date.now() - start;
    const text = await res.text();
    if (!res.ok) throw new Error(`ML updateItem failed (${res.status}): ${text.slice(0, 300)}`);
    const parsed = parseMlResponse(MlItemSchema, JSON.parse(text), 'mlUpdateItem');
    logger.debug({ function: 'ml-sync', ml_api_latency_ms: latency });
    return parsed;
}

async function mlCloseItemValidated(
    accessToken: string,
    itemId: string,
    idempotencyKey?: string,
): Promise<MlItem> {
    const start = Date.now();
    const res = await fetchWithTimeout(`${ML_API}/items/${itemId}`, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify({ status: 'closed' }),
    });
    const latency = Date.now() - start;
    const text = await res.text();
    if (!res.ok) throw new Error(`ML closeItem failed (${res.status}): ${text.slice(0, 300)}`);
    const parsed = parseMlResponse(MlItemSchema, JSON.parse(text), 'mlCloseItem');
    logger.debug({ function: 'ml-sync', ml_api_latency_ms: latency });
    return parsed;
}

async function mlSetDescriptionValidated(
    accessToken: string,
    itemId: string,
    plainText: string,
    idempotencyKey?: string,
): Promise<void> {
    const start = Date.now();
    const res = await fetchWithTimeout(`${ML_API}/items/${itemId}/description`, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify({ plain_text: plainText.slice(0, 20000) }),
    });
    const latency = Date.now() - start;
    const text = await res.text();
    if (!res.ok) throw new Error(`ML setDescription failed (${res.status}): ${text.slice(0, 300)}`);
    logger.debug({ function: 'ml-sync', ml_api_latency_ms: latency });
}

// ============================================================
// Retry Logic with Rate Limit Handling
// ============================================================

async function runWithRetry<T>(
    accessToken: string,
    fn: () => Promise<T>,
    operationName: string,
    jobId: number,
    propertyId: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string; rateLimited?: boolean }> {
    const start = Date.now();

    try {
        const data = await fn();
        const duration = Date.now() - start;
        logger.info({
            function: 'ml-sync',
            job_id: jobId,
            property_id: propertyId,
            operation: operationName,
            duration_ms: duration,
            status: 'success',
        });
        return { ok: true, data };
    } catch (err) {
        const duration = Date.now() - start;
        const error = (err as Error).message;
        const isRateLimit =
            error.includes('rate limit') ||
            error.includes('429') ||
            error.includes('too many requests');

        logger.warn({
            function: 'ml-sync',
            job_id: jobId,
            property_id: propertyId,
            operation: operationName,
            duration_ms: duration,
            status: isRateLimit ? 'rate_limited' : 'failed',
            error,
        });

        if (isRateLimit) {
            // Try to extract Retry-After
            const retryAfterMatch = error.match(/retry[-\s]?after[:\s]+(\d+)/i);
            const retryAfter = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : 60;
            logger.info({
                function: 'ml-sync',
                job_id: jobId,
                property_id: propertyId,
                operation: operationName,
                retry_after: retryAfter,
                status: 'retry',
            });
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
            return { ok: false, error, rateLimited: true };
        }

        return { ok: false, error };
    }
}

// ============================================================
// Dead Letter Queue
// ============================================================

async function moveToDeadLetter(
    job: QueueJob,
    attempts: number,
    maxAttempts: number,
    error: string,
    payload: Record<string, unknown>,
): Promise<void> {
    await supabase.from('ml_sync_dead_letter').insert({
        original_queue_id: job.id,
        property_id: job.property_id,
        operation: job.operation as any,
        attempts,
        max_attempts: maxAttempts,
        last_error: error,
        payload: payload as any,
        ml_item_id: job.ml_item_id ?? null,
    });

    await supabase
        .from('ml_sync_queue')
        .update({ status: 'failed', locked_by: null, locked_at: null, last_error: error })
        .eq('id', job.id);

    await supabase.from('ml_sync_history').insert({
        queue_id: job.id,
        operation: job.operation,
        status: 'dead_letter',
        attempt: attempts,
        error,
    });

    logger.warn({
        function: 'ml-sync',
        job_id: job.id,
        property_id: job.property_id,
        operation: job.operation,
        status: 'dead_letter',
        error,
    });
}

// ============================================================
// Job Processing
// ============================================================

async function runJob(
    queueId: number,
    operation: string,
    propertyId: string,
    mlItemId: string | null,
    accessToken: string,
): Promise<{
    ok: boolean;
    itemId?: string | null;
    permalink?: string;
    mlStatus?: string;
    price?: number | null;
    error?: string;
    rateLimited?: boolean;
}> {
    const property = await fetchProperty(propertyId);
    if (!property) return { ok: false, error: 'Propiedad no encontrada' };

    const defaults = await fetchDefaults();
    if (operation === 'publish' && !defaults.category_id)
        return { ok: false, error: 'Falta configurar la categorÃ­a de Mercado Libre.' };
    if (operation === 'publish' && !defaults.listing_type_id)
        return { ok: false, error: 'Falta configurar el tipo de publicaciÃ³n de Mercado Libre.' };
    const mlImageUrls = await prepareImagesForML(accessToken, property.images);

    try {
        if (operation === 'publish') {
            if (property.price === null || property.price <= 0) {
                return { ok: false, error: 'La propiedad debe tener precio para publicarse' };
            }

            const operationLabel = property.listing_type === 'venta' ? 'Venta' : 'Alquiler';
            const propertyType = property.property_type ?? 'Departamento';
            const roomsLabel = property.rooms ?? property.bedrooms ?? 1;
            const location = property.address?.split(',')[0]?.trim() ?? '';
            const mlTitle =
                `${operationLabel} ${propertyType} ${roomsLabel} amb. ${location || 'Salta'}`.slice(
                    0,
                    60,
                );

            const attributes: Array<{ id: string; value_name: string }> = [
                {
                    id: 'OPERATION',
                    value_name: property.listing_type === 'venta' ? 'Venta' : 'Alquiler',
                },
                { id: 'PROPERTY_TYPE', value_name: propertyType },
                { id: 'ROOMS', value_name: String(property.rooms ?? property.bedrooms ?? 1) },
            ];

            if (property.bedrooms !== null)
                attributes.push({ id: 'BEDROOMS', value_name: String(property.bedrooms) });
            if (property.full_bathrooms !== null)
                attributes.push({
                    id: 'FULL_BATHROOMS',
                    value_name: String(property.full_bathrooms),
                });
            if (property.bathrooms !== null)
                attributes.push({ id: 'BATHROOMS', value_name: String(property.bathrooms) });
            if (property.area_covered !== null)
                attributes.push({ id: 'COVERED_AREA', value_name: String(property.area_covered) });
            if (property.area_total !== null)
                attributes.push({ id: 'TOTAL_AREA', value_name: String(property.area_total) });
            if (property.pets_allowed !== null)
                attributes.push(
                    { id: 'PETS', value_name: property.pets_allowed ? 'SÃ­' : 'No' },
                    { id: 'IS_SUITABLE_FOR_PETS', value_name: property.pets_allowed ? 'SÃ­' : 'No' },
                );
            if (property.garages !== null && property.garages > 0)
                attributes.push({ id: 'PARKING_LOTS', value_name: String(property.garages) });
            if (property.has_storage !== null)
                attributes.push({ id: 'STORAGE', value_name: property.has_storage ? 'SÃ­' : 'No' });
            if (property.furnished !== null)
                attributes.push({ id: 'FURNISHED', value_name: property.furnished ? 'SÃ­' : 'No' });
            if (property.maintenance_fee !== null)
                attributes.push(
                    { id: 'MAINTENANCE_FEE', value_name: String(property.maintenance_fee) },
                    { id: 'COMMON_EXPENSES', value_name: String(property.maintenance_fee) },
                );
            if (property.inscription_number)
                attributes.push({
                    id: 'INSCRIPTION_NUMBER',
                    value_name: property.inscription_number,
                });

            const payload: MlItemPayload = {
                title: mlTitle,
                price: Number(property.price),
                currency_id: property.currency,
                available_quantity: 1,
                buying_mode: 'classified',
                condition: ['new', 'used'].includes(defaults.condition)
                    ? (defaults.condition as 'new' | 'used')
                    : 'not_specified',
                channels: ['marketplace'],
                attributes,
                location: { address_line: property.address },
            };
            if (defaults.category_id) payload.category_id = defaults.category_id;
            if (defaults.listing_type_id) payload.listing_type_id = defaults.listing_type_id;
            if (mlImageUrls.length === 0) {
                return {
                    ok: false,
                    error: 'Mercado Libre requiere al menos una imagen vÃ¡lida para esta publicaciÃ³n. Verifica que la propiedad tenga imÃ¡genes accesibles.',
                };
            }
            payload.pictures = mlImageUrls.map((url) => ({ source: url }));

            const idempotencyKey = `${queueId}:${propertyId}:publish`;

            const result = await runWithRetry(
                accessToken,
                () => mlCreateItemValidated(accessToken, payload, idempotencyKey),
                'mlCreateItem',
                queueId,
                propertyId,
            );
            if ('error' in result)
                return { ok: false, error: result.error, rateLimited: result.rateLimited };

            const item = result.data;

            if (property.description) {
                const descResult = await runWithRetry(
                    accessToken,
                    () =>
                        mlSetDescriptionValidated(
                            accessToken,
                            item.id,
                            property.description,
                            `${queueId}:${propertyId}:publish:description`,
                        ),
                    'mlSetDescription',
                    queueId,
                    propertyId,
                );
                if ('error' in descResult)
                    logger.warn({
                        function: 'ml-sync',
                        job_id: queueId,
                        property_id: propertyId,
                        operation: 'mlSetDescription',
                        error: descResult.error,
                    });
            }
            return {
                ok: true,
                itemId: item.id,
                permalink: item.permalink,
                mlStatus: item.status,
                price: Number(item.price),
            };
        }

        if (operation === 'update') {
            let itemId = mlItemId;
            if (!itemId) {
                const { data: meta } = await supabase
                    .from('property_ml_meta')
                    .select('ml_item_id')
                    .eq('property_id', propertyId)
                    .maybeSingle();
                itemId = meta?.ml_item_id ?? null;
            }
            if (!itemId) return { ok: false, error: 'La propiedad no tiene item en Mercado Libre' };

            const patch: Record<string, unknown> = {
                available_quantity: 1,
                condition: ['new', 'used'].includes(defaults.condition)
                    ? (defaults.condition as 'new' | 'used')
                    : 'not_specified',
            };
            if (property.price !== null && property.price > 0) patch.price = Number(property.price);
            if (property.currency) patch.currency_id = property.currency;
            if (mlImageUrls.length > 0) {
                patch.pictures = mlImageUrls.map((url) => ({ source: url }));
            }

            const idempotencyKey = `${queueId}:${propertyId}:update`;

            const result = await runWithRetry(
                accessToken,
                () => mlUpdateItemValidated(accessToken, String(itemId), patch, idempotencyKey),
                'mlUpdateItem',
                queueId,
                propertyId,
            );
            if ('error' in result)
                return { ok: false, error: result.error, rateLimited: result.rateLimited };

            if (property.description) {
                const descResult = await runWithRetry(
                    accessToken,
                    () =>
                        mlSetDescriptionValidated(
                            accessToken,
                            String(itemId),
                            property.description,
                            `${queueId}:${propertyId}:update:description`,
                        ),
                    'mlSetDescription',
                    queueId,
                    propertyId,
                );
                if ('error' in descResult)
                    logger.warn({
                        function: 'ml-sync',
                        job_id: queueId,
                        property_id: propertyId,
                        operation: 'mlSetDescription',
                        error: descResult.error,
                    });
            }

            const itemResult = await runWithRetry(
                accessToken,
                () =>
                    fetch(`https://api.mercadolibre.com/items/${itemId}`, {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    }).then((r) => r.json()),
                'mlGetItem',
                queueId,
                propertyId,
            );
            if ('error' in itemResult)
                return { ok: false, error: itemResult.error, rateLimited: itemResult.rateLimited };
            const item = parseMlResponse(MlItemSchema, itemResult.data, 'mlGetItem');

            return {
                ok: true,
                itemId,
                permalink: item.permalink,
                mlStatus: item.status,
                price: Number(item.price),
            };
        }

        if (operation === 'delete') {
            let itemId = mlItemId;
            if (!itemId) {
                const { data: meta } = await supabase
                    .from('property_ml_meta')
                    .select('ml_item_id')
                    .eq('property_id', propertyId)
                    .maybeSingle();
                itemId = meta?.ml_item_id ?? null;
            }
            if (!itemId) return { ok: false, error: 'La propiedad no tiene item en Mercado Libre' };

            const idempotencyKey = `${queueId}:${propertyId}:delete`;

            const result = await runWithRetry(
                accessToken,
                () => mlCloseItemValidated(accessToken, String(itemId), idempotencyKey),
                'mlCloseItem',
                queueId,
                propertyId,
            );
            if ('error' in result)
                return { ok: false, error: result.error, rateLimited: result.rateLimited };

            return { ok: true, itemId, mlStatus: 'closed' };
        }

        return { ok: false, error: `OperaciÃ³n desconocida: ${operation}` };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}

// ============================================================
// Main Handler
// ============================================================

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
    const rlResult = await checkRateLimit(RATE_LIMIT_FN, clientIp);
    if (!rlResult.allowed) {
        return respond(429, { error: 'Rate limited', retry_after: rlResult.retryAfter });
    }

    if (!(await isAuthorized(req))) return respond(401, { error: 'No autorizado' });

    // Get active ML connection
    const { data: conns } = await supabase
        .from('ml_connection')
        .select(
            'id, nickname, email, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, token_expires_at',
        )
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1);

    const conn = conns?.[0] ?? null;
    if (!conn) return respond(400, { error: 'No hay una cuenta de Mercado Libre conectada' });

    // F0.6: Requeue stuck jobs â€” locked hace >15 min, o 'processing' sin lock desde hace >15 min
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: requeued, error: requeueError } = await supabase
        .from('ml_sync_queue')
        .update({ status: 'pending', locked_by: null, locked_at: null })
        .eq('status', 'processing')
        .or(`locked_at.lt.${staleCutoff},and(locked_at.is.null,updated_at.lt.${staleCutoff})`)
        .select('id');
    if (requeueError) {
        logger.warn({
            function: 'ml-sync',
            status: 'requeue_failed',
            error: requeueError.message,
        });
    } else if (requeued && requeued.length > 0) {
        logger.info({
            function: 'ml-sync',
            status: 'requeued_stuck_jobs',
            metadata: { count: requeued.length },
        });
    }

    // F0.3: Circuit breaker â€” si la API ML estÃ¡ en cooldown, abortar temprano
    const cooldown = await getMlCooldown(supabase, conn.id);
    if (cooldown) {
        const retryAfter = Math.max(1, Math.ceil((cooldown.getTime() - Date.now()) / 1000));
        logger.warn({
            function: 'ml-sync',
            status: 'cooldown_active',
            retry_after: retryAfter,
        });
        return respond(429, { error: 'ML en cooldown por rate limit', retry_after: retryAfter });
    }

    // F0.2: Claim atÃ³mico vÃ­a RPC (FOR UPDATE SKIP LOCKED, incrementa attempts)
    const { data: claimData, error: claimError } = await supabase.rpc('ml_claim_jobs', {
        p_batch_size: BATCH_SIZE,
    });
    if (claimError) {
        logger.error({
            function: 'ml-sync',
            status: 'claim_failed',
            error: claimError.message,
        });
        return respond(500, { error: `No se pudo reclamar jobs: ${claimError.message}` });
    }
    const jobs = (claimData ?? []) as QueueJob[];
    if (jobs.length === 0) return respond(200, { processed: 0, results: [] });

    // Get access token
    let accessToken: string;
    try {
        accessToken = await getAccessToken(supabase, conn);
    } catch (err) {
        return respond(500, { error: `No se pudo obtener token: ${(err as Error).message}` });
    }

    const results: Record<string, unknown>[] = [];

    // Process jobs with controlled concurrency
    for (let i = 0; i < jobs.length; i += MAX_CONCURRENT_JOBS) {
        const batch = jobs.slice(i, i + MAX_CONCURRENT_JOBS);
        const batchResults = await Promise.allSettled(
            batch.map(async (job: QueueJob) => {
                // El claim atÃ³mico (ml_claim_jobs) ya incrementÃ³ attempts y fijÃ³ el lock.
                const attempts = job.attempts;
                const maxAttempts = job.max_attempts;

                const outcome = await runJob(
                    job.id,
                    job.operation,
                    job.property_id,
                    job.ml_item_id,
                    accessToken,
                );

                if (outcome.ok) {
                    await supabase.from('ml_sync_history').insert({
                        queue_id: job.id,
                        operation: job.operation,
                        status: 'success',
                        attempt: attempts,
                        response: {
                            item_id: outcome.itemId ?? null,
                            permalink: outcome.permalink ?? null,
                            ml_status: outcome.mlStatus ?? null,
                            price: outcome.price ?? null,
                        },
                    });
                    const meta = {
                        ml_item_id: outcome.itemId ?? null,
                        status: outcome.mlStatus ?? null,
                        permalink: outcome.permalink ?? null,
                        price: outcome.price ?? null,
                        last_sync_at: new Date().toISOString(),
                        last_sync_status: 'success',
                    };
                    await supabase
                        .from('property_ml_meta')
                        .upsert({ property_id: job.property_id, ...meta });
                    await supabase
                        .from('ml_sync_queue')
                        .update({
                            status: 'success',
                            ml_item_id: outcome.itemId ?? null,
                            locked_by: null,
                            locked_at: null,
                            last_error: null,
                        })
                        .eq('id', job.id);
                    return {
                        queue_id: job.id,
                        property_id: job.property_id,
                        operation: job.operation,
                        status: 'success',
                    };
                } else if (outcome.rateLimited) {
                    // F0.3: 429 â†’ cooldown global + liberar el job SIN consumir el intento ya incrementado por el claim
                    await setMlCooldown(supabase, conn.id, 'ML rate limit (429)', ML_COOLDOWN_MS);
                    await supabase
                        .from('ml_sync_queue')
                        .update({
                            status: 'pending',
                            attempts: Math.max(0, attempts - 1),
                            locked_by: null,
                            locked_at: null,
                            next_attempt_at: new Date().toISOString(),
                            last_error: outcome.error ?? 'Rate limit',
                        })
                        .eq('id', job.id);
                    return {
                        queue_id: job.id,
                        property_id: job.property_id,
                        operation: job.operation,
                        status: 'rate_limited',
                        error: outcome.error ?? 'Rate limit',
                    };
                } else {
                    const finalFailed = attempts >= maxAttempts;
                    const nextAttempt = finalFailed
                        ? null
                        : new Date(Date.now() + attempts * 5 * 60 * 1000).toISOString();
                    const errorMsg = outcome.error ?? 'Error desconocido';

                    if (finalFailed) {
                        // Move to dead letter
                        await moveToDeadLetter(job, attempts, maxAttempts, errorMsg, {
                            bulk: true,
                            source: 'ml-sync',
                        });
                        return {
                            queue_id: job.id,
                            property_id: job.property_id,
                            operation: job.operation,
                            status: 'dead_letter',
                            error: errorMsg,
                        };
                    } else {
                        await supabase.from('ml_sync_history').insert({
                            queue_id: job.id,
                            operation: job.operation,
                            status: 'failed',
                            attempt: attempts,
                            error: errorMsg,
                        });
                        await supabase
                            .from('ml_sync_queue')
                            .update({
                                status: 'pending',
                                attempts,
                                next_attempt_at:
                                    nextAttempt ??
                                    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                                last_error: errorMsg,
                                locked_by: null,
                                locked_at: null,
                            })
                            .eq('id', job.id);
                        await supabase.from('property_ml_meta').upsert({
                            property_id: job.property_id,
                            last_sync_at: new Date().toISOString(),
                            last_sync_status: 'failed',
                        });
                        return {
                            queue_id: job.id,
                            property_id: job.property_id,
                            operation: job.operation,
                            status: 'failed',
                            error: errorMsg,
                        };
                    }
                }
            }),
        );

        results.push(
            ...batchResults.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason })),
        );

        // F0.3: si algÃºn job del batch fue rate limited, liberar el resto del batch y abortar
        const wasRateLimited = batchResults.some(
            (r) => r.status === 'fulfilled' && r.value?.status === 'rate_limited',
        );
        if (wasRateLimited) {
            logger.warn({
                function: 'ml-sync',
                status: 'batch_aborted_rate_limited',
                metadata: { released: jobs.length - (i + MAX_CONCURRENT_JOBS) },
            });
            for (const job of jobs.slice(i + MAX_CONCURRENT_JOBS)) {
                await supabase
                    .from('ml_sync_queue')
                    .update({
                        status: 'pending',
                        attempts: Math.max(0, job.attempts - 1),
                        locked_by: null,
                        locked_at: null,
                        next_attempt_at: new Date().toISOString(),
                        last_error: null,
                    })
                    .eq('id', job.id);
            }
            break;
        }
    }

    return respond(200, { processed: results.length, results });
});
