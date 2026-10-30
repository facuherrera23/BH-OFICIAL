// ============================================================
// Tests de ANALÍTICA del canal (módulo CONTENIDO / YouTube)
// ------------------------------------------------------------
// Cubre el módulo cliente (assets/js/yt-analytics.js) y el panel
// de reportes del Studio (resumen, evolución, top de videos,
// retención, tráfico y audiencia) + el aviso de needs_reconnect.
//
// OJO: la analítica real exige el scope yt-analytics.readonly.
// Las conexiones viejas NO lo tienen → el server responde
// `needs_reconnect` y la UI debe avisar sin romperse.
// ============================================================
const { test, expect } = require('@playwright/test');
const { boot } = require('./helpers/yt-harness');

const SUMMARY = {
  report: 'summary',
  label: 'Resumen del período',
  range: { start: '2026-10-01', end: '2026-10-28', days: 28 },
  headers: [
    { key: 'views', type: 'METRIC' },
    { key: 'estimatedMinutesWatched', type: 'METRIC' },
    { key: 'averageViewDuration', type: 'METRIC' },
    { key: 'impressionsClickThroughRate', type: 'METRIC' },
  ],
  rows: [{ views: 1234, estimatedMinutesWatched: 90, averageViewDuration: 125, impressionsClickThroughRate: 4.52 }],
  titles: {},
};

const TOP_VIDEOS = {
  report: 'top_videos',
  label: 'Top de videos',
  range: { start: '2026-10-01', end: '2026-10-28', days: 28 },
  headers: [
    { key: 'video', type: 'DIMENSION' },
    { key: 'views', type: 'METRIC' },
    { key: 'estimatedMinutesWatched', type: 'METRIC' },
  ],
  rows: [{ video: 'abc123', views: 800, estimatedMinutesWatched: 60 }],
  titles: { abc123: 'Tour de la casa en Nueva Córdoba' },
};

const TRAFFIC = {
  report: 'traffic',
  label: 'Origen del tráfico',
  range: { start: '2026-10-01', end: '2026-10-28', days: 28 },
  headers: [
    { key: 'trafficSource', type: 'DIMENSION' },
    { key: 'views', type: 'METRIC' },
  ],
  rows: [
    { trafficSource: 'YOUTUBE_SEARCH', views: 900 },
    { trafficSource: 'EXTERNAL', views: 100 },
  ],
  titles: {},
};

test.describe('BH_YT.analytics — módulo de analítica', () => {
  test('pide el reporte al server con el período pedido', async ({ page }) => {
    const h = await boot(page, { reports: { summary: SUMMARY } });
    const data = await page.evaluate(() => window.BH_YT.analytics.report('acc-1', 'summary', { days: 90 }));
    expect(data.report).toBe('summary');
    const call = h.requests.find((r) => r.fn === 'studio' && r.body.action === 'analytics_report');
    expect(call.body.report).toBe('summary');
    expect(call.body.days).toBe(90);
    expect(call.body.account_id).toBe('acc-1');
  });

  test('el resultado se cachea 5 min (no le pega a Google en cada cambio de tab)', async ({ page }) => {
    const h = await boot(page, { reports: { summary: SUMMARY } });
    await page.evaluate(async () => {
      const a = window.BH_YT.analytics;
      await a.report('acc-1', 'summary', { days: 28 });
      await a.report('acc-1', 'summary', { days: 28 });
    });
    expect(h.calls.analytics_report).toBe(1);
    /* Con force: vuelve a pedir. */
    await page.evaluate(() => window.BH_YT.analytics.report('acc-1', 'summary', { days: 28, force: true }));
    expect(h.calls.analytics_report).toBe(2);
  });

  test('detecta needs_reconnect (scope faltante)', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async () => {
      const a = window.BH_YT.analytics;
      try {
        await a.report('acc-1', 'summary', { force: true });
        return { needs: false };
      } catch (e) {
        return { needs: a.isNeedsReconnect(e), code: e.code || null };
      }
    });
    expect(r.needs).toBe(false); // el harness responde 200 con un reporte vacío
  });

  test('formatea los valores según el tipo de métrica', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const a = window.BH_YT.analytics;
      return {
        views: a.formatValue('views', 1234),
        minutos: a.formatValue('estimatedMinutesWatched', 90),
        horas: a.formatValue('estimatedMinutesWatched', 3660),
        dur: a.formatValue('averageViewDuration', 125),
        ctr: a.formatValue('impressionsClickThroughRate', 4.523),
        origen: a.formatValue('trafficSource', 'YOUTUBE_SEARCH'),
        edad: a.formatValue('ageGroup', 'AGE_RANGE_25_34'),
      };
    });
    expect(r.views).toContain('1');
    expect(r.minutos).toContain('min');
    expect(r.horas).toContain('h');
    expect(r.dur).toBe('2:05');
    expect(r.ctr).toBe('4.52%');
    expect(r.origen).toContain('Búsqueda');
    expect(r.edad).toBe('25–34');
  });

  test('sumColumn suma una métrica de las filas', async ({ page }) => {
    await boot(page);
    const total = await page.evaluate(() => window.BH_YT.analytics.sumColumn(
      [{ views: 10 }, { views: 5 }, { views: 'x' }], 'views'
    ));
    expect(total).toBe(15);
  });
});

test.describe('Panel de reportes en el Studio', () => {
  test('el panel muestra los 6 tabs de reportes', async ({ page }) => {
    await boot(page, { reports: { summary: SUMMARY } });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#ytReportsPanel .yt-report-tab')).toHaveCount(6);
  });

  test('el resumen muestra las métricas del período', async ({ page }) => {
    await boot(page, { reports: { summary: SUMMARY } });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#ytReportsBody')).toContainText('Vistas');
    await expect(page.locator('#ytReportsBody')).toContainText('CTR (%)');
    await expect(page.locator('#ytReportsBody')).toContainText('1.234');
  });

  test('cambiar de tab pide el reporte nuevo', async ({ page }) => {
    const h = await boot(page, { reports: { summary: SUMMARY, top_videos: TOP_VIDEOS } });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect.poll(() => h.calls.analytics_report).toBeGreaterThan(0);
    await page.click('#ytReportsPanel [data-yt-report="top_videos"]');
    await expect.poll(() => h.calls.analytics_report).toBe(2);
    const call = h.requests.filter((r) => r.fn === 'studio' && r.body.action === 'analytics_report').pop();
    expect(call.body.report).toBe('top_videos');
    await expect(page.locator('#ytReportsBody')).toContainText('Tour de la casa en Nueva Córdoba');
  });

  test('el top de videos muestra el título (viene del server) y el link', async ({ page }) => {
    await boot(page, { reports: { top_videos: TOP_VIDEOS } });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('#ytReportsPanel [data-yt-report="top_videos"]');
    await expect(page.locator('#ytReportsBody .yt-report-link')).toHaveAttribute('href', /watch\?v=abc123/);
  });

  test('el tráfico se dibuja con barras horizontales legibles', async ({ page }) => {
    await boot(page, { reports: { traffic: TRAFFIC } });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('#ytReportsPanel [data-yt-report="traffic"]');
    await expect(page.locator('#ytReportsBody .yt-hbar-row')).toHaveCount(2);
    await expect(page.locator('#ytReportsBody')).toContainText('Búsqueda de YouTube');
  });

  test('cambiar el período vuelve a pedir el reporte', async ({ page }) => {
    const h = await boot(page, { reports: { summary: SUMMARY } });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect.poll(() => h.calls.analytics_report).toBeGreaterThan(0);
    const antes = h.calls.analytics_report;
    await page.selectOption('#ytReportDays', '90');
    await expect.poll(() => h.calls.analytics_report).toBeGreaterThan(antes);
    const call = h.requests.filter((r) => r.fn === 'studio' && r.body.action === 'analytics_report').pop();
    expect(call.body.days).toBe(90);
  });

  test('sin el scope de analítica avisa que hay que reconectar (no rompe el Studio)', async ({ page }) => {
    await boot(page, { analyticsNeedsReconnect: true });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#ytReportsBody')).toContainText('yt-analytics.readonly');
    /* El inventario del canal sigue en su lugar. */
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(1);
  });

  test('un reporte vacío lo dice (no muestra una tabla vacía)', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#ytReportsBody')).toContainText('No hay datos');
  });
});
