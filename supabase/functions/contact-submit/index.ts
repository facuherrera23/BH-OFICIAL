// ============================================================
// contact-submit — Único punto de entrada de leads públicos.
// Reemplaza al insert anónimo directo a `leads` (política revocada
// en la migración leads_crm_revamp_rls_scoring_notify).
// Defensas: rate limit por IP (5/h), honeypot, validación estricta,
// dedup por email o últimos 8 dígitos de teléfono (60 días).
// La notificación a admins sale del trigger DB -> notify-new-lead.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

type TipoCliente = 'propietario' | 'comprador' | 'inquilino' | 'inversor';
type OperationType = 'compra' | 'venta' | 'alquiler';
type PropertyType = 'casa' | 'departamento' | 'terreno' | 'local' | 'oficina' | 'galpon' | 'quinta' | 'ph' | 'otro';

interface ContactPayload {
  kind?: 'contact' | 'newsletter';
  name?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  message?: string;
  zone?: string;
  budget_usd?: number | string | null;
  property_type?: string;
  property_id?: string;
  tipo_cliente?: string;
  operation_type?: string;
  utm_source?: string;
  utm_campaign?: string;
  website?: string; // honeypot: si viene con contenido, es un bot
}

const TIPOS_CLIENTE: readonly TipoCliente[] = ['propietario', 'comprador', 'inquilino', 'inversor'];
const OPERATIONS: readonly OperationType[] = ['compra', 'venta', 'alquiler'];
const PROPERTY_TYPES: readonly PropertyType[] = ['casa', 'departamento', 'terreno', 'local', 'oficina', 'galpon', 'quinta', 'ph', 'otro'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;

function clip(s: string, max = MAX_TEXT): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim().slice(0, max);
}

function inList<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return optionsResponse(req);
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Método no permitido' }, req);

  const ip = clientIp(req);
  const rl = await checkRateLimit('contact-submit', ip);
  if (!rl.allowed) {
    return jsonResponse(429, { error: 'Demasiados intentos. Probá más tarde.' }, req);
  }

  let payload: ContactPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: 'JSON inválido' }, req);
  }

  // Honeypot: responder éxito falso y no persistir nada
  if (payload.website && payload.website.trim() !== '') {
    return jsonResponse(200, { ok: true }, req);
  }

  const name = clip(String(payload.name ?? ''), 150);
  const email = clip(String(payload.email ?? ''), 200).toLowerCase();
  const phone = clip(String(payload.phone ?? ''), 40);
  const whatsapp = clip(String(payload.whatsapp ?? ''), 40);
  const message = clip(String(payload.message ?? ''));

  if (!email || !EMAIL_RE.test(email)) return jsonResponse(400, { error: 'Email inválido' }, req);
  const isNewsletter = payload.kind === 'newsletter';
  if (!isNewsletter) {
    if (!name) return jsonResponse(400, { error: 'Falta el nombre' }, req);
    if (!message) return jsonResponse(400, { error: 'Falta el mensaje' }, req);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // --- Dedup: misma persona consultando de nuevo en 60 días ---
  const dupFilters: string[] = [];
  const digits = phone.replace(/\D/g, '');
  const wdigits = whatsapp.replace(/\D/g, '');
  if (digits.length >= 6) dupFilters.push(`phone.ilike.%${digits.slice(-8)}%`);
  if (wdigits.length >= 6 && wdigits !== digits) dupFilters.push(`whatsapp.ilike.%${wdigits.slice(-8)}%`);
  if (email) dupFilters.push(`email.ilike.${email}`);

  if (dupFilters.length) {
    const { data: dup } = await supabase
      .from('leads')
      .select('id')
      .or(dupFilters.join(','))
      .is('deleted_at', null)
      .gte('created_at', new Date(Date.now() - 60 * 86400000).toISOString())
      .limit(1)
      .maybeSingle();
    if (dup) {
      if (!isNewsletter) {
        await supabase.from('lead_activities').insert([{
          lead_id: dup.id,
          activity_type: 'note',
          title: 'Nueva consulta desde la web (lead existente)',
          description: message,
        }]);
      }
      return jsonResponse(200, { ok: true, duplicate: true }, req);
    }
  }

  if (isNewsletter) {
    const { error: nlErr } = await supabase.from('leads').insert([{
      full_name: 'Suscriptor Newsletter',
      email,
      source: 'newsletter',
      stage: 'nuevo',
      notes: 'Suscripción al newsletter desde la landing page',
    }]);
    if (nlErr) {
      console.error('[contact-submit] newsletter insert error:', nlErr);
      return jsonResponse(500, { error: 'No pudimos registrar tu suscripción. Probá de nuevo.' }, req);
    }
    return jsonResponse(200, { ok: true }, req);
  }

  const budgetRaw = payload.budget_usd;
  const budget = typeof budgetRaw === 'number'
    ? budgetRaw
    : parseFloat(String(budgetRaw ?? '').replace(/[^\d.]/g, ''));
  if (budgetRaw != null && budgetRaw !== '' && (!isFinite(budget) || budget < 0)) {
    return jsonResponse(400, { error: 'Presupuesto inválido' }, req);
  }

  const propertyId = typeof payload.property_id === 'string' && UUID_RE.test(payload.property_id)
    ? payload.property_id
    : null;

  const record = {
    full_name: name,
    email,
    phone: phone || null,
    whatsapp: whatsapp || null,
    notes: message,
    preferred_zone: clip(String(payload.zone ?? ''), 120) || null,
    budget_usd: isFinite(budget) && budget > 0 ? budget : null,
    preferred_type: inList(payload.property_type, PROPERTY_TYPES),
    tipo_cliente: inList(payload.tipo_cliente, TIPOS_CLIENTE),
    operation_type: inList(payload.operation_type, OPERATIONS),
    property_id: propertyId,
    source: 'landing_page',
    stage: 'nuevo',
    utm_source: clip(String(payload.utm_source ?? ''), 120) || null,
    utm_campaign: clip(String(payload.utm_campaign ?? ''), 120) || null,
  };

  const { error } = await supabase.from('leads').insert([record]);
  if (error) {
    console.error('[contact-submit] insert error:', error);
    return jsonResponse(500, { error: 'No pudimos registrar tu consulta. Probá de nuevo.' }, req);
  }

  return jsonResponse(200, { ok: true }, req);
});
