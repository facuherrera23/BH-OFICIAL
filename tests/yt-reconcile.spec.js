// ============================================================
// Reparación del incidente Shorts 27/10/2026
// ------------------------------------------------------------
// Los bytes llegaron a Google pero `complete` no se registró: el
// post quedó 'publishing' → 'failed' y cada reintento subía OTRO
// video. Estos guards cubren las tres capas del fix:
//   1. servidor: reconcile_upload + match 1:1 por título/fecha;
//   2. cliente: reconciliar ANTES de marcar fallo / reintentar;
//   3. sesión resumable en localStorage con TTL (sobrevive al cierre).
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/yt-harness');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'supabase/functions/social-youtube-studio/index.ts'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'assets/js/admin-contenido.js'), 'utf8');
const publish = fs.readFileSync(path.join(ROOT, 'assets/js/yt-publish.js'), 'utf8');

const ZOMBIE = {
  id: 'post-z',
  platform: 'youtube',
  status: 'publishing',
  content: { title: 'CASA EN VENTA –  Barrio Crisol Sud (Córdoba Capital)' },
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  published_at: null,
  external_post_id: null,
  external_url: null,
  error: null,
};
const FALLIDO = Object.assign({}, ZOMBIE, {
  status: 'failed',
  error: 'Subida interrumpida (el navegador se cerró antes de terminar).',
});
const VIDEO_EN_CANAL = {
  ok: true, found: true, video_id: 't5iS0Bi9GPE',
  url: 'https://www.youtube.com/watch?v=t5iS0Bi9GPE',
  status: 'published',
  title: 'CASA EN VENTA –  Barrio Crisol Sud (Córdoba Capital)',
};

test.describe('reconciliación de subidas — guards estáticos', () => {
  test('el servidor expone reconcile_upload, empareja 1:1 y audita', () => {
    expect(server).toContain("body.action === 'reconcile_upload'");
    expect(server).toContain('function mejorCoincidencia(');
    expect(server).toContain('function normTitle(');
    expect(server).toContain('huerfanoPorVideo');
    expect(server).toContain('30 * 60 * 1000');
    expect(server).toContain('yt_upload_reconciled');
    expect(server).toContain('reconciliadosSubidas');
    /* La reconciliación es SÓLO lectura de YouTube + update de la fila
       existente: nunca crea otra publicación (audit_log sí se escribe). */
    const from = server.indexOf("body.action === 'reconcile_upload'");
    const to = server.indexOf("body.action === 'videos_sync_public'");
    const block = server.slice(from, to);
    expect(block).not.toContain(".from('social_posts').insert(");
    expect(block).toContain(".from('social_posts').update({");
    /* Vincular en forma manual, uno por uno, no puede robarle el video a
       otro post: se excluyen los videos ya vinculados del canal. */
    expect(block).toContain("const vedados = new Set((vinculados ?? []).map(");
    expect(block).toContain('mejorCoincidencia(title, post.created_at, vids, vedados)');
  });

  test('el emparejamiento 1:1 es único por AMBOS lados y globalmente cercano', () => {
    /* 3 shorts con el MISMO título: el emparejamiento voraz por filas dejaba
       un post a 2 min del suyo; el global por distancia asigna los 3. */
    expect(server).toContain('pares.sort((a, b) => a.diff - b.diff)');
    expect(server).toContain('postsUsados.has(par.post.id) || huerfanoPorVideo.has(par.vid)');
    expect(server).toContain('esMismoVideo(');
  });

  test('el cliente reconcilia antes de marcar fallo y antes de reintentar', () => {
    const catchAt = ui.indexOf("logError('Contenido: publish', err)");
    const failAt = ui.indexOf("CORE.api.publish('fail'", catchAt);
    const reconcileAt = ui.indexOf('const ya = await reconcileUpload(postId)', catchAt);
    expect(catchAt).toBeGreaterThan(-1);
    expect(failAt).toBeGreaterThan(catchAt);
    expect(reconcileAt).toBeGreaterThan(catchAt);
    expect(reconcileAt).toBeLessThan(failAt);

    const sweepAt = ui.indexOf('PASO 1: reconciliar ANTES del update');
    const sweepRecon = ui.indexOf('const ya = await reconcileUpload(z.id)', sweepAt);
    const sweepFail = ui.indexOf(".update({ status: 'failed', error: 'Subida interrumpida", sweepAt);
    expect(sweepAt).toBeGreaterThan(-1);
    expect(sweepRecon).toBeGreaterThan(sweepAt);
    expect(sweepFail).toBeGreaterThan(sweepRecon);

    expect(ui).toContain('data-yt-reconcile');
    expect(ui).toContain('function reconcileFromHistory(');
    /* El reintento de YouTube NO carga el form sin antes preguntar por el
       video real en el canal (si matchea, vincula y no re-sube). */
    const retryAt = ui.indexOf('dataset.contenidoRetry');
    const retryRecon = ui.indexOf('reconcileUpload(p.id)', retryAt);
    expect(retryRecon).toBeGreaterThan(retryAt);
    expect(ui).toContain("p.platform === 'youtube' && !p.external_post_id");
  });

  test('la sesión resumable vive en localStorage y retoma desde el byte real', () => {
    expect(publish).toContain('RESUME_TTL_MS');
    expect(publish).toContain('storage.set(RESUME_KEY');
    expect(publish).not.toContain('storage.sessionSet(RESUME_KEY');
    expect(publish).toContain('ctx.startOffset');
    expect(publish).toContain('await queryUploadStatus(ctx, total)');
    expect(ui).toContain('startOffset: Math.max(0, Number(startOffset || 0))');
    expect(ui).toContain('YTPUB.resume.updateOffset(offset)');
    /* `complete` debe usar el postId de la sesión retomada, no el de un
       init que ya NO se llama al retomar. */
    expect(ui).not.toContain("publish('complete', { post_id: init.post_id");
  });
});

test.describe('reconciliación de subidas — navegador', () => {
  test('un zombie se reconcilia antes de marcarlo fallido', async ({ page }) => {
    const h = await boot(page, { posts: [ZOMBIE], reconcileResult: VIDEO_EN_CANAL });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await expect.poll(() => h.calls.reconcile_upload).toBeGreaterThan(0);
    expect(h.calls.fail).toBe(0); // jamás se marcó fallo
    const toasts = await page.evaluate(() => window.__TOASTS.join(' | '));
    expect(toasts).toContain('vinculamos');
    await expect(page.locator('#contenidoHistory')).toContainText('CASA EN VENTA');
  });

  test('el botón manual vincula una fila fallida sin volver a subir', async ({ page }) => {
    const h = await boot(page, { posts: [FALLIDO], reconcileResult: VIDEO_EN_CANAL });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await expect(page.locator('[data-yt-reconcile]')).toHaveCount(1);
    await page.locator('[data-yt-reconcile]').click();
    await expect.poll(() => h.calls.reconcile_upload).toBeGreaterThan(0);
    const toasts = await page.evaluate(() => window.__TOASTS.join(' | '));
    expect(toasts).toContain('Video vinculado');
    expect(h.calls.init).toBe(0);
  });

  test('reintentar un fallido ya subido NO vuelve a gastar la cuota de subida', async ({ page }) => {
    const h = await boot(page, { posts: [FALLIDO], reconcileResult: VIDEO_EN_CANAL });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await page.locator('[data-contenido-retry]').click();
    await expect.poll(() => h.calls.reconcile_upload).toBeGreaterThan(0);
    expect(h.calls.init).toBe(0);
    const toasts = await page.evaluate(() => window.__TOASTS.join(' | '));
    expect(toasts).toContain('No hace falta volver a subirlo');
  });

  test('la sesión resumable sobrevive a recargar la página', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const r = window.BH_YT.publish.resume;
      r.clear();
      r.save({ sessionUrl: 'http://x/session', postId: 'post-1', fileName: 'v.mp4', fileSize: 10, title: 'T', offset: 4096 });
    });
    expect(await page.evaluate(() => localStorage.getItem('bh_yt_upload_resume'))).toContain('post-1');
    await page.reload();
    await page.addScriptTag({ url: '/assets/js/yt-core.js' });
    await page.addScriptTag({ url: '/assets/js/yt-publish.js' });
    const r = await page.evaluate(() => window.BH_YT.publish.resume.load());
    expect(r && r.postId).toBe('post-1');
    expect(r && r.offset).toBe(4096);
  });

  test('una sesión vencida (URL de Google ya muerta) se descarta', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      localStorage.setItem('bh_yt_upload_resume', JSON.stringify({
        sessionUrl: 'http://x/session', postId: 'viejo',
        savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      }));
    });
    const r = await page.evaluate(() => window.BH_YT.publish.resume.load());
    expect(r).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('bh_yt_upload_resume'))).toBeNull();
  });

  test('al retomar una sesión NO se llama init y complete usa el post guardado', async ({ page }) => {
    const h = await boot(page, { uploadStatus: 200 });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Video para retomar');
    const buffer = Buffer.from('contenido-video');
    await page.setInputFiles('#ytFile', { name: 'video.mp4', mimeType: 'video/mp4', buffer });
    await page.evaluate((size) => {
      window.BH_YT.publish.resume.save({
        sessionUrl: 'http://localhost:8788/fake-upload-session',
        postId: 'post-resume', fileName: 'video.mp4', fileSize: size,
        title: 'Video para retomar', offset: 0,
      });
    }, buffer.length);
    await page.click('#ytPublishBtn');
    await expect.poll(() => h.calls.complete).toBeGreaterThan(0);
    expect(h.calls.init).toBe(0);
    const complete = h.requests.find((r) => r.fn === 'publish' && r.body.action === 'complete');
    expect(complete.body.post_id).toBe('post-resume');
    expect(complete.body.video_id).toBe('vid-uploaded-1');
  });
});
