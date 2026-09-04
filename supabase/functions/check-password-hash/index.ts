// ============================================================
// BIENENHAUS - check-password-hash
// Edge Function: verifica si una contraseña aparece en filtraciones
// usando Have I Been Pwned (HIBP) con k-anonymity.
// Se llama DESPUÉS de validación client-side, ANTES de signUp/updateUser.
// Fail-open: si HIBP falla, permite (no bloquear usuarios legítimos).
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const HIBP_API = 'https://api.pwnedpasswords.com/range/';
const ALLOWED_ORIGINS = [
  'https://bienenhaus.com.ar',
  'https://www.bienenhaus.com.ar',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

// Rate limiting compartido (tabla rate_limit_logs, fail-closed).
// El limiter anterior era en memoria: en Deno Deploy (multi-instancia)
// cada instancia tenía su propio contador y el límite no era real.

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'vary': 'Origin',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
    };
  }
  return { 'vary': 'Origin' };
}

function jsonResponse(status: number, body: unknown, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'content-type': 'application/json' },
  });
}

async function sha1Hex(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(req) });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, req);
  }

  // Rate limiting por IP (compartido, DB-backed)
  const clientIp = getClientIp(req);
  const rl = await checkRateLimit('check-password-hash', clientIp);
  if (!rl.allowed) {
    return jsonResponse(429, {
      error: 'Too many requests',
      message: `Demasiadas verificaciones. Espera ${rl.retryAfter ?? 60} segundos.`,
    }, req);
  }

  // Parse body
  let password: string;
  try {
    const body = await req.json();
    password = body?.password;
    if (typeof password !== 'string' || password.length === 0) {
      return jsonResponse(400, { error: 'Password requerido' }, req);
    }
    if (password.length > 128) {
      return jsonResponse(400, { error: 'Password demasiado largo' }, req);
    }
  } catch (_err) {
    return jsonResponse(400, { error: 'Body inválido (JSON esperado)' }, req);
  }

  try {
    // SHA-1 del password
    const hashHex = await sha1Hex(password);
    const prefix = hashHex.slice(0, 5);
    const suffix = hashHex.slice(5);

    // Llamar a HIBP API (k-anonymity)
    const hibpResponse = await fetch(`${HIBP_API}${prefix}`, {
      headers: {
        'User-Agent': 'Bienenhaus-Auth-Check/1.0',
        'Accept': 'text/plain',
      },
      // Timeout manual via AbortController (Deno no soporta timeout en fetch nativo)
      signal: AbortSignal.timeout(5000),
    });

    if (!hibpResponse.ok) {
      // HIBP devuelve 404 si no hay brechas para ese prefijo
      if (hibpResponse.status === 404) {
        return jsonResponse(200, { pwned: false, count: 0 }, req);
      }
      console.error(`HIBP error: ${hibpResponse.status}`);
      // Fail-open: si HIBP falla, permitimos
      return jsonResponse(200, { pwned: false, count: 0, source: 'hibp_error' }, req);
    }

    const text = await hibpResponse.text();
    // Formato: "SUFFIX1:COUNT1\nSUFFIX2:COUNT2\n..."
    const lines = text.trim().split('\n');
    let count = 0;
    let pwned = false;

    for (const line of lines) {
      const [foundSuffix, countStr] = line.split(':');
      if (foundSuffix === suffix) {
        pwned = true;
        count = parseInt(countStr, 10) || 0;
        break;
      }
    }

    return jsonResponse(200, { pwned, count }, req);
  } catch (err) {
    // Fail-open: error de red, timeout, parse error, etc.
    console.error('check-password-hash error:', err);
    return jsonResponse(200, { pwned: false, count: 0, source: 'error' }, req);
  }
});