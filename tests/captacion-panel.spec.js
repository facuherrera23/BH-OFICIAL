// Estado de captación — guard de la Fase 1 (2026-11-18).
//
// POR QUÉ ESTE GUARD: el 10/11/2026 Mercado Libre dejó de entregar consultas
// (0 eventos vis_leads desde entonces, 25 publicaciones activas) y NADIE lo
// notó: el panel de Portales decía "Conectado · 25 avisos activos" y nunca
// mostraba "¿cuándo fue la última consulta?". La misma clase de bug pasó con
// RELA: `rela_webhook_events` tiene 0 filas desde siempre (el callback nunca
// estuvo configurado) y el panel no lo decía.
//
// Este guard es estático: lee el repo, NO toca la BD ni la red.
//
// QUÉ PROTEGE:
//   1. Las funciones de captación existen y son SECDEF con search_path fijo.
//   2. La de ESCRITURA (la alarma) NO es ejecutable por anon/authenticated.
//   3. El cron de la alarma existe.
//   4. El panel existe y llama a la RPC con los 3 canales.
//   5. La alarma usa solo estados válidos del CHECK de supervision_alerts.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const mig = read('supabase', 'migrations', '20261118000003_captacion_health.sql');
const fix = read('supabase', 'migrations', '20261118000004_captacion_health_fix.sql');
const apiAlert = read('supabase', 'migrations', '20261122000001_rela_api_health_alert.sql');
const portales = read('assets', 'js', 'admin-portales.js');
const html = read('admin.html');

test.describe('estado de captación (Fase 1)', () => {
  test('las funciones de captación existen', () => {
    expect(mig).toContain('FUNCTION public.bh_captacion_status()');
    expect(mig).toContain('FUNCTION public.bh_check_captacion_health(');
  });

  test('ambas son SECURITY DEFINER con search_path fijo (evita search_path_mutable)', () => {
    expect(mig).toMatch(/bh_captacion_status\(\)[\s\S]*?SECURITY DEFINER\s+SET search_path = ''/);
    expect(mig).toMatch(/bh_check_captacion_health\([\s\S]*?SECURITY DEFINER\s+SET search_path = ''/);
  });

  test('la función de escritura (alarma) NO la puede ejecutar anon ni authenticated', () => {
    expect(mig).toContain(
      "REVOKE ALL ON FUNCTION public.bh_check_captacion_health(integer, integer) FROM PUBLIC, anon, authenticated"
    );
    expect(mig).toContain(
      "GRANT EXECUTE ON FUNCTION public.bh_check_captacion_health(integer, integer) TO service_role"
    );
    // El default privileges de Supabase re-otorgan authenticated: el revoke
    // explícito tiene que estar (en la migración y en el fix).
    expect(fix).toContain(
      "REVOKE ALL ON FUNCTION public.bh_check_captacion_health(integer, integer) FROM PUBLIC, anon, authenticated"
    );
  });

  test('la RPC de lectura la puede ejecutar authenticated (la usa el panel)', () => {
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.bh_captacion_status() TO authenticated, service_role');
    expect(mig).toContain("REVOKE ALL ON FUNCTION public.bh_captacion_status() FROM PUBLIC, anon");
  });

  test('el cron de la alarma existe y está activo', () => {
    expect(mig).toContain("'bh-captacion-health-hourly'");
    expect(mig).toMatch(/cron\.schedule\(\s*'bh-captacion-health-hourly'/);
  });

  test('la alarma solo usa estados válidos del CHECK de supervision_alerts', () => {
    // CHECK: open | acknowledged | resolved | dismissed
    // Ojo: \b para NO matchear `ml_status = 'active'`.
    const estados = [...mig.matchAll(/\bstatus\s*=\s*'([a-z]+)'/g)].map(m => m[1]);
    expect(estados.length).toBeGreaterThan(0);
    for (const e of estados) {
      expect(['open', 'acknowledged', 'resolved', 'dismissed']).toContain(e);
    }
  });

  test('el panel existe en admin.html y llama a la RPC', () => {
    expect(html).toContain('id="captacionPanel"');
    expect(html).toContain('id="captacionPanelBody"');
    expect(portales).toContain("rpc('bh_captacion_status')");
    expect(portales).toContain('loadCaptacionPanel()');
  });

  test('el panel muestra los 3 canales (ML, RELA, web)', () => {
    expect(portales).toContain("key: 'ml'");
    expect(portales).toContain("key: 'rela'");
    expect(portales).toContain("key: 'web'");
  });

  test('el panel escapa los datos que vienen de la RPC (regla del proyecto)', () => {
    const bloque = portales.slice(portales.indexOf('function captacionFila'), portales.indexOf('async function loadCaptacionPanel'));
    expect(bloque).toContain('esc(metricas)');
    expect(bloque).toContain('esc(ultimo)');
    expect(bloque).toContain('esc(hint)');
  });

  test('la RPC no filtra PII: solo conteos y fechas', () => {
    // Ni emails, ni teléfonos, ni nombres de leads en el JSON de salida.
    // ('whatsapp' sí aparece: es un ORIGEN de lead, no un dato personal.)
    expect(mig).not.toMatch(/email|phone|full_name/i);
    // Los únicos SELECT de la función son sobre ml_listings / ml_webhook_events
    // / rela_listings / rela_webhook_events / leads, y solo por agregados.
    expect(mig).toMatch(/count\(\*\)/);
    expect(mig).toMatch(/max\(received_at\)/);
    expect(mig).toMatch(/max\(created_at\)/);
  });
});

test.describe('alarma de API RELA caída (2026-11-22)', () => {
  test('la alarma abre desde last_error del cron fail-soft y se cierra sola', () => {
    expect(apiAlert).toContain("'rela_api_down'");
    expect(apiAlert).toMatch(/SELECT last_error, last_sync_at, base_url[\s\S]*?FROM public\.rela_config WHERE id = true/);
    expect(apiAlert).toMatch(/IF v_rela_api_error IS NOT NULL THEN/);
    expect(apiAlert).toMatch(/ELSIF v_open_alert > 0 THEN[\s\S]*?'rela_api_down' AND status = 'open'/);
    expect(apiAlert).toContain('Auto-resuelto: la API de RELA volvió a responder.');
  });

  test('no agrega cron ni edge function: reutiliza bh-captacion-health-hourly', () => {
    expect(apiAlert).not.toMatch(/cron\.schedule|NO_VERIFY|Deno\.serve/);
    expect(mig).toContain("'bh-captacion-health-hourly'");
  });

  test('mantiene la firma y los permisos de la función (anon/authenticated NO)', () => {
    expect(apiAlert).toMatch(/bh_check_captacion_health\(\s*p_ml_horas_sin_consultas integer DEFAULT 48,\s*p_rela_dias_sin_callbacks integer DEFAULT 7\s*\)/);
    expect(apiAlert).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
    expect(apiAlert).toContain(
      "REVOKE ALL ON FUNCTION public.bh_check_captacion_health(integer, integer) FROM PUBLIC, anon, authenticated"
    );
    expect(apiAlert).toContain(
      "GRANT EXECUTE ON FUNCTION public.bh_check_captacion_health(integer, integer) TO service_role"
    );
  });

  test('la alarma es de portales, severidad high y no expone credenciales', () => {
    const bloque = apiAlert.slice(apiAlert.indexOf('-- ---------- RELA API caída'), apiAlert.indexOf('RETURN jsonb_build_object'));
    expect(bloque).toContain("'portales'");
    expect(bloque).toContain("'high'");
    expect(bloque).not.toMatch(/client_secret|access_token|RELA_CLIENT_/i);
    expect(bloque).toMatch(/left\(v_rela_api_error, 500\)/);
  });
});
