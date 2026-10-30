// ============================================================
// rela-callbacks — Receptor de callbacks Open RELA (verify_jwt OFF)
// Doc: sección "5. Callbacks" de https://open-classifieds.notion.site/arg/rela/
//  - RELA envía POST con body JSON y header Authorization (o el key
//    configurado) con el valor autorizado por PUT /v1/configuracion/callbacks.
//  - RELA acepta cualquier 2xx/3xx; reintenta por 72hs ante error/timeout.
//  - Respondemos SIEMPRE rápido (el procesamiento pesado es barato aquí:
//    inserts idempotentes; si falla, el evento queda con processed=false
//    y se reprocesa desde el panel, no desde RELA).
// Idempotencia: dedupe exacto por idEvento (UNIQUE en rela_webhook_events).
// Dedup de leads (2026-10-29, patrón ML): la misma persona no crea leads
// duplicados — se consolida en el lead existente (fields vacíos rellenan,
// propiedad extra queda en lead_properties, mensaje trazado en notes).
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const CALLBACK_SECRET = Deno.env.get('RELA_CALLBACK_SECRET') ?? '';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Rate limit compartido (_shared/rate-limit.ts): misma key y mismo límite (120/min)
  // que el limiter local que reemplaza. Cambio intencional: ante error de DB ahora
  // es fail-closed (429); es seguro porque RELA reintenta callbacks por 72hs.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = await checkRateLimit('rela-callbacks', ip);
  if (!rl.allowed) return json({ error: 'rate_limited', retry_after: rl.retryAfter ?? 60 }, 429);

  // Autenticación: RELA envía el valor configurado en Authorization (doc 5).
  if (!CALLBACK_SECRET) {
    console.error('[rela-callbacks] RELA_CALLBACK_SECRET no configurado');
    return json({ error: 'callback no configurado' }, 503);
  }
  const received = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${CALLBACK_SECRET}`;
  if (!timingSafeEqual(received, expected)) {
    return json({ error: 'no autorizado' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }

  const eventId = String(body.idEvento ?? body.eventId ?? '');
  const tipoEvento = String(body.tipoEvento ?? body.eventType ?? '');
  if (!eventId || !tipoEvento) return json({ error: 'payload incompleto: faltan idEvento/tipoEvento' }, 400);

  // Dedupe exacto: INSERT; si viola UNIQUE(event_id) → ya procesado / en proceso
  const { data: inserted, error: insErr } = await supabase
    .from('rela_webhook_events')
    .insert({
      event_id: eventId,
      tipo_evento: tipoEvento,
      codigo_inmobiliaria: body.codigoInmobiliaria ?? null,
      referencia: body.referencia ?? body.reference ?? null,
      id_aviso_navplat: body.idNavplat ?? null,
      payload: body,
    })
    .select('id')
    .maybeSingle();

  if (insErr) {
    if (insErr.code === '23505') return json({ ok: true, deduplicated: true });
    console.error('[rela-callbacks] insert error', insErr);
    return json({ error: 'error interno' }, 500);
  }

  const eventRowId = inserted?.id as string;

  try {
    await processEvent(supabase, body, eventRowId);
    await supabase
      .from('rela_webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('id', eventRowId);
  } catch (err) {
    console.error('[rela-callbacks] process error', eventId, err);
    await supabase
      .from('rela_webhook_events')
      .update({ process_error: (err as Error).message?.slice(0, 1000) })
      .eq('id', eventRowId);
    // Respondemos 200 igual: el evento quedó persistido y se reprocesa internamente.
    // Devolver 5xx haría que RELA reintente y duplique trabajo.
  }

  return json({ ok: true });
});

async function processEvent(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  eventRowId: string,
): Promise<void> {
  const tipoEvento = String(body.tipoEvento ?? body.eventType ?? '');

  if (tipoEvento === 'CONTACTO' || tipoEvento === 'CONTACTO_MENSAJE') {
    await handleContact(supabase, body, eventRowId);
    return;
  }

  if (tipoEvento === 'AVISO_ESTADO_PUBLICACION' || tipoEvento === 'AVISO_ACTIVIDAD') {
    const referencia = String(body.referencia ?? body.codigoAviso ?? '');
    if (!referencia) return;
    const remoteStatus = tipoEvento === 'AVISO_ESTADO_PUBLICACION' ? String(body.estado ?? '') : null;
    await supabase
      .from('rela_listings')
      .update({
        last_sync_at: new Date().toISOString(),
        ...(remoteStatus ? { remote_status: remoteStatus } : {}),
      })
      .eq('codigo_aviso', referencia);
    return;
  }

  if (tipoEvento === 'AVISO_CALIDAD') {
    const referencia = String(body.referencia ?? body.codigoAviso ?? '');
    if (!referencia) return;
    const pct = Number(body.porcentajeCalidad ?? body.qualityPercentage ?? NaN);
    const status = String(body.status ?? '');
    const note = `Calidad RELA: ${Number.isNaN(pct) ? '—' : pct + '%'} (${status})`;
    await supabase
      .from('rela_listings')
      .update({ last_error: status === 'ERROR' ? note : null, last_warnings: { calidad: { pct, status } }, last_sync_at: new Date().toISOString() })
      .eq('codigo_aviso', referencia);
    return;
  }

  // CREDITO y desconocidos: sólo se persisten (se analizan desde el panel).
}

/* ---------------- Dedup de leads (patrón ML, portado 2026-10-29) ----------------
   La misma persona puede escribir varias veces (o por varias propiedades):
   queda en UN solo lead de source='rela_zonaprop'. La consolidación rellena
   campos vacíos, vincula la propiedad adicional vía lead_properties y traza
   cada mensaje en notes (anti-duplicado por subcadena). Nunca consolida sobre
   leads terminales (cerrado/perdido/vendido/descartado). */
const RELA_TERMINAL_STAGES_EXCL = '("cerrado_perdido","cerrado_vendido","vendido","descartado")';
const RELA_ANON_NAME = 'Contacto RELA (anónimo)';

async function findConsolidableRelaLead(
  supabase: ReturnType<typeof createClient>,
  email: string | null,
  phone: string | null,
) {
  const filters: string[] = [];
  if (email) filters.push(`email.eq.${email}`);
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 10) filters.push(`phone.ilike.%${digits.slice(-10)}%`);
  if (!filters.length) return null;
  const { data } = await supabase
    .from('leads')
    .select('id, full_name, email, phone, whatsapp, notes, stage, property_id')
    .eq('source', 'rela_zonaprop')
    .is('deleted_at', null)
    .not('stage', 'in', RELA_TERMINAL_STAGES_EXCL)
    .or(filters.join(','))
    .order('created_at', { ascending: true }) /* el lead canónico es el primero */
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function mergeRelaEventIntoLead(
  supabase: ReturnType<typeof createClient>,
  leadId: string,
  opts: {
    email: string | null; phone: string | null; name: string | null;
    propertyId: string | null; noteLabel: string; noteText: string; propertyContext: string;
  },
) {
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
  if ((lead.full_name || '').startsWith('Contacto RELA') && opts.name) patch.full_name = opts.name;

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

  /* Propiedad adicional: la misma persona contactó otra publicación — queda
     vinculada al MISMO lead (no se crea otra fila en la tabla leads). */
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

async function handleContact(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  eventRowId: string,
): Promise<void> {
  const referencia = String(body.referencia ?? body.reference ?? '');

  let propertyId: string | null = null;
  let agentId: string | null = null;
  if (referencia) {
    const { data: listing } = await supabase
      .from('rela_listings')
      .select('property_id')
      .eq('codigo_aviso', referencia)
      .maybeSingle();
    propertyId = listing?.property_id ?? null;
    if (propertyId) {
      const { data: prop } = await supabase
        .from('properties')
        .select('agent_id')
        .eq('id', propertyId)
        .maybeSingle();
      agentId = (prop?.agent_id as string | undefined) ?? null;
    } else {
      // Fallback: RELA reporta la clave interna del panel (codigoAviso = property_code)
      // incluso si el aviso aún no figura en rela_listings.
      const { data: prop } = await supabase
        .from('properties')
        .select('id, agent_id')
        .eq('property_code', referencia)
        .is('deleted_at', null)
        .maybeSingle();
      propertyId = prop?.id ?? null;
      agentId = (prop?.agent_id as string | undefined) ?? null;
    }
  }

  const email = String(body.email ?? body.mail ?? '').trim().toLowerCase() || null;
  const phone = String(body.telefono ?? body.phone ?? body.celular ?? '').trim() || null;
  const mensaje = String(body.mensaje ?? body.message ?? body.comentarios ?? '').trim() || null;
  const nombre = String(body.nombre ?? body.name ?? '').trim() || '';
  const hasIdentity = !!(nombre || email || phone);
  const contactLabel = 'Contacto Zonaprop · RELA';
  const propContext = referencia ? `\nAviso Zonaprop: ${referencia}` : '';

  /* Regla del dueño (igual que ML 2026-10-26): toda consulta entra al CRM.
     Con identidad, se consolida en el lead existente de esa persona (nunca
     duplica); sin identidad, la fila queda como anónima para trabajarla. */
  if (hasIdentity) {
    const existing = await findConsolidableRelaLead(supabase, email, phone);
    if (existing) {
      await mergeRelaEventIntoLead(supabase, existing.id, {
        email,
        phone,
        name: nombre || null,
        propertyId,
        noteLabel: contactLabel,
        noteText: mensaje || 'Interesado vía contacto de Zonaprop',
        propertyContext: propContext,
      });
      await supabase.from('rela_webhook_events').update({ lead_id: existing.id }).eq('id', eventRowId);
      return;
    }
  }

  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      full_name: nombre || RELA_ANON_NAME,
      email,
      phone,
      notes: `[${contactLabel}] ${mensaje || 'Interesado vía contacto de Zonaprop'}${propContext}`,
      source: 'rela_zonaprop',
      stage: 'nuevo',
      property_id: propertyId,
      assigned_to: agentId ?? undefined,
    })
    .select('id')
    .single();

  if (error) throw error;
  await supabase.from('rela_webhook_events').update({ lead_id: lead.id }).eq('id', eventRowId);
}
