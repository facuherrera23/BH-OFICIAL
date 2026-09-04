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

async function handleContact(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  eventRowId: string,
): Promise<void> {
  const referencia = String(body.referencia ?? body.reference ?? '');

  let propertyId: string | null = null;
  if (referencia) {
    const { data: listing } = await supabase
      .from('rela_listings')
      .select('property_id')
      .eq('codigo_aviso', referencia)
      .maybeSingle();
    propertyId = listing?.property_id ?? null;
    if (!propertyId) {
      // Fallback: RELA reporta la clave interna del panel (codigoAviso = property_code)
      // incluso si el aviso aún no figura en rela_listings.
      const { data: prop } = await supabase
        .from('properties')
        .select('id')
        .eq('property_code', referencia)
        .is('deleted_at', null)
        .maybeSingle();
      propertyId = prop?.id ?? null;
    }
  }

  const nombre = String(body.nombre ?? body.name ?? '').trim() || 'Contacto RELA';
  const mensaje = String(body.mensaje ?? body.Mensaje ?? '').trim() || null;

  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      full_name: nombre,
      email: String(body.email ?? '').trim() || null,
      phone: String(body.telefono ?? body.phone ?? '').trim() || null,
      notes: mensaje,
      source: 'rela_zonaprop',
      stage: 'nuevo',
      property_id: propertyId,
    })
    .select('id')
    .single();

  if (error) throw error;
  await supabase.from('rela_webhook_events').update({ lead_id: lead.id }).eq('id', eventRowId);
}
