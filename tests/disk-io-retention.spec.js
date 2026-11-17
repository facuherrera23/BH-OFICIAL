// Guard del Disk IO Budget de Supabase (2026-11-16/17).
//
// CONTEXTO: el free tier agotó su "Disk IO Budget" (baseline 6 MB/s) porque
// tres tablas sin indexar creaban seq scans masivos:
//
//   1. ml_webhook_events (137k filas): get_sidebar_badge_counts() hacía
//      max(received_at) en seq scan por CADA llamada → 81 GB leídos.
//   2. ml_sync_queue (85k filas): sin índice por status, la cola de ML
//      crecía ~2.200 jobs/día y el panel la leía entera.
//   3. audit_log (161k filas, +5.000/día): el panel de supervisión hacía
//      seq scan + sort (11,5 s) y calculate_supervision_baselines() tardaba
//      19,5 s por corrida.
//
// Este spec es la RED DE SEGURIDAD: si alguien borra un índice crítico,
// desvía el cron de retención, deja de archivar antes de borrar, o vuelve a
// poner un .limit() silencioso en el Dashboard, el CI falla.
//
// Guard ESTÁTICO: lee el repo, NO toca la BD ni la red.
//
// REGLA DURA DEL PROYECTO: NADA SE BORRA SIN COPIA — todo lo que sale de una
// tabla operativa pasa primero por una tabla *_archive.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MIG_1 = 'supabase/migrations/20261117000001_disk_io_retention_indexes.sql';
const MIG_2 = 'supabase/migrations/20261117000002_io_alarm_retention_loop.sql';

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */

/** Indices que, si desaparecen, el Disk IO vuelve a explotar. */
const CRITICAL_INDEXES = [
  // ML: el badge del sidebar leía 137k filas por llamada (81 GB).
  'idx_ml_webhook_events_received_at',
  'idx_ml_webhook_events_status_received',
  // ML: cola sin índice por status → seq scan + backlog de 85k jobs.
  'idx_ml_sync_queue_status_created',
  'idx_ml_sync_history_created_at',
  // Supervisión: audit_log sin índice de fecha → seq scan + sort de 11,5 s.
  'idx_audit_log_created_cover',
  'idx_audit_log_module_created',
  // Landing + Dashboard: catálogo de publicadas (seq scan en cada visita).
  'idx_properties_published_created',
  'idx_properties_active_dashboard',
  'idx_properties_agent_id',
  // CRM + agenda + dashboard de agentes.
  'idx_leads_active_stage_created',
  'idx_visits_upcoming',
  'idx_agents_active',
  // Panel de propietarios y links lead↔propiedad.
  'idx_owner_tasks_owner_due_status',
  'idx_lead_properties_lead_id',
  // Chat Zernio.
  'idx_zernio_conv_open',
];

/** Tablas de archivo: RLS ON, sin policies, solo service_role. */
const ARCHIVE_TABLES = [
  'ml_sync_queue_success_archive',
  'ml_sync_history_success_archive',
  'ml_webhook_events_archive',
  'audit_log_archive',
];

/** Funciones de retención: SECURITY DEFINER + search_path fijo + permisos cerrados. */
const RETENTION_FNS = [
  'bh_archive_ml_sync_queue_success',
  'bh_archive_audit_log',
  'bh_archive_ml_webhook_events',
];

/** Tabla operativa → tabla de archivo donde se copia antes de borrar. */
const ARCHIVE_TARGET = {
  bh_archive_ml_sync_queue_success: ['ml_sync_queue', 'ml_sync_queue_success_archive'],
  bh_archive_audit_log: ['audit_log', 'audit_log_archive'],
  bh_archive_ml_webhook_events: ['ml_webhook_events', 'ml_webhook_events_archive'],
};

/** Quita los comentarios SQL (-- hasta el fin de línea) para no contarlos. */
function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

/** Devuelve el cuerpo de una función (bloque $fn$...$fn$) del SQL. */
function functionBody(sql, name) {
  const start = sql.indexOf(`FUNCTION public.${name}`);
  if (start === -1) return null;
  const from = sql.indexOf('$fn$', start);
  if (from === -1) return null;
  const to = sql.indexOf('$fn$', from + 4);
  if (to === -1) return null;
  return sql.slice(from + 4, to);
}

/** Verifica que la función archive ANTES de borrar de la tabla operativa. */
function archivesBeforeDelete(body, operationalTable, archiveTable) {
  const ins = body.indexOf(`INSERT INTO public.${archiveTable}`);
  const del = body.indexOf(`DELETE FROM public.${operationalTable}`);
  if (ins === -1 || del === -1) return false;
  return ins < del;
}

/** Devuelve el bloque de un cron (schedule → schedule + cuerpo $cron$...$cron$). */
function cronBlock(sql, jobname) {
  // El nombre aparece 2 veces: en el unschedule y en el schedule. Nos sirve
  // el que está dentro de un cron.schedule(...).
  let from = 0;
  let best = -1;
  for (;;) {
    const i = sql.indexOf(`'${jobname}'`, from);
    if (i === -1) break;
    if (sql.slice(Math.max(0, i - 200), i).includes('cron.schedule(')) {
      best = i;
      break;
    }
    from = i + 1;
  }
  if (best === -1) return null;
  const bodyStart = sql.indexOf('$cron$', best);
  if (bodyStart === -1) return null;
  const bodyEnd = sql.indexOf('$cron$', bodyStart + 6);
  if (bodyEnd === -1) return null;
  return sql.slice(best, bodyEnd + 6);
}

/* ------------------------------------------------------------------
   1. Las migraciones existen
   ------------------------------------------------------------------ */
test.describe('migraciones de Disk IO', () => {
  test('las 2 migraciones de retención/IO están en el repo', () => {
    expect(fs.existsSync(path.join(ROOT, MIG_1))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, MIG_2))).toBe(true);
  });
});

/* ------------------------------------------------------------------
   2. Índices críticos (el guard más importante)
   ------------------------------------------------------------------ */
test.describe('índices que matan los seq scans', () => {
  const mig = read(MIG_1);

  test('todos los índices críticos están declarados en la migración', () => {
    const missing = CRITICAL_INDEXES.filter(
      (i) => !new RegExp(`CREATE INDEX IF NOT EXISTS\\s+${i}\\b`).test(mig)
    );
    expect(missing, `índices críticos ausentes: ${missing.join(', ')}`).toEqual([]);
  });

  test('los índices se crean con IF NOT EXISTS (idempotente en producción)', () => {
    const bare = stripSqlComments(mig).match(/CREATE INDEX(?! IF NOT EXISTS)\s+\w+/g) || [];
    expect(bare, `CREATE INDEX sin IF NOT EXISTS: ${bare.join(', ')}`).toEqual([]);
  });

  test('el índice cubriente de audit_log incluye las columnas de los baselines', () => {
    // Sin INCLUDE, el cron horario hace heap fetch de 160k filas.
    expect(mig).toMatch(
      /idx_audit_log_created_cover[\s\S]*?INCLUDE\s*\(\s*module\s*,\s*user_id\s*,\s*action\s*,\s*status\s*\)/
    );
  });

  test('los índices de ML cubren status + received_at (los 2 seq scans)', () => {
    expect(mig).toMatch(
      /idx_ml_webhook_events_status_received[\s\S]*?ON public\.ml_webhook_events\s*\(\s*status\s*,\s*received_at DESC\s*\)/
    );
    expect(mig).toMatch(
      /idx_ml_webhook_events_received_at[\s\S]*?ON public\.ml_webhook_events\s*\(\s*received_at DESC\s*\)/
    );
  });

  test('la cola de ML tiene índice por status (el backlog de 85k jobs)', () => {
    expect(mig).toMatch(
      /idx_ml_sync_queue_status_created[\s\S]*?ON public\.ml_sync_queue\s*\(\s*status\s*,\s*created_at DESC\s*\)/
    );
  });
});

/* ------------------------------------------------------------------
   3. Tablas de archivo: RLS ON, sin policies, solo service_role
   ------------------------------------------------------------------ */
test.describe('tablas de archivo (nada se borra sin copia)', () => {
  const mig = read(MIG_1);

  test('las 4 tablas de archivo se crean en la migración', () => {
    for (const t of ARCHIVE_TABLES) {
      expect(mig, `falta la tabla ${t}`).toContain(`public.${t}`);
    }
  });

  test('cada tabla de archivo tiene RLS habilitado', () => {
    for (const t of ARCHIVE_TABLES) {
      expect(mig, `falta ENABLE ROW LEVEL SECURITY en ${t}`).toMatch(
        new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`)
      );
    }
  });

  test('ninguna tabla de archivo es accesible por anon/authenticated', () => {
    for (const t of ARCHIVE_TABLES) {
      expect(mig, `falta REVOKE en ${t}`).toMatch(
        new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM anon, authenticated`)
      );
    }
  });

  test('cada tabla de archivo es accesible por service_role', () => {
    for (const t of ARCHIVE_TABLES) {
      expect(mig, `falta GRANT en ${t}`).toMatch(
        new RegExp(`GRANT ALL ON public\\.${t}\\s+TO service_role`)
      );
    }
  });
});

/* ------------------------------------------------------------------
   4. Las funciones de retención: archivan antes de borrar + permisos
   ------------------------------------------------------------------ */
test.describe('funciones de retención', () => {
  const mig1 = read(MIG_1);
  const mig2 = read(MIG_2);

  test('cada función de retención existe en las migraciones', () => {
    for (const fn of RETENTION_FNS) {
      expect(mig1, `falta ${fn} en ${MIG_1}`).toContain(`FUNCTION public.${fn}`);
      expect(mig2, `falta ${fn} en ${MIG_2}`).toContain(`FUNCTION public.${fn}`);
    }
  });

  test('cada función es SECURITY DEFINER con search_path vacío', () => {
    for (const fn of RETENTION_FNS) {
      for (const [name, sql] of [['000001', mig1], ['000002', mig2]]) {
        const body = functionBody(sql, fn);
        expect(body, `no se encontró el cuerpo de ${fn} en ${name}`).not.toBeNull();
        const start = sql.indexOf(`FUNCTION public.${fn}`);
        const head = sql.slice(start, sql.indexOf('AS $fn$', start));
        expect(head, `${fn} en ${name} no es SECURITY DEFINER`).toContain('SECURITY DEFINER');
        expect(head, `${fn} en ${name} no fija search_path`).toMatch(/SET search_path\s*=\s*''/);
      }
    }
  });

  test('ARCHIVA ANTES de borrar (nada se borra sin copia)', () => {
    for (const [fn, [operational, archiveTable]] of Object.entries(ARCHIVE_TARGET)) {
      for (const [name, sql] of [['000001', mig1], ['000002', mig2]]) {
        const body = functionBody(sql, fn);
        expect(body, `no se encontró ${fn} en ${name}`).not.toBeNull();
        expect(
          archivesBeforeDelete(body, operational, archiveTable),
          `${fn} (${name}) borra de ${operational} sin archivar antes en ${archiveTable}`
        ).toBe(true);
      }
    }
  });

  test('la cola de ML archiva el HISTORIAL antes de la cola (FK DELETE CASCADE)', () => {
    const body = functionBody(mig2, 'bh_archive_ml_sync_queue_success');
    expect(body).not.toBeNull();
    const hist = body.indexOf('INSERT INTO public.ml_sync_history_success_archive');
    const queue = body.indexOf('INSERT INTO public.ml_sync_queue_success_archive');
    const del = body.indexOf('DELETE FROM public.ml_sync_queue');
    expect(hist).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    // El historial se copia ANTES del DELETE (que lo arrastra por CASCADE).
    expect(hist).toBeLessThan(del);
    expect(queue).toBeLessThan(del);
  });

  test('el purge histórico de ML también archiva antes de borrar', () => {
    const body = functionBody(mig1, 'purge_ml_webhook_events');
    expect(body).not.toBeNull();
    expect(archivesBeforeDelete(body, 'ml_webhook_events', 'ml_webhook_events_archive')).toBe(true);
  });

  test('ninguna función de retención es ejecutable por anon/authenticated', () => {
    for (const mig of [mig1, mig2]) {
      for (const fn of RETENTION_FNS) {
        const revokes = [
          ...mig.matchAll(
            new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`, 'g')
          ),
        ];
        expect(revokes.length, `falta REVOKE de ${fn}`).toBeGreaterThan(0);
      }
    }
    expect(mig2, 'falta REVOKE de bh_check_io_budget').toMatch(
      /REVOKE ALL ON FUNCTION public\.bh_check_io_budget\([^)]*\) FROM PUBLIC, anon, authenticated/
    );
  });

  test('las funciones de retención se otorgan a service_role', () => {
    for (const mig of [mig1, mig2]) {
      for (const fn of RETENTION_FNS) {
        expect(mig, `falta GRANT EXECUTE de ${fn} a service_role`).toMatch(
          new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`)
        );
      }
    }
    expect(mig2).toMatch(/GRANT EXECUTE ON FUNCTION public\.bh_check_io_budget\([^)]*\) TO service_role/);
  });

  test('la retención procesa LOTES (p_batches) para no dejar backlog', () => {
    const body = functionBody(mig2, 'bh_archive_audit_log');
    expect(body).not.toBeNull();
    expect(body).toContain('p_batches');
    expect(body).toMatch(/FOR v_i IN 1\.\.GREATEST\(p_batches, 1\) LOOP/);
  });
});

/* ------------------------------------------------------------------
   5. Crons: retención cada 6 h + alarma de IO cada hora
   ------------------------------------------------------------------ */
test.describe('crons', () => {
  const mig2 = read(MIG_2);

  test('el cron de retención existe y corre cada 6 horas', () => {
    const block = cronBlock(mig2, 'bh-archive-retention-daily');
    expect(block, 'no se encontró el cron de retención').not.toBeNull();
    expect(block).toContain("'15 */6 * * *'");
  });

  test('el cron de retención llama a las 3 funciones de archivado', () => {
    const block = cronBlock(mig2, 'bh-archive-retention-daily');
    expect(block).not.toBeNull();
    for (const fn of RETENTION_FNS) {
      expect(block, `el cron no llama a ${fn}`).toContain(`public.${fn}()`);
    }
  });

  test('la alarma de IO tiene cron horario', () => {
    const block = cronBlock(mig2, 'bh-io-budget-check-hourly');
    expect(block, 'no se encontró el cron de la alarma de IO').not.toBeNull();
    expect(block).toContain("'30 * * * *'");
    expect(block).toContain('public.bh_check_io_budget()');
  });

  test('los crons se reprograman (unschedule antes de schedule)', () => {
    expect(mig2).toContain(
      "SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'bh-archive-retention-daily'"
    );
    expect(mig2).toContain(
      "SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'bh-io-budget-check-hourly'"
    );
  });
});

/* ------------------------------------------------------------------
   6. Alarma de IO (mitigación A)
   ------------------------------------------------------------------ */
test.describe('alarma de Disk IO', () => {
  const mig2 = read(MIG_2);

  test('bh_check_io_budget es SECURITY DEFINER con search_path vacío', () => {
    const start = mig2.indexOf('FUNCTION public.bh_check_io_budget');
    expect(start).toBeGreaterThan(-1);
    const head = mig2.slice(start, mig2.indexOf('AS $fn$', start));
    expect(head).toContain('SECURITY DEFINER');
    expect(head).toMatch(/SET search_path\s*=\s*''/);
  });

  test('la alarma mide el ritmo de lectura de disco (pg_stat_database)', () => {
    const body = functionBody(mig2, 'bh_check_io_budget');
    expect(body).not.toBeNull();
    expect(body).toContain('pg_stat_database');
    expect(body).toContain('blks_read');
  });

  test('la alarma abre una alerta visible en el panel de Supervisión', () => {
    const body = functionBody(mig2, 'bh_check_io_budget');
    expect(body).toContain('public.supervision_alerts');
    expect(body).toContain("'disk_io_budget'");
  });

  test('la alarma se auto-resuelve cuando el IO vuelve al baseline', () => {
    const body = functionBody(mig2, 'bh_check_io_budget');
    expect(body).toMatch(/status\s*=\s*'resolved'/);
  });

  test('la tabla de muestras de IO tiene RLS y solo service_role', () => {
    expect(mig2).toContain('ALTER TABLE public.bh_io_samples ENABLE ROW LEVEL SECURITY');
    expect(mig2).toContain('REVOKE ALL ON public.bh_io_samples FROM anon, authenticated');
    expect(mig2).toContain('GRANT ALL ON public.bh_io_samples TO service_role');
  });
});

/* ------------------------------------------------------------------
   7. Cliente Supabase: timeout de red + realtime con throttle
   ------------------------------------------------------------------ */
test.describe('cliente supabase (timeout + realtime)', () => {
  const js = read('assets/js/supabase-client.js');

  test('el timeout de red es de 30 s (10 s cortaba los exports CSV)', () => {
    expect(js).toContain('AbortSignal.timeout(30000)');
    expect(js).not.toContain('AbortSignal.timeout(10000)');
  });

  test('el realtime tiene throttle (eventsPerSecond)', () => {
    expect(js).toMatch(/eventsPerSecond:\s*10/);
  });

  test('el schema de la DB es explícito (public)', () => {
    expect(js).toMatch(/db:\s*\{\s*schema:\s*'public'\s*\}/);
  });
});

/* ------------------------------------------------------------------
   8. Landing: selects explícitos y sin recorte silencioso
   ------------------------------------------------------------------ */
test.describe('landing público', () => {
  const js = read('assets/js/landing-app.js');
  const CATALOG_SELECT = ".select('id, title, property_code, status,";

  test('el catálogo de propiedades usa columnas explícitas', () => {
    expect(js).toContain(CATALOG_SELECT);
  });

  test('los únicos select(*) del landing son conteos (head: true, sin filas)', () => {
    // select('*') con head:true solo cuenta (no transfiere filas) → es seguro.
    const stars = [...js.matchAll(/\.select\('\*'([^)]*)\)/g)];
    expect(stars.length, 'no se encontró ningún select(*)').toBeGreaterThan(0);
    for (const m of stars) {
      expect(m[1], `select('*') sin head:true transfiere todas las columnas`).toContain('head');
    }
  });

  test('el select del catálogo trae TODAS las columnas que lee el modal', () => {
    // Si falta una, el modal abre con undefined (bug real: status/rooms/video_url).
    const idx = js.indexOf(CATALOG_SELECT);
    expect(idx).toBeGreaterThan(-1);
    const m = js.slice(idx).match(/\.select\('([^']+)'/);
    expect(m, 'no se encontró el select del catálogo').not.toBeNull();
    const cols = m[1].split(',').map((c) => c.trim());
    for (const col of ['status', 'rooms', 'year_built', 'video_url', 'description', 'image_urls', 'price_usd']) {
      expect(cols, `falta la columna ${col} en el select del catálogo`).toContain(col);
    }
  });

  test('el catálogo público NO recorta con .limit()', () => {
    // Un .limit() deja de mostrar propiedades publicadas (y rompe el SEO).
    const idx = js.indexOf(CATALOG_SELECT);
    expect(idx).toBeGreaterThan(-1);
    const end = js.indexOf(';', idx);
    const chunk = js.slice(idx, end === -1 ? idx + 1200 : end);
    expect(chunk).not.toContain('.limit(');
  });
});

/* ------------------------------------------------------------------
   10. Particionado de audit_log
   ------------------------------------------------------------------ */
test.describe('audit_log particionado por mes', () => {
  const MIG_3 = 'supabase/migrations/20261117000003_audit_log_partitioning.sql';
  const mig = read(MIG_3);

  test('la migración del particionado está en el repo', () => {
    expect(fs.existsSync(path.join(ROOT, MIG_3))).toBe(true);
  });

  test('audit_log es PARTITION BY RANGE (created_at)', () => {
    expect(mig).toMatch(/PARTITION BY RANGE\s*\(\s*created_at\s*\)/);
  });

  test('crea las particiones mensuales + una DEFAULT de seguridad', () => {
    for (const m of ['202609', '202610', '202611', '202612', '202701', '202702']) {
      expect(mig, `falta la partición audit_log_p${m}`).toContain(`public.audit_log_p${m}`);
    }
    expect(mig).toMatch(/PARTITION OF public\.audit_log_new DEFAULT/);
  });

  test('la PK es compuesta (id, created_at) — obligatoria en particionado', () => {
    expect(mig).toMatch(/ADD CONSTRAINT audit_log_new_pkey PRIMARY KEY \(id, created_at\)/);
    expect(mig).not.toMatch(/PRIMARY KEY \(id\)(?!,)/);
  });

  test('recrea los 11 índices del panel de supervisión', () => {
    for (const ix of [
      'idx_audit_log_new_broker_id',
      'idx_audit_log_new_user_created_hash',
      'idx_audit_log_new_entity',
      'idx_audit_log_new_request',
      'idx_audit_log_new_session',
      'idx_audit_log_new_created_cover',
      'idx_audit_log_new_user_created',
      'idx_audit_log_new_module_created',
      'idx_audit_log_new_action_created',
      'idx_audit_log_new_status_created',
    ]) {
      expect(mig, `falta el índice ${ix}`).toContain(`CREATE INDEX IF NOT EXISTS ${ix}`);
    }
  });

  test('recrea las 4 policies (solo super_admin lee)', () => {
    expect(mig).toContain('CREATE POLICY audit_log_no_insert ON public.audit_log_new');
    expect(mig).toContain('CREATE POLICY audit_log_no_update ON public.audit_log_new');
    expect(mig).toContain('CREATE POLICY audit_log_no_delete ON public.audit_log_new');
    expect(mig).toContain('CREATE POLICY audit_log_super_admin_select ON public.audit_log_new');
  });

  test('las particiones quedan con RLS activa y sin acceso directo', () => {
    expect(mig).toMatch(/ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
    expect(mig).toMatch(/REVOKE ALL ON public\.%I FROM anon, authenticated/);
  });

  test('la tabla vieja NO se dropea (rollback instantáneo)', () => {
    expect(mig).toContain('ALTER TABLE public.audit_log RENAME TO audit_log_pre_part;');
    expect(mig).not.toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?(public\.)?audit_log\s*(;|CASCADE)/i);
  });

  test('el trigger de integridad se crea DESPUÉS de la copia (preserva hashes)', () => {
    const copyIdx = mig.indexOf('INSERT INTO public.audit_log_new');
    const trigIdx = mig.indexOf('CREATE TRIGGER audit_log_integrity');
    expect(copyIdx).toBeGreaterThan(-1);
    expect(trigIdx).toBeGreaterThan(-1);
    // Si el trigger existiera durante la copia, recalcularía los hashes
    // históricos al insertar y rompería la cadena event_hash/previous_hash.
    expect(trigIdx, 'el trigger se crea antes de la copia: rompe la cadena de hashes').toBeGreaterThan(
      copyIdx
    );
  });

  test('el trigger preserva el hash si la fila ya lo trae (copia entre particiones)', () => {
    expect(mig).toMatch(/IF NEW\.event_hash IS NOT NULL THEN\s*RETURN NEW;/);
  });

  test('la vista purge_audit_log se recrea con security_invoker (no saltea RLS)', () => {
    expect(mig).toMatch(/CREATE VIEW public\.purge_audit_log\s*\nWITH \(security_invoker = true\)/);
  });

  test('las particiones futuras se crean solas (función + cron)', () => {
    expect(mig).toContain('FUNCTION public.bh_ensure_audit_log_partitions');
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.bh_ensure_audit_log_partitions\(integer\)\s*\n?\s*FROM PUBLIC, anon, authenticated/
    );
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.bh_ensure_audit_log_partitions(integer) TO service_role');
    expect(mig).toContain("'bh-audit-log-partitions-daily'");
  });

  test('la función de particiones tiene guarda: no toca una tabla no particionada', () => {
    expect(mig).toMatch(/FROM pg_partitioned_table WHERE partrelid = 'public\.audit_log'::regclass/);
  });
});

/* ------------------------------------------------------------------
   9. Dashboard admin: los KPI no pueden truncarse
   ------------------------------------------------------------------ */
test.describe('dashboard admin', () => {
  const js = read('assets/js/admin-app.js');

  /** Devuelve la cadena de una query concreta dentro de loadDashboard(). */
  function dashboardQuery(table) {
    const dashStart = js.indexOf('async function loadDashboard()');
    expect(dashStart, 'no se encontró loadDashboard()').toBeGreaterThan(-1);
    const start = js.indexOf(`client.from('${table}')`, dashStart);
    if (start === -1) return null;
    const next = js.indexOf('client.from(', start + 20);
    const end = next === -1 ? start + 2000 : next;
    return js.slice(start, end);
  }

  test('las queries de propiedades/leads del dashboard no usan .limit()', () => {
    const props = dashboardQuery('properties');
    const leads = dashboardQuery('leads');
    expect(props, 'no se encontró la query de properties').not.toBeNull();
    expect(leads, 'no se encontró la query de leads').not.toBeNull();
    // Un tope trunca en silencio el SUM(price_usd) de TODAS las properties.
    expect(props, 'la query de properties del dashboard tiene .limit()').not.toContain('.limit(');
    expect(leads, 'la query de leads del dashboard tiene .limit()').not.toContain('.limit(');
  });

  test('la query de properties del dashboard usa columnas explícitas', () => {
    const props = dashboardQuery('properties');
    expect(props).toContain("select('price_usd");
    expect(props).not.toContain("select('*'");
  });

  test('deja el comentario de advertencia para quien edite esto después', () => {
    const start = js.indexOf('async function loadDashboard()');
    const rest = js.slice(start);
    const end = rest.search(/\n  (async )?function [A-Za-z_$]/);
    const block = end === -1 ? rest : rest.slice(0, end);
    expect(block).toContain('.limit()');
    expect(block.toLowerCase()).toContain('trunca');
  });
});
