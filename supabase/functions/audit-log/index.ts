import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

async function isAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return false;
  
  const { data: admins } = await supabase
    .from('admin_users')
    .select('role, is_active')
    .eq('id', data.user.id)
    .limit(1);
  
  const admin = admins?.[0];
  return !!admin && admin.is_active && ['super_admin', 'admin', 'staff'].includes(admin.role);
}

interface AuditLogEntry {
  action: string;
  entity_type: string;
  entity_id?: string;
  entity_title?: string;
  old_values?: Record<string, unknown>;
  new_values?: Record<string, unknown>;
  changed_fields?: string[];
  metadata?: Record<string, unknown>;
  status?: 'success' | 'failure' | 'partial';
  error_message?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return respond(405, { error: 'Method not allowed' });

  if (!(await isAdmin(req))) return respond(401, { error: 'No autorizado' });

  // POST - Insertar log de auditoría manual
  if (req.method === 'POST') {
    let entry: AuditLogEntry;
    try {
      entry = await req.json();
    } catch {
      return respond(400, { error: 'JSON inválido' });
    }

    if (!entry.action || !entry.entity_type) {
      return respond(400, { error: 'action y entity_type son requeridos' });
    }

    const { error } = await supabase.from('audit_logs').insert({
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id ?? null,
      entity_title: entry.entity_title ?? null,
      old_values: entry.old_values ?? null,
      new_values: entry.new_values ?? null,
      changed_fields: entry.changed_fields ?? null,
      metadata: entry.metadata ?? null,
      status: entry.status ?? 'success',
      error_message: entry.error_message ?? null,
    });

    if (error) return respond(500, { error: error.message });

    return respond(201, { ok: true });
  }

  // GET - Listar logs con filtros y paginación
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') ?? '1');
  const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') ?? '50'), 200);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const filters: Record<string, string> = {};
  if (url.searchParams.get('actor_id')) filters.actor_id = `eq.${url.searchParams.get('actor_id')}`;
  if (url.searchParams.get('entity_type')) filters.entity_type = `eq.${url.searchParams.get('entity_type')}`;
  if (url.searchParams.get('entity_id')) filters.entity_id = `eq.${url.searchParams.get('entity_id')}`;
  if (url.searchParams.get('action')) filters.action = `eq.${url.searchParams.get('action')}`;
  if (url.searchParams.get('status')) filters.status = `eq.${url.searchParams.get('status')}`;
  if (url.searchParams.get('from_date')) filters.created_at = `gte.${url.searchParams.get('from_date')}`;
  if (url.searchParams.get('to_date')) filters.created_at = `lte.${url.searchParams.get('to_date')}`;
  if (url.searchParams.get('search')) {
    filters.entity_title = `ilike.*${url.searchParams.get('search')}*`;
  }

  const { data, error, count } = await supabase
    .from('audit_logs')
    .select('*', { count: 'exact' })
    .match(filters)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) return respond(500, { error: error.message });

  return respond(200, {
    data: data ?? [],
    page,
    pageSize,
    total: count ?? 0,
    totalPages: Math.ceil((count ?? 0) / pageSize),
  });
});