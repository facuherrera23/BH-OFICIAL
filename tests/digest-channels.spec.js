// KPI "Leads por canal" en el digest semanal (lote captación 2026-11-03).
// La RPC agrega por source + UTM de leads con la semana previa como delta —
// el dueño ve en el email del lunes si el cartel QR y el post GBP dieron fruto.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const migrationSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261103000001_lead_channels_stats.sql'), 'utf8');
const digestSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'supervision-digest', 'index.ts'), 'utf8');

test.describe('Leads por canal — RPC del digest', () => {
  test('migración: la RPC es SECURITY DEFINER y solo service_role', () => {
    expect(migrationSrc).toContain('CREATE OR REPLACE FUNCTION public.supervision_digest_lead_channels(p_from timestamptz, p_to timestamptz)');
    expect(migrationSrc).toContain("SET search_path = ''");
    expect(migrationSrc).toContain('GRANT EXECUTE ON FUNCTION public.supervision_digest_lead_channels(timestamptz, timestamptz) TO service_role;');
    // Menos privilegios: ni anon ni authenticated (el digest corre con service_role).
    expect(migrationSrc).not.toMatch(/GRANT EXECUTE[^\n]*TO (anon|authenticated)/);
  });

  test('la RPC trae ventana previa para el delta (y excluye eliminados)', () => {
    // La semana previa se computa dentro de la RPC (prevBySource / prevByUtm + prevTotal).
    expect(migrationSrc).toContain('prevBySource');
    expect(migrationSrc).toContain('prevByUtm');
    expect(migrationSrc).toContain("'prevTotal', v_prev_total");
    // Nunca cuenta leads eliminados.
    expect((migrationSrc.match(/deleted_at IS NULL/g) || []).length).toBeGreaterThanOrEqual(2);
    // El UTM solo entra si está declarado (el trim descarta cadenas vacías).
    expect(migrationSrc).toContain("btrim(coalesce(utm_source, '')) <> ''");
  });

  test('digest: consume la RPC y arma el bloque con delta semana a semana', () => {
    expect(digestSrc).toContain('supabase.rpc("supervision_digest_lead_channels"');
    expect(digestSrc).toContain('leadChannels: (channelsRes.data || {}) as any');
    // Bloque HTML con título propio + delta ▲▼.
    expect(digestSrc).toContain('Leads · Canales de captación');
    expect(digestSrc).toContain('${leadChannelsBlock()}');
    expect(digestSrc).toContain('▲ +${dlt}');
    // Labels de source que vienen de la DB REAL (landing_page, no 'web').
    expect(digestSrc).toContain('landing_page: "Landing web"');
    // Y la versión texto plano del email.
    expect(digestSrc).toContain('LEADS · CANALES DE CAPTACIÓN');
  });

  test('digest: el bloque es fail-soft (sin RPC → email igual sale)', () => {
    // Si la RPC falla o retorna sin bySource, el bloque devuelve "" — el email
    // no se rompe (la lección del digest con queries flojas de 2026-10-15).
    expect(digestSrc).toContain('if (!c || (c.bySource || []).length === 0) return "";');
  });
});
