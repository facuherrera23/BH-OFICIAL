import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
);

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
};

function respond(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'content-type': 'application/json' },
    });
}

async function isSuperAdmin(req: Request): Promise<string | null> {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const { data, error } = await supabase.auth.getUser(auth.slice(7));
    if (error || !data.user) return null;
    const { data: admins } = await supabase
        .from('admin_users')
        .select('role, is_active')
        .eq('id', data.user.id)
        .limit(1);
    const admin = admins?.[0];
    if (!admin || !admin.is_active || admin.role !== 'super_admin') return null;
    return data.user.id;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });

    const actorId = await isSuperAdmin(req);
    if (!actorId) return respond(401, { error: 'No autorizado (se requiere rol super_admin)' });

    let payload: Record<string, unknown>;
    try {
        payload = await req.json();
    } catch {
        return respond(400, { error: 'JSON inválido' });
    }

    const action = payload.action;

    try {
        if (action === 'invite') {
            const email = String(payload.email ?? '')
                .trim()
                .toLowerCase();
            const fullName = String(payload.full_name ?? '').trim();
            const role = String(payload.role ?? 'staff');

            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
                return respond(400, { error: 'Email inválido' });
            if (!fullName) return respond(400, { error: 'Nombre requerido' });
            if (!['super_admin', 'admin', 'staff', 'viewer'].includes(role)) {
                return respond(400, { error: 'Rol inválido' });
            }

            const { data: existing } = await supabase
                .from('admin_users')
                .select('id')
                .eq('email', email)
                .limit(1);
            if (existing && existing.length > 0) {
                return respond(409, { error: 'Ya existe un usuario con ese email' });
            }

            const { data: user, error: createError } = await supabase.auth.admin.createUser({
                email,
                email_confirm: true,
            });
            if (createError) return respond(500, { error: createError.message });
            if (!user) return respond(500, { error: 'No se pudo crear el usuario' });

            const { error: insertError } = await supabase.from('admin_users').insert({
                id: user.id,
                email,
                full_name: fullName,
                role,
                is_active: true,
                must_change_password: true,
            });
            if (insertError) {
                await supabase.auth.admin.deleteUser(user.id);
                return respond(500, { error: insertError.message });
            }

            const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
                type: 'recovery',
                email,
            });
            if (linkError) return respond(500, { error: linkError.message });

            await supabase.from('activity_log').insert({
                actor_id: actorId,
                action: 'create',
                entity_type: 'admin_user',
                metadata: { email, role },
            });

            return respond(200, {
                ok: true,
                link: linkData?.properties?.action_link ?? null,
                user_id: user.id,
            });
        }

        if (action === 'reset') {
            const email = String(payload.email ?? '')
                .trim()
                .toLowerCase();
            const { data: row } = await supabase
                .from('admin_users')
                .select('id')
                .eq('email', email)
                .limit(1);
            if (!row || row.length === 0) return respond(404, { error: 'Usuario no encontrado' });

            const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
                type: 'recovery',
                email,
            });
            if (linkError) return respond(500, { error: linkError.message });

            return respond(200, { ok: true, link: linkData?.properties?.action_link ?? null });
        }

        if (action === 'remove') {
            const email = String(payload.email ?? '')
                .trim()
                .toLowerCase();
            const { data: row } = await supabase
                .from('admin_users')
                .select('id, role')
                .eq('email', email)
                .limit(1);
            if (!row || row.length === 0) return respond(404, { error: 'Usuario no encontrado' });
            const target = row[0] as { id: string; role: string };

            if (target.id === actorId)
                return respond(400, { error: 'No podés eliminarte a vos mismo' });

            const { data: superAdmins } = await supabase
                .from('admin_users')
                .select('id')
                .eq('role', 'super_admin')
                .eq('is_active', true);
            if (target.role === 'super_admin' && (superAdmins?.length ?? 0) <= 1) {
                return respond(400, { error: 'Debe existir al menos un super_admin' });
            }

            await supabase.from('admin_users').delete().eq('id', target.id);
            await supabase.auth.admin.deleteUser(target.id);

            await supabase.from('activity_log').insert({
                actor_id: actorId,
                action: 'delete',
                entity_type: 'admin_user',
                metadata: { email },
            });

            return respond(200, { ok: true });
        }

        return respond(400, { error: 'Acción desconocida' });
    } catch (err) {
        console.error('admin-user-invite error', err);
        return respond(500, { error: (err as Error).message });
    }
});
