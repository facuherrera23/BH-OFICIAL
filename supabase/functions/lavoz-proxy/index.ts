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
  RE_BLOQUEANTE_LAVOZ,
  SUBRUBROS_LAVOZ,
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

/** Validación de la config: la DB sólo garantiza dias ∈ {10,30}; el resto
 *  tiene que ser un objeto con la forma que espera el mapper, si no un
 *  config_set descuidado rompe TODOS los prepares en silencio. */
function validarConfigPatch(body: Json): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (body.dias_publicacion !== undefined) {
    const d = Number(body.dias_publicacion);
    if (d !== 10 && d !== 30) throw new Error('dias_publicacion debe ser 10 o 30');
    patch.dias_publicacion = d;
  }
  const esObjeto = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const esSlugLavoz = (v: unknown) => typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.trim());
  if (body.tipo_map !== undefined) {
    if (!esObjeto(body.tipo_map)) throw new Error('tipo_map debe ser un objeto');
    const mapa: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.tipo_map)) {
      if (!esObjeto(v) || typeof v.subrubro !== 'string' || !v.subrubro.trim()
        || typeof v.label !== 'string' || !v.label.trim()) {
        throw new Error(`tipo_map.${k} necesita subrubro y label no vacíos`);
      }
      const subrubro = v.subrubro.trim().toLowerCase();
      if (!SUBRUBROS_LAVOZ.has(subrubro)) {
        throw new Error(`tipo_map.${k}.subrubro "${v.subrubro}" no es un subrubro válido de La Voz`);
      }
      mapa[k] = { subrubro, label: v.label.trim() };
    }
    patch.tipo_map = mapa;
  }
  if (body.ubicacion_map !== undefined) {
    if (!esObjeto(body.ubicacion_map)) throw new Error('ubicacion_map debe ser un objeto');
    const mapa: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.ubicacion_map)) {
      if (!esObjeto(v)) throw new Error(`ubicacion_map.${k} debe ser un objeto`);
      const limpio: Record<string, unknown> = {};
      for (const campo of ['ciudad', 'ciudad_label', 'barrio', 'label', 'provincia', 'nota']) {
        const valor = v[campo];
        if (valor !== undefined && valor !== null && typeof valor !== 'string') {
          throw new Error(`ubicacion_map.${k}.${campo} debe ser texto o null`);
        }
        if ((campo === 'ciudad' || campo === 'barrio') && typeof valor === 'string' && valor.trim() && !esSlugLavoz(valor)) {
          throw new Error(`ubicacion_map.${k}.${campo} debe ser slug de La Voz (minúsculas, números y guiones)`);
        }
        if (valor !== undefined) limpio[campo] = typeof valor === 'string' ? valor.trim() || null : valor;
      }
      mapa[k] = limpio;
    }
    patch.ubicacion_map = mapa;
  }
  if (body.contacto !== undefined) {
    if (!esObjeto(body.contacto)) throw new Error('contacto debe ser un objeto');
    const limpio: Record<string, unknown> = {};
    for (const campo of ['email', 'telefono', 'whatsapp']) {
      const valor = body.contacto[campo];
      if (valor !== undefined && valor !== null && typeof valor !== 'string') {
        throw new Error(`contacto.${campo} debe ser texto o null`);
      }
      const txt = typeof valor === 'string' ? valor.trim() : null;
      if (campo === 'email' && txt && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(txt)) {
        throw new Error('contacto.email no tiene formato válido');
      }
      if ((campo === 'telefono' || campo === 'whatsapp') && txt && !/[0-9]{6,}/.test(txt)) {
        throw new Error(`contacto.${campo} debe contener un teléfono válido`);
      }
      if (valor !== undefined) limpio[campo] = txt || null;
    }
    if (body.contacto.mostrar_whatsapp !== undefined) {
      if (typeof body.contacto.mostrar_whatsapp !== 'boolean') {
        throw new Error('contacto.mostrar_whatsapp debe ser true/false');
      }
      limpio.mostrar_whatsapp = body.contacto.mostrar_whatsapp;
    }
    patch.contacto = limpio;
  }

  return patch;
}

/** URL de un AVISO REAL de La Voz: la valida también el panel y el asistente,
 *  pero el server no puede confiar en ninguno de los dos. Tres condiciones:
 *  host exacto (o subdominio), NO el wizard /publicar, e id numérico en el
 *  path. Sin esto, un link ajeno (notlavoz.com.ar) o el formulario mismo se
 *  guardaban como "publicado" y el panel mostraba un link muerto como prueba. */
function validarAdUrl(valor: unknown): string | null {
  const s = String(valor ?? '').trim();
  if (!s) return null;
  let parsed: URL;
  try { parsed = new URL(s); } catch { throw new Error('La URL del aviso no es válida (debe empezar con https://)'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('La URL del aviso debe ser http:// o https://');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'lavoz.com.ar' && !host.endsWith('.lavoz.com.ar')) {
    throw new Error('La URL del aviso debe ser de clasificados.lavoz.com.ar');
  }
  if (/\/publicar(\/|$)/.test(parsed.pathname)) {
    throw new Error('Esa URL es del formulario, no del aviso publicado');
  }
  if (!/\/\d{5,}(?:\/|$)/.test(parsed.pathname)) {
    throw new Error('La URL del aviso no incluye el id del aviso');
  }
  return s;
}

/**
 * Vence los avisos cuyo expires_at ya pasó (10 o 30 días, según el plan).
 * Es self-healing: el estado se corrige solo la primera vez que alguien
 * mira el panel (no hace falta un cron para un aviso que nadie consulta).
 */
async function expireVencidos(supabase: ReturnType<typeof createClient>) {
  const ahora = new Date().toISOString();
  const { error } = await supabase
    .from('lavoz_listings')
    .update({ status: 'expired' })
    .eq('status', 'published')
    .lt('expires_at', ahora);
  if (error) console.error('[lavoz] expireVencidos:', error.message);

  /* Los avisos que un prepare viejo degradó a ready/failed CON link guardado
     también vencen: si no, el panel los sigue mostrando como "listos para
     subir" aunque su fecha ya pasó (y el asistente los publicaría de nuevo). */
  const { error: errorDegradados } = await supabase
    .from('lavoz_listings')
    .update({ status: 'expired' })
    .in('status', ['ready', 'failed'])
    .not('ad_url', 'is', null)
    .lt('expires_at', ahora);
  if (errorDegradados) console.error('[lavoz] expireVencidos degradados:', errorDegradados.message);
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
      const patch = validarConfigPatch(body);
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
        /* Tampoco reprocesar los VENCIDOS: su ad_url es la única forma de
           renovar el aviso desde el panel (botón "renovar"). Un prepare en
           lote les borraba el link y la renovación quedaba imposible. */
        const yaPublicados = new Set(
          (rows || [])
            .filter((r: { status: string }) => r.status === 'published' || r.status === 'expired')
            .map((r: { property_id: string }) => r.property_id),
        );
        props = ((data || []) as Record<string, unknown>[]).filter((p) => !yaPublicados.has(String(p.id)));
      }

      const results = [];
      for (const p of props) {
        const payload = buildLavozPayload(p, cfg);
        const bloqueante = payload.avisos.filter((a) => RE_BLOQUEANTE_LAVOZ.test(a));

        /* Un re-prepare NO puede degradar un aviso ya publicado: el link,
           la fecha de publicación y el vencimiento son la prueba de que se
           cargó en La Voz (incidente 2026-11-22: DA-P0013/DA-P0002 quedaron
           'ready' al volver a prepararlos, con el ad_url todavía guardado). */
        const { data: existing, error: existingError } = await supabase
          .from('lavoz_listings')
          .select('status, ad_url, remote_id, plan, published_at, expires_at')
          .eq('property_id', p.id)
          .maybeSingle();
        /* Si no podemos leer el estado, NO escribimos: un upsert a ciegas
           degradaría un aviso publicado (perdería su link de verdad). */
        if (existingError) throw existingError;
        /* También reparamos los avisos que un prepare anterior dejó en
           ready/failed CON link y fecha de publicación guardados
           (DA-P0013/DA-P0002). Un 'expired' NO se resucita a published:
           necesita renovación, pero SÍ conserva su ad_url (es la única
           forma de encontrar el aviso viejo y renovarlo desde el panel). */
        const estadoPrevio = String(existing?.status || '');
        const conLink = !!existing?.ad_url && !!existing?.published_at;
        const degradado = ['ready', 'failed'].includes(estadoPrevio) && conLink;
        const vencido = estadoPrevio === 'expired'
          || (conLink && !!existing?.expires_at
            && new Date(String(existing.expires_at)).getTime() < Date.now());
        const yaPublicado = estadoPrevio === 'published' || degradado || vencido;
        const statusFinal = vencido ? 'expired'
          : yaPublicado ? 'published'
          : bloqueante.length ? 'failed' : 'ready';
        /* El plan de un aviso PUBLICADO (o degradado/vencido con link) es un
           dato REAL de La Voz, no una recomendación: pisarlo con
           `plan_recomendado` en un re-prepare puede borrar un plan vigente o
           inventar uno Premium que nunca se pagó. Si no hay plan guardado, se
           conserva null a propósito (no se adivina). */
        const planFinal = yaPublicado ? (existing?.plan ?? null) : payload.plan_recomendado;

        /* El bloqueante es un motivo para NO publicar, no un diagnóstico de
           un aviso VIVO: si el CRM perdió el precio pero La Voz ya lo publicó
           con el precio de entonces, marcar 'Falta el precio' en last_error
           hace creer al empleador que el aviso falló (y no es así). Los
           avisos publicados/vencidos/degradados nunca llevan last_error. */
        const patch: Record<string, unknown> = {
          property_id: p.id,
          status: statusFinal,
          payload,
          fotos_count: payload.fotos_count,
          plan: planFinal,
          last_error: yaPublicado || !bloqueante.length ? null : bloqueante.join(' | '),
        };
        if (yaPublicado) {
          patch.ad_url = existing?.ad_url ?? null;
          patch.remote_id = existing?.remote_id ?? null;
          patch.published_at = existing?.published_at ?? null;
          patch.expires_at = existing?.expires_at ?? null;
        } else {
          /* Si no está publicado, un ad_url viejo sería mentira en el panel. */
          patch.ad_url = null;
          patch.remote_id = null;
          patch.published_at = null;
          patch.expires_at = null;
        }

        const { error } = await supabase.from('lavoz_listings').upsert(patch, { onConflict: 'property_id' });
        if (error) throw error;
        results.push({
          property_id: payload.property_id,
          property_code: payload.property_code,
          titulo: payload.titulo,
          avisos: payload.avisos,
          status: patch.status,
          ad_url: patch.ad_url,
          plan: planFinal,
          published_at: patch.published_at,
          expires_at: patch.expires_at,
          payload,
          ficha: buildLavozFicha(payload),
        });
      }
      await audit(supabase, actor, 'lavoz_prepare', {
        action,
        count: results.length,
        preserved_published: results.filter((r) => r.status === 'published').length,
        preserved_expired: results.filter((r) => r.status === 'expired').length,
      });
      return jsonResponse(200, { ok: true, count: results.length, results }, req);
    }

    if (action === 'confirm') {
      if (!WRITE_ROLES.includes(actor.role)) {
        return jsonResponse(403, { error: 'Tu rol no puede confirmar publicaciones' }, req);
      }
      const propertyId = String(body.property_id || '');
      if (!propertyId) return jsonResponse(400, { error: 'Falta property_id' }, req);
      const { data: prop, error: propError } = await supabase
        .from('properties').select('id').eq('id', propertyId).maybeSingle();
      if (propError) throw propError;
      if (!prop) return jsonResponse(404, { error: 'La propiedad no existe' }, req);

      const { data: existing, error: existingError } = await supabase
        .from('lavoz_listings')
        .select('ad_url, remote_id, plan, status')
        .eq('property_id', propertyId)
        .maybeSingle();
      if (existingError) throw existingError;

      const PLANES_CONFIRM = new Set(['basico', 'estandar', 'premium', 'super_premium']);
      let adUrl: string | null;
      let dias: number;
      let plan: string | null;
      try {
        /* Un re-confirm sin URL conserva el link real ya guardado. La
           versión anterior lo pisaba con null (el asistente confirma sin URL
           cuando no captura el enlace y eso borraba la prueba de publicación). */
        adUrl = validarAdUrl(body.ad_url) || existing?.ad_url || null;
        if (body.dias !== undefined && body.dias !== null && body.dias !== '') {
          const n = Number(body.dias);
          if (n !== 10 && n !== 30) {
            throw new Error('dias debe ser 10 o 30');
          }
          dias = n;
        } else {
          const cfgDias = Number(cfg.dias_publicacion);
          dias = cfgDias === 10 ? 10 : 30;
        }
        if (body.plan !== undefined && body.plan !== null && body.plan !== '') {
          const p = String(body.plan).trim().toLowerCase();
          if (!PLANES_CONFIRM.has(p)) {
            throw new Error('plan debe ser basico, estandar, premium o super_premium');
          }
          plan = p;
        } else {
          plan = existing?.plan || null;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(400, { error: msg }, req);
      }

      const remoteId = String(body.remote_id ?? '').trim() || existing?.remote_id || null;
      const now = new Date();
      const expires = new Date(now.getTime() + dias * 86400000);
      const { error } = await supabase.from('lavoz_listings').upsert({
        property_id: propertyId,
        status: 'published',
        ad_url: adUrl,
        remote_id: remoteId,
        plan,
        published_at: now.toISOString(),
        expires_at: expires.toISOString(),
        last_error: null,
      }, { onConflict: 'property_id' });
      if (error) throw error;
      await audit(supabase, actor, 'lavoz_confirm', { property_id: propertyId, ad_url: adUrl });
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
