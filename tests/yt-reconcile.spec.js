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
const matching = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/youtube-matching.ts'), 'utf8');
const fichas = fs.readFileSync(path.join(ROOT, 'scripts/generate-ficha.mjs'), 'utf8');

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
    expect(server).toContain("from '../_shared/youtube-matching.ts'");
    expect(matching).toContain('export function mejorCoincidencia(');
    expect(matching).toContain('export function normTitle(');
    expect(matching).toContain('const VENTANA_MS = 30 * 60 * 1000');
    expect(server).toContain('huerfanoPorVideo');
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
    expect(block).toContain(".eq('account_id', post.account_id)");
    expect(block).toContain(".in('external_post_id', ids)");
    expect(block).toContain('mejorCoincidencia(title, post.created_at, vids, vedados, publishAt)');
    /* Sin inventario completo, un "not_found" sería mentira: no se marca
       fallo ni se vincula nada con el canal truncado. */
    expect(block).toContain("reason: 'incompleto'");
  });

  test('el emparejamiento 1:1 es único, global y óptimo (flujo de costo mínimo)', () => {
    /* 3 shorts con el MISMO título: el greedy por distancia podía dejar un
       huérfano sin match. El test unitario cubre el contraejemplo real. */
    expect(server).toContain('emparejarGlobal(');
    expect(matching).toContain('export function emparejarGlobal(');
    expect(matching).toContain('flujo de costo mínimo');
    expect(matching).toContain('export function esMismoVideo(');
  });

  test('la programación se usa como ancha alternativa y los borradores NO se promueven', () => {
    expect(matching).toContain('publishAt = \'\'');
    expect(matching).toContain('diffMs(pub, publishAt)');
    expect(server).toContain('estadoPublicado(uploadStatus, privacy, postContent)');
    expect(server).toContain('estadoPublicado(uploadStatus, privacy, prevContent)');
    expect(server).toContain('estadoPublicado(uploadStatus, privacy, huerfano.content)');
    expect(matching).toContain("if (content?.draft === true) return 'draft'");
    const publishServer = fs.readFileSync(path.join(ROOT, 'supabase/functions/social-publish-youtube/index.ts'), 'utf8');
    expect(publishServer).toContain('estadoPublicado(uploadStatus, privacyReal, postContent)');
    /* Un borrador/programado aunque tenga status='published' en el CRM
       NO se embebe en la ficha pública (misma regla del canal). */
    expect(fichas).toContain("select', 'property_id,external_post_id,content,metrics,published_at'");
    expect(fichas).toContain('splitChannelVideos(rows).visibles');
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
    /* El TTL se mide DESDE que nació la sesión: refrescar un chunk no
       puede revivir una URL de Google ya vencida. */
    expect(publish).toContain('createdAt: Date.now()');
    expect(publish).toContain('Number(cur.createdAt || cur.savedAt || 0)');
    expect(ui).toContain('startOffset: Math.max(0, Number(startOffset || 0))');
    expect(ui).toContain('YTPUB.resume.updateOffset(offset)');
    /* Si cambia la metadata del form, la sesión vieja se descarta. */
    expect(ui).toContain('function ytInitFingerprint(');
    expect(ui).toContain('prev.fingerprint === initFingerprint');
    expect(ui).toContain('fingerprint: initFingerprint');
    /* El sweep reconciliaba DOS veces: la segunda pasada reconsultaba los
       zombis ya marcados fallido y duplicaba el toast. */
    expect((ui.match(/const ya = await reconcileUpload\(z\.id\)/g) || []).length).toBe(1);
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
    /* El sweep del historial ya puede haber llamado a reconcile_upload: esperar
       por el CONTADOR daba un falso positivo (el toast del botón llegaba después). */
    await expect.poll(async () => page.evaluate(() => window.__TOASTS.join(' | '))).toContain('Video vinculado');
    expect(h.calls.reconcile_upload).toBeGreaterThan(0);
    expect(h.calls.init).toBe(0);
  });

  test('reintentar un fallido ya subido NO vuelve a gastar la cuota de subida', async ({ page }) => {
    const h = await boot(page, { posts: [FALLIDO], reconcileResult: VIDEO_EN_CANAL });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await page.locator('[data-contenido-retry]').click();
    await expect.poll(async () => page.evaluate(() => window.__TOASTS.join(' | '))).toContain('No hace falta volver a subirlo');
    expect(h.calls.reconcile_upload).toBeGreaterThan(0);
    expect(h.calls.init).toBe(0);
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

  test('refrescar un chunk NO extiende el TTL de la sesión resumable', async ({ page }) => {
    await boot(page);
    const tiempos = await page.evaluate(() => {
      const r = window.BH_YT.publish.resume;
      r.clear();
      r.save({ sessionUrl: 'http://x/session', postId: 'p-ttl', fileName: 'v.mp4', fileSize: 10, title: 'T', offset: 0 });
      const antes = JSON.parse(localStorage.getItem('bh_yt_upload_resume')).createdAt;
      r.updateOffset(4096);
      const despues = JSON.parse(localStorage.getItem('bh_yt_upload_resume'));
      return { antes, createdAt: despues.createdAt, savedAt: despues.savedAt };
    });
    expect(tiempos.createdAt).toBe(tiempos.antes);
    expect(tiempos.savedAt).toBeGreaterThanOrEqual(tiempos.antes);
    await page.evaluate(() => {
      const cur = JSON.parse(localStorage.getItem('bh_yt_upload_resume'));
      cur.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      cur.savedAt = Date.now(); // un chunk recién refinado NO la revive
      localStorage.setItem('bh_yt_upload_resume', JSON.stringify(cur));
    });
    expect(await page.evaluate(() => window.BH_YT.publish.resume.load())).toBeNull();
  });

  test('si cambió la metadata se descarta la sesión vieja y se hace un init nuevo', async ({ page }) => {
    const h = await boot(page, { uploadStatus: 200 });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Título nuevo');
    const buffer = Buffer.from('contenido-video-nuevo');
    await page.setInputFiles('#ytFile', { name: 'video.mp4', mimeType: 'video/mp4', buffer });
    await page.evaluate((size) => {
      window.BH_YT.publish.resume.save({
        sessionUrl: 'http://localhost:8788/fake-upload-session',
        postId: 'post-viejo', fileName: 'video.mp4', fileSize: size,
        title: 'Título viejo', fingerprint: 'metadata-vieja', offset: 0,
      });
    }, buffer.length);
    await page.click('#ytPublishBtn');
    await expect.poll(() => h.calls.complete).toBeGreaterThan(0);
    expect(h.calls.init).toBeGreaterThan(0);
    /* La sesión se limpia al terminar: verificamos el init NUEVO (con el
       título actual) y el post que usó `complete`, no el guardado final. */
    const init = h.requests.find((r) => r.fn === 'publish' && r.body.action === 'init');
    expect(init.body.title).toBe('Título nuevo');
    const complete = h.requests.find((r) => r.fn === 'publish' && r.body.action === 'complete');
    expect(complete.body.post_id).toBe('post-99');
  });
});
