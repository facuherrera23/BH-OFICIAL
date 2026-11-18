// ============================================================
// track-event — Medición first-party del sitio (SIN cookies).
// ============================================================
// POR QUÉ EXISTE (auditoría 18/11/2026): el sitio no tenía NINGÚN dato de
// tráfico. GA4 y Clarity solo cargan con consentimiento 'all' → la mayoría
// de las visitas no se registraban (y con la AAIP no se puede pedir 'all' por
// defecto). `bhTrack` era un no-op sin consentimiento → ni siquiera las
// conversiones (form_start/form_submit/wa_click) se veían. Resultado: 1 lead
// del formulario en 12 semanas y ninguna idea de si entra gente.
//
// QUÉ HACE: recibe un evento de navegación del sitio y lo guarda en
// `page_events` (agregados, sin PII). El cliente es `assets/js/tracking.js`.
//
// PRIVACIDAD (AAIP / Ley 25.326):
//   • NO se guarda IP, ni user agent, ni email, ni nombre, ni teléfono.
//   • session_id = UUID aleatorio en sessionStorage (se borra al cerrar la
//     pestaña). Sirve para contar sesiones, NO para identificar personas.
//   • Sin cookies: va por fetch/sendBeacon a nuestra propia función.
//   • Opt-out: localStorage 'bh_track_optout' = '1' → el cliente no manda nada.
//   • La IP solo se usa para el rate limit (igual que en contact-submit) y NO
//     se escribe en la base.
//
// verify_jwt OFF (es pública, la llama el visitante anónimo) → tiene que estar
// en NO_VERIFY de .github/workflows/deploy.yml Y en CALLED_WITHOUT_JWT de
// tests/functions-deploy.spec.js (si no, el gateway responde 401 y no se
// registra nada: el mismo 401 silencioso que mató los crons).
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/* Whitelist de eventos: el cliente NO puede inventar nombres (evita que un
   bot llene la tabla con basura y que el panel muestre basura). */
const EVENTS = new Set([
  'page_view',
  'wa_click',
  'wa_handoff_start',
  'wa_handoff_submit',
  'wa_handoff_skip',
  'wa_handoff_error',
  'form_start',
  'form_submit',
  'property_view',
  'property_open',
  'ficha_link_click',
  'cta_click',
  'tel_click',
  'share_click',
  'newsletter_submit',
  'tasacion_start',
  'tasacion_request_submit',
  'tasacion_save_attempt',
]);

const PAGES = new Set(['landing', 'ficha', 'tasacion', 'canal', 'portal', 'otro']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z]{2}-P[0-9]{4}$/;

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Ruta del sitio: sin query ni hash, siempre relativa, topada. */
function cleanPath(v: unknown): string {
  const raw = str(v, 300) ?? '/';
  let p = raw.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = '/' + p;
  return p.slice(0, 200);
}

/** Código de propiedad (DA-P0002): formato estricto, si no → null. */
function cleanCode(v: unknown): string | null {
  const s = str(v, 20);
  if (!s) return null;
  const m = s.toUpperCase().match(CODE_RE);
  return m ? m[0] : null;
}

/** Tokens cortos (origin, utm_*): solo caracteres seguros. */
function cleanToken(v: unknown, max = 120): string | null {
  const s = str(v, max);
  if (!s) return null;
  return /^[a-zA-Z0-9._-]+$/.test(s) ? s : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return optionsResponse(req);
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Método no permitido' }, req);

  // Rate limit por IP (60/min): evita que un bot llene page_events.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = await checkRateLimit('track-event', ip);
  if (!rl.allowed) return jsonResponse(429, { error: 'rate_limited' }, req);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: 'JSON inválido' }, req);
  }
  if (!body || typeof body !== 'object') {
    return jsonResponse(400, { error: 'JSON inválido' }, req);
  }

  const event = str(body.event, 40);
  if (!event || !EVENTS.has(event)) {
    return jsonResponse(400, { error: 'evento no permitido' }, req);
  }

  const pageRaw = str(body.page, 20);
  const sessionRaw = str(body.session_id, 36);

  const row = {
    event,
    path: cleanPath(body.path),
    page: pageRaw && PAGES.has(pageRaw) ? pageRaw : null,
    property_code: cleanCode(body.property_code),
    origin: cleanToken(body.origin, 40),
    referrer: str(body.referrer, 300),
    utm_source: cleanToken(body.utm_source, 120),
    utm_campaign: cleanToken(body.utm_campaign, 120),
    session_id: sessionRaw && UUID_RE.test(sessionRaw) ? sessionRaw : null,
  };

  const { error } = await supabase.from('page_events').insert(row);
  if (error) {
    // Se loguea pero no se le devuelve el detalle al navegador.
    console.error('[track-event] insert error:', error.message);
    return jsonResponse(500, { error: 'no se pudo registrar' }, req);
  }

  return jsonResponse(202, { ok: true }, req);
});
