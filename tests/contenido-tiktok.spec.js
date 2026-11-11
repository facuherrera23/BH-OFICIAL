// ============================================================
// Tests del flujo TIKTOK del módulo CONTENIDO (v4).
// ------------------------------------------------------------
// Comportamiento con el harness compartido (tests/helpers/
// yt-harness.js — módulo REAL en el browser + server fake) y
// guards estáticos sobre los archivos (server + cliente +
// OAuth + shared + CI).
//
// Contrato clave (misma decisión que IG/FB/YouTube): el
// contenido vive ÚNICAMENTE en TikTok — la foto de propiedad va
// por URL (Cloudinary, PULL_FROM_URL) y la de PC por bucket
// temporal con cleanup SIEMPRE. El video va por FILE_UPLOAD
// (server baja los bytes y los sube con PUT al upload_url).
// Diferencias propias de TikTok:
//   · NO hay endpoint para borrar posts → sin delete ni botón.
//   · App sin auditar → solo posts PRIVADOS (SELF_ONLY default).
//   · Access token 2h + refresh token 180d ROTATIVO (CAS en la
//     shared persiste el refresh nuevo).
//   · El post_id público solo llega si el post es público y pasó
//     moderación (campo con typo real: publicaly_available_post_id).
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const { boot } = require('./helpers/yt-harness');

const CLIENT_PATH = path.join(__dirname, '..', 'assets', 'js', 'admin-contenido.js');
const SERVER_PATH = path.join(__dirname, '..', 'supabase', 'functions', 'social-tiktok', 'index.ts');
const AUTH_PATH = path.join(__dirname, '..', 'supabase', 'functions', 'social-auth-tiktok', 'index.ts');
const SHARED_PATH = path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'social.ts');

const TT_ACC = { id: 'acc-tt', platform: 'tiktok', display_name: 'Bienenhaus Propiedades', avatar_url: '', status: 'active', last_publish_at: null };
const PHOTO_URL = 'https://res.cloudinary.com/demo/image/upload/casa-frente.jpg';

/* Boot con cuenta de TikTok conectada + app configurada. */
async function bootTt(page, extra = {}) {
  const h = await boot(page, Object.assign({
    accounts: [TT_ACC],
    platformsConfig: [
      { platform: 'youtube', configured: true },
      { platform: 'instagram', configured: false },
      { platform: 'facebook', configured: false },
      { platform: 'tiktok', configured: true },
    ],
  }, extra));
  await page.click('#contenidoSubTabs button[data-sub="create"]');
  await page.click('[data-create-plat="tiktok"]');
  return h;
}

test.describe('Contenido/TikTok — switcher y estado de conexión', () => {
  test('el tab Crear tiene switcher de 4 redes y alterna los paneles', async ({ page }) => {
    await boot(page, {
      platformsConfig: [
        { platform: 'youtube', configured: true },
        { platform: 'instagram', configured: true },
        { platform: 'facebook', configured: true },
        { platform: 'tiktok', configured: true },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await expect(page.locator('#ytCreatePanel')).toBeVisible();
    await page.click('[data-create-plat="tiktok"]');
    await expect(page.locator('#ttCreatePanel')).toBeVisible();
    await expect(page.locator('#ytCreatePanel')).toBeHidden();
    await expect(page.locator('#igCreatePanel')).toBeHidden();
    await expect(page.locator('#fbCreatePanel')).toBeHidden();
    await expect(page.locator('[data-create-plat="tiktok"]')).toHaveClass(/is-active/);
    await page.click('[data-create-plat="facebook"]');
    await expect(page.locator('#fbCreatePanel')).toBeVisible();
    await expect(page.locator('#ttCreatePanel')).toBeHidden();
    await page.click('[data-create-plat="youtube"]');
    await expect(page.locator('#ytCreatePanel')).toBeVisible();
    await expect(page.locator('#ttCreatePanel')).toBeHidden();
  });

  test('sin app de TikTok configurada: aviso claro y SIN botón conectar', async ({ page }) => {
    await boot(page); // tiktok configured: false (default del harness)
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.click('[data-create-plat="tiktok"]');
    await expect(page.locator('#ttConnectState')).toContainText('TikTok todavía no tiene su app configurada');
    await expect(page.locator('#ttConnectState [data-contenido-connect="tiktok"]')).toHaveCount(0);
    await expect(page.locator('#ttFormWrap')).toBeHidden();
  });

  test('app configurada pero sin cuenta: ofrece conectar', async ({ page }) => {
    await boot(page, {
      platformsConfig: [
        { platform: 'youtube', configured: true },
        { platform: 'tiktok', configured: true },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.click('[data-create-plat="tiktok"]');
    await expect(page.locator('#ttConnectState')).toContainText('Sin cuenta de TikTok conectada');
    await expect(page.locator('#ttConnectState [data-contenido-connect="tiktok"]')).toHaveCount(1);
    await expect(page.locator('#ttFormWrap')).toBeHidden();
  });

  test('con cuenta TikTok activa: form visible con la cuenta en el select y privacidad default privado', async ({ page }) => {
    await bootTt(page);
    await expect(page.locator('#ttFormWrap')).toBeVisible();
    await expect(page.locator('#ttAccountSelect')).toHaveValue('acc-tt');
    await expect(page.locator('#ttConnectState .empty-state')).toHaveCount(0);
    // App sin auditar → el default seguro es "Solo yo"
    await expect(page.locator('#ttPrivacy')).toHaveValue('SELF_ONLY');
  });
});

test.describe('Contenido/TikTok — propiedad y foto', () => {
  test('elegir propiedad llena el caption vacío y muestra el grid de fotos', async ({ page }) => {
    await bootTt(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL, 'https://res.cloudinary.com/demo/image/upload/casa-living.jpg'] } },
    });
    await page.selectOption('#ttProperty', 'prop-1');
    const cap = await page.inputValue('#ttCaption');
    expect(cap).toContain('ML-0001');
    expect(cap).toContain('Casa en Nueva Córdoba');
    const cells = page.locator('#ttPhotoGrid [data-tt-photo]');
    await expect(cells).toHaveCount(2);
    // thumbs con transform Cloudinary (no la original)
    const src = await cells.first().locator('img').getAttribute('src');
    expect(src).toContain('w_200,h_200,c_fill');
  });

  test('el caption ya escrito NO se pisa al elegir propiedad', async ({ page }) => {
    await bootTt(page);
    await page.fill('#ttCaption', 'Mi caption propio');
    await page.selectOption('#ttProperty', 'prop-1');
    expect(await page.inputValue('#ttCaption')).toBe('Mi caption propio');
  });

  test('la foto se selecciona con un clic y se marca activa', async ({ page }) => {
    await bootTt(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#ttProperty', 'prop-1');
    const cell = page.locator('#ttPhotoGrid [data-tt-photo]').first();
    await cell.click();
    await expect(cell).toHaveClass(/is-active/);
    await cell.click(); // click de nuevo deselecciona
    await expect(cell).not.toHaveClass(/is-active/);
  });

  test('sin fotos en la propiedad avisa y sugiere subir desde PC', async ({ page }) => {
    await bootTt(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [] } },
    });
    await page.selectOption('#ttProperty', 'prop-1');
    await expect(page.locator('#ttPhotoGrid')).toContainText('no tiene fotos');
  });
});

test.describe('Contenido/TikTok — archivo desde PC', () => {
  test('una imagen chica ajusta el tipo a photo y muestra el archivo', async ({ page }) => {
    await bootTt(page);
    await page.click('[data-tt-mode="upload"]');
    await page.setInputFiles('#ttFile', { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
    await expect(page.locator('#ttMediaType')).toHaveValue('photo');
    await expect(page.locator('#ttFileInfo')).toContainText('foto.jpg');
  });

  test('un video ajusta el tipo a video', async ({ page }) => {
    await bootTt(page);
    await page.click('[data-tt-mode="upload"]');
    await page.setInputFiles('#ttFile', { name: 'tour.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mp4') });
    await expect(page.locator('#ttMediaType')).toHaveValue('video');
    await expect(page.locator('#ttFileInfo')).toContainText('video');
  });

  test('un archivo que no es media se rechaza con aviso', async ({ page }) => {
    await bootTt(page);
    await page.click('[data-tt-mode="upload"]');
    await page.setInputFiles('#ttFile', { name: 'raro.xyz', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('no es una imagen ni un video');
  });
});

test.describe('Contenido/TikTok — publicación (server fake)', () => {
  test('foto de la propiedad: create → poll status → media_info, la URL viaja completa (sin upload_temp)', async ({ page }) => {
    const h = await bootTt(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#ttProperty', 'prop-1');
    await page.locator('#ttPhotoGrid [data-tt-photo]').first().click();
    await page.fill('#ttCaption', 'Casa en Nueva Córdoba — #bienenhaus');
    await page.click('#ttPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en TikTok');

    const ttReqs = h.requests.filter(r => r.fn === 'tiktok');
    const actions = ttReqs.map(r => r.body.action);
    expect(actions).toEqual(['create', 'status', 'media_info']); // foto async: create + poll + permalink
    const create = ttReqs[0].body;
    // URL Cloudinary con transform embebido: TikTok limita fotos a 1080p JPEG
    expect(create.image_url).toBe('https://res.cloudinary.com/demo/image/upload/w_1080,c_limit,f_jpg,casa-frente.jpg');
    expect(create.image_url).not.toBe(PHOTO_URL); // nunca la original sin capar
    expect(create.media_type).toBe('photo');
    expect(create.caption).toContain('Casa en Nueva Córdoba');
    expect(create.privacy_level).toBe('SELF_ONLY'); // default seguro

    /* Registro previo en social_posts con traza completa */
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins.length).toBe(1);
    expect(ins[0].row.platform).toBe('tiktok');
    expect(ins[0].row.status).toBe('publishing');
    expect(ins[0].row.post_type).toBe('photo');
    expect(ins[0].row.account_id).toBe('acc-tt');
    expect(ins[0].row.property_id).toBe('prop-1');
    expect(ins[0].row.created_by).toBe('user-test-1');
    expect(ins[0].row.content.caption).toContain('Casa en Nueva Córdoba');
    expect(ins[0].row.content.privacy_level).toBe('SELF_ONLY');
  });

  test('post privado (sin post_id público): el permalink se saltea sin romper la publicación', async ({ page }) => {
    const h = await bootTt(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
      ttPostIds: [], // los posts privados NO tienen post_id público
    });
    await page.selectOption('#ttProperty', 'prop-1');
    await page.locator('#ttPhotoGrid [data-tt-photo]').first().click();
    await page.fill('#ttCaption', 'Post privado');
    await page.click('#ttPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('privado');
    const actions = h.requests.filter(r => r.fn === 'tiktok').map(r => r.body.action);
    expect(actions).toEqual(['create', 'status']); // media_info NO se llama (no hay post_id)
    expect(h.requests.find(r => r.fn === 'tiktok' && r.body.action === 'media_info')).toBeUndefined();
  });

  test('subida desde PC (foto): upload_temp + create con la URL temporal + cleanup_temp', async ({ page }) => {
    const h = await bootTt(page);
    await page.click('[data-tt-mode="upload"]');
    await page.setInputFiles('#ttFile', { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
    await page.fill('#ttCaption', 'Depto Alberdi');
    await page.click('#ttPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en TikTok');
    await expect.poll(() => h.requests.filter(r => r.fn === 'tiktok').map(r => r.body.action).join(',')).toContain('cleanup_temp');

    const ttReqs = h.requests.filter(r => r.fn === 'tiktok');
    const actions = ttReqs.map(r => r.body.action);
    expect(actions).toEqual(['upload_temp', 'create', 'status', 'media_info', 'cleanup_temp']);
    expect(ttReqs[1].body.image_url).toContain('/social-temp/');
    expect(ttReqs[4].body.temp_path).toBe('tt_1_test.mp4'); // el temporal se borra SIEMPRE
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins[0].row.post_type).toBe('photo');
  });

  test('video desde PC: create video con video_url → poll status → media_info + cleanup del temporal', async ({ page }) => {
    const h = await bootTt(page);
    await page.click('[data-tt-mode="upload"]');
    await page.setInputFiles('#ttFile', { name: 'tour.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mp4') });
    await page.fill('#ttCaption', 'Tour del depto');
    await page.click('#ttPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en TikTok');

    const ttReqs = h.requests.filter(r => r.fn === 'tiktok');
    const create = ttReqs.find(r => r.body.action === 'create');
    expect(create.body.media_type).toBe('video');
    expect(create.body.video_url).toContain('/social-temp/'); // el video viaja por SU campo
    expect(create.body.image_url).toBe('');
    // el poll pregunta por el publish_id que devolvió create
    const status = ttReqs.find(r => r.body.action === 'status');
    expect(status.body.publish_id).toBe('tt-publish-1');
    const actions = ttReqs.map(r => r.body.action);
    expect(actions).toEqual(['upload_temp', 'create', 'status', 'media_info', 'cleanup_temp']);
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins[0].row.post_type).toBe('video');
    expect(ins[0].row.media.type).toBe('video');
  });

  test('fallo del create (foto): toast de error, fila en failed y audit', async ({ page }) => {
    const h = await bootTt(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
      ttFailAction: 'create',
      ttFailStatus: 400,
      ttFailError: 'TikTok rechazó el post',
    });
    await page.selectOption('#ttProperty', 'prop-1');
    await page.locator('#ttPhotoGrid [data-tt-photo]').first().click();
    await page.fill('#ttCaption', 'Casa de prueba');
    await page.click('#ttPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('No se pudo publicar: TikTok rechazó el post');
    // modo propiedad (Cloudinary): no hay archivo temporal → NO hay cleanup
    const actions = h.requests.filter(r => r.fn === 'tiktok').map(r => r.body.action);
    expect(actions).toEqual(['create']);
    // traza de auditoría del fallo (vía action audit_log del Studio)
    expect(h.calls.audit_log).toBeGreaterThanOrEqual(1);
    // el form queda desbloqueado tras el fallo
    await expect(page.locator('#ttPublishBtn')).toBeEnabled();
  });

  test('sin caption no se publica nada', async ({ page }) => {
    await bootTt(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#ttProperty', 'prop-1');
    // el prefill automático llena el caption → se vacía a mano para probar el gate
    await page.fill('#ttCaption', '');
    await page.locator('#ttPhotoGrid [data-tt-photo]').first().click();
    await page.click('#ttPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Escribí el caption');
    expect((await page.evaluate(() => window.__INSERTS)).length).toBe(0);
  });

  test('sin foto elegida en modo propiedad no se publica nada', async ({ page }) => {
    await bootTt(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#ttProperty', 'prop-1');
    await page.fill('#ttCaption', 'caption');
    await page.click('#ttPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Elegí una foto');
    expect((await page.evaluate(() => window.__INSERTS)).length).toBe(0);
  });
});

test.describe('Contenido/TikTok — historial', () => {
  const TT_POST = { id: 'post-tt-1', platform: 'tiktok', status: 'published', post_type: 'photo', content: { title: 'ML-0001 — Casa' }, published_at: '2026-11-09T15:00:00Z', created_at: '2026-11-09T15:00:00Z', external_url: 'https://www.tiktok.com/@bienenhaus/video/1', external_post_id: 'tt-77', error: null, property_id: 'prop-1', social_accounts: { display_name: 'Bienenhaus Propiedades' } };

  test('posts de TikTok NO tienen botón eliminar (la API no permite borrar)', async ({ page }) => {
    await bootTt(page, {
      posts: [
        TT_POST,
        { id: 'post-fb-1', platform: 'facebook', status: 'published', post_type: 'photo', content: { title: 'ML-0001 — Casa' }, published_at: '2026-11-09T15:00:00Z', created_at: '2026-11-09T15:00:00Z', external_url: 'https://www.facebook.com/x', external_post_id: 'fb-77', error: null, property_id: 'prop-1', social_accounts: { display_name: 'Bienenhaus FB' } },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    /* TikTok no tiene endpoint de borrado: la fila no expone data-tt-delete
       (el post se elimina desde la app de TikTok). FB sí lo tiene. */
    await expect(page.locator('[data-tt-delete]')).toHaveCount(0);
    await expect(page.locator('[data-fb-delete="post-fb-1"]')).toHaveCount(1);
  });
});

test.describe('Contenido/TikTok — guards estáticos', () => {
  test('el server expone upload_temp/create/status/media_info/cleanup_temp y NO delete', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain("body.action === 'upload_temp'");
    expect(server).toContain("body.action === 'create'");
    expect(server).toContain("body.action === 'status'");
    expect(server).toContain("body.action === 'media_info'");
    expect(server).toContain("body.action === 'cleanup_temp'");
    // TikTok NO tiene endpoint para borrar posts publicados — la acción
    // delete no existe a propósito (el post se elimina desde la app).
    expect(server).not.toContain("body.action === 'delete'");
  });

  test('la FOTO va solo por PULL_FROM_URL (TikTok descarga — dominio Cloudinary verificado)', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain('/post/publish/content/init/');
    expect(server).toContain("'PHOTO'");
    expect(server).toContain("source: 'PULL_FROM_URL'");
    expect(server).toContain('photo_images');
    expect(server).toContain('photo_cover_index');
    // NADA de subida binaria para fotos: la API no lo soporta
    expect(server).not.toContain("source: 'FILE_UPLOAD',\n                source_info");
  });

  test('el VIDEO va por FILE_UPLOAD en 1 chunk con PUT directo al upload_url', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain('/post/publish/video/init/');
    expect(server).toContain("source: 'FILE_UPLOAD'");
    expect(server).toContain('total_chunk_count: 1');
    expect(server).toContain('Content-Range');
    expect(server).toContain('bytes 0-');
    expect(server).toContain('upload_url');
    // sin file_url ni URL pública propia (decisión del dueño)
    expect(server).not.toContain("'PULL_FROM_URL'" + ",\n" + "            video_url");
  });

  test('privacidad: whitelist de TikTok con SELF_ONLY como default seguro (app sin auditar)', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain("PRIVACY_LEVELS = ['SELF_ONLY', 'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS']");
    expect(server).toContain("'SELF_ONLY'");
    // el post promociona el propio negocio, NO es paid partnership
    expect(server).toContain('brand_organic_toggle: true');
    expect(server).toContain('brand_content_toggle: false');
  });

  test('límites reales de caption: foto title ≤90 / desc ≤4000 · video title ≤2200', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain('MAX_PHOTO_TITLE = 90');
    expect(server).toContain('MAX_PHOTO_DESC = 4000');
    expect(server).toContain('MAX_VIDEO_TITLE = 2200');
  });

  test('status/fetch normaliza PUBLISH_COMPLETE→FINISHED y lee el typo real de TikTok', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain('PUBLISH_COMPLETE');
    expect(server).toContain("'FAILED'");
    expect(server).toContain('fail_reason');
    // typo REAL del campo en la API de TikTok (no corregirlo rompe el post_id)
    expect(server).toContain('publicaly_available_post_id');
  });

  test('los errores frecuentes de TikTok llegan traducidos con la acción concreta', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain('friendlyTikTokError');
    expect(server).toContain('unaudited_client_can_only_post_to_private_accounts');
    expect(server).toContain('url_ownership_unverified');
    expect(server).toContain('access_token_invalid');
    expect(server).toContain('scope_not_authorized');
    // TikTok responde 200 con error en el body → se trata como fallo
    expect(server).toContain("err.code !== 'ok'");
  });

  test('el cap de video PC es 50 MB (memoria del edge function) con doble guard', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain('MAX_VIDEO_BYTES = 50 * 1024 * 1024');
    expect(server).toContain('supera 50 MB');
    // guard ANTES de buffer (content-length) + guard después (blob.size)
    expect(server).toContain('content-length');
    expect(server).toContain('blob.size > MAX_VIDEO_BYTES');
  });

  test('el cliente habla con social-tiktok, escapa las URLs y NO tiene botón eliminar', () => {
    const js = fs.readFileSync(CLIENT_PATH, 'utf8');
    expect(js).toContain('/social-tiktok');
    // el grid de fotos escapa la URL con escAttr (no hay HTML crudo)
    expect(js).toContain("data-tt-photo=\"' + escAttr(s)");
    // el thumb usa el transform Cloudinary
    expect(js).toContain('w_200,h_200,c_fill');
    // sin delete: TikTok no permite borrar posts por API
    expect(js).not.toContain('data-tt-delete');
    // el caption respeta el límite de título de video
    expect(js).toContain('maxlength="2200"');
    // las fotos de propiedad viajan capadas a 1080p JPEG (límite de la API de fotos)
    expect(js).toContain('w_1080,c_limit,f_jpg,');
    // la subida desde PC reescala a 1080px (helper compartido, override por red)
    expect(js).toContain('downscaleImageForIg(f, 1080)');
  });

  test('el OAuth de TikTok canjea en open.tiktokapis.com con scopes de publicación y token de 2h', () => {
    const auth = fs.readFileSync(AUTH_PATH, 'utf8');
    expect(auth).toContain('user.info.basic');
    expect(auth).toContain('video.publish');
    expect(auth).toContain('https://www.tiktok.com/v2/auth/authorize/');
    expect(auth).toContain('open.tiktokapis.com/v2/oauth/token/');
    // el canje es form-urlencoded (no JSON)
    expect(auth).toContain('application/x-www-form-urlencoded');
    // access token 2h (7200s) — el refresh lo maneja la shared
    expect(auth).toContain('7200');
    expect(auth).toContain("onConflict: 'platform,external_id'");
    expect(auth).toContain('open_id');
  });

  test('la shared maneja la ROTACIÓN del refresh token con CAS (TikTok invalida el refresh viejo)', () => {
    const shared = fs.readFileSync(SHARED_PATH, 'utf8');
    // el refresh de TikTok puede devolver un refresh_token nuevo
    expect(shared).toContain('refreshToken?: string');
    expect(shared).toContain('open.tiktokapis.com');
    expect(shared).toContain("grant_type: 'refresh_token'");
    // la rotación se persiste (el refresh viejo queda invalidado por TikTok)
    expect(shared).toContain('update.refresh_token_encrypted = encRef.data');
    // carrera: si otra instancia refrescó primero (invalid_grant), relee la fila
    expect(shared).toContain('again?.access_token_encrypted');
  });

  test('el CI deploya social-auth-tiktok sin verify_jwt y social-tiktok con verify_jwt', () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(yml).toContain('"social-auth-tiktok"'); // NO_VERIFY (callback de TikTok)
    expect(yml).not.toContain('"social-tiktok"');   // el resto de las actions va CON verify_jwt
  });

  test('el rate limiter tiene las dos funciones nuevas', () => {
    const rl = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'rate-limit.ts'), 'utf8');
    expect(rl).toContain("'social-auth-tiktok'");
    expect(rl).toContain("'social-tiktok'");
  });

  test('cero onclick inline en el módulo (CSP del panel)', () => {
    const js = fs.readFileSync(CLIENT_PATH, 'utf8');
    expect(js.includes('onclick=')).toBe(false);
  });
});
