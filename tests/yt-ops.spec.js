// ============================================================
// Tests de OPERACIONES del canal (módulo CONTENIDO / YouTube)
// ------------------------------------------------------------
// Cubre el módulo assets/js/yt-ops.js:
//   · #29 semáforo de salud (conexión, permisos, inventario,
//     publicaciones fallidas, días sin publicar)
//   · #29 alerta en audit_log (una vez por día)
//   · #40 historial de acciones del módulo
// ============================================================
const { test, expect } = require('@playwright/test');
const { boot, VIDEO } = require('./helpers/yt-harness');

/* Los scopes van como literales dentro de page.evaluate (el callback corre
   en el navegador: no puede ver constantes de Node). */
const FORCE_SSL = 'https://www.googleapis.com/auth/youtube.force-ssl';
const ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';

test.describe('BH_YT.ops — semáforo de salud', () => {
  test('todo bien: la cuenta activa, con permisos y con videos', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => window.BH_YT.ops.health({
      account: { status: 'active', scope: "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly", display_name: 'Canal' },
      channel: { id: 'ch-1' },
      videos: [{ id: 'v1', published_at: new Date().toISOString() }],
      history: [],
      canManage: true,
    }));
    expect(r.level).toBe('ok');
    expect(r.checks.length).toBeGreaterThanOrEqual(5);
    expect(r.checks.every((c) => c.level === 'ok')).toBe(true);
  });

  test('conexión vencida = error', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => window.BH_YT.ops.health({
      account: { status: 'expired', scope: '' },
      channel: { id: 'ch-1' },
      videos: [],
      history: [],
      canManage: false,
    }));
    expect(r.level).toBe('error');
    const conn = r.checks.find((c) => c.id === 'connection');
    expect(conn.level).toBe('error');
    expect(conn.detail).toContain('Reconectá');
  });

  test('sin force-ssl = aviso (modo solo lectura), sin analytics = aviso', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => window.BH_YT.ops.health({
      account: { status: 'active', scope: "https://www.googleapis.com/auth/yt-analytics.readonly" },
      channel: { id: 'ch-1' },
      videos: [{ id: 'v1', published_at: new Date().toISOString() }],
      history: [],
      canManage: false,
    }));
    expect(r.level).toBe('warning');
    expect(r.checks.find((c) => c.id === 'manage').level).toBe('warning');
    expect(r.checks.find((c) => c.id === 'analytics').level).toBe('ok');
  });

  test('publicaciones fallidas = aviso con el número', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => window.BH_YT.ops.health({
      account: { status: 'active', scope: "https://www.googleapis.com/auth/youtube.force-ssl" },
      channel: { id: 'ch-1' },
      videos: [{ id: 'v1', published_at: new Date().toISOString() }],
      history: [{ status: 'failed' }, { status: 'failed' }],
      canManage: true,
    }));
    const failed = r.checks.find((c) => c.id === 'failed');
    expect(failed.level).toBe('warning');
    expect(failed.label).toContain('2');
  });

  test('canal parado hace más de 30 días = aviso', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => window.BH_YT.ops.health({
      account: { status: 'active', scope: "https://www.googleapis.com/auth/youtube.force-ssl" },
      channel: { id: 'ch-1' },
      videos: [{ id: 'v1', published_at: new Date(Date.now() - 45 * 86400000).toISOString() }],
      history: [],
      canManage: true,
    }));
    const cad = r.checks.find((c) => c.id === 'cadence');
    expect(cad.level).toBe('warning');
    expect(cad.label).toContain('45');
  });

  test('alertOnce avisa una vez por día (no spam)', async ({ page }) => {
    const h = await boot(page);
    const r = await page.evaluate(async () => {
      const a = window.BH_YT.ops;
      const res = a.health({
        account: { status: 'expired', scope: '' }, channel: {}, videos: [], history: [], canManage: false,
      });
      const uno = await a.alertOnce(res, 'acc-1');
      const dos = await a.alertOnce(res, 'acc-1');
      return { uno, dos };
    });
    expect(r.uno).toBe(true);
    expect(r.dos).toBe(false);
    const audits = h.requests.filter((x) => x.fn === 'studio' && x.body.action === 'audit_log');
    expect(audits.length).toBe(1);
    expect(audits[0].body.audit_action).toBe('yt_health_alert');
    expect(audits[0].body.module).toBe('contenido');
  });

  test('alertOnce no avisa si todo está bien', async ({ page }) => {
    const h = await boot(page);
    const ok = await page.evaluate(async () => window.BH_YT.ops.alertOnce(
      window.BH_YT.ops.health({
        account: {
          status: 'active',
          scope: 'https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly',
        },
        channel: { id: 'ch' },
        videos: [{ id: 'v', published_at: new Date().toISOString() }],
        history: [],
        canManage: true,
      }),
      'acc-1'
    ));
    expect(ok).toBe(false);
    expect(h.requests.filter((x) => x.fn === 'studio' && x.body.action === 'audit_log').length).toBe(0);
  });
});

test.describe('Operaciones en el panel', () => {
  test('el Studio muestra el semáforo de salud', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#ytHealthPanel')).toContainText('Salud del canal');
    await page.click('#ytHealthToggle');
    await expect(page.locator('#ytHealthPanel .yt-health-row')).toHaveCount(6);
  });

  test('una conexión sin el scope de analítica se ve en amarillo', async ({ page }) => {
    /* Ojo: con status 'expired' el Studio ni siquiera abre (no hay cuenta
       activa) — por eso el caso "conexión vencida" se testea sobre la
       función pura, y acá se prueba el estado de aviso. */
    await boot(page, { accountPatch: { scope: 'https://www.googleapis.com/auth/youtube.force-ssl' } });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#ytHealthPanel')).toContainText('Hay cosas para revisar');
  });

  test('el historial tiene el botón de acciones del módulo', async ({ page }) => {
    await boot(page, { posts: [{ id: 'p1', platform: 'youtube', status: 'published', content: { title: 'Video' }, created_at: '2026-10-20T10:00:00Z' }] });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await expect(page.locator('#ytAuditTrailBtn')).toHaveCount(1);
  });

  test('el modal de acciones lista las trazas del módulo', async ({ page }) => {
    await boot(page, {
      posts: [{ id: 'p1', platform: 'youtube', status: 'published', content: { title: 'Video' }, created_at: '2026-10-20T10:00:00Z' }],
      auditRows: [
        { id: 'a1', action: 'yt_publish_fail', module: 'contenido', status: 'error', error_code: 'YT_UPLOAD_FAIL', created_at: '2026-10-20T10:00:00Z', metadata: {} },
        { id: 'a2', action: 'yt_health_alert', module: 'contenido', status: 'success', created_at: '2026-10-21T10:00:00Z', metadata: { problems: ['connection: La conexión venció'] } },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await page.click('#ytAuditTrailBtn');
    await expect(page.locator('#ytAuditOverlay')).toHaveCount(1);
    await expect(page.locator('#ytAuditOverlay')).toContainText('yt_publish_fail');
    await expect(page.locator('#ytAuditOverlay')).toContainText('La conexión venció');
  });

  test('el modal de acciones avisa si no hay trazas', async ({ page }) => {
    await boot(page, {
      posts: [{ id: 'p1', platform: 'youtube', status: 'published', content: { title: 'Video' }, created_at: '2026-10-20T10:00:00Z' }],
    });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await page.click('#ytAuditTrailBtn');
    await expect(page.locator('#ytAuditOverlay')).toContainText('Todavía no hay acciones');
  });
});
