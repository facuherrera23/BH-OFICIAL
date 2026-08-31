// ============================================================
// rela-proxy — Edge Function autenticada (verify_jwt ON)
// Acciones de la integración Open RELA Argentina para el panel.
//  - Lectura: cualquier rol de panel activo.
//  - Escritura (publish/unpublish/config): rol super_admin.
//  - DRY_RUN: cfg.dry_run=TRUE o body.dry_run → valida y devuelve el
//    payload SIN tocar la API de RELA.
// Autocontenida (sin imports ../_shared): el deploy se hace por MCP.
// Doc: https://open-classifieds.notion.site/arg/rela/
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const WRITE_ROLES = ['super_admin'];
const RETRY_DELAYS_MS = [1000, 3000, 9000];
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

type Json = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function enc(s: string): string { return encodeURIComponent(s); }

// ---------------- Auth / roles ----------------

async function getProfile(supabase: ReturnType<typeof createClient>, req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const { data } = await supabase.auth.getUser(auth.slice(7));
  if (!data.user) return null;
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', data.user.id).maybeSingle();
  if (!profile || !profile.is_active) return null;
  return profile as { role: string };
}

async function audit(supabase: ReturnType<typeof createClient>, action: string, metadata: Json, status: 'success' | 'error' = 'success') {
  await supabase.rpc('insert_audit_log', {
    p_user_id: null, p_role_snapshot: null, p_broker_id: null,
    p_action: action, p_module: 'rela',
    p_table_name: null, p_record_id: null,
    p_entity_type: null, p_entity_id: null, p_entity_label: null,
    p_old_data: null, p_new_data: null, p_changed_fields: null,
    p_metadata: metadata, p_status: status, p_error_code: null,
    p_ip: null, p_user_agent: null, p_session_id: null, p_request_id: crypto.randomUUID(),
  }).then(({ error }: { error: unknown }) => { if (error) console.error('[audit]', error); });
}

// ---------------- RELA client ----------------

class RelaError extends Error {
  status: number; body: unknown; retryable: boolean;
  constructor(message: string, status: number, body: unknown, retryable: boolean) {
    super(message); this.status = status; this.body = body; this.retryable = retryable;
  }
}

class RelaClient {
  supabase: ReturnType<typeof createClient>;
  baseUrl: string; clientId: string; clientSecret: string;
  constructor(supabase: ReturnType<typeof createClient>, baseUrl: string, clientId: string, clientSecret: string) {
    this.supabase = supabase; this.baseUrl = baseUrl; this.clientId = clientId; this.clientSecret = clientSecret;
  }
  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const { data } = await this.supabase.from('rela_tokens').select('access_token, expires_at').eq('id', true).maybeSingle();
      if (data && new Date(data.expires_at).getTime() - 5 * 60_000 > Date.now()) return data.access_token as string;
    }
    const q = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret });
    const res = await fetch(`${this.baseUrl}/v1/application/login?${q.toString()}`, {
      method: 'POST', headers: { 'User-Agent': 'BienenhausCRM/1.0 (contacto@bienenhaus.com.ar)' },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) {
      throw new RelaError(`RELA login falló (${res.status})`, res.status, body, RETRYABLE_STATUSES.has(res.status));
    }
    const expiresAt = new Date(Date.now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) : 86400) * 1000);
    await this.supabase.from('rela_tokens').upsert({ id: true, access_token: body.access_token, expires_at: expiresAt.toISOString(), obtained_at: new Date().toISOString() });
    await this.supabase.from('rela_config').update({ last_auth_at: new Date().toISOString(), last_error: null }).eq('id', true);
    return body.access_token as string;
  }
  async request<T = unknown>(method: string, path: string, body?: unknown, attempt = 0, refreshed = false): Promise<T> {
    const token = await this.getToken(refreshed);
    const startedAt = Date.now();

    // Sandbox AR: los endpoints bajo /v1/inmobiliarias/{codigo}/… rechazan el
    // Bearer header (invalid_token); hay que enviar también ?access_token=.
    const sep = path.includes('?') ? '&' : '?';
    const url = path.startsWith('/v1/inmobiliarias/')
      ? `${this.baseUrl}${path}${sep}access_token=${encodeURIComponent(token)}`
      : `${this.baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'BienenhausCRM/1.0 (contacto@bienenhaus.com.ar)' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); return this.request(method, path, body, attempt + 1, refreshed); }
      throw new RelaError(`RELA red: ${(err as Error).message}`, 0, null, true);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    console.log(JSON.stringify({ module: 'rela', action: 'api_call', method, path, status: res.status, durationMs: Date.now() - startedAt, attempt }));
    if (res.status === 401 && !refreshed) return this.request(method, path, body, attempt, true);
    if (!res.ok) {
      const retryable = RETRYABLE_STATUSES.has(res.status);
      if (retryable && attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); return this.request(method, path, body, attempt + 1, refreshed); }
      throw new RelaError(`RELA ${method} ${path} → ${res.status}`, res.status, parsed, retryable);
    }
    return parsed as T;
  }
}

// ---------------- Mapper BH → RELA (copia de _shared/rela.mapper.ts) ----------------

interface BhProperty {
  id: string; property_code: string | null; title: string | null; description: string | null;
  property_type: string | null; status: string | null; zone: string | null; address: string | null;
  price_usd: number | null; price_currency: string | null; area_m2: number | null;
  surface_covered: number | null; surface_total: number | null; rooms: number | null;
  bedrooms: number | null; bathrooms: number | null; garage_spaces: number | null;
  year_built: number | null; image_urls: string[] | null; video_url: string | null;
}
interface RelaCfg {
  codigoInmobiliaria?: string; plan?: string; contactoNombre?: string; contactoEmail?: string; contactoTelefono?: string;
  catalogMapping?: Record<string, string>;
  tipoPropiedadMap?: Record<string, { idTipo: string; idSubtipo?: string; idSubTipo?: string }>;
  ubicacionMap?: Record<string, string>;
}

function normalizeZone(zone: string): string {
  return zone.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}
function isHttpUrl(u: string): boolean { return /^https?:\/\//i.test(u); }

function makeCodigoAviso(p: BhProperty): string {
  const base = (p.property_code && p.property_code.trim()) || `BH-${p.id.slice(0, 8)}`;
  return base.replace(/\s+/g, '-').slice(0, 60);
}

function validateForRela(p: BhProperty, cfg: RelaCfg): string[] {
  const errors: string[] = [];
  if (!cfg.codigoInmobiliaria) errors.push('Falta configurar el código de inmobiliaria de RELA (Portales → RELA).');
  if (!cfg.plan) errors.push('Falta configurar el plan de publicación RELA (tipoDePublicacion).');
  if (!p.title || !p.title.trim()) errors.push('No se puede publicar en RELA: falta el título de la propiedad.');
  else if (p.title.length > 80) errors.push('El título supera los 80 caracteres que acepta RELA (se truncaría).');
  if (!p.description || p.description.trim().length < 50) errors.push('No se puede publicar en RELA: la descripción debe tener al menos 50 caracteres.');
  const typeEntry = p.property_type ? cfg.tipoPropiedadMap?.[p.property_type] : undefined;
  if (!typeEntry?.idTipo) errors.push(`No hay mapeo RELA para el tipo de propiedad "${p.property_type || 'sin definir'}". Cargá el mapeo en Portales → RELA (catálogos).`);
  const ubId = p.zone ? cfg.ubicacionMap?.[normalizeZone(p.zone)] : undefined;
  if (!ubId) errors.push(`No hay idUbicacion RELA para la zona "${p.zone || 'sin definir'}". Sincronizá el catálogo de ubicaciones y mapeala en Portales → RELA.`);
  if (p.status !== 'venta' && p.status !== 'alquiler') errors.push(`La propiedad está en estado "${p.status || 'sin estado'}"; sólo se publican 'venta' o 'alquiler'.`);
  if (!p.price_usd || p.price_usd <= 0) errors.push('No se puede publicar en RELA: falta el precio o es 0 (WARN-0210 prohíbe precio 0).');
  if (!p.price_currency || !['USD', 'ARS'].includes(p.price_currency)) errors.push('Moneda no soportada: debe ser USD o ARS.');
  if (!p.surface_covered && !p.surface_total && !p.area_m2) errors.push('No se puede publicar en RELA: falta superficie (cubierta o total).');
  if ((p.image_urls || []).filter(isHttpUrl).length === 0) errors.push('No se puede publicar en RELA: no hay fotos con URL pública (http/https).');
  return errors;
}

function mapPropertyToRela(p: BhProperty, cfg: RelaCfg) {
  const typeEntry = cfg.tipoPropiedadMap![p.property_type as string];
  const ubId = cfg.ubicacionMap![normalizeZone(p.zone as string)];
  const cm = cfg.catalogMapping || {};
  const caracteristicas: Array<{ id: string; valor: string }> = [];
  const covered = p.surface_covered ?? p.area_m2 ?? null;
  const total = (p.surface_total && p.surface_total > 0) ? p.surface_total : covered;
  const addChar = (key: string, value: number | null) => {
    const id = cm[key];
    if (id && value !== null && value !== undefined && value > 0) caracteristicas.push({ id, valor: String(value) });
  };
  addChar('SUPERFICIE_TOTAL', total);
  addChar('SUPERFICIE_CUBIERTA', covered);
  addChar('AMBIENTES', p.rooms);
  addChar('DORMITORIOS', p.bedrooms);
  addChar('BANOS', p.bathrooms);
  addChar('GARAGE', p.garage_spaces);
  const imagenes = (p.image_urls || []).filter(isHttpUrl).slice(0, 50).map((url) => ({ urlImagenOriginal: url }));
  return {
    codigoAviso: makeCodigoAviso(p),
    publicador: {
      codigoInmobiliaria: cfg.codigoInmobiliaria as string,
      nombreDeContacto: cfg.contactoNombre || undefined,
      emailDeContacto: cfg.contactoEmail || undefined,
      telefonoDeContacto: cfg.contactoTelefono || undefined,
    },
    publicacion: { tipoDePublicacion: cfg.plan as string },
    titulo: (p.title as string).slice(0, 80),
    descripcion: p.description as string,
    tipoDePropiedad: (typeEntry.idSubTipo || typeEntry.idSubtipo)
      ? { idTipo: typeEntry.idTipo, idSubTipo: (typeEntry.idSubTipo ?? typeEntry.idSubtipo) as string }
      : { idTipo: typeEntry.idTipo },
    localizacion: { idUbicacion: ubId, direccion: p.address || undefined, muestraMapa: 'NO_MOSTRAR' },
    precios: [{ operacion: p.status === 'alquiler' ? 'ALQUILER' : 'VENTA', monto: String(p.price_usd), moneda: p.price_currency as string }],
    caracteristicas,
    multimedia: imagenes.length ? { imagenes } : {},
    claveReferencia: p.property_code || undefined,
  };
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
function hashPayload(payload: unknown): string {
  const str = stableStringify(payload);
  let h1 = 5381; let h2 = 52711;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 31) ^ c; }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0');
}

// ---------------- Config / data loaders ----------------

async function loadConfig(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.from('rela_config').select('*').eq('id', true).single();
  if (error) throw new Error('rela_config no disponible: ' + error.message);
  const mapped: RelaCfg = {
    codigoInmobiliaria: data.codigo_inmobiliaria || undefined,
    plan: data.plan_default || undefined,
    contactoNombre: data.contacto_nombre || undefined,
    contactoEmail: data.contacto_email || undefined,
    contactoTelefono: data.contacto_telefono || undefined,
    catalogMapping: data.catalog_mapping || {},
    tipoPropiedadMap: data.tipo_propiedad_map || {},
    ubicacionMap: data.ubicacion_map || {},
  };
  return { row: data, mapped };
}

async function loadProperty(supabase: ReturnType<typeof createClient>, propertyId: string): Promise<BhProperty> {
  const { data, error } = await supabase
    .from('properties')
    .select('id, property_code, title, description, property_type, status, zone, address, price_usd, price_currency, area_m2, surface_covered, surface_total, rooms, bedrooms, bathrooms, garage_spaces, year_built, image_urls, video_url')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .single();
  if (error || !data) throw new Error('Propiedad no encontrada');
  return data as BhProperty;
}

function makeClient(supabase: ReturnType<typeof createClient>, cfgRow: Record<string, unknown>): RelaClient {
  const clientId = Deno.env.get('RELA_CLIENT_ID');
  const clientSecret = Deno.env.get('RELA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new RelaError('Faltan credenciales RELA (RELA_CLIENT_ID / RELA_CLIENT_SECRET)', 500, null, false);
  const baseUrl = (cfgRow.base_url as string) || Deno.env.get('RELA_BASE_URL') || 'https://api-zp-sandbox-open.navent.com';
  return new RelaClient(supabase, baseUrl, clientId, clientSecret);
}

// ---------------- Handler ----------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const correlationId = crypto.randomUUID();

  try {
    const profile = await getProfile(supabase, req);
    if (!profile) return json({ error: 'No autorizado' }, 401);

    let body: Json = {};
    if (req.method === 'POST') body = (await req.json().catch(() => ({}))) as Json;
    else body = Object.fromEntries(new URL(req.url).searchParams.entries());
    const action = String(body.action || '');
    const { row: cfgRow, mapped: cfg } = await loadConfig(supabase);

    if (action === 'status') {
      const { data } = await supabase.rpc('rela_portal_status');
      return json({ ok: true, status: data, credentials_configured: !!(Deno.env.get('RELA_CLIENT_ID') && Deno.env.get('RELA_CLIENT_SECRET')) });
    }
    if (action === 'config_get') return json({ ok: true, config: cfgRow });
    if (action === 'catalogs_list') {
      const { data } = await supabase.from('rela_catalog_cache').select('catalog, fetched_at');
      return json({ ok: true, catalogs: data || [] });
    }
    if (action === 'catalogs_get') {
      const name = String(body.catalog || '');
      if (!name) return json({ error: 'Falta catalog' }, 400);
      const { data } = await supabase.from('rela_catalog_cache').select('payload, fetched_at').eq('catalog', name).maybeSingle();
      return json({ ok: true, catalog: name, data: data?.payload ?? null, fetched_at: data?.fetched_at ?? null });
    }
    if (action === 'listing_get') {
      const propertyId = String(body.property_id || '');
      const { data } = await supabase.from('rela_listings').select('*').eq('property_id', propertyId).maybeSingle();
      return json({ ok: true, listing: data });
    }
    if (action === 'events_list') {
      const { data } = await supabase.from('rela_webhook_events')
        .select('id, event_id, tipo_evento, referencia, processed, process_error, lead_id, received_at')
        .order('received_at', { ascending: false }).limit(50);
      return json({ ok: true, events: data || [] });
    }

    if (action === 'dry_run' || action === 'publish' || action === 'update') {
      if (action !== 'dry_run' && !WRITE_ROLES.includes(profile.role)) return json({ error: 'Tu rol no permite publicar en RELA' }, 403);
      const propertyId = String(body.property_id || '');
      if (!propertyId) return json({ error: 'Falta property_id' }, 400);

      const property = await loadProperty(supabase, propertyId);
      const errors = validateForRela(property, cfg);
      if (errors.length) {
        await supabase.from('rela_listings').upsert({
          property_id: propertyId, codigo_aviso: makeCodigoAviso(property),
          status: 'BLOCKED', last_error: errors.join(' | '), last_sync_at: new Date().toISOString(),
        }, { onConflict: 'property_id' });
        return json({ ok: false, blocked: true, errors }, 200);
      }

      const payload = mapPropertyToRela(property, cfg);
      const payloadHash = hashPayload(payload);
      const { data: existing } = await supabase.from('rela_listings').select('*').eq('property_id', propertyId).maybeSingle();

      if (action === 'dry_run' || body.dry_run === true || cfgRow.dry_run) {
        return json({ ok: true, dry_run: true, codigo_aviso: payload.codigoAviso, payload, payload_hash: payloadHash, would_be: existing ? 'update' : 'create', note: 'DRY_RUN activo: no se envió nada a RELA.' });
      }

      if (action === 'update' && existing?.status === 'PUBLISHED' && existing?.payload_hash === payloadHash) {
        return json({ ok: true, skipped: true, reason: 'Sin cambios (payload hash idéntico)' });
      }

      const client = makeClient(supabase, cfgRow);

      if (!existing || existing.status === 'PENDING' || action === 'publish') {
        const disp = (await client.request('GET', `/v1/inmobiliarias/${enc(cfgRow.codigo_inmobiliaria)}/disponibilidad`)) as { disponibles?: Array<{ planDePublicacion: string; cantidadDisponible: number }> } | null;
        const plan = (disp?.disponibles || []).find((d) => d.planDePublicacion === cfg.plan);
        if (plan && Number(plan.cantidadDisponible) <= 0) {
          throw new RelaError(`Sin créditos RELA para el plan ${cfg.plan} (ERR-0502)`, 422, disp, false);
        }
      }

      await supabase.from('rela_listings').upsert({
        property_id: propertyId, codigo_aviso: payload.codigoAviso,
        status: action === 'publish' ? 'SYNCING' : 'UPDATING',
        plan: cfg.plan, payload_hash: payloadHash, last_sync_at: new Date().toISOString(),
      }, { onConflict: 'property_id' });

      try {
        const resp = (await client.request('PUT', `/v1/inmobiliarias/${enc(cfgRow.codigo_inmobiliaria)}/avisos/${enc(payload.codigoAviso)}`, payload)) as Record<string, unknown> | Array<Record<string, unknown>>;
        const arr = (Array.isArray(resp) ? resp[0] : resp) as Record<string, unknown> | undefined;
        const relaErrors = (arr?.errors as unknown[]) || [];
        const warnings = (arr?.warnings as unknown[]) || [];
        const remoteStatus = (arr?.estado as string) || null;
        const idAviso = (arr?.idAviso as number) ?? null;
        const failed = relaErrors.length > 0 || arr?.error === true;
        const published = !failed && remoteStatus === 'ONLINE';

        const update: Json = {
          status: failed ? 'ERROR' : published ? 'PUBLISHED' : 'UPDATE_PENDING',
          remote_status: remoteStatus, id_aviso_navplat: idAviso, last_warnings: warnings,
          last_error: failed ? (relaErrors as Array<{ messageCode?: string; messageText?: string }>).map((e) => `${e.messageCode}: ${e.messageText}`).join(' | ') : null,
          last_sync_at: new Date().toISOString(), remote_snapshot: arr,
        };
        if (published && !existing?.published_at) update.published_at = new Date().toISOString();
        await supabase.from('rela_listings').update(update).eq('property_id', propertyId);

        await audit(supabase, action === 'publish' ? 'rela_publish' : 'rela_update', {
          property_id: propertyId, codigo_aviso: payload.codigoAviso,
          outcome: failed ? 'error' : remoteStatus, warnings: warnings.length, correlationId,
        }, failed ? 'error' : 'success');

        return json({ ok: !failed, codigo_aviso: payload.codigoAviso, remote_status: remoteStatus, id_aviso: idAviso, errors: relaErrors, warnings }, failed ? 422 : 200);
      } catch (err) {
        const message = err instanceof RelaError ? err.message : (err as Error).message;
        await supabase.from('rela_listings').update({ status: 'ERROR', last_error: message, last_sync_at: new Date().toISOString() }).eq('property_id', propertyId);
        await audit(supabase, `rela_${action}_error`, { property_id: propertyId, error: message, correlationId }, 'error');
        return json({ ok: false, error: message }, err instanceof RelaError && err.status ? err.status : 502);
      }
    }

    if (action === 'unpublish') {
      if (!WRITE_ROLES.includes(profile.role)) return json({ error: 'Tu rol no permite despublicar en RELA' }, 403);
      const propertyId = String(body.property_id || '');
      const { data: listing } = await supabase.from('rela_listings').select('*').eq('property_id', propertyId).maybeSingle();
      if (!listing) return json({ ok: true, skipped: true, reason: 'La propiedad no tiene aviso en RELA' });

      if (cfgRow.dry_run || body.dry_run === true) {
        return json({ ok: true, dry_run: true, note: 'DRY_RUN: no se dio de baja el aviso', codigo_aviso: listing.codigo_aviso });
      }

      const client = makeClient(supabase, cfgRow);
      try {
        const resp = (await client.request('DELETE', `/v1/inmobiliarias/${enc(cfgRow.codigo_inmobiliaria)}/avisos/${enc(listing.codigo_aviso)}`)) as Record<string, unknown>[] | Record<string, unknown>;
        const arr = (Array.isArray(resp) ? resp[0] : resp) as Record<string, unknown> | undefined;
        const relaErrors = (arr?.errors as unknown[]) || [];
        const failed = relaErrors.length > 0 || arr?.error === true;
        const remoteStatus = (arr?.estado as string) || null;

        await supabase.from('rela_listings').update({
          status: failed ? 'ERROR' : 'UNPUBLISHED',
          remote_status: remoteStatus,
          unpublished_at: failed ? null : new Date().toISOString(),
          last_error: failed ? (relaErrors as Array<{ messageCode?: string; messageText?: string }>).map((e) => `${e.messageCode}: ${e.messageText}`).join(' | ') : null,
          last_sync_at: new Date().toISOString(),
        }).eq('property_id', propertyId);

        await audit(supabase, 'rela_unpublish', { property_id: propertyId, codigo_aviso: listing.codigo_aviso, outcome: failed ? 'error' : remoteStatus, correlationId }, failed ? 'error' : 'success');
        return json({ ok: !failed, remote_status: remoteStatus, errors: relaErrors }, failed ? 422 : 200);
      } catch (err) {
        const message = err instanceof RelaError ? err.message : (err as Error).message;
        await supabase.from('rela_listings').update({ status: 'ERROR', last_error: message }).eq('property_id', propertyId);
        await audit(supabase, 'rela_unpublish_error', { property_id: propertyId, error: message, correlationId }, 'error');
        return json({ ok: false, error: message }, err instanceof RelaError && err.status ? err.status : 502);
      }
    }

    if (action === 'reconcile' || action === 'sync_state') {
      if (!WRITE_ROLES.includes(profile.role)) return json({ error: 'Sin permiso' }, 403);
      const client = makeClient(supabase, cfgRow);
      const { data: listings } = await supabase.from('rela_listings').select('id, property_id, codigo_aviso, status').in('status', ['PUBLISHED', 'UPDATE_PENDING', 'ERROR', 'SYNCING']);
      const results: Json[] = [];
      for (const l of listings || []) {
        try {
          const aviso = (await client.request('GET', `/v1/inmobiliarias/${enc(cfgRow.codigo_inmobiliaria)}/avisos/${enc(l.codigo_aviso)}`)) as Record<string, unknown>;
          await supabase.from('rela_listings').update({
            remote_status: (aviso?.estado as string) ?? null,
            remote_snapshot: aviso,
            last_sync_at: new Date().toISOString(),
            status: aviso?.estado === 'ONLINE' ? 'PUBLISHED' : aviso?.estado === 'OFFLINE' ? 'UNPUBLISHED' : l.status,
          }).eq('id', l.id);
          results.push({ codigo_aviso: l.codigo_aviso, remote_status: aviso?.estado });
        } catch (err) {
          results.push({ codigo_aviso: l.codigo_aviso, error: (err as Error).message });
        }
      }
      await supabase.from('rela_config').update({ last_sync_at: new Date().toISOString() }).eq('id', true);
      return json({ ok: true, reconciled: results });
    }

    if (action === 'stock') {
      const client = makeClient(supabase, cfgRow);
      const data = await client.request('GET', `/v1/inmobiliarias/${enc(cfgRow.codigo_inmobiliaria)}/disponibilidad`);
      return json({ ok: true, stock: data });
    }

    if (action === 'catalogs_sync') {
      if (!WRITE_ROLES.includes(profile.role)) return json({ error: 'Sin permiso' }, 403);
      const client = makeClient(supabase, cfgRow);
      const endpoints: Array<[string, string]> = [
        ['ubicaciones_root', '/v1/ubicaciones'],
        ['tipopropiedades', '/v1/tipopropiedades'],
        ['planes', '/v1/publicacion/planes'],
        ['operaciones', '/v1/operaciones'],
        ['monedas', '/v1/monedas'],
      ];
      const synced: string[] = [];
      const failed: Record<string, string> = {};
      for (const [name, path] of endpoints) {
        try {
          const payload = await client.request('GET', path);
          await supabase.from('rela_catalog_cache').upsert({ catalog: name, payload, fetched_at: new Date().toISOString() });
          synced.push(name);
        } catch (err) { failed[name] = (err as Error).message; }
      }
      await audit(supabase, 'rela_catalogs_sync', { synced, failedCount: Object.keys(failed).length, correlationId }, Object.keys(failed).length ? 'error' : 'success');
      return json({ ok: Object.keys(failed).length === 0, synced, failed });
    }

    if (action === 'catalog_ubication_children') {
      const parentId = String(body.parent_id || '');
      const client = makeClient(supabase, cfgRow);
      const key = parentId ? `ubicaciones:${parentId}` : 'ubicaciones_root';
      const { data: cached } = await supabase.from('rela_catalog_cache').select('payload, fetched_at').eq('catalog', key).maybeSingle();
      if (cached && Date.now() - new Date(cached.fetched_at as string).getTime() < 24 * 3600_000) {
        return json({ ok: true, cached: true, data: cached.payload });
      }
      const payload = await client.request('GET', parentId ? `/v1/ubicaciones/${enc(parentId)}` : '/v1/ubicaciones');
      await supabase.from('rela_catalog_cache').upsert({ catalog: key, payload, fetched_at: new Date().toISOString() });
      return json({ ok: true, cached: false, data: payload });
    }

    if (action === 'callbacks_config_get') {
      const client = makeClient(supabase, cfgRow);
      return json({ ok: true, callbacks: await client.request('GET', '/v1/configuracion/callbacks') });
    }

    if (action === 'callbacks_config_set') {
      if (!WRITE_ROLES.includes(profile.role)) return json({ error: 'Sin permiso' }, 403);
      const url = String(body.url || `${SUPABASE_URL}/functions/v1/rela-callbacks`);
      if (!/^https:\/\//.test(url)) return json({ error: 'La URL del callback debe ser https' }, 400);
      const client = makeClient(supabase, cfgRow);
      await client.request('PUT', '/v1/configuracion/callbacks', {
        url,
        authorizationHeaderKey: 'Authorization',
        authorizationHeaderValue: `Bearer ${Deno.env.get('RELA_CALLBACK_SECRET') ?? ''}`,
        lenguajeCallbackBody: 'ES',
      });
      await supabase.from('rela_config').update({ callbacks_enabled: true }).eq('id', true);
      return json({ ok: true, url });
    }

    if (action === 'asociar_aviso') {
      if (!WRITE_ROLES.includes(profile.role)) return json({ error: 'Sin permiso' }, 403);
      const codigoAviso = String(body.codigo_aviso || '');
      const idAviso = String(body.id_aviso || '');
      if (!codigoAviso || !idAviso) return json({ error: 'Faltan codigo_aviso e id_aviso' }, 400);
      const client = makeClient(supabase, cfgRow);
      const resp = await client.request('PUT', `/v1/inmobiliarias/${enc(cfgRow.codigo_inmobiliaria)}/avisos/${enc(codigoAviso)}/asociar/${enc(idAviso)}`);
      await audit(supabase, 'rela_asociar_aviso', { codigo_aviso: codigoAviso, id_aviso: idAviso, correlationId });
      return json({ ok: true, respuesta: resp });
    }

    return json({ error: `Acción desconocida: ${action}` }, 400);
  } catch (err) {
    console.error('[rela-proxy]', correlationId, err);
    const status = err instanceof RelaError && err.status ? err.status : 500;
    return json({ ok: false, error: (err as Error).message, correlationId }, status >= 400 && status < 600 ? status : 500);
  }
});

