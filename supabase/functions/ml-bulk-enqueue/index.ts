import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { isAdmin } from '../_shared/auth.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

type MlOperation = 'publish' | 'update' | 'delete';

const VALID_OPERATIONS: MlOperation[] = ['publish', 'update', 'delete'];

Deno.serve(async (req) => {
    const respond = (status: number, body: Record<string, unknown>): Response =>
        jsonResponse(status, body, req);
    if (req.method === 'OPTIONS') return optionsResponse(req);

    const rl = await rateLimitMiddleware('ml-bulk-enqueue', req);
    if (rl) return rl;

    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });
    if (!(await isAdmin(req, supabase))) return respond(401, { error: 'No autorizado' });

    let payload: { property_ids?: unknown; operation?: unknown };
    try {
        payload = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' });
    }

    const propertyIds = Array.isArray(payload.property_ids)
        ? (payload.property_ids.filter((v): v is string => typeof v === 'string') as string[])
        : [];
    const operation =
        typeof payload.operation === 'string' ? (payload.operation as MlOperation) : null;

    if (propertyIds.length === 0) {
        return respond(400, { error: 'property_ids es requerido' });
    }
    if (!operation || !VALID_OPERATIONS.includes(operation)) {
        return respond(400, { error: 'operation debe ser publish, update o delete' });
    }

    /* ml_enqueue_batch espera p_jobs: array JSON de {property_id, operation} y
       devuelve bigint[] (ids de queue). El contrato anterior con p_property_ids /
       p_operation / p_internal nunca existió en el RPC y fallaba con 500 siempre. */
    const jobs = propertyIds.map((id) => ({ property_id: id, operation }));
    const { data, error } = await supabase.rpc('ml_enqueue_batch', { p_jobs: jobs });

    if (error) {
        return respond(500, { error: error.message });
    }

    const ids = Array.isArray(data) ? (data as unknown[]) : [];
    return respond(200, { enqueued: ids.length, skipped: propertyIds.length - ids.length });
});
