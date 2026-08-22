// Auth compartido para Edge Functions que requieren admin staff/super_admin.
//
// PatrÃ³n: validar Bearer JWT -> getUser -> admin_users role + is_active.
// Antes este patrÃ³n se duplicaba en 9 funciones; ahora se reusa desde aquÃ­.
//
// Uso:
//   import { requireAdmin, isAdmin } from '../_shared/auth.ts';
//   const token = await requireAdmin(req, supabase);   // string | null
//   if (!token) return respond(401, { error: 'No autorizado' }, req);
//   // o
//   if (!(await isAdmin(req, supabase))) return respond(401, ...);

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const ADMIN_ROLES = ['super_admin', 'admin', 'staff'] as const;
type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * Valida el Bearer JWT de la request contra `admin_users`.
 * Devuelve el `token` si el usuario es un admin activo (rol en ADMIN_ROLES),
 * o `null` si la credencial falta, es invÃ¡lida o no corresponde a un admin activo.
 */
export async function requireAdmin(req: Request, supabase: SupabaseClient): Promise<string | null> {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;

    const { data: admins } = await supabase
        .from('admin_users')
        .select('role, is_active')
        .eq('id', data.user.id)
        .limit(1);

    const admin = admins?.[0];
    if (!admin || !admin.is_active) return null;
    if (!ADMIN_ROLES.includes(admin.role as AdminRole)) return null;

    return token;
}

/**
 * Wrapper booleano de `requireAdmin`. Ãštil cuando la funciÃ³n no necesita
 * reutilizar el token downstream (ej. para llamadas a la API de ML).
 */
export async function isAdmin(req: Request, supabase: SupabaseClient): Promise<boolean> {
    return (await requireAdmin(req, supabase)) !== null;
}
