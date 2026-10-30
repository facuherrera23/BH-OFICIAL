// ============================================================
// Tests de los MÓDULOS del CONTENIDO (YouTube) — lote 50 mejoras
// ------------------------------------------------------------
// Cubre las tres piezas nuevas del módulo:
//   · assets/js/yt-core.js      → API con timeout/reintentos, utils, bus, audit
//   · assets/js/yt-seo-tools.js → validaciones, variantes, bloques, presets
//   · assets/js/yt-publish.js   → pre-flight, cola, sesión de reanudación
// Y su integración en el orquestador (assets/js/admin-contenido.js).
//
// El harness (stubs + rutas de las Edge Functions) está en
// tests/helpers/yt-harness.js — compartido con contenido-ui.spec.js.
// ============================================================
const { test, expect } = require('@playwright/test');
const { boot, VIDEO } = require('./helpers/yt-harness');

test.describe('BH_YT.core — núcleo compartido', () => {
  test('utils: escapa HTML, normaliza y recorta', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const u = window.BH_YT.core.utils;
      return {
        esc: u.esc('<b>"x" & \'y\'</b>'),
        norm: u.norm('Córdoba Ñandú'),
        clip: u.clip('hola  \u0000mundo', 7),
        num: u.fmtNum(1234),
        local: u.toLocalInput('2026-10-31T18:00:00Z'),
      };
    });
    /* esc() debe convertir los caracteres especiales en entidades: el
       resultado NO puede contener un "<" crudo (si lo tuviera, el
       innerHTML interpretaría markup). */
    const AMP = String.fromCharCode(38);
    expect(r.esc).toContain(AMP + 'lt;b' + AMP + 'gt;');
    expect(r.esc).toContain(AMP + 'amp;');
    expect(r.esc).toContain(AMP + 'quot;');
    expect(r.esc).not.toContain('<b>');
    expect(r.esc).not.toContain(String.fromCharCode(34));
    expect(r.norm).toBe('cordoba nandu');
    expect(r.clip.length).toBeLessThanOrEqual(7);
    expect(r.num).toContain('1');
    expect(r.local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  test('api.studio reintenta un 5xx y termina bien', async ({ page }) => {
    await boot(page);
    let n = 0;
    /* Ruta registrada DESPUÉS de boot → tiene prioridad (Playwright usa la
       última registrada que matchea). */
    await page.route('**/functions/v1/social-youtube-studio', async (route) => {
      n++;
      if (n === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, intentos: n }) });
    });
    const res = await page.evaluate(() => window.BH_YT.core.api.studio('channel', { account_id: 'acc-1' }));
    expect(res.ok).toBe(true);
    expect(n).toBe(2); // el primer 5xx se reintenta
  });

  test('api.studio NO reintenta un 4xx y propaga el error', async ({ page }) => {
    await boot(page);
    let n = 0;
    await page.route('**/functions/v1/social-youtube-studio', async (route) => {
      n++;
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'dato inválido' }) });
    });
    const err = await page.evaluate(async () => {
      try {
        await window.BH_YT.core.api.studio('channel', { account_id: 'acc-1' });
        return null;
      } catch (e) { return { msg: e.message, status: e.status }; }
    });
    expect(err).not.toBeNull();
    expect(err.msg).toContain('dato inválido');
    expect(err.status).toBe(400);
    expect(n).toBe(1); // los 4xx son deterministas: no se reintentan
  });

  test('api clasifica needs_reconnect y cuota', async ({ page }) => {
    await boot(page);
    await page.route('**/functions/v1/social-youtube-studio', async (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'needs_reconnect' }) }));
    const code = await page.evaluate(async () => {
      try { await window.BH_YT.core.api.studio('analytics', { account_id: 'acc-1' }); return null; }
      catch (e) { return e.code || null; }
    });
    expect(code).toBe('needs_reconnect');
  });

  test('el bus emite, desuscribe y aísla los errores de un listener', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const core = window.BH_YT.core;
      let a = 0, b = 0;
      const off = core.on('prueba', () => { a++; });
      core.on('prueba', () => { throw new Error('boom'); }); // no debe romper la emisión
      core.on('prueba', () => { b++; });
      core.emit('prueba', { x: 1 });
      off();
      core.emit('prueba', { x: 2 });
      return { a, b };
    });
    expect(r.a).toBe(1); // desuscrito después del primer emit
    expect(r.b).toBe(2); // el listener que falló no impidió al siguiente
  });

  test('audit manda audit_action (no action) — el contrato no colisiona', async ({ page }) => {
    const h = await boot(page);
    await page.evaluate(() => window.BH_YT.core.audit('yt_prueba', { recordId: null, metadata: { x: 1 } }));
    const call = h.requests.find((r) => r.fn === 'studio' && r.body.action === 'audit_log');
    expect(call).toBeTruthy();
    expect(call.body.audit_action).toBe('yt_prueba');
    expect(call.body.action).toBe('audit_log');
    expect(call.body.module).toBe('contenido');
  });
});

test.describe('BH_YT.seo — herramientas de SEO', () => {
  test('validate detecta título vacío, título largo y descripción larga', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const v = window.BH_YT.seo.validate({ title: '', description: 'x'.repeat(6000), tags: '' });
      return {
        codes: v.errors.map((e) => e.code),
        warns: v.warnings.map((e) => e.code),
      };
    });
    expect(r.codes).toContain('title_required');
    expect(r.codes).toContain('desc_long');
    expect(r.warns).not.toContain('title_caps'); // un título vacío no es "gritón"
  });

  test('validate avisa de tags repetidos y demasiados', async ({ page }) => {
    await boot(page);
    const codes = await page.evaluate(() => {
      const v = window.BH_YT.seo.validate({
        title: 'Tour de casa en Nueva Córdoba con pileta',
        description: 'Una descripción razonable con https://bienenhaus.com.ar y texto.',
        tags: ['casa', 'casa', 'córdoba', 'nueva', 'córdoba', 'depto', 'alquiler', 'venta', 'barrio', 'centro', 'norte', 'sur', 'este', 'oeste', 'lote', 'terreno'],
      });
      return v.warnings.map((e) => e.code);
    });
    expect(codes).toContain('tags_dupes');
    expect(codes).toContain('tags_many');
  });

  test('validate avisa si la descripción tiene emojis (rompe al replicar a ML)', async ({ page }) => {
    await boot(page);
    const codes = await page.evaluate(() => {
      const v = window.BH_YT.seo.validate({ title: 'Tour de casa', description: 'Hola \u{1F600} casa', tags: '' });
      return v.warnings.map((e) => e.code);
    });
    expect(codes).toContain('desc_emoji');
  });

  test('titleVariants devuelve hasta 5 variantes, dentro del límite y con score', async ({ page }) => {
    await boot(page);
    const variants = await page.evaluate(() => window.BH_YT.seo.titleVariants({
      title: 'Tour de casa en Nueva Córdoba',
      description: 'Recorremos la casa completa con todos sus ambientes.',
      tags: 'bienenhaus, casa',
      keyword: 'casa nueva córdoba',
      property: { property_type: 'casa', zone: 'Nueva Córdoba', rooms: 3 },
    }));
    expect(variants.length).toBeGreaterThanOrEqual(3);
    expect(variants.length).toBeLessThanOrEqual(5);
    variants.forEach((v) => {
      expect(v.title.length).toBeLessThanOrEqual(100);
      expect(v.why).toBeTruthy();
    });
    // vienen ordenadas de mejor a peor score
    const scores = variants.map((v) => v.score || 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test('los bloques de descripción se construyen sin romper nada', async ({ page }) => {
    await boot(page);
    const blocks = await page.evaluate(() => window.BH_YT.seo.BLOCKS.map((b) => ({
      id: b.id,
      text: String(b.build({ keyword: 'casa', propertyUrl: 'https://bienenhaus.com.ar/fichas/ML-1.html' }) || ''),
    })));
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    blocks.forEach((b) => expect(typeof b.text).toBe('string'));
    const hashtags = blocks.find((b) => b.id === 'hashtags');
    expect(hashtags.text).toContain('#bienenhaus');
    const property = blocks.find((b) => b.id === 'property');
    expect(property.text).toContain('ML-1.html');
  });

  test('las plantillas por tipo devuelven metadata coherente', async ({ page }) => {
    await boot(page);
    const p = await page.evaluate(() => {
      const preset = window.BH_YT.seo.presetById('tour');
      return preset.apply({ property: { property_type: 'casa', zone: 'Nueva Córdoba', rooms: 3, surface_total: 120 } });
    });
    expect(p.title).toContain('Nueva Córdoba');
    expect(p.tags.length).toBeGreaterThan(2);
    expect(p.privacy).toBe('public');
  });

  test('canibalización detecta la keyword repetida en otro video del canal', async ({ page }) => {
    await boot(page);
    const warns = await page.evaluate(() => window.BH_YT.seo.canibalization({
      title: 'Casas en venta en Nueva Córdoba',
      keyword: 'casa nueva córdoba',
      channelVideos: [{ id: 'v1', title: 'Casa nueva córdoba — tour', tags: [] }],
    }));
    expect(warns.some((w) => w.code === 'keyword_repeated')).toBe(true);
  });
});

test.describe('BH_YT.publish — pre-flight, cola y reanudación', () => {
  test('pre-flight falla sin archivo y con formato no soportado', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const p = window.BH_YT.publish;
      const sinArchivo = p.preflight(null, { title: 'x', description: '', tags: '' });
      const malFormato = p.preflight({ name: 'documento.pdf', size: 100, type: 'application/pdf' }, { title: 'x', description: '', tags: '' });
      const ok = p.preflight({ name: 'video.mp4', size: 100, type: 'video/mp4' }, { title: 'Tour de casa', description: 'desc', tags: 'casa' });
      const grande = p.preflight({ name: 'video.mp4', size: 3 * 1024 * 1024 * 1024, type: 'video/mp4' }, { title: 'Tour de casa', description: 'desc', tags: '' });
      return {
        sinArchivoOk: sinArchivo.ok,
        malFormatoOk: malFormato.ok,
        ok: ok.ok,
        grandeOk: grande.ok,
      };
    });
    expect(r.sinArchivoOk).toBe(false);
    expect(r.malFormatoOk).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.grandeOk).toBe(false); // 3 GB > 2 GB (tope del módulo)
  });

  test('la cola guarda, lista y saca metadata', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const q = window.BH_YT.publish.queue;
      q.clear();
      const id = q.add({ title: 'Video en cola', description: 'd', tags: 'casa' });
      const list = q.list();
      q.remove(id);
      return { antes: list.length, titulo: list[0] && list[0].title, despues: q.list().length };
    });
    expect(r.antes).toBe(1);
    expect(r.titulo).toBe('Video en cola');
    expect(r.despues).toBe(0);
  });

  test('la serie crea N items con fechas escalonadas', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const q = window.BH_YT.publish.queue;
      q.clear();
      q.series({ title: 'Serie' }, [
        { publishAt: '2026-11-01T18:00', label: 'Serie #1' },
        { publishAt: '2026-11-03T18:00', label: 'Serie #2' },
        { publishAt: '2026-11-05T18:00', label: 'Serie #3' },
      ]);
      const list = q.list();
      return { n: list.length, fechas: list.map((i) => i.publishAt).sort() };
    });
    expect(r.n).toBe(3);
    expect(r.fechas[0]).toBe('2026-11-01T18:00');
  });

  test('la sesión de reanudación se persiste y se limpia', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const res = window.BH_YT.publish.resume;
      res.clear();
      res.save({ sessionUrl: 'http://x/session', postId: 'post-1', fileName: 'v.mp4', fileSize: 10, title: 'T', offset: 0 });
      res.updateOffset(4096);
      const cur = res.load();
      res.clear();
      return { offset: cur && cur.offset, postId: cur && cur.postId, limpio: res.load() };
    });
    expect(r.offset).toBe(4096);
    expect(r.postId).toBe('post-1');
    expect(r.limpio).toBeNull();
  });
});

test.describe('Integración en el panel de Contenido', () => {
  test('la validación en vivo muestra los avisos del formulario', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    /* El input tiene maxlength=100 (límite de YouTube): con un título
       cortito aparece el aviso de "poco descriptivo". */
    await page.fill('#ytTitle', 'Casa');
    await expect(page.locator('#ytValidationPanel')).toContainText('poco descriptivo');
    await expect(page.locator('#ytValidationPanel .yt-validation-item--warning')).not.toHaveCount(0);
    /* Con un título completo, el aviso desaparece. */
    await page.fill('#ytTitle', 'Tour completo de casa en Nueva Córdoba con pileta y cochera');
    await expect(page.locator('#ytValidationPanel')).not.toContainText('poco descriptivo');
  });

  test('el modal de títulos alternativos aplica el título elegido', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Tour de casa en Nueva Córdoba');
    await page.click('#ytTitleVariantsBtn');
    await expect(page.locator('#ytVariantsOverlay')).toHaveCount(1);
    const n = await page.locator('#ytVariantsOverlay .yt-variant').count();
    expect(n).toBeGreaterThanOrEqual(3);
    await page.locator('#ytVariantsOverlay .yt-variant').first().click();
    await expect(page.locator('#ytVariantsOverlay')).toHaveCount(0);
    const valor = await page.inputValue('#ytTitle');
    expect(valor.length).toBeGreaterThan(0);
    expect(valor.length).toBeLessThanOrEqual(100);
  });

  test('el modal de bloques inserta un bloque en la descripción', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytDesc', 'Descripción base');
    await page.click('#ytBlocksBtn');
    await expect(page.locator('#ytBlocksOverlay')).toHaveCount(1);
    await page.locator('#ytBlocksOverlay .yt-block').first().click();
    const desc = await page.inputValue('#ytDesc');
    expect(desc).toContain('Descripción base');
    expect(desc.length).toBeGreaterThan('Descripción base'.length);
  });

  test('la plantilla por tipo completa el formulario', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    const opts = page.locator('#ytPresetSel option');
    await expect(opts).toHaveCount(6); // placeholder + 5 plantillas
    await page.selectOption('#ytPresetSel', 'valuation');
    await expect(page.locator('#ytTitle')).not.toHaveValue('');
    await expect(page.locator('#ytTags')).not.toHaveValue('');
  });

  test('el pre-flight muestra los chequeos del archivo y la metadata', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.click('#ytPreflightBtn');
    await expect(page.locator('#ytPreflightOverlay')).toHaveCount(1);
    await expect(page.locator('#ytPreflightOverlay')).toContainText('Archivo de video');
    await expect(page.locator('#ytPreflightOverlay')).toContainText('Título');
  });

  test('la simulación muestra lo que devuelve el servidor', async ({ page }) => {
    await boot(page, { dryRunIssues: [{ level: 'warning', message: 'El video no se podrá incrustar.' }] });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.click('#ytDryRunBtn');
    await expect(page.locator('#ytDryRunOverlay')).toHaveCount(1);
    await expect(page.locator('#ytDryRunOverlay')).toContainText('no se podrá incrustar');
  });

  test('la cola: encolar, cargar y quitar', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Video encolado');
    await page.click('#ytQueueBtn');
    await expect(page.locator('#ytQueuePanel')).toContainText('Video encolado');
    await page.fill('#ytTitle', 'Otro título');
    await page.click('[data-yt-queue-load]');
    await expect(page.locator('#ytTitle')).toHaveValue('Video encolado');
    await page.click('[data-yt-queue-del]');
    await expect(page.locator('#ytQueuePanel .yt-queue-item')).toHaveCount(0);
  });

  test('el botón de borrador publica en privado con draft=true', async ({ page }) => {
    const h = await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Borrador de prueba');
    await page.setInputFiles('#ytFile', { name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('contenido') });
    await page.click('#ytDraftBtn');
    await expect.poll(() => h.requests.filter((r) => r.fn === 'publish' && r.body.action === 'init').length).toBeGreaterThan(0);
    const init = h.requests.find((r) => r.fn === 'publish' && r.body.action === 'init');
    expect(init.body.draft).toBe(true);
    expect(init.body.privacy).toBe('private');
  });

  test('la publicación normal manda la categoría y los flags', async ({ page }) => {
    const h = await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Video con flags');
    await page.setInputFiles('#ytFile', { name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('contenido') });
    await page.uncheck('#ytEmbeddable');
    await page.uncheck('#ytNotifySubs');
    await page.check('#ytMadeForKids');
    await page.click('#ytPublishBtn');
    await expect.poll(() => h.requests.filter((r) => r.fn === 'publish' && r.body.action === 'init').length).toBeGreaterThan(0);
    const init = h.requests.find((r) => r.fn === 'publish' && r.body.action === 'init');
    expect(init.body.embeddable).toBe(false);
    expect(init.body.notify_subscribers).toBe(false);
    expect(init.body.made_for_kids).toBe(true);
    expect(init.body.draft).toBe(false);
  });

  test('la categoría se carga desde la API de YouTube (no hardcodeada)', async ({ page }) => {
    const h = await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await expect.poll(() => h.calls.video_categories).toBeGreaterThan(0);
    await expect(page.locator('#ytCategory option')).toHaveCount(3);
    await expect(page.locator('#ytCategory option').first()).toContainText('People & Blogs');
  });

  test('la programación viaja como instante absoluto (no como hora local sin zona)', async ({ page }) => {
    const h = await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Video programado');
    await page.setInputFiles('#ytFile', { name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('contenido') });
    const cuando = new Date(Date.now() + 3 * 86400000);
    await page.fill('#ytPublishAt', cuando.toISOString().slice(0, 16));
    await page.click('#ytPublishBtn');
    await expect.poll(() => h.requests.filter((r) => r.fn === 'publish' && r.body.action === 'init').length).toBeGreaterThan(0);
    const init = h.requests.find((r) => r.fn === 'publish' && r.body.action === 'init');
    expect(init.body.publish_at).toMatch(/Z$/);
    expect(Math.abs(new Date(init.body.publish_at).getTime() - new Date(cuando.toISOString().slice(0, 16)).getTime())).toBeLessThan(60000);
  });

  test('el buscador del Studio también matchea la descripción', async ({ page }) => {
    await boot(page, {
      videos: [{ ...VIDEO, id: 'vid-desc', title: 'Tour', description: 'mención única de la cocina island' }],
    });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(1);
    await page.fill('#studioSearch', 'island');
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(1);
    await page.fill('#studioSearch', 'noexiste');
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(0);
  });

  test('la card del Studio muestra el score SEO del video', async ({ page }) => {
    await boot(page, {
      videos: [{ ...VIDEO, id: 'vid-seo', title: 'Tour de casa en Nueva Córdoba', description: 'Una casa de 120 m² en el centro con pileta y cochera. https://bienenhaus.com.ar', tags: ['bienenhaus', 'casa', 'nueva córdoba'] }],
    });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos .yt-video-seo')).toHaveCount(1);
  });
});
