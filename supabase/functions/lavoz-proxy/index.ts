// ============================================================
// lavoz-proxy — Edge Function autenticada (verify_jwt ON)
// Publicación ASISTIDA en Clasificados La Voz.
//
// POR QUÉ ASISTIDA (investigación 2026-11-04):
//   La Voz NO tiene API pública ni carga masiva (sin API en FAQ/Términos/
//   sitemap/bundles; la única ruta JSON del front es /api/auth/me; el
//   portal está detrás de Cloudflare Turnstile y su robots.txt bloquea AI
//   crawlers). Por eso esta función NO publica: ARMA el aviso completo
//   (texto + fotos con la PORTADA primero + campos del formulario) y
//   trackea el estado de cada aviso (incluido el vencimiento a 10/30 días).
//   La carga en el panel la hace una persona, o el asistente local
//   scripts/lavoz-publisher.mjs (navegador visible, login humano).
//
// La lógica pura (armado del aviso) vive en _shared/lavoz.mapper.ts para
// poder testearla sin red ni DB (tests/unit/lavoz-mapper.test.mts).
//
// Acciones:
//   status        → resumen + config
//   config_get    → config (mapeos)
//   config_set    → actualiza mapeos (super_admin)
//   list          → avisos + estado (join con properties)
//   prepare       → arma el aviso de UNA propiedad (crea/actualiza la fila)
//   prepare_all   → arma los avisos de todas las publicadas sin publicar
//   confirm       → marca publicado (URL + vencimiento)
//   unpublish     → despublica (deja el aviso, limpia el estado)
//   expire        → marca vencido
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { insertAuditLog } from '../_shared/audit.ts';
import {
  buildLavozPayload,
  buildLavozFicha,
  type LavozConfig,
} from '../_shared/lavoz.mapper.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const WRITE_ROLES = ['super_admin', 'broker'];
const CONFIG_ROLES = ['super_admin'];

type Json = Record<string, unknown>;

// ---------------- Auth / roles / auditoría ----------------

interface Actor {
  id: string;
  role: string;
}

async function getProfile(supabase: ReturnType<typeof createClient>, req: Request): Promise<Actor | null> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const { data } = await supabase.auth.getUser(auth.slice(7));
  if (!data.user) return null;
  const { data: profile } = await supabase
    .from('profiles').select('id, role, is_active').eq('id', data.user.id).maybeSingle();
  if (!profile || !profile.is_active) return null;
  return { id: String(profile.id), role: String(profile.role) };
}

async function audit(
  supabase: ReturnType<typeof createClient>,
  actor: Actor | null,
  action: string,
  metadata: Json,
  status: 'success' | 'error' = 'success',
) {
  await insertAuditLog(supabase, {
    userId: actor?.id ?? null,
    roleSnapshot: actor?.role ?? null,
    action,
    module: 'lavoz',
    tableName: 'lavoz_listings',
    entityType: 'property',
    metadata,
    status,
  });
}

// ---------------- Config ----------------

async function loadConfig(supabase: ReturnType<typeof createClient>): Promise<LavozConfig> {
  const { data } = await supabase.from('lavoz_config').select('*').eq('id', true).maybeSingle();
  const cfg = (data || {}) as Partial<LavozConfig>;
  return {
    dias_publicacion: Number(cfg.dias_publicacion) || 30,
    tipo_map: cfg.tipo_map || {},
    ubicacion_map: cfg.ubicacion_map || {},
    contacto: cfg.contacto || {},
  };
}

const PROP_SELECT = [
  'id', 'property_code', 'title', 'description', 'property_type', 'listing_type',
  'status', 'zone', 'locality', 'address', 'price_usd', 'price_currency',
  'area_m2', 'surface_covered', 'surface_total', 'rooms', 'bedrooms', 'bathrooms',
  'garage_spaces', 'year_built', 'maintenance_fee', 'image_urls', 'video_url',
  'is_published', 'is_vendida', 'is_reservada', 'deleted_at',
].join(', ');

/** Avisos que impiden publicar: sin operación, sin precio o sin subrubro. */
const BLOQUEANTES = /Falta la operación|Falta el precio|no tiene subrubro/i;

/**
 * Vence los avisos cuyo expires_at ya pasó (10 o 30 días, según el plan).
 * Es self-healing: el estado se corrige solo la primera vez que alguien
 * mira el panel (no hace falta un cron para un aviso que nadie consulta).
 */
async function expireVencidos(supabase: ReturnType<typeof createClient>) {
  const { error } = await supabase
    .from('lavoz_listings')
    .update({ status: 'expired' })
    .eq('status', 'published')
    .lt('expires_at', new Date().toISOString());
  if (error) console.error('[lavoz] expireVencidos:', error.message);
}

// ---------------- Handlers ----------------

async function handleRequest(req: Request): Promise<Response> {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const actor = await getProfile(supabase, req);
  if (!actor) return jsonResponse(401, { error: 'No autenticado' }, req);

  let body: Json = {};
  try { body = await req.json(); } catch { /* body vacío */ }
  const action = String(body.action || 'status');

  const cfg = await loadConfig(supabase);

  try {
    if (action === 'status') {
      await expireVencidos(supabase);
      const { data } = await supabase.rpc('lavoz_portal_status');
      return jsonResponse(200, { ok: true, status: data, config: cfg, role: actor.role }, req);
    }

    if (action === 'config_get') {
      return jsonResponse(200, { ok: true, config: cfg }, req);
    }

    if (action === 'config_set') {
      if (!CONFIG_ROLES.includes(actor.role)) {
        return jsonResponse(403, { error: 'Solo super_admin puede cambiar la configuración' }, req);
      }
      const patch: Record<string, unknown> = {};
      for (const key of ['dias_publicacion', 'tipo_map', 'ubicacion_map', 'contacto']) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (Object.keys(patch).length) {
        const { error } = await supabase.from('lavoz_config').update(patch).eq('id', true);
        if (error) throw error;
      }
      await audit(supabase, actor, 'lavoz_config_set', { keys: Object.keys(patch) });
      return jsonResponse(200, { ok: true, config: await loadConfig(supabase) }, req);
    }

    if (action === 'list') {
      await expireVencidos(supabase);
      const { data, error } = await supabase
        .from('lavoz_listings')
        .select('id, property_id, status, ad_url, remote_id, plan, fotos_count, published_at, expires_at, last_error, updated_at, payload, properties!inner(property_code, title, image_urls, zone, locality, is_published)')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return jsonResponse(200, { ok: true, listings: data || [] }, req);
    }

    if (action === 'prepare' || action === 'prepare_all') {
      if (!WRITE_ROLES.includes(actor.role)) {
        return jsonResponse(403, { error: 'Tu rol no puede preparar publicaciones en La Voz' }, req);
      }

      let props: Record<string, unknown>[] = [];
      if (action === 'prepare') {
        const propertyId = String(body.property_id || '');
        if (!propertyId) return jsonResponse(400, { error: 'Falta property_id' }, req);
        const { data, error } = await supabase.from('properties').select(PROP_SELECT).eq('id', propertyId).maybeSingle();
        if (error) throw error;
        if (!data) return jsonResponse(404, { error: 'La propiedad no existe' }, req);
        props = [data as Record<string, unknown>];
      } else {
        const { data, error } = await supabase
          .from('properties')
          .select(PROP_SELECT)
          .eq('is_published', true)
          .is('deleted_at', null)
          .is('is_vendida', false)
          .is('is_reservada', false);
        if (error) throw error;
        const { data: rows } = await supabase.from('lavoz_listings').select('property_id, status');
        const yaPublicados = new Set(
          (rows || [])
            .filter((r: { status: string }) => r.status === 'published')
            .map((r: { property_id: string }) => r.property_id),
        );
        props = ((data || []) as Record<string, unknown>[]).filter((p) => !yaPublicados.has(String(p.id)));
      }

      const results = [];
      for (const p of props) {
        const payload = buildLavozPayload(p, cfg);
        const bloqueante = payload.avisos.filter((a) => BLOQUEANTES.test(a));
        const { error } = await supabase.from('lavoz_listings').upsert({
          property_id: p.id,
          status: bloqueante.length ? 'failed' : 'ready',
          payload,
          fotos_count: payload.fotos_count,
          plan: payload.plan_recomendado,
          last_error: bloqueante.length ? bloqueante.join(' | ') : null,
        }, { onConflict: 'property_id' });
        if (error) throw error;
        results.push({
          property_id: payload.property_id,
          property_code: payload.property_code,
          titulo: payload.titulo,
          avisos: payload.avisos,
          status: bloqueante.length ? 'failed' : 'ready',
          payload,
          ficha: buildLavozFicha(payload),
        });
      }
      await audit(supabase, actor, 'lavoz_prepare', { action, count: results.length });
      return jsonResponse(200, { ok: true, count: results.length, results }, req);
    }

    if (action === 'confirm') {
      if (!WRITE_ROLES.includes(actor.role)) {
        return jsonResponse(403, { error: 'Tu rol no puede confirmar publicaciones' }, req);
      }
      const propertyId = String(body.property_id || '');
      if (!propertyId) return jsonResponse(400, { error: 'Falta property_id' }, req);
      const dias = Math.max(1, Number(body.dias || cfg.dias_publicacion));
      const now = new Date();
      const expires = new Date(now.getTime() + dias * 86400000);
      const { error } = await supabase.from('lavoz_listings').upsert({
        property_id: propertyId,
        status: 'published',
        ad_url: body.ad_url ? String(body.ad_url) : null,
        remote_id: body.remote_id ? String(body.remote_id) : null,
        plan: body.plan ? String(body.plan) : null,
        published_at: now.toISOString(),
        expires_at: expires.toISOString(),
        last_error: null,
      }, { onConflict: 'property_id' });
      if (error) throw error;
      await audit(supabase, actor, 'lavoz_confirm', { property_id: propertyId, ad_url: body.ad_url || null });
      return jsonResponse(200, { ok: true, published_at: now.toISOString(), expires_at: expires.toISOString() }, req);
    }

    if (action === 'unpublish' || action === 'expire') {
      if (!WRITE_ROLES.includes(actor.role)) {
        return jsonResponse(403, { error: 'Tu rol no puede modificar publicaciones' }, req);
      }
      const propertyId = String(body.property_id || '');
      if (!propertyId) return jsonResponse(400, { error: 'Falta property_id' }, req);
      const status = action === 'expire' ? 'expired' : 'draft';
      const patch: Record<string, unknown> = { status };
      if (action === 'unpublish') { patch.ad_url = null; patch.published_at = null; patch.expires_at = null; }
      const { error } = await supabase.from('lavoz_listings').update(patch).eq('property_id', propertyId);
      if (error) throw error;
      await audit(supabase, actor, `lavoz_${action}`, { property_id: propertyId });
      return jsonResponse(200, { ok: true, status }, req);
    }

    return jsonResponse(400, { error: `Acción no soportada: ${action}` }, req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit(supabase, actor, `lavoz_${action}`, { error: message }, 'error');
    return jsonResponse(500, { error: message }, req);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return optionsResponse(req);
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Método no permitido' }, req);
  }
  try {
    return await handleRequest(req);
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : 'error' }, req);
  }
});
