// Auth compartido para Edge Functions que requieren usuario del panel (super_admin/broker/agente).
//
// Patrón: validar Bearer JWT -> getUser -> profiles role + is_active.
// Antes este patrón se duplicaba en 9 funciones; ahora se reusa desde aquí.
//
// Uso:
//   import { requireAdmin, isAdmin } from '../_shared/auth.ts';
//   const token = await requireAdmin(req, supabase);   // string | null
//   if (!token) return respond(401, { error: 'No autorizado' }, req);
//   // o
//   if (!(await isAdmin(req, supabase))) return respond(401, ...);
//
// NOTA: esta función permite CUALQUIER rol de panel activo (super_admin/broker/agente).
// Funciones que requieran super_admin exclusivamente deben añadir su propio
// chequeo (patrón verificado en manage-users/supervision-api/zernio-proxy).

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const ADMIN_ROLES = ['super_admin', 'broker', 'agente'] as const;
type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * Valida el Bearer JWT de la request contra `profiles`.
 * Devuelve el `token` si el usuario tiene perfil activo con rol en ADMIN_ROLES,
 * o `null` si la credencial falta, es inválida o no corresponde a un usuario
 * activo del panel.
 */
export async function requireAdmin(req: Request, supabase: SupabaseClient): Promise<string | null> {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;

    const { data: profile } = await supabase
        .from('profiles')
        .select('role, is_active')
        .eq('id', data.user.id)
        .maybeSingle();

    if (!profile || !profile.is_active) return null;
    if (!ADMIN_ROLES.includes(profile.role as AdminRole)) return null;

    return token;
}

/**
 * Wrapper booleano de `requireAdmin`. Útil cuando la función no necesita
 * reutilizar el token downstream (ej. para llamadas a la API de ML).
 */
export async function isAdmin(req: Request, supabase: SupabaseClient): Promise<boolean> {
    return (await requireAdmin(req, supabase)) !== null;
}
