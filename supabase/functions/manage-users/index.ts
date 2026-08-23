// ============================================================
// BIENENHAUS - manage-users
// Edge Function: invitacion de usuarios + cambio de roles.
//
// Seguridad:
// - verify_jwt=true (plataforma): rechaza requests sin JWT valido.
// - Chequeo interno: JWT debe ser de usuario autenticado Y con
//   perfil role='super_admin' (via service role key).
// - Acciones: invite | create-direct | set-role | update-user | update-self
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

async function fetchProfileRow(
  userId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`,
    { headers: serviceHeaders(serviceKey) },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function patchAuthUser(
  userId: string,
  payloadBody: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
): Promise<boolean> {
  const res = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody),
    },
  );
  return res.ok;
}

async function countOtherActiveSuperAdmins(
  excludeId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<number> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?role=eq.super_admin&is_active=eq.true&id=neq.${encodeURIComponent(excludeId)}&select=id`,
    { headers: serviceHeaders(serviceKey) },
  );
  const rows = res.ok ? await res.json() : [];
  return Array.isArray(rows) ? rows.length : 0;
}

/* Edicion por super_admin: datos de contacto de cualquier usuario; rol y
   estado de cualquiera menos de si mismo; nunca deja el sistema sin un
   super_admin activo. Espeja email/ban/metadata en auth.users: el ban
   bloquea el login real, no solo la etiqueta. */
async function actionUpdateUser(
  body: Record<string, unknown>,
  callerId: string,
  supabaseUrl: string,
  serviceKey: string,
) {
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!userId) return json({ error: 'Falta el usuario a modificar' }, 400);

  const target = await fetchProfileRow(userId, supabaseUrl, serviceKey);
  if (!target) return json({ error: 'Usuario no encontrado' }, 404);
  const currentRole = typeof target.role === 'string' ? target.role : 'agente';
  const currentActive = target.is_active !== false;
  const selfEdit = userId === callerId;

  const profilePatch: Record<string, unknown> = {};
  if (typeof body.full_name === 'string') {
    const fullName = body.full_name.trim();
    if (!fullName) return json({ error: 'El nombre completo es obligatorio' }, 400);
    profilePatch.full_name = fullName;
  }
  if (typeof body.phone === 'string') {
    profilePatch.phone = body.phone.trim();
  }
  let newEmail = '';
  if (typeof body.email === 'string') {
    newEmail = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(newEmail)) return json({ error: 'Email invalido' }, 400);
    profilePatch.email = newEmail;
  }

  let nextRole = '';
  if (body.role !== undefined && body.role !== null && body.role !== '') {
    if (typeof body.role !== 'string' || !VALID_ROLES.has(body.role)) {
      return json({ error: 'Rol invalido' }, 400);
    }
    nextRole = body.role;
    if (selfEdit && nextRole !== currentRole) {
      return json({ error: 'No podes cambiar tu propio rol' }, 400);
    }
    profilePatch.role = nextRole;
  }

  let banChange: boolean | null = null;
  if (body.is_active !== undefined && body.is_active !== null) {
    if (typeof body.is_active !== 'boolean') return json({ error: 'Estado invalido' }, 400);
    if (selfEdit && body.is_active !== currentActive) {
      return json({ error: 'No podes cambiar tu propio estado' }, 400);
    }
    if (body.is_active !== currentActive) {
      profilePatch.is_active = body.is_active;
      banChange = !body.is_active;
    }
  }

  if (Object.keys(profilePatch).length === 0) {
    return json({ error: 'No hay cambios para aplicar' }, 400);
  }

  if (currentRole === 'super_admin') {
    const demoting = typeof profilePatch.role === 'string' && profilePatch.role !== 'super_admin';
    const deactivating = profilePatch.is_active === false;
    if (demoting || deactivating) {
      const others = await countOtherActiveSuperAdmins(userId, supabaseUrl, serviceKey);
      if (others === 0) {
        return json({ error: 'No podes dejar el sistema sin un super_admin activo' }, 400);
      }
    }
  }

  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(profilePatch),
    },
  );
  if (!patchRes.ok) return json({ error: 'No se pudo actualizar el perfil' }, 500);

  const authPatch: Record<string, unknown> = {};
  if (newEmail) {
    authPatch.email = newEmail;
    authPatch.email_confirm = true;
  }
  if (banChange === true) authPatch.ban_duration = '876000h';
  if (banChange === false) authPatch.ban_duration = 'none';
  const meta: Record<string, string> = {};
  if (typeof profilePatch.full_name === 'string') meta.full_name = profilePatch.full_name;
  if (typeof profilePatch.phone === 'string') meta.phone = profilePatch.phone;
  if (nextRole) meta.role = nextRole;
  if (Object.keys(meta).length > 0) authPatch.user_metadata = meta;

  let authMirror = true;
  if (Object.keys(authPatch).length > 0) {
    authMirror = await patchAuthUser(userId, authPatch, supabaseUrl, serviceKey);
  }

  return json({ ok: true, userId, authMirror });
}

/* Autogestion: cualquier usuario del panel actualiza su nombre y telefono.
   Rol/estado jamas (validacion explicita + trigger trg_profiles_guard_self
   en DB como segunda capa). El email propio de un no-admin se cambia desde
   el cliente con supabase.auth.updateUser (flujo con confirmacion). */
async function actionUpdateSelf(
  body: Record<string, unknown>,
  callerId: string,
  supabaseUrl: string,
  serviceKey: string,
) {
  if (body.role !== undefined || body.is_active !== undefined) {
    return json({ error: 'Tu rol y estado solo puede cambiarlos un super_admin' }, 400);
  }

  const target = await fetchProfileRow(callerId, supabaseUrl, serviceKey);
  if (!target) return json({ error: 'Usuario no encontrado' }, 404);

  const profilePatch: Record<string, unknown> = {};
  if (typeof body.full_name === 'string') {
    const fullName = body.full_name.trim();
    if (!fullName) return json({ error: 'El nombre completo es obligatorio' }, 400);
    profilePatch.full_name = fullName;
  }
  if (typeof body.phone === 'string') {
    profilePatch.phone = body.phone.trim();
  }
  if (Object.keys(profilePatch).length === 0) {
    return json({ error: 'No hay cambios para aplicar' }, 400);
  }

  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(callerId)}`,
    {
      method: 'PATCH',
      headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(profilePatch),
    },
  );
  if (!patchRes.ok) return json({ error: 'No se pudo actualizar tu perfil' }, 500);

  const meta: Record<string, string> = {};
  if (typeof profilePatch.full_name === 'string') meta.full_name = profilePatch.full_name;
  if (typeof profilePatch.phone === 'string') meta.phone = profilePatch.phone;
  const authMirror = await patchAuthUser(
    callerId,
    { user_metadata: meta },
    supabaseUrl,
    serviceKey,
  );

  return json({ ok: true, userId: callerId, authMirror });
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

    /* Autogestion basica disponible para cualquier usuario autenticado;
       debe resolverse antes del gate super_admin. */
    if (body.action === 'update-self') {
      return await actionUpdateSelf(body, payload.sub, supabaseUrl, serviceKey);
    }

    const admin = await isAdminUser(payload.sub);
    if (!admin) {
      return json({ error: 'Solo super_admin pueden gestionar usuarios' }, 403);
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
    if (body.action === 'update-user') {
      return await actionUpdateUser(body, payload.sub, supabaseUrl, serviceKey);
    }
    return json({ error: 'Accion desconocida' }, 400);
  } catch (err) {
    console.error('manage-users error:', err);
    return json({ error: 'Error interno gestionando usuarios' }, 500);
  }
});
