// ============================================================
// backup-snapshot (cron diario 04:00 ART): snapshot lógico automático
// de las tablas de negocio → bucket privado `backups` de Supabase
// Storage, con retención de 30 días.
//
// El plan free de Supabase NO incluye backups automáticos; este cron
// es la red diaria (docs/BACKUPS.md). El pg_dump semanal del runbook
// sigue siendo el backup estructural completo.
//
// Auth: header x-sync-secret (compartido con zernio-sync, guardado en
// zernio_config key='sync_secret') — solo pg_cron lo conoce.
//
// DEPLOY: supabase functions deploy backup-snapshot --no-verify-jwt
// CRON: ver migración 20261010000002_backup_snapshot_cron.sql
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || '';
const BUCKET = 'backups';
const RETENCION_DIAS = 30;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});

function log(level: string, entry: Record<string, unknown>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, function: 'backup-snapshot', ...entry }));
}

function respond(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function getSyncSecret(): Promise<string> {
    const { data } = await supabase.from('zernio_config').select('value').eq('key', 'sync_secret').maybeSingle();
    return data?.value?.secret || '';
}

Deno.serve(async (req: Request) => {
    if (req.method !== 'POST') return respond(405, { error: 'Method not allowed' });

    const secret = await getSyncSecret();
    if (secret && req.headers.get('x-sync-secret') !== secret) {
        return respond(401, { error: 'No autorizado' });
    }

    try {
        const { data, error } = await supabase.rpc('backup_build_snapshot');
        if (error) {
            log('error', { op: 'backup_build_snapshot', error: error.message });
            return respond(500, { ok: false, error: error.message });
        }

        // PostgREST devuelve jsonb ya parseado como objeto (o string según cliente)
        const snapshot = typeof data === 'string' ? JSON.parse(data) : data;

        const ahora = new Date();
        const stamp = ahora.toISOString().slice(0, 10);
        const path = `snapshot-${stamp}.json`;
        const contenido = JSON.stringify({
            generated_by: 'backup-snapshot',
            generated_at: ahora.toISOString(),
            data: snapshot,
        });

        const { error: uploadErr } = await supabase.storage
            .from(BUCKET)
            .upload(path, new TextEncoder().encode(contenido), {
                contentType: 'application/json',
                upsert: true,
            });

        if (uploadErr) {
            log('error', { op: 'upload', path, error: uploadErr.message });
            return respond(500, { ok: false, error: uploadErr.message });
        }

        // Retención: borrar snapshots > 30 días
        let pruned = 0;
        const { data: files } = await supabase.storage
            .from(BUCKET)
            .list('', { limit: 100, sortBy: { column: 'name', order: 'asc' } });
        const limite = new Date(ahora.getTime() - RETENCION_DIAS * 86400000).toISOString().slice(0, 10);
        const viejos = (files ?? [])
            .filter(f => f.name.startsWith('snapshot-') && f.name.slice(9, 19) < limite)
            .map(f => f.name);
        if (viejos.length > 0) {
            const { error: delErr } = await supabase.storage.from(BUCKET).remove(viejos);
            if (delErr) log('warn', { op: 'prune', error: delErr.message });
            else pruned = viejos.length;
        }

        const summary = { ok: true, archivo: path, bytes: contenido.length, podados: pruned };
        log('info', summary);
        return respond(200, summary);
    } catch (err) {
        log('error', { op: 'handler', error: (err as Error).message });
        return respond(500, { ok: false, error: (err as Error).message });
    }
});
