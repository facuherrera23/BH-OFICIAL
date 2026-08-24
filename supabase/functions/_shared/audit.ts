// ============================================================
// BIENENHAUS - Shared Audit Helper para Edge Functions
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
);

const encoder = new TextEncoder();

/**
 * Lista de claves sensibles que nunca deben llegar a auditoría
 */
const SENSITIVE_KEYS = new Set([
    'password', 'password_hash', 'api_key', 'access_token', 'refresh_token',
    'client_secret', 'secret', 'encryption_key', 'authorization',
    'cookie', 'session_token', 'jwt', 'bearer', 'private_key',
    'service_role_key', 'anon_key', 'signing_secret', 'webhook_secret',
    'ml_client_secret', 'ml_access_token', 'ml_refresh_token',
    'zernio_api_key', 'brevo_api_key', 'cloudinary_api_secret',
    'crypto_secret', 'encryption_key', 'smtp_password'
]);

/**
 * Redacta campos sensibles de un payload JSON recursivamente
 */
export function sanitizeAuditPayload(payload: unknown): unknown {
    if (payload === null || payload === undefined) return payload;
    
    if (Array.isArray(payload)) {
        return payload.map(sanitizeAuditPayload);
    }
    
    if (typeof payload === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
            if (SENSITIVE_KEYS.has(key.toLowerCase())) {
                result[key] = '[REDACTED]';
            } else if (typeof value === 'object' && value !== null) {
                result[key] = sanitizeAuditPayload(value);
            } else {
                result[key] = value;
            }
        }
        return result;
    }
    
    return payload;
}

/**
 * Genera un request_id único
 */
export function genRequestId(): string {
    return crypto.randomUUID();
}

/**
 * Extrae el user_id del JWT en el header Authorization
 */
export function extractUserIdFromAuth(req: Request): string | null {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    
    const token = auth.slice(7);
    try {
        const part = token.split('.')[1];
        if (!part) return null;
        let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        const payload = JSON.parse(atob(b64));
        return payload.sub ?? null;
    } catch {
        return null;
    }
}

/**
 * Obtiene el perfil del usuario (rol, broker_id) usando service role
 */
export async function getUserProfile(
    supabase: SupabaseClient, 
    userId: string
): Promise<{ role: string; broker_id: string | null } | null> {
    const { data, error } = await supabase
        .from('profiles')
        .select('role, broker_id')
        .eq('id', userId)
        .limit(1)
        .single();
    
    if (error || !data) return null;
    return { role: data.role, broker_id: data.broker_id };
}

/**
 * Interface para eventos de auditoría
 */
export interface AuditEventParams {
    userId?: string | null;
    roleSnapshot?: string | null;
    brokerId?: string | null;
    action: string;
    module: string;
    tableName?: string | null;
    recordId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    entityLabel?: string | null;
    oldData?: Record<string, unknown> | null;
    newData?: Record<string, unknown> | null;
    changedFields?: string[] | null;
    metadata?: Record<string, unknown>;
    status?: 'success' | 'error' | 'partial';
    errorCode?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    sessionId?: string | null;
    requestId?: string;
}

/**
 * Inserta evento en audit_log (usa función SECURITY DEFINER en DB)
 */
export async function insertAuditLog(
    supabase: SupabaseClient,
    params: AuditEventParams
): Promise<string | null> {
    const requestId = params.requestId ?? crypto.randomUUID();
    
    const { data, error } = await supabase.rpc('insert_audit_log', {
        p_user_id: params.userId,
        p_role_snapshot: params.roleSnapshot,
        p_broker_id: params.brokerId,
        p_action: params.action,
        p_module: params.module,
        p_table_name: params.tableName,
        p_record_id: params.recordId,
        p_entity_type: params.entityType,
        p_entity_id: params.entityId,
        p_entity_label: params.entityLabel,
        p_old_data: params.oldData ? sanitizeAuditPayload(params.oldData) : null,
        p_new_data: params.newData ? sanitizeAuditPayload(params.newData) : null,
        p_changed_fields: params.changedFields,
        p_metadata: params.metadata ?? {},
        p_status: params.status ?? 'success',
        p_error_code: params.errorCode,
        p_ip: params.ip,
        p_user_agent: params.userAgent,
        p_session_id: params.sessionId,
        p_request_id: params.requestId
    });
    
    if (error) {
        console.error('[audit] Failed to insert audit log:', error);
        return null;
    }
    
    return data as string;
}

/**
 * Interface para eventos de uso/métricas
 */
export interface UsageEventParams {
    userId?: string | null;
    roleSnapshot?: string | null;
    brokerId?: string | null;
    module: string;
    eventType: string;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    status?: 'success' | 'error' | 'partial' | 'rate_limited';
    durationMs?: number | null;
    sessionId?: string | null;
    requestId?: string;
}

/**
 * Inserta evento de uso/métrica
 */
export async function insertUsageEvent(
    supabase: SupabaseClient,
    params: UsageEventParams
): Promise<string | null> {
    const requestId = params.requestId ?? crypto.randomUUID();
    
    const { data, error } = await supabase.rpc('insert_usage_event', {
        p_user_id: params.userId,
        p_role_snapshot: params.roleSnapshot,
        p_broker_id: params.brokerId,
        p_module: params.module,
        p_event_type: params.eventType,
        p_action: params.action,
        p_entity_type: params.entityType,
        p_entity_id: params.entityId,
        p_metadata: params.metadata ?? {},
        p_status: params.status ?? 'success',
        p_duration_ms: params.durationMs,
        p_session_id: params.sessionId,
        p_request_id: params.requestId
    });
    
    if (error) {
        console.error('[audit] Failed to insert usage event:', error);
        return null;
    }
    
    return data as string;
}

/**
 * Helper para crear evento de auditoría desde una Edge Function
 * Uso: await auditEvent(supabase, req, { action: 'create', module: 'properties', ... })
 */
export async function auditEvent(
    supabase: SupabaseClient,
    req: Request,
    params: Omit<AuditEventParams, 'userId' | 'roleSnapshot' | 'brokerId' | 'ip' | 'userAgent' | 'requestId'>
): Promise<string | null> {
    const userId = extractUserIdFromAuth(req);
    let roleSnapshot: string | null = null;
    let brokerId: string | null = null;
    
    if (params.module !== 'auth' && userId) {
        const profile = await getUserProfile(supabase, userId);
        if (profile) {
            roleSnapshot = profile.role;
            brokerId = profile.broker_id;
        }
    }
    
    const clientIp = 
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        'unknown';
    
    const userAgent = req.headers.get('user-agent') ?? 'unknown';
    
    return insertAuditLog(supabase, {
        ...params,
        userId,
        roleSnapshot,
        brokerId,
        ip: params.ip ?? (clientIp === 'unknown' ? null : clientIp),
        userAgent: params.userAgent ?? userAgent,
        requestId: crypto.randomUUID()
    });
}

/**
 * Helper para evento de uso/métrica desde Edge Function
 */
export async function usageEvent(
    supabase: SupabaseClient,
    req: Request,
    params: Omit<UsageEventParams, 'userId' | 'roleSnapshot' | 'brokerId' | 'requestId'>
): Promise<string | null> {
    const userId = extractUserIdFromAuth(req);
    let roleSnapshot: string | null = null;
    let brokerId: string | null = null;
    
    if (userId) {
        const profile = await getUserProfile(supabase, userId);
        if (profile) {
            roleSnapshot = profile.role;
            brokerId = profile.broker_id;
        }
    }
    
    return insertUsageEvent(supabase, {
        ...params,
        userId,
        roleSnapshot,
        brokerId,
        requestId: crypto.randomUUID()
    });
}

/**
 * Helper para acción sensible (siempre genera audit log)
 */
export async function auditSensitiveAction(
    supabase: SupabaseClient,
    req: Request,
    action: string,
    module: string,
    entityType: string,
    entityId: string,
    entityLabel: string,
    oldData?: Record<string, unknown> | null,
    newData?: Record<string, unknown> | null
): Promise<string | null> {
    return auditEvent(supabase, req, {
        action,
        module,
        entityType,
        entityId,
        entityLabel,
        oldData,
        newData,
        metadata: { sensitive: true }
    });
}

/**
 * Helper para evento de uso de herramienta
 */
export async function trackToolUsage(
    supabase: SupabaseClient,
    req: Request,
    module: string,
    action: string,
    entityType?: string,
    entityId?: string,
    metadata?: Record<string, unknown>,
    durationMs?: number
): Promise<string | null> {
    return usageEvent(supabase, req, {
        module,
        eventType: 'tool_usage',
        action,
        entityType,
        entityId,
        metadata,
        durationMs
    });
}

/**
 * Helper para evento de navegación
 */
export async function trackNavigation(
    supabase: SupabaseClient,
    req: Request,
    module: string,
    action: string,
    metadata?: Record<string, unknown>
): Promise<string | null> {
    return usageEvent(supabase, req, {
        module,
        eventType: 'navigation',
        action,
        metadata
    });
}

/**
 * Helper para evento de exportación
 */
export async function trackExport(
    supabase: SupabaseClient,
    req: Request,
    module: string,
    entityType: string,
    entityId: string,
    format: 'csv' | 'html' | 'pdf' | 'json',
    recordCount: number
): Promise<string | null> {
    return auditEvent(supabase, req, {
        action: 'export',
        module,
        entityType,
        entityId,
        entityLabel: `${format.toUpperCase()} export (${recordCount} records)`,
        newData: { format, recordCount },
        metadata: { exportFormat: format, recordCount }
    });
}

/**
 * Helper para acción masiva (bulk operation)
 */
export async function auditBulkOperation(
    supabase: SupabaseClient,
    req: Request,
    module: string,
    operation: 'create' | 'update' | 'delete' | 'publish' | 'export',
    totalItems: number,
    successCount: number,
    failedCount: number,
    durationMs: number,
    entityIds?: string[]
): Promise<string | null> {
    return auditEvent(supabase, req, {
        action: `bulk_${operation}`,
        module,
        entityType: 'bulk_operation',
        entityId: crypto.randomUUID(),
        entityLabel: `Bulk ${operation}: ${successCount}/${totalItems} success`,
        newData: { 
            operation, 
            total: totalItems, 
            success: successCount, 
            failed: failedCount,
            entityIds: entityIds?.slice(0, 100) // limitar a 100 IDs
        },
        metadata: { 
            bulk: true, 
            totalItems, 
            successCount, 
            failedCount,
            durationMs 
        }
    });
}

/**
 * Helper para error de auditoría
 */
export async function auditError(
    supabase: SupabaseClient,
    req: Request,
    action: string,
    module: string,
    error: Error | string,
    entityType?: string,
    entityId?: string,
    metadata?: Record<string, unknown>
): Promise<string | null> {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const errorCode = error instanceof Error && 'code' in error ? (error as any).code : 'UNKNOWN_ERROR';
    
    return auditEvent(supabase, req, {
        action,
        module,
        entityType,
        entityId,
        entityLabel: `Error: ${errorMessage}`,
        newData: { error: errorMessage, code: errorCode },
        status: 'error',
        errorCode,
        metadata
    });
}

/**
 * Obtiene IP del cliente
 */
export function getClientIp(req: Request): string {
    return (
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        'unknown'
    );
}

/**
 * Obtiene User-Agent
 */
export function getUserAgent(req: Request): string {
    return req.headers.get('user-agent') ?? 'unknown';
}

/**
 * Middleware de auditoría automática para Edge Functions
 * Uso: export default withAudit('ml-sync', handler, { module: 'ml', trackDuration: true, auditActions: ['publish', 'sync'] });
 */
export function withAudit<Fn extends (req: Request, supabase: SupabaseClient) => Promise<Response>>(
    module: string,
    handler: Fn,
    options?: {
        trackDuration?: boolean;
        trackNavigation?: boolean;
        auditActions?: string[];
    }
): Fn {
    const auditActionsRegex = options?.auditActions?.length
        ? new RegExp(options.auditActions.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
        : null;
    
    return (async (req: Request) => {
        const startTime = Date.now();
        const requestId = crypto.randomUUID();
        
        // Track navigation si habilitado
        if (options?.trackNavigation) {
            await usageEvent(supabase, req, {
                module,
                eventType: 'navigation',
                action: 'request',
                metadata: { method: req.method, url: req.url },
                requestId: crypto.randomUUID()
            });
        }
        
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SERVICE_ROLE_KEY') ?? '',
            { auth: { persistSession: false } }
        );
        
        try {
            const response = await handler(req, supabase);
            const durationMs = Date.now() - startTime;
            
            // Auditar acción exitosa si la URL coincide con alguna acción auditada
            if (auditActionsRegex && auditActionsRegex.test(req.url)) {
                await auditEvent(supabase, req, {
                    action: 'request',
                    module,
                    metadata: { 
                        method: req.method,
                        status: response.status,
                        durationMs 
                    },
                    requestId
                });
            }
            
            // Track duration si habilitado
            if (options?.trackDuration) {
                await usageEvent(supabase, {
                    headers: new Headers({}) // mock request for internal call
                } as unknown as Request, {
                    module,
                    eventType: 'api_call',
                    action: 'handler',
                    durationMs,
                    metadata: { status: response.status },
                    requestId
                });
            }
            
            return response;
        } catch (error) {
            const durationMs = Date.now() - startTime;
            await auditError(supabase, req, 'handler_error', module, error as Error, undefined, undefined, {
                durationMs
            });
            throw error;
        }
    }) as Fn;
}