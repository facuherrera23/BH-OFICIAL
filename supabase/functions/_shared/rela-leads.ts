/* ============================================================
   RELA → CRM: captación de contactos/leads (código compartido)

   Dos caminos alimentan el mismo ledger y el mismo motor de leads:
   1) rela-callbacks: RELA empuja eventos CONTACTO (cuando se registren).
   2) rela-sync / rela-contacts: polling de
      GET /v1/inmobiliarias/{codigo}/mensajes?fromDate&toDate
      (documentado en el Swagger oficial api-zp.open.navent.com).

   El canal de callbacks está caído del lado de QuintoAndar (PUT
   /v1/configuracion/callbacks → 500 "Access is denied"), así que el
   polling es la red de seguridad que hace que ZonaProp SÍ traiga leads.

   Reglas duras (heredadas de rela-callbacks / ML):
   - TODA consulta entra al CRM, con o sin identidad.
   - Dedupe por identidad (email o últimos 10 dígitos del teléfono) sobre
     leads de source='rela_zonaprop', nunca sobre etapas terminales.
     Los labels del enum lead_stage son REALES: inventar uno revienta
     con 22P02 en runtime y la query vuelve data:null en silencio.
   - Dedupe de evento por UNIQUE(rela_webhook_events.event_id), con el
     prefijo 'poll:' para no colisionar con los idEvento del callback.
   - El mensaje se traza en notes; la propiedad adicional se vincula en
     lead_properties sin crear otra fila en leads.
   ============================================================ */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

type Db = SupabaseClient;

export const RELA_TERMINAL_STAGES_EXCL = '("cerrado_ganado","cerrado_perdido")';
export const RELA_ANON_NAME = 'Contacto RELA (anónimo)';
export const RELA_CONTACT_LABEL = 'Contacto Zonaprop · RELA';

export interface RelaContact {
  id?: number | string | null;
  idMensaje?: number | string | null;
  idContacto?: number | string | null;
  idAvisoNavplat?: number | string | null;
  codigoAviso?: string | null;
  nombre?: string | null;
  email?: string | null;
  telefono?: string | null;
  textoMensaje?: string | null;
  fecha?: number | string | null;
  idContactoAccion?: number | null;
  [key: string]: unknown;
}

export interface IngestResult {
  lead_id: string;
  created: boolean;
  consolidated: boolean;
}

/* Cliente mínimo para no acoplar este módulo a la implementación HTTP.
   RelaClient (../_shared/rela.ts) cumple esta interfaz. */
export interface RelaRequestClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

export async function resolveRelaProperty(
  supabase: Db,
  referencia: string | null,
  idAvisoNavplat?: number | string | null,
): Promise<{ propertyId: string | null; agentId: string | null }> {
  let propertyId: string | null = null;

  if (idAvisoNavplat != null && String(idAvisoNavplat) !== '') {
    const { data } = await supabase
      .from('rela_listings')
      .select('property_id')
      .eq('id_aviso_navplat', Number(idAvisoNavplat))
      .maybeSingle();
    propertyId = (data?.property_id as string | undefined) ?? null;
  }
  if (!propertyId && referencia) {
    const { data } = await supabase
      .from('rela_listings')
      .select('property_id')
      .eq('codigo_aviso', referencia)
      .maybeSingle();
    propertyId = (data?.property_id as string | undefined) ?? null;
  }
  /* Fallback: RELA a veces reporta la clave interna del panel
     (codigoAviso = property_code) aunque el aviso no figure en listings. */
  if (!propertyId && referencia) {
    const { data } = await supabase
      .from('properties')
      .select('id')
      .eq('property_code', referencia)
      .is('deleted_at', null)
      .maybeSingle();
    propertyId = (data?.id as string | undefined) ?? null;
  }
  if (!propertyId) return { propertyId: null, agentId: null };

  const { data: prop } = await supabase
    .from('properties')
    .select('agent_id')
    .eq('id', propertyId)
    .maybeSingle();
  return { propertyId, agentId: (prop?.agent_id as string | undefined) ?? null };
}

export async function findConsolidableRelaLead(
  supabase: Db,
  email: string | null,
  phone: string | null,
) {
  const filters: string[] = [];
  if (email) filters.push(`email.eq.${email}`);
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 10) filters.push(`phone.ilike.%${digits.slice(-10)}%`);
  if (!filters.length) return null;
  const { data, error } = await supabase
    .from('leads')
    .select('id, full_name, email, phone, whatsapp, notes, stage, property_id')
    .eq('source', 'rela_zonaprop')
    .is('deleted_at', null)
    .not('stage', 'in', RELA_TERMINAL_STAGES_EXCL)
    .or(filters.join(','))
    .order('created_at', { ascending: true }) /* el lead canónico es el primero */
    .limit(1)
    .maybeSingle();
  if (error) console.error('[rela-leads] findConsolidableRelaLead query error', error);
  return (data ?? null) as Record<string, unknown> | null;
}

async function mergeRelaEventIntoLead(
  supabase: Db,
  leadId: string,
  opts: {
    email: string | null; phone: string | null; name: string | null;
    propertyId: string | null; noteLabel: string; noteText: string; propertyContext: string;
  },
): Promise<boolean> {
  const { data: lead } = await supabase
    .from('leads')
    .select('id, full_name, email, phone, whatsapp, notes, property_id')
    .eq('id', leadId)
    .maybeSingle();
  if (!lead) return false;

  const patch: Record<string, string> = {};
  if (!lead.email && opts.email) patch.email = opts.email;
  if (!lead.phone && opts.phone) patch.phone = opts.phone;
  if (!lead.whatsapp && opts.phone) patch.whatsapp = opts.phone;
  if (String(lead.full_name || '').startsWith('Contacto RELA') && opts.name) patch.full_name = opts.name;

  const pieces: string[] = [];
  const labelLine = `[${opts.noteLabel}] ${opts.noteText || ''}`.trim();
  if (labelLine.length > opts.noteLabel.length + 2) pieces.push(labelLine);
  if (opts.propertyContext) pieces.push(opts.propertyContext.trim());
  const extra = pieces.filter(Boolean).join('\n');
  const notes = (lead.notes as string) || '';
  if (extra && !notes.includes(extra.substring(0, 60))) {
    patch.notes = notes ? notes + '\n' + extra : extra;
  }
  if (Object.keys(patch).length) {
    await supabase.from('leads').update(patch).eq('id', leadId);
  }

  if (opts.propertyId && opts.propertyId !== lead.property_id) {
    const { data: link } = await supabase
      .from('lead_properties')
      .select('lead_id, property_id')
      .eq('lead_id', leadId)
      .eq('property_id', opts.propertyId)
      .maybeSingle();
    if (!link) {
      await supabase.from('lead_properties').insert({
        lead_id: leadId,
        property_id: opts.propertyId,
        created_at: new Date().toISOString(),
      });
    }
  }
  return true;
}

/* Punto único de entrada: crea o consolida el lead a partir de un contacto.
   Equivalente al handleContact del callback, pero reutilizable por el poll. */
export async function ingestRelaContact(
  supabase: Db,
  opts: {
    nombre: string | null;
    email: string | null;
    phone: string | null;
    mensaje: string | null;
    referencia: string | null;
    idAvisoNavplat?: number | string | null;
  },
): Promise<IngestResult> {
  const email = opts.email ? String(opts.email).trim().toLowerCase() : null;
  const phone = opts.phone ? String(opts.phone).trim() : null;
  const mensaje = opts.mensaje ? String(opts.mensaje).trim() : null;
  const nombre = opts.nombre ? String(opts.nombre).trim() : '';
  const referencia = opts.referencia || null;

  const { propertyId, agentId } = await resolveRelaProperty(
    supabase, referencia, opts.idAvisoNavplat,
  );
  const propContext = referencia ? `\nAviso Zonaprop: ${referencia}` : '';

  if (nombre || email || phone) {
    const existing = await findConsolidableRelaLead(supabase, email, phone);
    if (existing) {
      const ok = await mergeRelaEventIntoLead(supabase, String(existing.id), {
        email, phone, name: nombre || null, propertyId,
        noteLabel: RELA_CONTACT_LABEL,
        noteText: mensaje || 'Interesado vía contacto de Zonaprop',
        propertyContext: propContext,
      });
      return { lead_id: String(existing.id), created: false, consolidated: ok };
    }
  }

  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      full_name: nombre || RELA_ANON_NAME,
      email,
      phone,
      whatsapp: phone || null,
      notes: `[${RELA_CONTACT_LABEL}] ${mensaje || 'Interesado vía contacto de Zonaprop'}${propContext}`,
      source: 'rela_zonaprop',
      stage: 'nuevo',
      property_id: propertyId,
      assigned_to: agentId ?? undefined,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { lead_id: String(lead.id), created: true, consolidated: false };
}

/* Formato estricto documentado: yyyyMMdd (o 'yyyyMMdd HH:mm:ss').
   Se calcula en ART (UTC-3) para que el día local coincida con el del panel. */
export function relaDateParam(date: Date): string {
  const art = new Date(date.getTime() - 3 * 3600_000);
  const y = art.getUTCFullYear();
  const m = String(art.getUTCMonth() + 1).padStart(2, '0');
  const d = String(art.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export interface PullResult {
  total: number;
  nuevos: number;
  consolidados: number;
  duplicados: number;
  errores: number;
  preview: boolean;
  dias: number;
  detalles: Array<Record<string, unknown>>;
}

/* Polling paginado + dedupe en el ledger. `preview` Consulta y clasifica
   SIN escribir: permite mostrar al dueño cuántos leads se crearían antes
   de ejecutar la importación real de los contactos históricos. */
export async function pullRelaContacts(
  supabase: Db,
  client: RelaRequestClient,
  codigoInmobiliaria: string,
  days: number,
  preview = false,
): Promise<PullResult> {
  const desde = new Date(Date.now() - Math.max(1, Math.min(365, days)) * 24 * 3600_000);
  const fromDate = relaDateParam(desde);
  const toDate = relaDateParam(new Date());
  const pageSize = 100;
  const result: PullResult = {
    total: 0, nuevos: 0, consolidados: 0, duplicados: 0,
    errores: 0, preview, dias: days, detalles: [],
  };

  for (let page = 0; page < 50; page++) {
    const q = `fromDate=${fromDate}&toDate=${toDate}&pageable.size=${pageSize}&pageable.page=${page}`;
    const resp = await client.request<{
      content?: RelaContact[]; total?: number; number?: number;
    }>('GET', `/v1/inmobiliarias/${encodeURIComponent(codigoInmobiliaria)}/mensajes?${q}`);
    const rows = Array.isArray(resp?.content) ? resp.content : [];
    if (page === 0) result.total = Number(resp?.total ?? rows.length);
    /* Guardar el contacto COMPLETO: el loop de abajo necesita telefono,
       textoMensaje, idMensaje/idContacto e idAvisoNavplat. Recortar acá a
       5 campos hacía que el dedupe por teléfono y el mensaje en notes
       llegaran siempre NULL (bug detectado antes del primer deploy). */
    for (const m of rows) result.detalles.push({ ...m });
    if (!rows.length || result.detalles.length >= result.total) break;
  }

  for (const raw of result.detalles) {
    /* El spread de arriba pierde el tipo RelaContact: lo recuperamos acá
       para que telefono/idAvisoNavplat no sean `unknown` (deno check). */
    const m = raw as RelaContact;
    /* El `id` del mensaje es la única clave estable: idMensaje es NULL en
       los contactos por WhatsApp (la mayoría). */
    const rawId = m.id ?? m.idMensaje ?? m.idContacto;
    const eventId = `poll:${rawId ?? 'sin-id'}`;
    const email = m.email ? String(m.email).trim().toLowerCase() : null;
    const phone = m.telefono ? String(m.telefono).trim() : null;

    const { data: ya } = await supabase
      .from('rela_webhook_events')
      .select('id, lead_id')
      .eq('event_id', eventId)
      .maybeSingle();
    if (ya) { result.duplicados++; continue; }

    if (preview) {
      const existing = await findConsolidableRelaLead(supabase, email, phone);
      if (existing) result.consolidados++; else result.nuevos++;
      continue;
    }

    const { data: ev, error: insErr } = await supabase
      .from('rela_webhook_events')
      .insert({
        event_id: eventId,
        tipo_evento: 'CONTACTO_POLL',
        codigo_inmobiliaria: codigoInmobiliaria,
        referencia: m.codigoAviso ? String(m.codigoAviso) : null,
        id_aviso_navplat: m.idAvisoNavplat ? Number(m.idAvisoNavplat) : null,
        payload: { ...m, origen: 'poll' },
      })
      .select('id')
      .maybeSingle();
    if (insErr) {
      if (insErr.code === '23505') { result.duplicados++; continue; }
      result.errores++;
      console.error('[rela-leads] insert evento poll', insErr);
      continue;
    }
    try {
      const r = await ingestRelaContact(supabase, {
        nombre: m.nombre ? String(m.nombre) : null,
        email,
        phone,
        mensaje: m.textoMensaje ? String(m.textoMensaje) : null,
        referencia: m.codigoAviso ? String(m.codigoAviso) : null,
        idAvisoNavplat: m.idAvisoNavplat,
      });
      if (r.created) result.nuevos++; else result.consolidados++;
      await supabase.from('rela_webhook_events').update({
        processed: true,
        processed_at: new Date().toISOString(),
        lead_id: r.lead_id,
      }).eq('id', String(ev?.id));
    } catch (err) {
      result.errores++;
      console.error('[rela-leads] ingest contacto poll', eventId, err);
      await supabase.from('rela_webhook_events').update({
        process_error: String((err as Error).message).slice(0, 1000),
      }).eq('id', String(ev?.id));
    }
  }
  return result;
}
