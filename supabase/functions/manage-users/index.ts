// ============================================================
// BIENENHAUS - manage-users
// Edge Function: invitacion de usuarios + cambio de roles.
//
// Seguridad:
// - JWT validado criptográficamente via supabase.auth.getUser()
// - Chequeo interno: usuario autenticado Y con
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

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  auditEvent,
  auditSensitiveAction,
  trackToolUsage,
  auditError,
  getClientIp,
  getUserAgent,
  genRequestId,
} from '../_shared/audit.ts';
import { corsHeaders, jsonResponse, optionsResponse } from '../_shared/http.ts';
import { rateLimitMiddleware } from '../_shared/rate-limit.ts';

/* user_role enum: super_admin | broker | agente */
const VALID_ROLES = new Set(['super_admin', 'broker', 'agente']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serviceHeaders(serviceKey: string) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
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

async function actionInvite(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  origin: string,
  supabaseClient: ReturnType<typeof createClient>,
  req: Request,
) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const role = typeof body.role === 'string' ? body.role : '';

  if (!EMAIL_RE.test(email)) return jsonResponse(400, { error: 'Email invalido' }, req);
  if (!fullName) return jsonResponse(400, { error: 'El nombre completo es obligatorio' }, req);
  if (!VALID_ROLES.has(role)) return jsonResponse(400, { error: 'Rol invalido' }, req);

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
    return jsonResponse(
      inviteRes.status,
      { error: err.msg || err.error_description || err.message || 'No se pudo enviar la invitacion' },
      req,
    );
  }
  const user = await inviteRes.json();
  if (!user?.id) return jsonResponse(500, { error: 'Invitacion enviada pero no se obtuvo el usuario' }, req);

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
    return jsonResponse(500, { error: 'Usuario invitado pero no se pudo asignar el rol en profiles' }, req);
  }

  // Auditoría: invitación de usuario
  await auditSensitiveAction(
    supabaseClient,
    new Request('internal', { method: 'POST' }),
    'invite',
    'users',
    'user',
    user.id,
    email,
    null,
    { email, full_name: fullName, role, phone }
  );

  return jsonResponse(200, { ok: true, userId: user.id, email }, req);
}

async function actionSetRole(
  body: Record<string, unknown>,
  callerId: string,
  supabaseUrl: string,
  serviceKey: string,
  supabaseClient: ReturnType<typeof createClient>,
  req: Request,
) {
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const role = typeof body.role === 'string' ? body.role : '';

  if (!userId) return jsonResponse(400, { error: 'Falta el usuario a modificar' }, req);
  if (!VALID_ROLES.has(role)) return jsonResponse(400, { error: 'Rol invalido' }, req);
  if (userId === callerId) {
    return jsonResponse(400, { error: 'No podes cambiar tu propio rol' }, req);
  }

  const targetRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,role`,
    { headers: serviceHeaders(serviceKey) },
  );
  if (!targetRes.ok) return jsonResponse(500, { error: 'No se pudo verificar el usuario' }, req);
  const targets = await targetRes.json();
  if (!Array.isArray(targets) || targets.length === 0) {
    return jsonResponse(404, { error: 'Usuario no encontrado' }, req);
  }
  const targetRole = targets[0].role as string;

  if (targetRole === 'super_admin' && role !== 'super_admin') {
    const othersRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?role=eq.super_admin&id=neq.${encodeURIComponent(userId)}&select=id`,
      { headers: serviceHeaders(serviceKey) },
    );
    const others = othersRes.ok ? await othersRes.json() : [];
    if (!Array.isArray(others) || others.length === 0) {
      return jsonResponse(400, { error: 'No podes degradar al ultimo super_admin del sistema' }, req);
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
  if (!patchProfile.ok) return jsonResponse(500, { error: 'No se pudo actualizar el rol' }, req);

  /* Espejo del rol en auth.users (visible en Authentication -> Users). */
  const patchAuth = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_metadata: { role } }),
    },
  );

  // Auditoría: cambio de rol
  await auditSensitiveAction(
    supabaseClient,
    new Request('internal', { method: 'POST' }),
    'change_role',
    'users',
    'user',
    userId,
    role,
    { oldRole: targetRole },
    { newRole: role }
  );

  return jsonResponse(200, { ok: true, userId, role, authMirror: patchAuth.ok }, req);
}

async function actionCreateDirect(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  supabaseClient: ReturnType<typeof createClient>,
  req: Request,
) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const role = typeof body.role === 'string' ? body.role : '';

  if (!EMAIL_RE.test(email)) return jsonResponse(400, { error: 'Email invalido' }, req);
  if (!fullName) return jsonResponse(400, { error: 'El nombre completo es obligatorio' }, req);
  if (!VALID_ROLES.has(role)) return jsonResponse(400, { error: 'Rol invalido' }, req);

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
    return jsonResponse(
      createRes.status,
      { error: err.msg || err.error_description || err.message || 'No se pudo crear el usuario' },
      req,
    );
  }
  const user = await createRes.json();
  if (!user?.id) return jsonResponse(500, { error: 'Usuario creado pero sin id' }, req);

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
    return jsonResponse(500, { error: 'Usuario creado pero no se pudo asignar el rol en profiles' }, req);
  }

  // Auditoría: creación directa de usuario
  await auditSensitiveAction(
    supabaseClient,
    new Request('internal', { method: 'POST' }),
    'create',
    'users',
    'user',
    user.id,
    email,
    null,
    { email, full_name: fullName, role, phone, tempPassword: true }
  );

  return jsonResponse(200, { ok: true, userId: user.id, email, tempPassword }, req);
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
  supabaseClient: ReturnType<typeof createClient>,
  req: Request,
) {
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!userId) return jsonResponse(400, { error: 'Falta el usuario a modificar' }, req);

  const target = await fetchProfileRow(userId, supabaseUrl, serviceKey);
  if (!target) return jsonResponse(404, { error: 'Usuario no encontrado' }, req);
  const currentRole = typeof target.role === 'string' ? target.role : 'agente';
  const currentActive = target.is_active !== false;
  const selfEdit = userId === callerId;

  const profilePatch: Record<string, unknown> = {};
  if (typeof body.full_name === 'string') {
    const fullName = body.full_name.trim();
    if (!fullName) return jsonResponse(400, { error: 'El nombre completo es obligatorio' }, req);
    profilePatch.full_name = fullName;
  }
  if (typeof body.phone === 'string') {
    profilePatch.phone = body.phone.trim();
  }
  let newEmail = '';
  if (typeof body.email === 'string') {
    newEmail = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(newEmail)) return jsonResponse(400, { error: 'Email invalido' }, req);
    profilePatch.email = newEmail;
  }

  let nextRole = '';
  if (body.role !== undefined && body.role !== null && body.role !== '') {
    if (typeof body.role !== 'string' || !VALID_ROLES.has(body.role)) {
      return jsonResponse(400, { error: 'Rol invalido' }, req);
    }
    nextRole = body.role;
    if (selfEdit && nextRole !== currentRole) {
      return jsonResponse(400, { error: 'No podes cambiar tu propio rol' }, req);
    }
    profilePatch.role = nextRole;
  }

  let banChange: boolean | null = null;
  if (body.is_active !== undefined && body.is_active !== null) {
    if (typeof body.is_active !== 'boolean') return jsonResponse(400, { error: 'Estado invalido' }, req);
    if (selfEdit && body.is_active !== currentActive) {
      return jsonResponse(400, { error: 'No podes cambiar tu propio estado' }, req);
    }
    if (body.is_active !== currentActive) {
      profilePatch.is_active = body.is_active;
      banChange = !body.is_active;
    }
  }

  if (Object.keys(profilePatch).length === 0) {
    return jsonResponse(400, { error: 'No hay cambios para aplicar' }, req);
  }

  if (currentRole === 'super_admin') {
    const demoting = typeof profilePatch.role === 'string' && profilePatch.role !== 'super_admin';
    const deactivating = profilePatch.is_active === false;
    if (demoting || deactivating) {
      const others = await countOtherActiveSuperAdmins(userId, supabaseUrl, serviceKey);
      if (others === 0) {
        return jsonResponse(400, { error: 'No podes dejar el sistema sin un super_admin activo' }, req);
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
  if (!patchRes.ok) return jsonResponse(500, { error: 'No se pudo actualizar el perfil' }, req);

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

  // Auditoría: actualización de usuario por super_admin
  const changed = [];
  if (typeof profilePatch.full_name === 'string') changed.push('full_name');
  if (typeof profilePatch.phone === 'string') changed.push('phone');
  if (newEmail) changed.push('email');
  if (nextRole) changed.push('role');
  if (banChange !== null) changed.push('is_active');
  if (changed.length) {
    await auditSensitiveAction(
      supabaseClient,
      new Request('internal', { method: 'POST' }),
      'update_sensitive',
      'users',
      'user',
      userId,
      String(target.full_name) || newEmail,
      { oldRole: currentRole, oldActive: currentActive },
      { newRole: nextRole || currentRole, newActive: banChange === null ? currentActive : !banChange }
    );
  }

  return jsonResponse(200, { ok: true, userId, authMirror }, req);
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
  req: Request,
) {
  if (body.role !== undefined || body.is_active !== undefined) {
    return jsonResponse(400, { error: 'Tu rol y estado solo puede cambiarlos un super_admin' }, req);
  }

  const target = await fetchProfileRow(callerId, supabaseUrl, serviceKey);
  if (!target) return jsonResponse(404, { error: 'Usuario no encontrado' }, req);

  const profilePatch: Record<string, unknown> = {};
  if (typeof body.full_name === 'string') {
    const fullName = body.full_name.trim();
    if (!fullName) return jsonResponse(400, { error: 'El nombre completo es obligatorio' }, req);
    profilePatch.full_name = fullName;
  }
  if (typeof body.phone === 'string') {
    profilePatch.phone = body.phone.trim();
  }
  if (Object.keys(profilePatch).length === 0) {
    return jsonResponse(400, { error: 'No hay cambios para aplicar' }, req);
  }

  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(callerId)}`,
    {
      method: 'PATCH',
      headers: { ...serviceHeaders(serviceKey), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(profilePatch),
    },
  );
  if (!patchRes.ok) return jsonResponse(500, { error: 'No se pudo actualizar tu perfil' }, req);

  const meta: Record<string, string> = {};
  if (typeof profilePatch.full_name === 'string') meta.full_name = profilePatch.full_name;
  if (typeof profilePatch.phone === 'string') meta.phone = profilePatch.phone;
  const authMirror = await patchAuthUser(
    callerId,
    { user_metadata: meta },
    supabaseUrl,
    serviceKey,
  );

  return jsonResponse(200, { ok: true, userId: callerId, authMirror }, req);
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
    const rlResponse = await rateLimitMiddleware('manage-users', req);
    if (rlResponse) return rlResponse;

    // Validar JWT via Supabase Auth (verificación criptográfica real)
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse(401, { error: 'No autorizado' }, req);
    }
    const token = authHeader.slice(7);

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) {
      return jsonResponse(500, { error: 'Servidor mal configurado' }, req);
    }

    // Verificar JWT criptográficamente contra Supabase Auth
    const supabaseClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !user) {
      return jsonResponse(401, { error: 'No autorizado' }, req);
    }
    const userId = user.id;

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (_err) {
      return jsonResponse(400, { error: 'Body invalido' }, req);
    }

    /* Autogestion basica disponible para cualquier usuario autenticado;
       debe resolverse antes del gate super_admin. */
    if (body.action === 'update-self') {
      return await actionUpdateSelf(body, userId, supabaseUrl, serviceKey, req);
    }

    const admin = await isAdminUser(userId);
    if (!admin) {
      return jsonResponse(403, { error: 'Solo super_admin pueden gestionar usuarios' }, req);
    }

    if (body.action === 'invite') {
      const origin = (req.headers.get('origin') || '').replace(/\/+$/, '');
      return await actionInvite(body, supabaseUrl, serviceKey, origin, supabaseClient, req);
    }
    if (body.action === 'create-direct') {
      return await actionCreateDirect(body, supabaseUrl, serviceKey, supabaseClient, req);
    }
    if (body.action === 'set-role') {
      return await actionSetRole(body, userId, supabaseUrl, serviceKey, supabaseClient, req);
    }
    if (body.action === 'update-user') {
      return await actionUpdateUser(body, userId, supabaseUrl, serviceKey, supabaseClient, req);
    }
    return jsonResponse(400, { error: 'Accion desconocida' }, req);
  } catch (err) {
    console.error('manage-users error:', err);
    return jsonResponse(500, { error: 'Error interno gestionando usuarios' }, req);
  }
});