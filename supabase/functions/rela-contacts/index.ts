// ============================================================
// rela-contacts — importación manual de contactos de ZonaProp (verify_jwt ON)
// Botón "Traer contactos" del panel Portales → RELA.
//
// ¿Por qué existe si rela-sync ya hace polling? Porque el cron corre con
// x-sync-secret (sin JWT) y el panel necesita una acción autenticada con
// control por rol y un modo `preview` para importar el histórico con OK
// explícito del dueño. Ambos comparten la MISMA lógica en
// _shared/rela-leads.ts (una feature no se implementa dos veces).
//
// Endpoint documentado: GET /v1/inmobiliarias/{codigo}/mensajes
// (Swagger oficial https://api-zp.open.navent.com/swagger-ui-init.js).
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { loadRelaEnv, RelaClient } from '../_shared/rela.ts';
import { pullRelaContacts } from '../_shared/rela-leads.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const WRITE_ROLES = ['super_admin', 'broker'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Sin sesión' }, 401);
  const { data: userData } = await supabase.auth.getUser(auth.slice(7));
  if (!userData.user) return json({ error: 'Sesión inválida' }, 401);
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (!profile?.is_active || !WRITE_ROLES.includes(profile.role as string)) {
    return json({ error: 'Solo super_admin o broker pueden traer contactos de ZonaProp' }, 403);
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const preview = body.preview === true;
  const days = Math.max(1, Math.min(365, Number(body.days ?? 30) || 30));

  const { data: cfg } = await supabase.from('rela_config').select('*').eq('id', true).maybeSingle();
  if (!cfg?.codigo_inmobiliaria) {
    return json({ ok: false, error: 'RELA no está configurado (falta código de inmobiliaria)' }, 400);
  }
  const env = loadRelaEnv();
  if (!env) return json({ ok: false, error: 'Faltan credenciales RELA en el servidor' }, 503);
  env.baseUrl = cfg.base_url || env.baseUrl;
  env.role = cfg.role || env.role;
  const client = new RelaClient(supabase, env);

  try {
    const result = await pullRelaContacts(
      supabase, client, String(cfg.codigo_inmobiliaria), days, preview,
    );
    await supabase.rpc('insert_audit_log', {
      p_user_id: null,
      p_role_snapshot: profile.role,
      p_broker_id: null,
      p_action: preview ? 'rela_contacts_preview' : 'rela_contacts_pull',
      p_module: 'rela',
      p_table_name: 'rela_webhook_events',
      p_record_id: null,
      p_entity_type: null,
      p_entity_id: null,
      p_entity_label: null,
      p_old_data: null,
      p_new_data: null,
      p_changed_fields: null,
      p_metadata: {
        dias: days,
        total: result.total,
        nuevos: result.nuevos,
        consolidados: result.consolidados,
        duplicados: result.duplicados,
        errores: result.errores,
      },
      p_status: result.errores ? 'error' : 'success',
      p_error_code: null,
      p_ip: null,
      p_user_agent: null,
      p_session_id: null,
      p_request_id: crypto.randomUUID(),
    });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error('[rela-contacts]', err);
    const status = (err as { status?: number }).status ?? 500;
    return json({ ok: false, error: (err as Error).message }, status >= 400 && status < 600 ? status : 500);
  }
});
