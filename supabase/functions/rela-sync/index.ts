// ============================================================
// rela-sync — Reconciliación programada (cron / invocación manual)
// 0) Polling de CONTACTOS: GET /v1/inmobiliarias/{codigo}/mensajes → leads.
//    Es la única captación viva mientras los callbacks estén denied.
// 1) Por cada listing PUBLISHED/UPDATE_PENDING: consulta el aviso en
//    RELA y alinea remote_status.
// 2) Recalcula el hash del payload: si la propiedad cambió y el aviso
//    está publicado, marca UPDATE_PENDING (la re-publicación la dispara
//    un usuario desde el panel — RELA consume créditos por plan).
// Se invoca como función verify_jwt OFF con header x-sync-secret (el mismo
// compartido de zernio_config, patrón backup-snapshot/zernio-sync) — ver la
// migración de scheduling pendiente en docs/integrations/RELA.md.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { loadRelaEnv, RelaClient } from '../_shared/rela.ts';
import { BhProperty, hashPayload, mapPropertyToRela, validateForRela } from '../_shared/rela.mapper.ts';
import { pullRelaContacts } from '../_shared/rela-leads.ts';

type ListingRow = {
  id: string; property_id: string; codigo_aviso: string;
  status: string; payload_hash: string | null;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Fail-closed con el patrón de los crons que funcionan (backup-snapshot,
  // zernio-sync, ml-vis-sweep): el secret vive en zernio_config(key='sync_secret')
  // y pg_cron lo lee en runtime. (Antes era env CRON_SECRET — el patrón que ya
  // rompió 3 crons de este proyecto por secret inexistente / mal seteado.)
  const { data: secretRow } = await supabase.from('zernio_config').select('value').eq('key', 'sync_secret').maybeSingle();
  const secret = (secretRow?.value?.secret) || '';
  if (!secret) {
    console.error('[rela-sync] sync_secret no configurado (zernio_config)');
    return json({ error: 'rela-sync no configurado (falta sync_secret)' }, 503);
  }
  if (req.headers.get('x-sync-secret') !== secret) {
    return json({ error: 'no autorizado' }, 401);
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  const { data: cfgRow } = await supabase.from('rela_config').select('*').eq('id', true).maybeSingle();
  if (!cfgRow?.codigo_inmobiliaria) {
    return json({ ok: false, skipped: true, reason: 'rela_config incompleta' });
  }
  /* DRY_RUN aplica SOLO a publicar avisos (gasta créditos). La lectura de
     contactos es gratuita y hoy es la ÚNICA vía viva de captación: el alta
     de callbacks en QuintoAndar responde 500 "Access is denied". Por eso el
     polling corre aunque dry_run siga activo. */

  const env = loadRelaEnv();
  if (!env) return json({ ok: false, skipped: true, reason: 'sin credenciales RELA' });
  env.baseUrl = cfgRow.base_url || env.baseUrl;
  env.role = cfgRow.role || env.role;
  const client = new RelaClient(supabase, env);

  /* Captación: polling de contactos de ZonaProp. Es la vía viva hoy — los
     callbacks no se pueden registrar (500 Access is denied del lado de
     QuintoAndar). `preview` clasifica sin escribir, para importar el
     histórico con OK del dueño.
     FAIL-SOFT: la API de sandbox cae seguido (HTTP 521 de Cloudflare,
     incidente 2026-11-21). Un 521 NO debe tumbar toda la función con 500:
     el cron seguiría reintentando cada 10 min sin traza accionable. Se
     devuelve `degraded:true` con el motivo para que se vea en logs/panel. */
  const contactDays = Math.max(1, Math.min(365, Number(body.days ?? 2) || 2));
  type ContactsResult = Awaited<ReturnType<typeof pullRelaContacts>>;
  let contacts: ContactsResult | null = null;
  let contactsError: string | null = null;
  try {
    contacts = await pullRelaContacts(
      supabase, client, cfgRow.codigo_inmobiliaria, contactDays, body.preview === true,
    );
  } catch (err) {
    contactsError = String((err as Error)?.message ?? err).slice(0, 500);
    console.error('[rela-sync] polling de contactos falló (API RELA caída?)', contactsError);
  }

  /* El DRY_RUN sigue frenando la RECONCILIACIÓN de avisos (no gasta nada,
     pero no hay listings publicados mientras tanto). */
  let listings: ListingRow[] = [];
  if (!cfgRow.dry_run) {
    const { data: rows } = await supabase
      .from('rela_listings')
      .select('id, property_id, codigo_aviso, status, payload_hash')
      .in('status', ['PUBLISHED', 'UPDATE_PENDING', 'ERROR']);
    listings = (rows ?? []) as ListingRow[];
  }

  const results: Array<Record<string, unknown>> = [];

  for (const l of listings) {
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

  await supabase.from('rela_config').update({
    last_sync_at: new Date().toISOString(),
    ...(contacts && !contacts.preview ? { last_error: null } : {}),
    ...(contactsError ? { last_error: contactsError } : {}),
  }).eq('id', true);
  return json({
    ok: true,
    ...(contactsError
      ? { degraded: true, contacts_error: contactsError }
      : { contacts }),
    processed: results.length,
    results,
    ...(cfgRow.dry_run ? { skipped: 'DRY_RUN: avisos no reconciliados (contactos sí importados)' } : {}),
  });
});
