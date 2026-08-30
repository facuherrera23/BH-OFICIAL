import { createClient } from 'npm:@supabase/supabase-js@2';
import { jsonResponse, optionsResponse } from '../_shared/http.ts';
import { requireAdmin } from '../_shared/auth.ts';

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return optionsResponse(req);

    if (req.method !== 'POST') {
        return jsonResponse(405, { error: 'Method not allowed' }, req);
    }

    try {
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SERVICE_ROLE_KEY') ?? '',
            { auth: { persistSession: false } },
        );

        // Solo staff puede ejecutar purgas permanentes
        if (!(await requireAdmin(req, supabase))) {
            return jsonResponse(401, { error: 'No autorizado' }, req);
        }

        const now = new Date();

        // Obtener políticas de retención activas
        const { data: policies, error: policiesError } = await supabase
            .from('trash_retention_policies')
            .select('*')
            .eq('auto_delete_enabled', true);

        if (policiesError) throw policiesError;

        let notified = 0;
        let deleted = 0;

        for (const policy of policies ?? []) {
            if (!policy.auto_delete_enabled) continue;

            const cutoff = new Date(now.getTime() - policy.retention_days * 24 * 60 * 60 * 1000);
            const notifyCutoff = new Date(
                now.getTime() -
                    (policy.retention_days - policy.notify_before_days) * 24 * 60 * 60 * 1000,
            );

            // 1. Notificar items próximos a auto-eliminarse
            // (sin tabla `notifications` en el schema: se registra el conteo en logs)
            const { data: toNotify } = await supabase
                .from(policy.entity)
                .select('id')
                .not('deleted_at', 'is', null)
                .lte('deleted_at', notifyCutoff.toISOString())
                .gt('deleted_at', cutoff.toISOString());

            if (toNotify?.length) {
                notified += toNotify.length;
                console.log(
                    `[retention] ${toNotify.length} items en ${policy.entity} próximos a auto-eliminación (dentro de ${policy.notify_before_days} días)`,
                );
            }

            // 2. Auto-eliminar items vencidos
            const { data: toDelete } = await supabase
                .from(policy.entity)
                .select('id')
                .not('deleted_at', 'is', null)
                .lte('deleted_at', cutoff.toISOString());

            if (toDelete?.length) {
                deleted += toDelete.length;
                console.log(
                    `[retention] Auto-eliminando ${toDelete.length} items de ${policy.entity}`,
                );

                // Eliminar en batches para evitar timeouts
                const batchSize = 100;
                for (let i = 0; i < toDelete.length; i += batchSize) {
                    const batch = toDelete.slice(i, i + batchSize);
                    const ids = batch.map((d) => d.id);

                    const { error } = await supabase.from(policy.entity).delete().in('id', ids);

                    if (error) {
                        console.error(`[retention] Error eliminando batch:`, error);
                    }
                }
            }
        }

        return jsonResponse(200, { ok: true, processed: policies?.length ?? 0, notified, deleted }, req);
    } catch (err) {
        console.error('[process-retention-policies] Error:', err);
        return jsonResponse(500, { error: (err as Error).message }, req);
    }
});
