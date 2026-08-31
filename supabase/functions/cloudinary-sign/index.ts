// ============================================================
// BIENENHAUS - cloudinary-sign
// Edge Function: firma uploads a Cloudinary (uploads firmados).
//
// Seguridad:
// - JWT validado criptográficamente via supabase.auth.getUser()
// - Chequeo interno: usuario autenticado Y con
//   perfil role activo del panel (via service role key).
// - Carpeta validada contra allowlist (evita firmar rutas arbitrarias).
// - El API secret NUNCA sale del entorno del servidor.
//
// Firma Cloudinary: SHA-1 hex de params ordenados alfabeticamente
// ("k=v&...") + api_secret concatenado al final.
//
// Secrets requeridos (supabase secrets set):
//   CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
//   CLOUDINARY_CLOUD_NAME (opcional; default bienenhaus)
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

/* Carpetas permitidas dentro del cloud. Cualquier otra -> default. */
const ALLOWED_FOLDERS = new Set([
  'bienenhaus',
  'bienenhaus/properties',
  'bienenhaus/hero',
  'bienenhaus/brokers',
]);

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function isAdminUser(userId: string): Promise<boolean> {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!serviceKey || !supabaseUrl) return false;

  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role,is_active`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    },
  );
  if (!res.ok) return false;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return false;

  const profile = rows[0];
  /* user_role enum: super_admin | broker | agente.
     Cualquier usuario activo del panel puede subir fotos de propiedades
     (la carga de imagenes no esta restringida a super_admin en el
     frontend: brokers y agentes tambien cargan/editan propiedades). */
  if (profile.is_active === false) return false;
  const ALLOWED_ROLES = new Set(['super_admin', 'broker', 'agente']);
  return ALLOWED_ROLES.has(profile.role);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return optionsResponse(req);
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'Method not allowed' }, req);
    }

    // Rate Limiting
    const rlResponse = await rateLimitMiddleware('cloudinary-sign', req);
    if (rlResponse) return rlResponse;

    // Validar JWT via Supabase Auth (verificación criptográfica real)
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse(401, { error: 'No autorizado' }, req);
    }
    const token = authHeader.slice(7);

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return jsonResponse(500, { error: 'Servidor mal configurado' }, req);

    const supabaseClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !user) {
      return jsonResponse(401, { error: 'No autorizado' }, req);
    }
    const userId = user.id;

    /* 2. Perfil valido y activo verificado server-side contra profiles
          (cualquier rol del panel: super_admin, broker o agente). */
    const admin = await isAdminUser(userId);
    if (!admin) {
      return jsonResponse(403, { error: 'Tu usuario no tiene permiso para subir imágenes' }, req);
    }

    /* 3. Carpeta pedida por el cliente, validada contra allowlist. */
    let requestedFolder = 'bienenhaus';
    try {
      const body = await req.json();
      if (typeof body?.folder === 'string' && body.folder.trim() !== '') {
        requestedFolder = body.folder.replace(/^\/+|\/+$/g, '');
      }
    } catch (_err) {
      /* body vacio -> carpeta default */
    }
    if (!ALLOWED_FOLDERS.has(requestedFolder)) {
      requestedFolder = 'bienenhaus';
    }

    /* 4. Credenciales Cloudinary desde secrets del entorno. */
    const apiKey = Deno.env.get('CLOUDINARY_API_KEY');
    const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET');
    const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME') ?? 'jpyigjrh';
    if (!apiKey || !apiSecret) {
      console.error('cloudinary-sign: secrets CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET no configurados');
      return jsonResponse(500, { error: 'Cloudinary no configurado en el servidor' }, req);
    }

    /* 5. Firmar solo folder+timestamp (Cloudinary excluye fetch_format/
          quality de su propia validacion - verificado empiricamente). */
    const timestamp = Math.floor(Date.now() / 1000);
    const signedParams: Record<string, string> = {
      folder: requestedFolder,
      timestamp: String(timestamp),
    };
    const toSign =
      Object.keys(signedParams)
        .sort()
        .map((k) => `${k}=${signedParams[k]}`)
        .join('&') + apiSecret;
    const signature = await sha1Hex(toSign);

    return jsonResponse(200, {
      cloudName,
      apiKey,
      signature,
      params: signedParams,
    }, req);
  } catch (err) {
    console.error('cloudinary-sign error:', err);
    return jsonResponse(500, { error: 'Error interno generando firma' }, req);
  }
});