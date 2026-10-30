// Tests del MÓDULO CONTENIDO (YouTube) — comportamiento del frontend.
//
// El módulo es una IIFE que se engancha al admin (window.__BH) y llama a las
// Edge Functions con OAuth. Estos tests montan un HARNESS mínimo en el
// navegador (stubs de __BH, supabaseClient y fetch a las Edge Functions) y
// ejercitan el módulo de verdad: render, sub-tabs, plantillas, gating por
// permisos, programación, inventario truncado y responsive.
//
// No tocan producción ni necesitan credenciales: el server local (8788) solo
// sirve los assets.
const { test, expect } = require('@playwright/test');

const { VIDEO, boot } = require('./helpers/yt-harness');

test.describe('Contenido/YouTube — reparaciones del lote', () => {
  test('el shell expone las 4 sub-pestañas (incluido Studio)', async ({ page }) => {
    await boot(page);
    const tabs = page.locator('#contenidoSubTabs button');
    await expect(tabs).toHaveCount(4);
    await expect(page.locator('#contenidoSubTabs button[data-sub="studio"]')).toHaveCount(1);
    await expect(page.locator('#contenidoSubTabs button[data-sub="accounts"]')).toHaveClass(/is-active/);
  });

  test('Studio sin canal conectado muestra un estado vacío accionable', async ({ page }) => {
    await boot(page, { accounts: [] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#contenidoStudio')).toContainText('Todavía no hay un canal conectado');
    await expect(page.locator('#studioGoAccounts')).toHaveCount(1);
    // el botón lleva a Cuentas
    await page.click('#studioGoAccounts');
    await expect(page.locator('#contenidoAccounts')).toBeVisible();
  });

  test('Studio con canal: KPIs, grilla y aviso de inventario truncado', async ({ page }) => {
    await boot(page, { truncated: true, total: 120 });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#contenidoStudio')).toContainText('Bienenhaus Propiedades');
    await expect(page.locator('#contenidoStudio')).toContainText('Mostrando 1 de 120 videos');
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(1);
    await expect(page.locator('#studioVideos')).toContainText('Tour de la casa');
  });

  test('sin permiso de administración (force-ssl) no se muestran editar/borrar', async ({ page }) => {
    await boot(page, { canManage: false });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#contenidoStudio')).toContainText('Modo solo lectura');
    await expect(page.locator('[data-studio-edit]')).toHaveCount(0);
    await expect(page.locator('[data-studio-delete]')).toHaveCount(0);
  });

  test('con permiso de administración aparecen editar/borrar', async ({ page }) => {
    await boot(page, { canManage: true });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('[data-studio-edit]')).toHaveCount(1);
    await expect(page.locator('[data-studio-delete]')).toHaveCount(1);
  });

  test('la grilla del Studio es responsive (no desborda en móvil)', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    // el render del Studio es async (espera la Edge Function)
    await expect(page.locator('#studioVideos')).toHaveCount(1);
    await expect(page.locator('#studioVideos')).toHaveClass(/yt-video-grid/);
    // en un viewport angosto la grilla no desborda horizontalmente
    await page.setViewportSize({ width: 420, height: 800 });
    const box = await page.evaluate(() => {
      const g = document.getElementById('studioVideos');
      return { scrollW: g.scrollWidth, clientW: g.clientWidth, cols: getComputedStyle(g).gridTemplateColumns };
    });
    expect(box.scrollW).toBeLessThanOrEqual(box.clientW + 2);
    expect(box.cols).toBeTruthy();
  });

  test('el modal de edición muestra la programación real del video', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await page.click('[data-studio-edit]');
    await expect(page.locator('#studioEditOverlay')).toHaveCount(1);
    const val = await page.inputValue('#stePublishAt');
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    await expect(page.locator('#steSchedHint')).toContainText('Se publica el');
    // al cambiar la visibilidad a pública se limpia la fecha (si no, YouTube
    // deja el video programado y nunca se publica)
    await page.selectOption('#stePrivacy', 'public');
    expect(await page.inputValue('#stePublishAt')).toBe('');
  });

  test('plantillas: se pueden guardar, aplicar y BORRAR (el select no se resetea)', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Título de prueba');
    await page.evaluate(() => { window.__PROMPT_VALUE = 'Mi plantilla'; });
    await page.click('#ytTemplateSave');
    const sel = page.locator('#ytTemplateSel');
    await expect(sel.locator('option')).toHaveCount(2); // placeholder + 1 plantilla
    await sel.selectOption({ index: 1 });
    await expect(page.locator('#ytTitle')).toHaveValue('Título de prueba');
    expect(await sel.inputValue()).toBeTruthy();
    await page.click('#ytTemplateDel');
    await expect(sel.locator('option')).toHaveCount(1);
  });

  test('la red sin app configurada no ofrece "Conectar"', async ({ page }) => {
    await boot(page);
    await page.waitForTimeout(200);
    const cards = page.locator('#contenidoAccounts .yt-account-card');
    await expect(cards.filter({ hasText: 'Instagram' })).toContainText('Sin configurar');
    await expect(page.locator('[data-contenido-connect="instagram"]')).toHaveCount(0);
    await expect(page.locator('[data-contenido-connect="youtube"]')).toHaveCount(0); // ya está conectada
  });

  test('la carga al Studio no se queda colgada si la Edge Function no responde', async ({ page }) => {
    const h = await boot(page, { hangAction: 'videos', fastAbort: true });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#contenidoStudio')).toContainText('tardó demasiado', { timeout: 10000 });
    // la navegación sigue viva
    await page.click('#contenidoSubTabs button[data-sub="accounts"]');
    await expect(page.locator('#contenidoAccounts')).toBeVisible();
    h.release();
  });

  test('reintentar desde el historial conserva keyword, programación y propiedad', async ({ page }) => {
    await boot(page, {
      posts: [{
        id: 'post-1',
        platform: 'youtube',
        status: 'failed',
        post_type: 'video',
        content: {
          title: 'Tour de la casa',
          description: 'descripción',
          tags: 'bienenhaus, casa',
          privacy: 'private',
          keyword: 'casa nueva córdoba',
          publish_at: '2026-11-02T15:00:00Z',
        },
        published_at: null,
        created_at: '2026-10-25T10:00:00Z',
        external_url: null,
        error: 'falló la subida',
        property_id: 'prop-1',
        social_accounts: { display_name: 'Bienenhaus Propiedades' },
      }],
    });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await expect(page.locator('[data-contenido-retry]')).toHaveCount(1);
    await page.click('[data-contenido-retry]');
    await expect(page.locator('#contenidoCreate')).toBeVisible();
    await expect(page.locator('#ytTitle')).toHaveValue('Tour de la casa');
    await expect(page.locator('#ytKeyword')).toHaveValue('casa nueva córdoba');
    await expect(page.locator('#ytProperty')).toHaveValue('prop-1');
    expect(await page.inputValue('#ytPublishAt')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  test('sin property_code la descripción NO publica un link roto (fichas/.html)', async ({ page }) => {
    await boot(page, {
      properties: [{
        id: 'prop-2', property_code: '', title: 'Depto sin codigo', property_type: 'departamento',
        status: 'venta', zone: 'Alberdi', address: 'Av. Colon 100', surface_total: 70,
        rooms: 2, bedrooms: 1, bathrooms: 1, is_published: true,
      }],
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await expect(page.locator('#ytProperty option')).toHaveCount(2);
    await page.selectOption('#ytProperty', 'prop-2');
    await page.click('#ytPropertyFill');
    const desc = await page.inputValue('#ytDesc');
    expect(desc).not.toContain('fichas/.html');
    expect(desc).toContain('bienenhaus.com.ar');
  });
});

test.describe('Contenido/YouTube — mejoras del lote', () => {
  test('el Studio tiene botón "Actualizar" que refresca el inventario (ignora el caché)', async ({ page }) => {
    const h = await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos')).toHaveCount(1);
    expect(h.calls.videos).toBe(1);
    await expect(page.locator('#studioRefreshBtn')).toHaveCount(1);
    await page.click('#studioRefreshBtn');
    await expect.poll(() => h.calls.videos).toBe(2);
  });

  test('el buscador de propiedades filtra las opciones en vivo', async ({ page }) => {
    await boot(page, {
      properties: [
        { id: 'prop-1', property_code: 'ML-0001', title: 'Casa en Nueva Córdoba', property_type: 'casa', status: 'venta', zone: 'Nueva Córdoba', address: 'Av. Siempreviva 123', surface_total: 120, rooms: 3, bedrooms: 2, bathrooms: 1, is_published: true },
        { id: 'prop-2', property_code: 'ML-0002', title: 'Depto en Alberdi', property_type: 'departamento', status: 'venta', zone: 'Alberdi', address: 'Av. Colon 100', surface_total: 70, rooms: 2, bedrooms: 1, bathrooms: 1, is_published: true },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await expect(page.locator('#ytProperty option')).toHaveCount(3); // placeholder + 2
    await page.fill('#ytPropertySearch', 'alberdi');
    await expect(page.locator('#ytProperty option')).toHaveCount(2); // placeholder + 1
    await expect(page.locator('#ytPropertyCount')).toContainText('1 de 2');
    // filtrar por código también funciona
    await page.fill('#ytPropertySearch', 'ML-0001');
    await expect(page.locator('#ytProperty option')).toHaveCount(2);
    // limpiar vuelve a mostrar todo
    await page.fill('#ytPropertySearch', '');
    await expect(page.locator('#ytProperty option')).toHaveCount(3);
  });

  test('los tags reales del canal aparecen como chips y se agregan con un clic', async ({ page }) => {
    await boot(page, {
      videos: [{ ...VIDEO, id: 'vid-2', title: 'Otro tour', tags: ['inmobiliaria cordoba', 'deptos'], views: 900 }],
    });
    // el Studio carga el inventario real → tags del canal
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos')).toHaveCount(1);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    const chips = page.locator('#ytChannelTags [data-yt-tag]');
    await expect(chips.first()).toBeVisible();
    const tag = await chips.first().getAttribute('data-yt-tag');
    await chips.first().click();
    await expect(page.locator('#ytTags')).toHaveValue(new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('se puede cancelar la subida en curso', async ({ page }) => {
    const h = await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Video de prueba');
    await page.setInputFiles('#ytFile', { name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('contenido de prueba') });
    await page.click('#ytPublishBtn');
    // la subida quedó colgada en el XHR → aparece el botón de cancelar
    await expect(page.locator('#ytCancelUpload')).toBeVisible({ timeout: 10000 });
    expect(h.calls.init).toBe(1);
    await page.click('#ytCancelUpload');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('cancelada');
    await expect(page.locator('#ytCancelUpload')).toBeHidden();
    h.release();
  });

  test('la card del Studio tiene botón para copiar el link', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos')).toHaveCount(1);
    await expect(page.locator('[data-studio-copy="vid-1"]')).toHaveCount(1);
  });

  test('se recuerda el último canal usado', async ({ page }) => {
    await boot(page, {
      accounts: [
        { id: 'acc-1', platform: 'youtube', display_name: 'Canal Uno', avatar_url: '', status: 'active', last_publish_at: null },
        { id: 'acc-2', platform: 'youtube', display_name: 'Canal Dos', avatar_url: '', status: 'active', last_publish_at: null },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await expect(page.locator('#ytAccountSelect option')).toHaveCount(2);
    await page.selectOption('#ytAccountSelect', 'acc-2');
    // recarga interna del módulo → debe restaurar el último canal
    await page.evaluate(() => window.__BH.loadContenido());
    await page.waitForTimeout(200);
    await expect(page.locator('#ytAccountSelect')).toHaveValue('acc-2');
  });

  test('se puede arrastrar el archivo de video a la zona de subida', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['bytes'], 'mi-video.mp4', { type: 'video/mp4' }));
      const zone = document.getElementById('ytFileDrop');
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(page.locator('#ytFileInfo')).toContainText('mi-video.mp4');
  });

  test('los filtros de vistas y antigüedad acotan la grilla', async ({ page }) => {
    await boot(page, {
      videos: [
        { ...VIDEO, id: 'vid-a', title: 'Con muchas vistas', views: 15000 },
        { ...VIDEO, id: 'vid-b', title: 'Sin vistas', views: 0, published_at: '2026-08-01T10:00:00Z' },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(2);
    await page.selectOption('#studioViews', '10k+');
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(1);
    await expect(page.locator('#studioVideos')).toContainText('Con muchas vistas');
    await page.selectOption('#studioViews', 'all');
    await page.selectOption('#studioAge', '30');
    await expect(page.locator('#studioVideos .yt-video-card')).toHaveCount(1);
    await expect(page.locator('#studioVideos')).toContainText('Con muchas vistas');
  });
});

test.describe('Contenido/YouTube — diseño (Lote 3)', () => {
  test('las sub-pestañas usan la barra del módulo (.yt-tabs / .yt-tab)', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#contenidoSubTabs')).toHaveClass(/yt-tabs/);
    await expect(page.locator('#contenidoSubTabs button')).toHaveCount(4);
    await expect(page.locator('#contenidoSubTabs button').first()).toHaveClass(/yt-tab/);
    await expect(page.locator('#contenidoSubTabs button[data-sub="accounts"]')).toHaveClass(/is-active/);
    // al cambiar de pestaña se mueve la clase activa
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await expect(page.locator('#contenidoSubTabs button[data-sub="history"]')).toHaveClass(/is-active/);
    await expect(page.locator('#contenidoSubTabs button[data-sub="accounts"]')).not.toHaveClass(/is-active/);
  });

  test('las cuentas se pintan con .yt-account-card (no con el panel genérico)', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#contenidoAccounts .yt-account-card')).not.toHaveCount(0);
    await expect(page.locator('#contenidoAccounts .yt-account-icon')).not.toHaveCount(0);
  });

  test('el modal del Studio usa el lenguaje del panel (.yt-modal + .modal-box) y cierra con la X', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos')).toHaveCount(1);
    await page.click('[data-studio-edit]');
    const ov = page.locator('#studioEditOverlay');
    await expect(ov).toHaveCount(1);
    await expect(ov).toHaveClass(/yt-modal/);
    await expect(page.locator('#studioEditOverlay .modal-box')).toHaveCount(1);
    // la X de cierre del panel está presente y cierra
    await expect(page.locator('#studioEditOverlay .modal-x-close')).toHaveCount(1);
    await page.click('#studioEditOverlay .modal-x-close');
    await expect(ov).toHaveCount(0);
  });

  test('el modal de detalle también usa .yt-modal y muestra el link del video', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos')).toHaveCount(1);
    await page.click('[data-studio-detail]');
    await expect(page.locator('#studioDetailOverlay')).toHaveClass(/yt-modal/);
    await expect(page.locator('#studioDetailOverlay')).toContainText('Tour de la casa');
    await expect(page.locator('#steCopyLink')).toHaveCount(1);
  });

  test('los avisos y KPIs del Studio usan las clases del módulo', async ({ page }) => {
    await boot(page, { truncated: true, total: 120 });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#contenidoStudio .yt-studio-head')).toHaveCount(1);
    await expect(page.locator('#contenidoStudio .yt-kpi')).toHaveCount(3);
    await expect(page.locator('#contenidoStudio .yt-notice--warning')).toHaveCount(1);
    await expect(page.locator('#contenidoStudio .yt-toolbar')).toHaveCount(1);
  });

  test('un canal sin videos muestra un estado vacío con acción', async ({ page }) => {
    await boot(page, { videos: [] });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos .empty-state')).toHaveCount(1);
    await expect(page.locator('#studioVideos')).toContainText('todavía no tiene videos');
    await page.click('#studioEmptyPublish');
    await expect(page.locator('#contenidoCreate')).toBeVisible();
  });

  test('el historial vacío y con filas usan el estilo del módulo', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await expect(page.locator('#contenidoHistory .empty-state')).toHaveCount(1);
    await expect(page.locator('#contenidoHistory')).toContainText('Todavía no hay publicaciones');
  });

  test('borrar un video pide confirmación con el DIÁLOGO DEL PANEL (no el nativo)', async ({ page }) => {
    await boot(page, { canManage: true });
    await page.click('#contenidoSubTabs button[data-sub="studio"]');
    await expect(page.locator('#studioVideos')).toHaveCount(1);
    await page.click('[data-studio-delete]');
    await expect.poll(() => page.evaluate(() => window.__CONFIRM_CALLS.length)).toBeGreaterThan(0);
    const calls = await page.evaluate(() => window.__CONFIRM_CALLS);
    expect(calls[0]).toContain('Borrar el video');
  });

  test('el nombre de la plantilla se pide con el diálogo del PANEL', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Título de prueba');
    await page.evaluate(() => { window.__PROMPT_VALUE = 'Mi plantilla'; });
    await page.click('#ytTemplateSave');
    await expect.poll(() => page.evaluate(() => window.__PROMPT_CALLS.length)).toBeGreaterThan(0);
    const calls = await page.evaluate(() => window.__PROMPT_CALLS);
    expect(calls[0]).toContain('Guardar plantilla');
  });

  test('el módulo NO usa confirm()/prompt() nativos (identidad del panel)', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.fill('#ytTitle', 'Título');
    await page.evaluate(() => { window.__PROMPT_VALUE = 'X'; });
    await page.click('#ytTemplateSave');
    await page.waitForTimeout(200);
    // el módulo debe usar los diálogos del panel (__BH.showInputPrompt),
    // nunca el confirm()/prompt() nativo del navegador
    const nativeCalls = await page.evaluate(() => window.__NATIVE_CALLS);
    expect(nativeCalls).toEqual([]);
  });

  test('el CSS del módulo se carga en admin.html (identidad visual compartida)', async ({ page, request }) => {
    const html = await (await request.get('/admin.html')).text();
    expect(html).toContain('assets/css/admin-contenido.css');
  });
});
