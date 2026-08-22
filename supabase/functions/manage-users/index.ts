// ============================================================
// BIENENHAUS - manage-users
// Edge Function: invitacion de usuarios + cambio de roles.
//
// Seguridad:
// - verify_jwt=true (plataforma): rechaza requests sin JWT valido.
// - Chequeo interno: JWT debe ser de usuario autenticado Y con
//   perfil role='super_admin' (via service role key).
// - Acciones: invite | create-direct | set-role
// - El service role key NUNCA sale del entorno del servidor.
//
// Notas de flujo:
// - invite usa el admin API de GoTrue (/auth/v1/invite): Supabase
//   envia el mail de invitacion; al aceptarla el usuario define
//   su password. Redirige al panel (admin.html) usando el Origin
//   del request. El trigger handle_new_user crea el perfil y
//   esta funcion luego hace upsert del rol en profiles.
// - set-role actualiza profiles Y espeja el rol en
//   auth.users.raw_user_meta_data (visible en Authentication
//   -> Users del dashboard de Supabase).
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* user_role enum: super_admin | broker | agente */
const VALID_ROLES = new Set(['super_admin', 'broker', 'agente']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function decodeJwtPayload(jwt: string): { sub?: string; role?: string } | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return JSON.parse(atob(b64));
  } catch (_err) {
    return null;
  }
}

async function isAdminUser(userId: string): Promise<boolean> {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!serviceKey || !supabaseUrl) return false;

  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (!res.ok) return false;
  const rows = await res.json();
  /* user_role enum: super_admin | broker | agente */
  return Array.isArray(rows) && rows.length > 0 && rows[0].role === 'super_admin';
}

function serviceHeaders(serviceKey: string) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
}

async function actionInvite(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  origin = '',
) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const role = typeof body.role === 'string' ? body.role : '';

  if (!EMAIL_RE.test(email)) return json({ error: 'Email invalido' }, 400);
  if (!fullName) return json({ error: 'El nombre completo es obligatorio' }, 400);
  if (!VALID_ROLES.has(role)) return json({ error: 'Rol invalido' }, 400);

  /* El link del mail debe caer en el PANEL (donde se define contraseña),
     no en la landing. Supabase valida redirect_to contra su allowlist;
     si el origen no esta permitido, cae al Site URL por defecto. */
  const cleanOrigin = origin.replace(/\/+$/, '');
  const redirectQs = /^https?:\/\//.test(cleanOrigin)
    ? `?redirect_to=${encodeURIComponent(`${cleanOrigin}/admin.html`)}`
    : '';

  const metadata: Record<string, string> = { full_name: fullName, role };
  if (phone) metadata.phone = phone;

  const inviteRes = await fetch(`${supabaseUrl}/auth/v1/invite${redirectQs}`, {
    method: 'POST',
    headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, data: metadata }),
  });
  if (!inviteRes.ok) {
    const err = await inviteRes.json().catch(() => ({}));
    return json(
      { error: err.msg || err.error_description || err.message || 'No se pudo enviar la invitacion' },
      inviteRes.status,
    );
  }
  const user = await inviteRes.json();
  if (!user?.id) return json({ error: 'Invitacion enviada pero no se obtuvo el usuario' }, 500);

  const profileRow: Record<string, string> = { id: user.id, email, full_name: fullName, role };
  if (phone) profileRow.phone = phone;
  const upsertRes = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
    method: 'POST',
    headers: {
      ...serviceHeaders(serviceKey),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify([profileRow]),
  });
  if (!upsertRes.ok) {
    return json({ error: 'Usuario invitado pero no se pudo asignar el rol en profiles' }, 500);
  }

  return json({ ok: true, userId: user.id, email });
}

async function actionSetRole(
  body: Record<string, unknown>,
  callerId: string,
  supabaseUrl: string,
  serviceKey: string,
) {
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const role = typeof body.role === 'string' ? body.role : '';

  if (!userId) return json({ error: 'Falta el usuario a modificar' }, 400);
  if (!VALID_ROLES.has(role)) return json({ error: 'Rol invalido' }, 400);
  if (userId === callerId) {
    return json({ error: 'No podes cambiar tu propio rol' }, 400);
  }

  const targetRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,role`,
    { headers: serviceHeaders(serviceKey) },
  );
  if (!targetRes.ok) return json({ error: 'No se pudo verificar el usuario' }, 500);
  const targets = await targetRes.json();
  if (!Array.isArray(targets) || targets.length === 0) {
    return json({ error: 'Usuario no encontrado' }, 404);
  }
  const targetRole = targets[0].role as string;

  if (targetRole === 'super_admin' && role !== 'super_admin') {
    const othersRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?role=eq.super_admin&id=neq.${encodeURIComponent(userId)}&select=id`,
      { headers: serviceHeaders(serviceKey) },
    );
    const others = othersRes.ok ? await othersRes.json() : [];
    if (!Array.isArray(others) || others.length === 0) {
      return json({ error: 'No podes degradar al ultimo super_admin del sistema' }, 400);
    }
  }

  const patchProfile = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ role }),
    },
  );
  if (!patchProfile.ok) return json({ error: 'No se pudo actualizar el rol' }, 500);

  /* Espejo del rol en auth.users (visible en Authentication -> Users). */
  const patchAuth = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_metadata: { role } }),
    },
  );

  return json({ ok: true, userId, role, authMirror: patchAuth.ok });
}

async function actionCreateDirect(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const role = typeof body.role === 'string' ? body.role : '';

  if (!EMAIL_RE.test(email)) return json({ error: 'Email invalido' }, 400);
  if (!fullName) return json({ error: 'El nombre completo es obligatorio' }, 400);
  if (!VALID_ROLES.has(role)) return json({ error: 'Rol invalido' }, 400);

  /* Contraseña temporal de un solo uso: se muestra al admin y él la deriva. */
  const rand = crypto.randomUUID().replace(/-/g, '');
  const tempPassword = `BH-${rand.slice(0, 6)}${rand.slice(6, 10)}!`;

  const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role,
        ...(phone ? { phone } : {}),
      },
    }),
  });
  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    return json(
      { error: err.msg || err.error_description || err.message || 'No se pudo crear el usuario' },
      createRes.status,
    );
  }
  const user = await createRes.json();
  if (!user?.id) return json({ error: 'Usuario creado pero sin id' }, 500);

  const profileRow: Record<string, string> = { id: user.id, email, full_name: fullName, role };
  if (phone) profileRow.phone = phone;
  const upsertRes = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
    method: 'POST',
    headers: {
      ...serviceHeaders(serviceKey),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify([profileRow]),
  });
  if (!upsertRes.ok) {
    return json({ error: 'Usuario creado pero no se pudo asignar el rol en profiles' }, 500);
  }

  return json({ ok: true, userId: user.id, email, tempPassword });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    const payload = decodeJwtPayload(jwt);
    if (!payload?.sub || payload.role !== 'authenticated') {
      return json({ error: 'No autorizado' }, 401);
    }

    const admin = await isAdminUser(payload.sub);
    if (!admin) {
      return json({ error: 'Solo super_admin pueden gestionar usuarios' }, 403);
    }

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) {
      return json({ error: 'Servidor mal configurado' }, 500);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (_err) {
      return json({ error: 'Body invalido' }, 400);
    }

    if (body.action === 'invite') {
      const origin = (req.headers.get('origin') || '').replace(/\/+$/, '');
      return await actionInvite(body, supabaseUrl, serviceKey, origin);
    }
    if (body.action === 'create-direct') {
      return await actionCreateDirect(body, supabaseUrl, serviceKey);
    }
    if (body.action === 'set-role') {
      return await actionSetRole(body, payload.sub, supabaseUrl, serviceKey);
    }
    return json({ error: 'Accion desconocida' }, 400);
  } catch (err) {
    console.error('manage-users error:', err);
    return json({ error: 'Error interno gestionando usuarios' }, 500);
  }
});
