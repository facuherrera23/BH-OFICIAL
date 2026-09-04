/**
 * Rate Limiting para Edge Functiones Edge de Mercado Libre.
 * Sliding window log almacenado en Supabase (tabla rate_limit_logs).
 * Configurable por función via env vars.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

// Configuración por función (requests por windowMs)
export const RATE_LIMIT_CONFIG = {
    'ml-sync': { requests: 30, windowMs: 60_000 }, // 30/min
    'ml-webhook': { requests: 100, windowMs: 60_000 }, // 100/min
    'ml-metrics': { requests: 10, windowMs: 60_000 }, // 10/min
    'ml-answer-question': { requests: 20, windowMs: 60_000 }, // 20/min
    'ml-bulk-enqueue': { requests: 5, windowMs: 60_000 }, // 5/min
    'ml-categories': { requests: 20, windowMs: 60_000 }, // 20/min
    'ml-listing-types': { requests: 20, windowMs: 60_000 }, // 20/min
    'ml-oauth': { requests: 10, windowMs: 60_000 }, // 10/min
    'audit-log': { requests: 20, windowMs: 60_000 }, // 20/min - staff actions
    'ml-revoke-tokens': { requests: 10, windowMs: 60_000 }, // 10/min - ML tokens
    'admin-user-invite': { requests: 5, windowMs: 60_000 }, // 5/min - admin invites
    'ml-connection-status': { requests: 20, windowMs: 60_000 }, // 20/min - connection status
    'qr-checkin': { requests: 30, windowMs: 60_000 }, // 30/min - QR check-ins
    'visits-process-reminders': { requests: 10, windowMs: 60_000 }, // 10/min - cron job
    'chat-ai': { requests: 10, windowMs: 60_000 }, // 10/min - AI chat assistant
    'chat-upload': { requests: 10, windowMs: 60_000 }, // 10/min - adjuntos de chat
    'convert-image': { requests: 30, windowMs: 60_000 }, // 30/min - conversión de imágenes
    'rela-proxy': { requests: 60, windowMs: 60_000 }, // 60/min - acciones panel RELA
    'rela-callbacks': { requests: 120, windowMs: 60_000 }, // 120/min - webhooks RELA
    'manage-users': { requests: 10, windowMs: 60_000 }, // 10/min - user management
    'cloudinary-sign': { requests: 30, windowMs: 60_000 }, // 30/min - image upload signing
} as const;

export type RateLimitFnName = keyof typeof RATE_LIMIT_CONFIG;

export interface RateLimitResult {
    allowed: boolean;
    retryAfter?: number;
    remaining: number;
    resetAt?: number;
}

/**
 * Verifica y consume un slot de rate limit para la función dada.
 * Usa sliding window log en tabla rate_limit_logs.
 */
export async function checkRateLimit(
    fnName: RateLimitFnName,
    identifier: string, // IP, user_id, o API key
): Promise<RateLimitResult> {
    const config = RATE_LIMIT_CONFIG[fnName];
    const key = `ratelimit:${fnName}:${identifier}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Limpiar logs antiguos (opcional, para mantener tabla limpia)
    // await supabase.from('rate_limit_logs').delete().lt('created_at', new Date(now - 24 * 60 * 60 * 1000).toISOString());

    // Contar requests en ventana actual
    const { data: logs, error } = await supabase
        .from('rate_limit_logs')
        .select('created_at')
        .eq('key', key)
        .gte('created_at', new Date(windowStart).toISOString());

    if (error) {
        // FAIL-CLOSED: ante error de DB denegamos (fail-safe según §15 de la misión)
        console.error(`[rate-limit] DB error for ${fnName}:`, error);
        return { allowed: false, remaining: 0, retryAfter: 60 };
    }

    const count = logs?.length ?? 0;

    if (count >= config.requests) {
        // Rate limited - calcular retry-after basado en el log más antiguo
        const oldestLog = logs?.[0];
        if (oldestLog) {
            const oldestTime = new Date(oldestLog.created_at).getTime();
            const retryAfterMs = Math.max(1, oldestTime + config.windowMs - now);
            return {
                allowed: false,
                retryAfter: Math.ceil(retryAfterMs / 1000),
                remaining: 0,
                resetAt: oldestTime + config.windowMs,
            };
        }
        return {
            allowed: false,
            retryAfter: Math.ceil(config.windowMs / 1000),
            remaining: 0,
        };
    }

    // Registrar este request
    await supabase.from('rate_limit_logs').insert({
        key,
        created_at: new Date().toISOString(),
    });

    return {
        allowed: true,
        remaining: config.requests - count - 1,
        resetAt: now + config.windowMs,
    };
}

/**
 * Middleware helper para usar al inicio de edge functions.
 * Retorna Response 429 si rate limited, null si OK.
 */
export async function rateLimitMiddleware(
    fnName: RateLimitFnName,
    req: Request,
): Promise<Response | null> {
    const clientIp =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        'unknown';

    const result = await checkRateLimit(fnName, clientIp);

    if (!result.allowed) {
        return new Response(
            JSON.stringify({
                error: 'Rate limited',
                message: `Demasiadas peticiones. Intente en ${result.retryAfter} segundos.`,
                retry_after: result.retryAfter,
            }),
            {
                status: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Retry-After': String(result.retryAfter ?? 60),
                    'X-RateLimit-Limit': String(RATE_LIMIT_CONFIG[fnName].requests),
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset': String(
                        Math.ceil(
                            (result.resetAt ?? Date.now() + RATE_LIMIT_CONFIG[fnName].windowMs) /
                                1000,
                        ),
                    ),
                },
            },
        );
    }

    // Headers informativos para cliente
    return null;
}

/**
 * Decorator para aplicar rate limiting automáticamente a un handler.
 * Uso: export default withRateLimit('ml-sync', handler);
 */
export function withRateLimit<Fn extends (req: Request) => Promise<Response>>(
    fnName: RateLimitFnName,
    handler: Fn,
): Fn {
    return (async (req: Request) => {
        const rateLimitResponse = await rateLimitMiddleware(fnName, req);
        if (rateLimitResponse) return rateLimitResponse;
        return handler(req);
    }) as Fn;
}
