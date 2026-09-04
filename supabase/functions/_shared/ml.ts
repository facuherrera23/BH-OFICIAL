/**
 * Helpers de la API de Mercado Libre (OAuth + items).
 * Credenciales de la app (client_id/client_secret) se leen de BD encriptadas.
 */

import { decrypt, encrypt } from './crypto.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const ML_AUTH_URL = 'https://auth.mercadolibre.com.ar/authorization';
export const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
export const ML_API = 'https://api.mercadolibre.com';

/**
 * Fetch con timeout configurable usando AbortController.
 * Default: 15 segundos.
 */
export async function fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs = 15000,
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

export interface MlTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    user_id: number;
    refresh_token: string;
}

/**
 * Obtiene client_id, client_secret y webhook_secret desde site_settings (BD).
 * Fallback a env vars (legacy) si no encuentran en BD.
 * Esta es la función canónica que deben usar todas las edge functions de ML.
 */
let cachedCredentials: {
    data: { clientId: string; clientSecret: string; webhookSecret: string };
    expiresAt: number;
} | null = null;

const CREDENTIALS_TTL_MS = 30_000;

/**
 * Invalida el cache de credenciales ML. Debe llamarse después de actualizar credenciales en BD.
 */
export function invalidateMlCredentialsCache(): void {
    cachedCredentials = null;
}

export async function getMlCredentials(
    supabase: SupabaseClient,
): Promise<{
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
}> {
    if (cachedCredentials && cachedCredentials.expiresAt > Date.now()) {
        return cachedCredentials.data;
    }

    const { data: settings } = await supabase
        .from('site_settings')
        .select('key, value')
        .in('key', ['ml_app_id', 'ml_client_secret', 'ml_webhook_secret']);

    const getSetting = (key: string): string =>
        (settings?.find((s) => s.key === key)?.value?.value as string) ?? '';

    const clientId = getSetting('ml_app_id') || (Deno.env.get('ML_CLIENT_ID') ?? '');
    const clientSecret = getSetting('ml_client_secret') || (Deno.env.get('ML_CLIENT_SECRET') ?? '');
    const webhookSecret = getSetting('ml_webhook_secret') || (Deno.env.get('ML_WEBHOOK_SECRET') ?? '');

    if (!clientId || !clientSecret) {
        throw new Error('ML_CLIENT_ID / ML_CLIENT_SECRET no configurados (ni en BD ni en env)');
    }

    const data = { clientId, clientSecret, webhookSecret };
    cachedCredentials = { data, expiresAt: Date.now() + CREDENTIALS_TTL_MS };
    return data;
}

/**
 * Obtiene client_id y client_secret desencriptados desde la BD.
 * Requiere que el caller sea staff (validado en RPC get_ml_credentials).
 * @deprecated Usar getMlCredentials(supabase) en nuevo código.
 */
export async function getMlAppCredentialsLegacy(
    supabase: SupabaseClient,
): Promise<{ clientId: string; clientSecret: string }> {
    const creds = await getMlCredentials(supabase);
    return { clientId: creds.clientId, clientSecret: creds.clientSecret };
}

export async function exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
    clientId?: string,
    clientSecret?: string,
): Promise<MlTokenResponse> {
    if (!clientId || !clientSecret) {
        throw new Error('clientId y clientSecret son requeridos');
    }

    const res = await fetchWithTimeout(ML_TOKEN_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
            ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`ML token exchange falló (${res.status}): ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as MlTokenResponse;
}

export async function refreshToken(
    refresh: string,
    clientId: string,
    clientSecret: string,
): Promise<MlTokenResponse> {
    const res = await fetchWithTimeout(ML_TOKEN_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refresh,
        }),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`ML token refresh falló (${res.status}): ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as MlTokenResponse;
}

// ============================================================
// Access token de la conexión (descifrado + refresh automático)
// ============================================================

export interface MlConnectionRow {
    id: string;
    access_token_encrypted: string;
    access_token_iv: string;
    refresh_token_encrypted: string;
    refresh_token_iv: string;
    token_expires_at: string;
}

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // token válido si expira en > 5 min
const SENTINEL_MS = 60 * 1000; // lock de refresh (autocaduca en 60 s)
const POLL_INTERVAL_MS = 500; // poll de los perdedores
const POLL_TIMEOUT_MS = 20 * 1000; // los perdedores esperan hasta 20 s

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Devuelve el access token de la conexión, refrescándolo si está por expirar.
 *
 * F0.1 — CAS + sentinel: ante refresh concurrente (múltiples edge functions),
 * solo un proceso refresca el token; los demás hacen poll hasta ver el nuevo.
 * - El ganador escribe `token_expires_at = sentinel` (CAS sobre el valor leído).
 * - Si el ganador muere, el sentinel expira en 60 s y otro proceso puede ganar.
 * - Si el refresh del ganador falla, restaura el valor stale para reintentar.
 */
export async function getAccessToken(
    supabase: SupabaseClient,
    conn: MlConnectionRow,
): Promise<string> {
    const expiresIn = new Date(conn.token_expires_at).getTime() - Date.now();
    if (expiresIn > REFRESH_THRESHOLD_MS) {
        return await decrypt(conn.access_token_encrypted, conn.access_token_iv);
    }

    const staleExpiresAt = conn.token_expires_at;

    // 1) Intentar tomar el lock (CAS sobre token_expires_at).
    // Reintentar hasta 3 veces si hay contención.
    let sentinel: string;
    let claimed: any[] = [];
    let claimError: any = null;
    
    for (let attempt = 0; attempt < 3; attempt++) {
        sentinel = new Date(Date.now() + SENTINEL_MS).toISOString();
        const result = await supabase
            .from('ml_connection')
            .update({ token_expires_at: sentinel })
            .eq('id', conn.id)
            .eq('token_expires_at', staleExpiresAt)
            .select('id');
        
        claimError = result.error;
        claimed = result.data ?? [];
        
        if (!claimError && (claimed ?? []).length > 0) {
            break; // Lock adquirido exitosamente
        }
        
        // Si falló por contención (CAS failed - no rows updated), reintentar
        if (!claimError && (claimed ?? []).length === 0) {
            await sleep(50 * (attempt + 1)); // backoff exponencial leve
            continue;
        }
        
        // Si hay error real (no contención), lanzar error
        if (claimError) {
            throw new Error(`No se pudo tomar el lock de refresh ML: ${claimError.message}`);
        }
    }

    if ((claimed ?? []).length > 0) {
        // Ganador: refrescar y persistir tokens nuevos.
        try {
            const refresh = await decrypt(conn.refresh_token_encrypted, conn.refresh_token_iv);

            // Obtener credenciales de la app (BD o env vars)
            const { clientId, clientSecret } = await getMlAppCredentialsLegacy(supabase);

            const tokens = await refreshToken(refresh, clientId, clientSecret);
            const access = await encrypt(tokens.access_token);
            const refreshEnc = await encrypt(tokens.refresh_token);

            await supabase
                .from('ml_connection')
                .update({
                    access_token_encrypted: access.data,
                    access_token_iv: access.iv,
                    refresh_token_encrypted: refreshEnc.data,
                    refresh_token_iv: refreshEnc.iv,
                    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
                })
                .eq('id', conn.id);

            return tokens.access_token;
        } catch (err) {
            // Falló el refresh: restaurar el valor stale para que otro proceso
            // pueda reintentar (si esto falla, el sentinel expira solo en 60 s).
            await supabase
                .from('ml_connection')
                .update({ token_expires_at: staleExpiresAt })
                .eq('id', conn.id)
                .eq('token_expires_at', sentinel);
            throw err;
        }
    }

    // 2) Perdedor: poll hasta que el ganador persista el token nuevo
    //    (o el sentinel expire y otro proceso lo reemplace).
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const { data: fresh } = await supabase
            .from('ml_connection')
            .select('access_token_encrypted, access_token_iv, token_expires_at')
            .eq('id', conn.id)
            .maybeSingle();

        if (!fresh) continue;

        const freshExpiresIn = new Date(fresh.token_expires_at).getTime() - Date.now();
        if (freshExpiresIn > REFRESH_THRESHOLD_MS) {
            return await decrypt(fresh.access_token_encrypted, fresh.access_token_iv);
        }
    }

    throw new Error('Timeout esperando refresh de token ML (lock mantenido por otro proceso)');
}

// ============================================================
// Cooldown (circuit breaker) — F0.3
// ============================================================

export const ML_COOLDOWN_DEFAULT_MS = 60 * 1000;

/**
 * Devuelve hasta cuándo la conexión está en cooldown, o null si no lo está
 * (o el cooldown ya expiró).
 */
export async function getMlCooldown(
    supabase: SupabaseClient,
    connectionId: string,
): Promise<Date | null> {
    const { data, error } = await supabase
        .from('ml_sync_cooldown')
        .select('cooldown_until')
        .eq('connection_id', connectionId)
        .maybeSingle();

    if (error) {
        console.error(`[ml] getMlCooldown failed:`, error.message);
        return null;
    }

    if (!data?.cooldown_until) return null;

    const until = new Date(data.cooldown_until);
    return until.getTime() > Date.now() ? until : null;
}

/**
 * Activa el cooldown de una conexión por `durationMs` (default 60 s).
 * La escribe el service_role (edge functions) — RLS lo permite.
 */
export async function setMlCooldown(
    supabase: SupabaseClient,
    connectionId: string,
    reason: string,
    durationMs: number = ML_COOLDOWN_DEFAULT_MS,
): Promise<void> {
    const { error } = await supabase
        .from('ml_sync_cooldown')
        .upsert(
            {
                connection_id: connectionId,
                cooldown_until: new Date(Date.now() + durationMs).toISOString(),
                reason,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'connection_id' },
        );

    if (error) {
        console.error(`[ml] setMlCooldown failed:`, error.message);
    }
}

export interface MlUser {
    id: number;
    nickname: string;
    email: string;
    site_id: string;
}

export async function getMe(accessToken: string): Promise<MlUser> {
    const res = await fetchWithTimeout(`${ML_API}/users/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`ML getMe falló (${res.status})`);
    return await res.json();
}

export interface MlItemPayload {
    title: string;
    category_id?: string;
    price: number;
    currency_id: string;
    available_quantity: number;
    buying_mode: 'classified';
    listing_type_id?: string;
    condition: 'new' | 'used' | 'not_specified';
    pictures?: { source: string }[];
    channels?: 'marketplace'[];
    location?: { address_line?: string };
    description?: { plain_text: string };
    [key: string]: unknown;
}

export interface MlItem {
    id: string;
    title: string;
    price: number;
    status: string;
    permalink: string;
    listing_type_id: string;
    [key: string]: unknown;
}

async function api(
    path: string,
    accessToken: string,
    init?: RequestInit,
    idempotencyKey?: string,
): Promise<unknown> {
    const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
    };
    if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => {
            headers[key] = value;
        });
    }
    if (idempotencyKey) {
        headers['x-idempotency-key'] = idempotencyKey;
    }
    const res = await fetchWithTimeout(`${ML_API}${path}`, {
        ...init,
        headers,
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`ML API ${path} falló (${res.status}): ${text.slice(0, 300)}`);
    }
    return text ? (JSON.parse(text) as unknown) : null;
}

export function mlCreateItem(
    accessToken: string,
    payload: MlItemPayload,
    idempotencyKey?: string,
): Promise<unknown> {
    return api(
        '/items',
        accessToken,
        { method: 'POST', body: JSON.stringify(payload) },
        idempotencyKey,
    );
}

export function mlUpdateItem(
    accessToken: string,
    itemId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
): Promise<unknown> {
    return api(
        `/items/${itemId}`,
        accessToken,
        { method: 'PUT', body: JSON.stringify(payload) },
        idempotencyKey,
    );
}

export function mlSetDescription(
    accessToken: string,
    itemId: string,
    plainText: string,
    idempotencyKey?: string,
): Promise<unknown> {
    return api(
        `/items/${itemId}/description`,
        accessToken,
        {
            method: 'PUT',
            body: JSON.stringify({ plain_text: plainText.slice(0, 20000) }),
        },
        idempotencyKey,
    );
}

export function mlCloseItem(
    accessToken: string,
    itemId: string,
    idempotencyKey?: string,
): Promise<unknown> {
    return mlUpdateItem(accessToken, itemId, { status: 'closed' }, idempotencyKey);
}

export function mlGetItem(accessToken: string, itemId: string): Promise<MlItem> {
    return api(`/items/${itemId}`, accessToken, { method: 'GET' }) as Promise<MlItem>;
}

// ============================================================
// Picture upload to Mercado Libre
// ============================================================

export interface MlPictureUploadResponse {
    id: string;
    max_size: number;
    max_width: number;
    max_height: number;
    quality: number;
    variations: Array<{ id: string; url: string; width: number; height: number; size: number }>;
}

export interface MlPicture {
    id: string;
    url: string;
    secure_url: string;
    size: string;
    max_size: number;
    width: number;
    height: number;
    quality: number;
    variation_id: string;
}

export async function mlUploadPicture(
    accessToken: string,
    file: Uint8Array<ArrayBuffer>,
    fileName: string,
    contentType: string,
    idempotencyKey?: string,
): Promise<MlPictureUploadResponse> {
    const formData = new FormData();
    const blob = new Blob([file], { type: 'image/jpeg' });
    formData.append('file', blob, fileName);

    const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
    };
    if (idempotencyKey) {
        headers['x-idempotency-key'] = idempotencyKey;
    }

    const res = await fetchWithTimeout(`${ML_API}/pictures`, {
        method: 'POST',
        headers,
        body: formData,
    });

    const text = await res.text();
    if (!res.ok) {
        throw new Error(`ML picture upload falló (${res.status}): ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as MlPictureUploadResponse;
}

export async function mlUploadPictures(
    accessToken: string,
    files: Array<{ data: Uint8Array<ArrayBuffer>; name: string; type: string }>,
    idempotencyKey?: string,
): Promise<string[]> {
    const urls: string[] = [];
    for (const file of files) {
        try {
            const result = await mlUploadPicture(
                accessToken,
                file.data,
                file.name,
                file.type,
                idempotencyKey,
            );
            // Usar la primera variación (original) como URL principal
            const mainVariation =
                result.variations.find((v) => v.id === 'original') || result.variations[0];
            if (mainVariation?.url) {
                urls.push(mainVariation.url);
            }
        } catch (err) {
            console.error(`Error subiendo imagen ${file.name}:`, err);
            // Continuar con las demás imágenes
        }
    }
    return urls;
}

// ============================================================
// Error categorization for retry logic
// ============================================================

export enum MlErrorType {
    RATE_LIMIT = 'RATE_LIMIT',
    AUTH_ERROR = 'AUTH_ERROR',
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    NOT_FOUND = 'NOT_FOUND',
    SERVER_ERROR = 'SERVER_ERROR',
    NETWORK_ERROR = 'NETWORK_ERROR',
    UNKNOWN = 'UNKNOWN',
}

export interface MlError {
    type: MlErrorType;
    message: string;
    retryable: boolean;
    statusCode?: number;
    rawError?: unknown;
}

export function categorizeMlError(err: unknown, statusCode?: number): MlError {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();

    // Rate limiting
    if (
        statusCode === 429 ||
        message.includes('429') ||
        lower.includes('rate limit') ||
        lower.includes('user_rate_limited') ||
        lower.includes('too many requests')
    ) {
        return { type: MlErrorType.RATE_LIMIT, message, retryable: true, statusCode };
    }

    // Auth errors
    if (
        statusCode === 401 ||
        statusCode === 403 ||
        lower.includes('invalid_token') ||
        lower.includes('unauthorized') ||
        lower.includes('access denied')
    ) {
        return { type: MlErrorType.AUTH_ERROR, message, retryable: false, statusCode };
    }

    // Validation errors (no retry)
    if (
        statusCode === 400 ||
        lower.includes('validation') ||
        lower.includes('invalid') ||
        lower.includes('required')
    ) {
        return { type: MlErrorType.VALIDATION_ERROR, message, retryable: false, statusCode };
    }

    // Not found
    if (statusCode === 404 || lower.includes('not found')) {
        return { type: MlErrorType.NOT_FOUND, message, retryable: false, statusCode };
    }

    // Server errors (retryable)
    if (statusCode && statusCode >= 500) {
        return { type: MlErrorType.SERVER_ERROR, message, retryable: true, statusCode };
    }

    // Network errors
    if (
        lower.includes('network') ||
        lower.includes('timeout') ||
        lower.includes('econnrefused') ||
        lower.includes('etimedout')
    ) {
        return { type: MlErrorType.NETWORK_ERROR, message, retryable: true, statusCode };
    }

    return { type: MlErrorType.UNKNOWN, message, retryable: true, statusCode };
}

export function isRetryableError(err: unknown, statusCode?: number): boolean {
    const categorized = categorizeMlError(err, statusCode);
    return categorized.retryable;
}

// ============================================================
// Rate-limited API call wrapper with retry logic
// ============================================================

export type MlApiCallResult<T> =
    { ok: true; data: T } | { ok: false; error: string; retryAfter?: number };

/**
 * Ejecuta una llamada a la API de Mercado Libre con manejo de rate limiting.
 * Si recibe 429, extrae el header Retry-After (o usa 60s por defecto),
 * espera y reintenta una vez.
 */
export async function runMlApiCall<T>(
    accessToken: string,
    fn: () => Promise<T>,
    operationName: string,
): Promise<MlApiCallResult<T>> {
    try {
        const data = await fn();
        return { ok: true, data };
    } catch (err) {
        const categorized = categorizeMlError(err);
        console.error(`[ml-api] ${operationName} failed:`, err);

        if (categorized.type === MlErrorType.RATE_LIMIT) {
            // Try to extract Retry-After from error message or use default
            const retryAfterMatch = categorized.message.match(/retry[-\s]?after[:\s]+(\d+)/i);
            const retryAfter = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : 60;
            return { ok: false, error: categorized.message, retryAfter };
        }

        return { ok: false, error: categorized.message };
    }
}

/**
 * Ejecuta una llamada a la API de ML con reintento automático en caso de rate limit.
 * Versión de conveniencia que hace el wait + retry internamente.
 * Si se provee `onRateLimit`, se invoca antes del wait (permite activar un
 * cooldown global / circuit breaker).
 */
export async function runMlApiCallWithRetry<T>(
    accessToken: string,
    fn: () => Promise<T>,
    operationName: string,
    onRateLimit?: (retryAfter: number) => void | Promise<void>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    const result = await runMlApiCall(accessToken, fn, operationName);

    if ('retryAfter' in result && result.retryAfter !== undefined) {
        console.log(
            `[ml-api] Rate limited on ${operationName}, waiting ${result.retryAfter}s before retry...`,
        );
        await onRateLimit?.(result.retryAfter);
        await new Promise((resolve) => setTimeout(resolve, result.retryAfter * 1000));
        return await runMlApiCall(accessToken, fn, `${operationName} (retry)`);
    }

    return result;
}

export async function fetchMlListingTypes(accessToken: string): Promise<MlListingType[]> {
    const res = await fetchWithTimeout(`${ML_API}/sites/MLA/listing_types`, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`ML listing_types falló (${res.status})`);
    const data = await res.json();
    return data?.map((lt: { id: string; name: string }) => ({ id: lt.id, name: lt.name })) ?? [];
}

// ============================================================
// Webhook Topics Registration (auto-register on OAuth)
// ============================================================

export const ML_WEBHOOK_TOPICS = [
    'questions',
    'orders',
    'items',
    'payments',
    'shipments',
] as const;

export type MlWebhookTopic = (typeof ML_WEBHOOK_TOPICS)[number];

export interface RegisterWebhookResult {
    ok: boolean;
    topic: string;
    error?: string;
}

/**
 * Registra un tópico de webhook para un usuario específico.
 * API: POST /users/{user_id}/topics/{topic}
 * Body: { callback_url, auth_token }
 */
export async function registerMlWebhookTopic(
    accessToken: string,
    userId: number,
    topic: MlWebhookTopic,
    callbackUrl: string,
    authToken: string,
): Promise<RegisterWebhookResult> {
    if (!callbackUrl.startsWith('https://')) {
        return { ok: false, topic, error: `callback_url debe ser HTTPS, recibido: ${callbackUrl}` };
    }
    try {
        const res = await fetchWithTimeout(`${ML_API}/users/${userId}/topics/${topic}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${accessToken}`,
                'content-type': 'application/json',
                accept: 'application/json',
            },
            body: JSON.stringify({ callback_url: callbackUrl, auth_token: authToken }),
        });
        const text = await res.text();
        if (!res.ok) {
            return { ok: false, topic, error: `ML ${topic} webhook falló (${res.status}): ${text.slice(0, 300)}` };
        }
        return { ok: true, topic };
    } catch (err) {
        return { ok: false, topic, error: err instanceof Error ? err.message : 'Error de red' };
    }
}

/**
 * Registra todos los tópicos necesarios para la integración.
 * Devuelve array de resultados por tópico.
 */
export async function registerMlWebhooks(
    accessToken: string,
    userId: number,
    callbackUrl: string,
    authToken: string,
): Promise<RegisterWebhookResult[]> {
    const results = await Promise.all(
        ML_WEBHOOK_TOPICS.map((topic) =>
            registerMlWebhookTopic(accessToken, userId, topic, callbackUrl, authToken),
        ),
    );
    return results;
}

/**
 * Verifica qué tópicos están registrados para un usuario.
 * GET /users/{user_id}/topics/{topic}
 */
export async function getRegisteredMlWebhookTopics(
    accessToken: string,
    userId: number,
): Promise<Record<MlWebhookTopic, boolean>> {
    const results = await Promise.all(
        ML_WEBHOOK_TOPICS.map(async (topic) => {
            try {
                const res = await fetchWithTimeout(`${ML_API}/users/${userId}/topics/${topic}`, {
                    headers: { authorization: `Bearer ${accessToken}` },
                });
                return [topic, res.ok] as const;
            } catch {
                return [topic, false] as const;
            }
        }),
    );
    return Object.fromEntries(results) as Record<MlWebhookTopic, boolean>;
}

// ============================================================
// Categories and Listing Types
// ============================================================

export interface MlCategory {
    id: string;
    name: string;
}

export interface MlListingType {
    id: string;
    name: string;
}

export async function fetchMlCategories(
    accessToken: string,
    parentId = 'MLA1459',
): Promise<MlCategory[]> {
    const res = await fetchWithTimeout(`${ML_API}/sites/MLA/categories/${parentId}`, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`ML categories falló (${res.status})`);
    const data = await res.json();
    return data?.children_categories ?? [];
}