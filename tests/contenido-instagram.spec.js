// ============================================================
// Tests del flujo INSTAGRAM del módulo CONTENIDO (v2).
// ------------------------------------------------------------
// Comportamiento con el harness compartido (tests/helpers/
// yt-harness.js — módulo REAL en el browser + server fake) y
// guards estáticos sobre los archivos (server + cliente).
//
// El contrato clave (decisión del dueño): el contenido subido
// vive ÚNICAMENTE en Instagram — la foto de propiedad va por
// URL Cloudinary y la de PC por bucket temporal con cleanup.
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const { boot } = require('./helpers/yt-harness');

const CLIENT_PATH = path.join(__dirname, '..', 'assets', 'js', 'admin-contenido.js');
const SERVER_PATH = path.join(__dirname, '..', 'supabase', 'functions', 'social-instagram', 'index.ts');

const IG_ACC = { id: 'acc-ig', platform: 'instagram', display_name: 'Bienenhaus IG', avatar_url: '', status: 'active', last_publish_at: null };
const PHOTO_URL = 'https://res.cloudinary.com/demo/image/upload/casa-frente.jpg';

/* Boot con cuenta de Instagram conectada + app configurada. */
async function bootIg(page, extra = {}) {
  const h = await boot(page, Object.assign({
    accounts: [IG_ACC],
    platformsConfig: [{ platform: 'youtube', configured: true }, { platform: 'instagram', configured: true }],
  }, extra));
  await page.click('#contenidoSubTabs button[data-sub="create"]');
  await page.click('[data-create-plat="instagram"]');
  return h;
}

test.describe('Contenido/Instagram — switcher y estado de conexión', () => {
  test('el tab Crear tiene switcher YouTube/Instagram y alterna los paneles', async ({ page }) => {
    await boot(page);
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await expect(page.locator('[data-create-plat="youtube"]')).toHaveClass(/is-active/);
    await expect(page.locator('#ytCreatePanel')).toBeVisible();
    await expect(page.locator('#igCreatePanel')).toBeHidden();
    await page.click('[data-create-plat="instagram"]');
    await expect(page.locator('#igCreatePanel')).toBeVisible();
    await expect(page.locator('#ytCreatePanel')).toBeHidden();
    await expect(page.locator('[data-create-plat="instagram"]')).toHaveClass(/is-active/);
    await page.click('[data-create-plat="youtube"]');
    await expect(page.locator('#ytCreatePanel')).toBeVisible();
    await expect(page.locator('#igCreatePanel')).toBeHidden();
  });

  test('sin app de Meta configurada: aviso claro y SIN botón conectar', async ({ page }) => {
    await boot(page); // instagram configured: false (default del harness)
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.click('[data-create-plat="instagram"]');
    await expect(page.locator('#igConnectState')).toContainText('Instagram todavía no tiene su app configurada');
    await expect(page.locator('#igConnectState [data-contenido-connect="instagram"]')).toHaveCount(0);
    await expect(page.locator('#igFormWrap')).toBeHidden();
  });

  test('app configurada pero sin cuenta: ofrece conectar', async ({ page }) => {
    await boot(page, {
      platformsConfig: [{ platform: 'youtube', configured: true }, { platform: 'instagram', configured: true }],
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.click('[data-create-plat="instagram"]');
    await expect(page.locator('#igConnectState')).toContainText('Sin cuenta de Instagram conectada');
    await expect(page.locator('#igConnectState [data-contenido-connect="instagram"]')).toHaveCount(1);
    await expect(page.locator('#igFormWrap')).toBeHidden();
  });

  test('con cuenta IG activa: form visible con la cuenta en el select', async ({ page }) => {
    await bootIg(page);
    await expect(page.locator('#igFormWrap')).toBeVisible();
    await expect(page.locator('#igAccountSelect')).toHaveValue('acc-ig');
    await expect(page.locator('#igConnectState .empty-state')).toHaveCount(0);
  });
});

test.describe('Contenido/Instagram — propiedad y foto', () => {
  test('elegir propiedad llena el caption vacío y muestra el grid de fotos', async ({ page }) => {
    await bootIg(page, {
      maybeSingle: {
        properties: { id: 'prop-1', image_urls: [PHOTO_URL, 'https://res.cloudinary.com/demo/image/upload/casa-living.jpg'] },
      },
    });
    await page.selectOption('#igProperty', 'prop-1');
    const cap = await page.inputValue('#igCaption');
    expect(cap).toContain('ML-0001');
    expect(cap).toContain('Casa en Nueva Córdoba');
    const cells = page.locator('#igPhotoGrid [data-ig-photo]');
    await expect(cells).toHaveCount(2);
    // thumbs con transform Cloudinary (no la original)
    const src = await cells.first().locator('img').getAttribute('src');
    expect(src).toContain('w_200,h_200,c_fill');
  });

  test('el caption ya escrito NO se pisa al elegir propiedad', async ({ page }) => {
    await bootIg(page);
    await page.fill('#igCaption', 'Mi caption propio');
    await page.selectOption('#igProperty', 'prop-1');
    expect(await page.inputValue('#igCaption')).toBe('Mi caption propio');
  });

  test('la foto se selecciona con un clic y se marca activa', async ({ page }) => {
    await bootIg(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#igProperty', 'prop-1');
    const cell = page.locator('#igPhotoGrid [data-ig-photo]').first();
    await cell.click();
    await expect(cell).toHaveClass(/is-active/);
    await cell.click(); // click de nuevo deselecciona
    await expect(cell).not.toHaveClass(/is-active/);
  });

  test('sin fotos en la propiedad avisa y sugiere subir desde PC', async ({ page }) => {
    await bootIg(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [] } },
    });
    await page.selectOption('#igProperty', 'prop-1');
    await expect(page.locator('#igPhotoGrid')).toContainText('no tiene fotos');
  });
});

test.describe('Contenido/Instagram — archivo desde PC', () => {
  test('una imagen chicha ajusta el tipo a FEED y muestra el archivo', async ({ page }) => {
    await bootIg(page);
    await page.click('[data-ig-mode="upload"]');
    await page.setInputFiles('#igFile', { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
    await expect(page.locator('#igMediaType')).toHaveValue('FEED');
    await expect(page.locator('#igFileInfo')).toContainText('foto.jpg');
  });

  test('un video ajusta el tipo a REELS', async ({ page }) => {
    await bootIg(page);
    await page.click('[data-ig-mode="upload"]');
    await page.setInputFiles('#igFile', { name: 'tour.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mp4') });
    await expect(page.locator('#igMediaType')).toHaveValue('REELS');
    await expect(page.locator('#igFileInfo')).toContainText('Reel');
  });

  test('un archivo que no es media se rechaza con aviso', async ({ page }) => {
    await bootIg(page);
    await page.click('[data-ig-mode="upload"]');
    await page.setInputFiles('#igFile', { name: 'raro.xyz', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('no es una imagen ni un video');
  });
});

test.describe('Contenido/Instagram — publicación (server fake)', () => {
  test('foto de la propiedad: create→status→publish→media_info SIN upload_temp', async ({ page }) => {
    const h = await bootIg(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#igProperty', 'prop-1');
    await page.locator('#igPhotoGrid [data-ig-photo]').first().click();
    await page.fill('#igCaption', 'Casa en Nueva Córdoba — #bienenhaus');
    await page.click('#igPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en Instagram');

    const igReqs = h.requests.filter(r => r.fn === 'instagram');
    const actions = igReqs.map(r => r.body.action);
    expect(actions).toEqual(['create', 'status', 'publish', 'media_info']);
    const create = igReqs[0].body;
    expect(create.image_url).toBe(PHOTO_URL); // URL Cloudinary original (no thumb)
    expect(create.media_type).toBe('FEED');
    expect(create.caption).toContain('Casa en Nueva Córdoba');
    // el poll se hace con el contenedor, no con el post
    expect(igReqs[1].body.creation_id).toBe('cont-1');

    /* Registro previo en social_posts con traza completa */
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins.length).toBe(1);
    expect(ins[0].row.platform).toBe('instagram');
    expect(ins[0].row.status).toBe('publishing');
    expect(ins[0].row.post_type).toBe('photo');
    expect(ins[0].row.account_id).toBe('acc-ig');
    expect(ins[0].row.property_id).toBe('prop-1');
    expect(ins[0].row.created_by).toBe('user-test-1');
    expect(ins[0].row.content.caption).toContain('Casa en Nueva Córdoba');
  });

  test('subida desde PC: upload_temp + create con la URL temporal + cleanup_temp', async ({ page }) => {
    const h = await bootIg(page);
    await page.click('[data-ig-mode="upload"]');
    await page.setInputFiles('#igFile', { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
    await page.fill('#igCaption', 'Depto Alberdi');
    await page.click('#igPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en Instagram');
    await expect.poll(() => h.requests.filter(r => r.fn === 'instagram').map(r => r.body.action).join(',')).toContain('cleanup_temp');

    const igReqs = h.requests.filter(r => r.fn === 'instagram');
    const actions = igReqs.map(r => r.body.action);
    expect(actions).toEqual(['upload_temp', 'create', 'status', 'publish', 'media_info', 'cleanup_temp']);
    expect(igReqs[1].body.image_url).toContain('/social-temp/');
    expect(igReqs[5].body.temp_path).toBe('ig_1_test.jpg'); // el temporal se borra SIEMPRE
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins[0].row.post_type).toBe('photo');
  });

  test('video desde PC: REELS con video_url y cleanup del temporal', async ({ page }) => {
    const h = await bootIg(page);
    await page.click('[data-ig-mode="upload"]');
    await page.setInputFiles('#igFile', { name: 'tour.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mp4') });
    await page.fill('#igCaption', 'Tour del depto');
    await page.click('#igPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en Instagram');

    const igReqs = h.requests.filter(r => r.fn === 'instagram');
    const create = igReqs.find(r => r.body.action === 'create');
    expect(create.body.media_type).toBe('REELS');
    expect(create.body.video_url).toContain('/social-temp/');
    expect(create.body.image_url).toBeUndefined();
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins[0].row.post_type).toBe('reel');
    expect(ins[0].row.media.type).toBe('video');
  });

  test('fallo del publish: toast de error, fila en failed y audit', async ({ page }) => {
    const h = await bootIg(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
      igFailAction: 'publish',
      igFailStatus: 400,
      igFailError: 'IG rechazó el post',
    });
    await page.selectOption('#igProperty', 'prop-1');
    await page.locator('#igPhotoGrid [data-ig-photo]').first().click();
    await page.fill('#igCaption', 'Casa de prueba');
    await page.click('#igPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('No se pudo publicar: IG rechazó el post');
    // modo propiedad (Cloudinary): no hay archivo temporal → NO hay cleanup
    const actions = h.requests.filter(r => r.fn === 'instagram').map(r => r.body.action);
    expect(actions).toEqual(['create', 'status', 'publish']);
    // traza de auditoría del fallo (vía action audit_log del Studio)
    expect(h.calls.audit_log).toBeGreaterThanOrEqual(1);
    // el form queda desbloqueado tras el fallo
    await expect(page.locator('#igPublishBtn')).toBeEnabled();
  });

  test('sin caption no se publica nada', async ({ page }) => {
    await bootIg(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#igProperty', 'prop-1');
    // el prefill automático llena el caption → se vacía a mano para probar el gate
    await page.fill('#igCaption', '');
    await page.locator('#igPhotoGrid [data-ig-photo]').first().click();
    await page.click('#igPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Escribí el caption');
    expect((await page.evaluate(() => window.__INSERTS)).length).toBe(0);
  });

  test('sin foto elegida en modo propiedad no se publica nada', async ({ page }) => {
    await bootIg(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#igProperty', 'prop-1');
    await page.fill('#igCaption', 'caption');
    await page.click('#igPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Elegí una foto');
    expect((await page.evaluate(() => window.__INSERTS)).length).toBe(0);
  });
});

test.describe('Contenido/Instagram — historial', () => {
  test('post IG publicado muestra botón de eliminar (el de YouTube no)', async ({ page }) => {
    await bootIg(page, {
      posts: [
        { id: 'post-ig-1', platform: 'instagram', status: 'published', post_type: 'photo', content: { title: 'ML-0001 — Casa' }, published_at: '2026-11-09T15:00:00Z', created_at: '2026-11-09T15:00:00Z', external_url: 'https://www.instagram.com/p/x/', external_post_id: 'ig-178', error: null, property_id: 'prop-1', social_accounts: { display_name: 'Bienenhaus IG' } },
        { id: 'post-yt-1', platform: 'youtube', status: 'published', post_type: 'video', content: { title: 'Tour' }, published_at: '2026-11-08T15:00:00Z', created_at: '2026-11-08T15:00:00Z', external_url: 'https://youtube.com/watch?v=x', external_post_id: 'vid-1', error: null, property_id: 'prop-1', social_accounts: { display_name: 'Bienenhaus' } },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await expect(page.locator('[data-ig-delete="post-ig-1"]')).toHaveCount(1);
    await expect(page.locator('[data-ig-delete="post-yt-1"]')).toHaveCount(0);
  });

  test('eliminar pide confirmación del panel y borra de verdad en IG', async ({ page }) => {
    const h = await bootIg(page, {
      posts: [
        { id: 'post-ig-1', platform: 'instagram', status: 'published', post_type: 'photo', content: { title: 'ML-0001 — Casa' }, published_at: '2026-11-09T15:00:00Z', created_at: '2026-11-09T15:00:00Z', external_url: 'https://www.instagram.com/p/x/', external_post_id: 'ig-178', error: null, property_id: 'prop-1', social_accounts: { display_name: 'Bienenhaus IG' } },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await page.click('[data-ig-delete="post-ig-1"]');
    await expect.poll(() => page.evaluate(() => window.__CONFIRM_CALLS.length)).toBeGreaterThan(0);
    expect((await page.evaluate(() => window.__CONFIRM_CALLS))[0]).toContain('Eliminar de Instagram');
    const del = h.requests.find(r => r.fn === 'instagram' && r.body.action === 'delete');
    expect(del).toBeTruthy();
    expect(del.body.media_id).toBe('ig-178');   // el post REAL de Instagram
    expect(del.body.account_id).toBe('acc-ig'); // con la cuenta activa
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Post eliminado de Instagram');
  });
});

test.describe('Contenido/Instagram — guards estáticos', () => {
  test('el server expone las actions status y media_info (poll + permalink)', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain("body.action === 'status'");
    expect(server).toContain("body.action === 'media_info'");
    // el poll lee status_code (el campo real de IG, no un inventado)
    expect(server).toContain('status_code');
    // el permalink pide los campos reales
    expect(server).toContain('fields=permalink,media_type');
  });

  test('el cliente habla con el endpoint social-instagram y escapa las URLs', () => {
    const js = fs.readFileSync(CLIENT_PATH, 'utf8');
    expect(js).toContain('/social-instagram');
    // el grid de fotos escapa la URL con escAttr (no hay HTML crudo)
    expect(js).toContain("data-ig-photo=\"' + escAttr(s)");
    // el thumb usa el transform Cloudinary
    expect(js).toContain('w_200,h_200,c_fill');
  });

  test('cero onclick inline en el módulo (CSP del panel)', () => {
    const js = fs.readFileSync(CLIENT_PATH, 'utf8');
    expect(js.includes('onclick=')).toBe(false);
  });

  test('la CSS del módulo tiene el grid de fotos IG (prefijo yt-)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'css', 'admin-contenido.css'), 'utf8');
    expect(css).toContain('.yt-photo-cell');
    expect(css).toContain('.yt-photo-cell.is-active img');
  });
});
