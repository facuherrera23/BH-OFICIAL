// ============================================================
// rela-sync — Reconciliación programada (cron / invocación manual)
// 1) Por cada listing PUBLISHED/UPDATE_PENDING: consulta el aviso en
//    RELA y alinea remote_status.
// 2) Recalcula el hash del payload: si la propiedad cambió y el aviso
//    está publicado, marca UPDATE_PENDING (la re-publicación la dispara
//    un usuario desde el panel — RELA consume créditos por plan).
// Se invoca con un header X-Cron-Secret o como función verify_jwt OFF
// desde pg_cron (ver migración de scheduling en docs/integrations/RELA.md).
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { loadRelaEnv, RelaClient } from '../_shared/rela.ts';
import { BhProperty, hashPayload, mapPropertyToRela, validateForRela } from '../_shared/rela.mapper.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  const secret = Deno.env.get('CRON_SECRET') ?? '';
  if (secret && req.headers.get('x-cron-secret') !== secret) {
    return json({ error: 'no autorizado' }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: cfgRow } = await supabase.from('rela_config').select('*').eq('id', true).maybeSingle();
  if (!cfgRow?.codigo_inmobiliaria) {
    return json({ ok: false, skipped: true, reason: 'rela_config incompleta' });
  }
  if (cfgRow.dry_run) {
    return json({ ok: true, skipped: true, reason: 'DRY_RUN activo — no se consulta la API' });
  }

  const env = loadRelaEnv();
  if (!env) return json({ ok: false, skipped: true, reason: 'sin credenciales RELA' });
  env.baseUrl = cfgRow.base_url || env.baseUrl;
  env.role = cfgRow.role || env.role;
  const client = new RelaClient(supabase, env);

  const { data: listings } = await supabase
    .from('rela_listings')
    .select('id, property_id, codigo_aviso, status, payload_hash')
    .in('status', ['PUBLISHED', 'UPDATE_PENDING', 'ERROR']);

  const results: Array<Record<string, unknown>> = [];

  for (const l of listings || []) {
    const entry: Record<string, unknown> = { codigo_aviso: l.codigo_aviso };
    try {
      // 1) Estado remoto
      const aviso = (await client.getAviso(cfgRow.codigo_inmobiliaria, l.codigo_aviso)) as Record<string, unknown>;
      const remoteStatus: string | null = (aviso?.estado as string) ?? null;
      entry.remote_status = remoteStatus;

      // 2) Drift local → relist si cambió el payload
      const { data: prop } = await supabase
        .from('properties')
        .select('id, property_code, title, description, property_type, status, zone, address, price_usd, price_currency, area_m2, surface_covered, surface_total, rooms, bedrooms, bathrooms, garage_spaces, year_built, image_urls, video_url')
        .eq('id', l.property_id)
        .is('deleted_at', null)
        .maybeSingle();

      let newStatus: string | null = null;
      if (remoteStatus === 'OFFLINE') {
        newStatus = 'UNPUBLISHED';
      } else if (prop && remoteStatus === 'ONLINE') {
        const errors = validateForRela(prop as BhProperty, {
          codigoInmobiliaria: cfgRow.codigo_inmobiliaria,
          plan: cfgRow.plan_default,
          contactoNombre: cfgRow.contacto_nombre,
          contactoEmail: cfgRow.contacto_email,
          contactoTelefono: cfgRow.contacto_telefono,
          catalogMapping: cfgRow.catalog_mapping,
          tipoPropiedadMap: cfgRow.tipo_propiedad_map,
          ubicacionMap: cfgRow.ubicacion_map,
        });
        if (errors.length === 0) {
          const hash = hashPayload(mapPropertyToRela(prop as BhProperty, {
            codigoInmobiliaria: cfgRow.codigo_inmobiliaria,
            plan: cfgRow.plan_default,
            contactoNombre: cfgRow.contacto_nombre,
            contactoEmail: cfgRow.contacto_email,
            contactoTelefono: cfgRow.contacto_telefono,
            catalogMapping: cfgRow.catalog_mapping,
            tipoPropiedadMap: cfgRow.tipo_propiedad_map,
            ubicacionMap: cfgRow.ubicacion_map,
          }));
          entry.payload_changed = hash !== l.payload_hash;
          if (hash !== l.payload_hash && l.status === 'PUBLISHED') newStatus = 'UPDATE_PENDING';
        }
      }

      await supabase.from('rela_listings').update({
        remote_status: remoteStatus,
        remote_snapshot: aviso,
        last_sync_at: new Date().toISOString(),
        ...(newStatus ? { status: newStatus } : {}),
      }).eq('id', l.id);
    } catch (err) {
      entry.error = (err as Error).message;
      await supabase.from('rela_listings').update({ last_error: (err as Error).message }).eq('id', l.id);
    }
    results.push(entry);
  }

  await supabase.from('rela_config').update({ last_sync_at: new Date().toISOString() }).eq('id', true);
  return json({ ok: true, processed: results.length, results });
});
