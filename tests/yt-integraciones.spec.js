// ============================================================
// Tests de INTEGRACIONES del canal (módulo CONTENIDO / YouTube)
// ------------------------------------------------------------
// Cubre assets/js/yt-integrations.js y su uso en el panel:
//   · #32  mapa video → publicación del CRM (botón "Ver ficha")
//   · #34  compartir por WhatsApp con el contexto del agente
//   · #36  republicar (clonar la metadata al formulario)
//   · #15  atajo desde una propiedad (una sola fuente del payload)
//   · #37  cola de publicación compartida con la nube
// ============================================================
const { test, expect } = require('@playwright/test');
const { boot, VIDEO } = require('./helpers/yt-harness');

const PROP = {
  id: 'prop-1',
  property_code: 'ML-0001',
  title: 'Casa en Nueva Córdoba',
  property_type: 'casa',
  zone: 'Nueva Córdoba',
  address: 'Av. Siempreviva 123',
  surface_total: 120,
  rooms: 3,
  bedrooms: 2,
  bathrooms: 1,
};

test.describe('BH_YT.integrations — módulo de integraciones', () => {
  test('indexPosts indexa las publicaciones por video', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const i = window.BH_YT.integrations;
      const map = i.indexPosts([
        { external_post_id: 'vid-1', property_code: 'ML-0001' },
        { external_post_id: 'vid-2', property_code: 'ML-0002' },
        { property_code: 'ML-0003' }, // sin video: se ignora
      ]);
      return { total: Object.keys(map).length, ficha: i.fichaDe('vid-2', map) };
    });
    expect(r.total).toBe(2);
    expect(r.ficha).toBe('ML-0002');
  });

  test('linkFicha arma el link de la ficha (y vacío si no hay)', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const i = window.BH_YT.integrations;
      const map = i.indexPosts([{ external_post_id: 'vid-1', property_code: 'ML-0001' }]);
      return {
        con: i.linkFicha('vid-1', map),
        sin: i.linkFicha('vid-99', map),
        fichaVacia: i.linkFicha('vid-1', i.indexPosts([{ external_post_id: 'vid-1' }])),
      };
    });
    expect(r.con).toBe('/fichas/ML-0001.html');
    expect(r.sin).toBe('');
    expect(r.fichaVacia).toBe('');
  });

  test('whatsappLink manda el video y el contexto del agente', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const i = window.BH_YT.integrations;
      const link = i.whatsappLink('vid-1', 'Facundo Herrera', '5493516379651');
      const texto = decodeURIComponent(link.split('text=')[1] || '');
      return { empieza: link.indexOf('https://wa.me/?text=') === 0, texto: texto };
    });
    expect(r.empieza).toBe(true);
    expect(r.texto).toContain('https://www.youtube.com/watch?v=vid-1');
    expect(r.texto).toContain('Facundo Herrera');
    expect(r.texto).toContain('5493516379651');
  });

  test('whatsappLink sin agente no inventa datos', async ({ page }) => {
    await boot(page);
    const texto = await page.evaluate(() => {
      const link = window.BH_YT.integrations.whatsappLink('vid-1', '', '');
      return decodeURIComponent(link.split('text=')[1] || '');
    });
    expect(texto).toContain('watch?v=vid-1');
    expect(texto).not.toContain('Consultá con');
  });

  test('clonePayload copia la metadata del video del canal', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const v = { title: 'Tour de la casa', description: 'desc del video', tags: ['bienenhaus', 'casa'], privacy: 'public', category_id: '22' };
      return window.BH_YT.integrations.clonePayload(v);
    });
    expect(r.title).toBe('Tour de la casa');
    expect(r.description).toContain('desc del video');
    expect(r.tags).toBe('bienenhaus, casa');
    expect(r.privacy).toBe('public');
  });

  test('payloadFromProperty arma la metadata SIN inventar datos', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => {
      const p = { id: 'prop-1', property_code: 'ML-0001', property_type: 'casa', zone: 'Nueva Córdoba', surface_total: 120, rooms: 3, bathrooms: 1 };
      return window.BH_YT.integrations.payloadFromProperty(p);
    });
    expect(r.title).toContain('casa');
    expect(r.title).toContain('Nueva Córdoba');
    expect(r.title.length).toBeLessThanOrEqual(100);
    expect(r.description).toContain('https://bienenhaus.com.ar/fichas/ML-0001.html');
    expect(r.description).toContain('120 m²');
    expect(r.keyword).toBe('casa en nueva córdoba');
    expect(r.tags).toContain('bienenhaus');
    expect(r.propertyId).toBe('prop-1');
  });

  test('los tags no se repiten aunque la propiedad repita datos', async ({ page }) => {
    await boot(page);
    const tags = await page.evaluate(() => {
      const p = { id: 'p', property_type: 'casa', zone: 'casa', rooms: 2 };
      return window.BH_YT.integrations.payloadFromProperty(p).tags;
    });
    const lista = tags.split(',').map((t) => t.trim()).filter(Boolean);
    const unicos = new Set(lista.map((t) => t.toLowerCase()));
    expect(lista.length).toBe(unicos.size);
  });

  test('sin property_code la descripción no publica una URL rota', async ({ page }) => {
    await boot(page);
    const desc = await page.evaluate(() => {
      const p = { id: 'p', property_type: 'casa', zone: 'Córdoba' };
      return window.BH_YT.integrations.payloadFromProperty(p).description;
    });
    expect(desc).not.toContain('fichas/.html');
  });
});

test.describe('Integraciones en el panel', () => {
  test('la card del Studio ofrece la ficha del video', async ({ page }) => {
    await boot(page, {
      posts: [{
        id: 'p1', platform: 'youtube', status: 'published', external_post_id: 'vid-1',
        property_id: 'prop-1', properties: { property_code: 'ML-0001' },
        content: { title: 'Tour' }, created_at: '2026-10-20T10:00:00Z',
      }],
    });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    const link = page.locator('#studioVideos a[href="/fichas/ML-0001.html"]');
    await expect(link).toHaveCount(1);
  });

  test('sin publicación NO hay botón de ficha (no hay links muertos)', async ({ page }) => {
    await boot(page, { posts: [] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos a[href*="/fichas/"]')).toHaveCount(0);
  });

  test('la card tiene el botón de compartir por WhatsApp', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    const wa = page.locator('#studioVideos a[href^="https://wa.me/?text="]');
    await expect(wa).toHaveCount(1);
  });

  test('republicar carga la metadata del video en el formulario', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('[data-studio-republish]');
    await expect(page.locator('#ytTitle')).toHaveValue(VIDEO.title);
    await expect(page.locator('#ytDesc')).toHaveValue(VIDEO.description);
    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some((t) => t.indexOf('Metadata copiada') >= 0)).toBe(true);
  });

  test('el botón "cargar datos de la propiedad" usa el módulo (fuente única)', async ({ page }) => {
    await boot(page, { properties: [PROP] });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.selectOption('#ytProperty', 'prop-1');
    await page.click('#ytPropertyFill');
    await expect(page.locator('#ytTitle')).toHaveValue(/casa/);
    await expect(page.locator('#ytDesc')).toHaveValue(/120 m²/);
    await expect(page.locator('#ytTags')).toHaveValue(/bienenhaus/);
  });
});

test.describe('Cola compartida con la nube (#37)', () => {
  test('mergeRemote trae los items de la nube', async ({ page }) => {
    await boot(page, {
      settings: { social_yt_publish_queue: [{ id: 'q_remoto', title: 'Video remoto', createdAt: '2026-10-20T10:00:00Z' }] },
    });
    const r = await page.evaluate(async () => {
      const q = window.BH_YT.publish.queue;
      q.clear();
      const nuevos = await q.mergeRemote();
      return { nuevos: nuevos, items: q.list() };
    });
    expect(r.nuevos).toBe(1);
    expect(r.items[0].id).toBe('q_remoto');
  });

  test('la cola local manda si el mismo id está en los dos lados', async ({ page }) => {
    await boot(page, {
      settings: { social_yt_publish_queue: [{ id: 'q_1', title: 'Remoto', createdAt: '2026-10-20T10:00:00Z' }] },
    });
    const r = await page.evaluate(async () => {
      const q = window.BH_YT.publish.queue;
      q.clear();
      q.add({ id: 'q_1', title: 'Local' });
      const nuevos = await q.mergeRemote();
      return { nuevos: nuevos, titulo: q.list()[0].title, n: q.list().length };
    });
    expect(r.nuevos).toBe(0);
    expect(r.titulo).toBe('Local');
    expect(r.n).toBe(1);
  });

  test('pushRemote sube la cola local al servidor', async ({ page }) => {
    const h = await boot(page);
    await page.evaluate(async () => {
      const q = window.BH_YT.publish.queue;
      q.clear();
      q.add({ title: 'Video en cola' });
      await q.pushRemote();
    });
    const set = h.requests.find((r) => r.fn === 'studio' && r.body.action === 'settings_set');
    expect(set).toBeTruthy();
    expect(set.body.key).toBe('social_yt_publish_queue');
    expect(Array.isArray(set.body.value)).toBe(true);
    expect(set.body.value[0].title).toBe('Video en cola');
  });

  test('el panel muestra el botón Sincronizar y sube la cola al pulsarlo', async ({ page }) => {
    const h = await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Video para sincronizar');
    await page.click('#ytQueueBtn');
    await expect(page.locator('#ytQueuePanel')).toContainText('Video para sincronizar');
    await expect(page.locator('#ytQueueSync')).toHaveCount(1);
    await page.click('#ytQueueSync');
    await expect.poll(() => h.requests.filter((r) => r.fn === 'studio' && r.body.action === 'settings_set').length).toBeGreaterThan(0);
    const set = h.requests.filter((r) => r.fn === 'studio' && r.body.action === 'settings_set').pop();
    expect(set.body.key).toBe('social_yt_publish_queue');
  });

  test('al abrir la tab Crear, la cola de la nube baja sola', async ({ page }) => {
    await boot(page, {
      settings: { social_yt_publish_queue: [{ id: 'q_auto', title: 'Encolado en otro dispositivo', createdAt: '2026-10-20T10:00:00Z' }] },
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await expect(page.locator('#ytQueuePanel')).toContainText('Encolado en otro dispositivo');
  });
});
