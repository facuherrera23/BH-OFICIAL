// ============================================================
// Privacidad de la página pública del canal + sincronización
// ------------------------------------------------------------
// La página /canal.html es indexable y comparte links → sólo puede
// mostrar videos PÚBLICOS de YouTube. Un row de social_posts con
// status='published' NO implica que el video sea público (puede ser
// "unlisted" o un video programado que sigue en privado).
//
// Cubre:
//   · la regla de privacidad (scripts/channel-privacy.mjs)
//   · el botón "Sincronizar canal" del Studio (videos_sync_public)
// ============================================================
const { test, expect } = require('@playwright/test');
const { boot } = require('./helpers/yt-harness');

let privacy;
test.beforeAll(async () => {
  privacy = await import('../scripts/channel-privacy.mjs');
});

test.describe('Regla de privacidad del canal', () => {
  test('un video público entra en la página pública', async () => {
    expect(privacy.isPublicChannelVideo({ metrics: { youtube_privacy: 'public' } })).toBe(true);
  });

  test('un video oculto (unlisted) NO entra', async () => {
    expect(privacy.isPublicChannelVideo({ metrics: { youtube_privacy: 'unlisted' } })).toBe(false);
  });

  test('un video privado NO entra', async () => {
    expect(privacy.isPublicChannelVideo({ metrics: { youtube_privacy: 'private' } })).toBe(false);
  });

  test('sin dato de visibilidad NO entra (fail closed)', async () => {
    expect(privacy.isPublicChannelVideo({})).toBe(false);
    expect(privacy.isPublicChannelVideo({ metrics: {}, content: {} })).toBe(false);
  });

  test('sin metrics pero con content.privacy público, entra (filas viejas)', async () => {
    expect(privacy.isPublicChannelVideo({ content: { privacy: 'public' } })).toBe(true);
    expect(privacy.isPublicChannelVideo({ content: { privacy: 'private' } })).toBe(false);
  });

  test('el dato real de YouTube manda sobre lo que pidió el dueño', async () => {
    /* El dueño pidió "unlisted" pero YouTube terminó el video público
       (o al revés): manda metrics.youtube_privacy. */
    expect(privacy.isPublicChannelVideo({
      metrics: { youtube_privacy: 'public' },
      content: { privacy: 'unlisted' },
    })).toBe(true);
    expect(privacy.isPublicChannelVideo({
      metrics: { youtube_privacy: 'private' },
      content: { privacy: 'public' },
    })).toBe(false);
  });

  test('splitChannelVideos separa lo visible de lo excluido', async () => {
    const r = privacy.splitChannelVideos([
      { external_post_id: 'a', metrics: { youtube_privacy: 'public' } },
      { external_post_id: 'b', metrics: { youtube_privacy: 'private' } },
      { external_post_id: '' },
      null,
    ]);
    expect(r.visibles.map((x) => x.external_post_id)).toEqual(['a']);
    expect(r.excluidas).toEqual([{ id: 'b', privacy: 'private' }]);
  });
});

test.describe('Sincronización del canal con el CRM', () => {
  test('el Studio ofrece el botón "Sincronizar canal"', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioSyncChannel')).toHaveCount(1);
  });

  test('el botón llama a videos_sync_public y avisa el resultado', async ({ page }) => {
    const h = await boot(page, {
      syncResult: { importados: 3, actualizados: 12, reconciliados: 1, total: 15 },
    });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('#studioSyncChannel');
    await expect.poll(() => h.calls.videos_sync_public).toBe(1);
    const toasts = await page.evaluate(() => window.__TOASTS);
    const joined = toasts.join(' | ');
    expect(joined).toContain('3 videos nuevos');
    expect(joined).toContain('12 actualizados');
    expect(joined).toContain('1 que ya no están en el canal');
  });

  test('si el server falla, avisa el error y no deja el botón trabado', async ({ page }) => {
    await boot(page);
    /* La ruta se registra DESPUÉS del boot: en Playwright gana la última
       registrada y `fallback()` le devuelve el resto al harness. */
    await page.route('**/functions/v1/social-youtube-studio', async (route) => {
      const body = route.request().postDataJSON() || {};
      if (body.action === 'videos_sync_public') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'YouTube no devolvió la playlist de uploads' }),
        });
      }
      return route.fallback();
    });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('#studioSyncChannel');
    await expect(page.locator('#studioSyncChannel')).toContainText('Sincronizar canal');
    await expect(page.locator('#studioSyncChannel')).not.toHaveAttribute('disabled', /.*/);
    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.join(' | ')).toContain('No se pudo sincronizar');
  });
});
