// ============================================================
// Tests del flujo FACEBOOK del módulo CONTENIDO (v3).
// ------------------------------------------------------------
// Comportamiento con el harness compartido (tests/helpers/
// yt-harness.js — módulo REAL en el browser + server fake) y
// guards estáticos sobre los archivos (server + cliente + CI).
//
// Contrato clave (misma decisión que IG/YouTube): el contenido
// vive ÚNICAMENTE en Facebook — la foto de propiedad va por URL
// (Cloudinary) y la de PC por bucket temporal con cleanup. La
// API de FB publica en PÁGINAS, no perfiles. La foto es
// SINCRÓNICA (create → post_id) y el video se poll-ea.
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const { boot } = require('./helpers/yt-harness');

const CLIENT_PATH = path.join(__dirname, '..', 'assets', 'js', 'admin-contenido.js');
const SERVER_PATH = path.join(__dirname, '..', 'supabase', 'functions', 'social-facebook', 'index.ts');
const IG_SERVER_PATH = path.join(__dirname, '..', 'supabase', 'functions', 'social-instagram', 'index.ts');
const AUTH_PATH = path.join(__dirname, '..', 'supabase', 'functions', 'social-auth-facebook', 'index.ts');

const FB_ACC = { id: 'acc-fb', platform: 'facebook', display_name: 'Bienenhaus Propiedades', avatar_url: '', status: 'active', last_publish_at: null };
const PHOTO_URL = 'https://res.cloudinary.com/demo/image/upload/casa-frente.jpg';

/* Boot con página de Facebook conectada + app configurada. */
async function bootFb(page, extra = {}) {
  const h = await boot(page, Object.assign({
    accounts: [FB_ACC],
    platformsConfig: [
      { platform: 'youtube', configured: true },
      { platform: 'instagram', configured: false },
      { platform: 'facebook', configured: true },
    ],
  }, extra));
  await page.click('#contenidoSubTabs button[data-sub="create"]');
  await page.click('[data-create-plat="facebook"]');
  return h;
}

test.describe('Contenido/Facebook — switcher y estado de conexión', () => {
  test('el tab Crear tiene switcher YouTube/Instagram/Facebook y alterna los tres paneles', async ({ page }) => {
    await boot(page, {
      platformsConfig: [
        { platform: 'youtube', configured: true },
        { platform: 'instagram', configured: true },
        { platform: 'facebook', configured: true },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await expect(page.locator('#ytCreatePanel')).toBeVisible();
    await page.click('[data-create-plat="facebook"]');
    await expect(page.locator('#fbCreatePanel')).toBeVisible();
    await expect(page.locator('#ytCreatePanel')).toBeHidden();
    await expect(page.locator('#igCreatePanel')).toBeHidden();
    await expect(page.locator('[data-create-plat="facebook"]')).toHaveClass(/is-active/);
    await page.click('[data-create-plat="instagram"]');
    await expect(page.locator('#igCreatePanel')).toBeVisible();
    await expect(page.locator('#fbCreatePanel')).toBeHidden();
    await page.click('[data-create-plat="youtube"]');
    await expect(page.locator('#ytCreatePanel')).toBeVisible();
    await expect(page.locator('#fbCreatePanel')).toBeHidden();
  });

  test('sin app de Meta configurada: aviso claro y SIN botón conectar', async ({ page }) => {
    await boot(page); // facebook configured: false (default del harness)
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.click('[data-create-plat="facebook"]');
    await expect(page.locator('#fbConnectState')).toContainText('Facebook todavía no tiene su app configurada');
    await expect(page.locator('#fbConnectState [data-contenido-connect="facebook"]')).toHaveCount(0);
    await expect(page.locator('#fbFormWrap')).toBeHidden();
  });

  test('app configurada pero sin página: ofrece conectar', async ({ page }) => {
    await boot(page, {
      platformsConfig: [
        { platform: 'youtube', configured: true },
        { platform: 'facebook', configured: true },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="create"]');
    await page.click('[data-create-plat="facebook"]');
    await expect(page.locator('#fbConnectState')).toContainText('Sin página de Facebook conectada');
    await expect(page.locator('#fbConnectState [data-contenido-connect="facebook"]')).toHaveCount(1);
    await expect(page.locator('#fbFormWrap')).toBeHidden();
  });

  test('con página FB activa: form visible con la página en el select', async ({ page }) => {
    await bootFb(page);
    await expect(page.locator('#fbFormWrap')).toBeVisible();
    await expect(page.locator('#fbAccountSelect')).toHaveValue('acc-fb');
    await expect(page.locator('#fbConnectState .empty-state')).toHaveCount(0);
  });
});

test.describe('Contenido/Facebook — propiedad y foto', () => {
  test('elegir propiedad llena el caption vacío y muestra el grid de fotos', async ({ page }) => {
    await bootFb(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL, 'https://res.cloudinary.com/demo/image/upload/casa-living.jpg'] } },
    });
    await page.selectOption('#fbProperty', 'prop-1');
    const cap = await page.inputValue('#fbCaption');
    expect(cap).toContain('ML-0001');
    expect(cap).toContain('Casa en Nueva Córdoba');
    const cells = page.locator('#fbPhotoGrid [data-fb-photo]');
    await expect(cells).toHaveCount(2);
    // thumbs con transform Cloudinary (no la original)
    const src = await cells.first().locator('img').getAttribute('src');
    expect(src).toContain('w_200,h_200,c_fill');
  });

  test('el caption ya escrito NO se pisa al elegir propiedad', async ({ page }) => {
    await bootFb(page);
    await page.fill('#fbCaption', 'Mi caption propio');
    await page.selectOption('#fbProperty', 'prop-1');
    expect(await page.inputValue('#fbCaption')).toBe('Mi caption propio');
  });

  test('la foto se selecciona con un clic y se marca activa', async ({ page }) => {
    await bootFb(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#fbProperty', 'prop-1');
    const cell = page.locator('#fbPhotoGrid [data-fb-photo]').first();
    await cell.click();
    await expect(cell).toHaveClass(/is-active/);
    await cell.click(); // click de nuevo deselecciona
    await expect(cell).not.toHaveClass(/is-active/);
  });

  test('sin fotos en la propiedad avisa y sugiere subir desde PC', async ({ page }) => {
    await bootFb(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [] } },
    });
    await page.selectOption('#fbProperty', 'prop-1');
    await expect(page.locator('#fbPhotoGrid')).toContainText('no tiene fotos');
  });
});

test.describe('Contenido/Facebook — archivo desde PC', () => {
  test('una imagen chica ajusta el tipo a photo y muestra el archivo', async ({ page }) => {
    await bootFb(page);
    await page.click('[data-fb-mode="upload"]');
    await page.setInputFiles('#fbFile', { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
    await expect(page.locator('#fbMediaType')).toHaveValue('photo');
    await expect(page.locator('#fbFileInfo')).toContainText('foto.jpg');
  });

  test('un video ajusta el tipo a video', async ({ page }) => {
    await bootFb(page);
    await page.click('[data-fb-mode="upload"]');
    await page.setInputFiles('#fbFile', { name: 'tour.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mp4') });
    await expect(page.locator('#fbMediaType')).toHaveValue('video');
    await expect(page.locator('#fbFileInfo')).toContainText('video');
  });

  test('un archivo que no es media se rechaza con aviso', async ({ page }) => {
    await bootFb(page);
    await page.click('[data-fb-mode="upload"]');
    await page.setInputFiles('#fbFile', { name: 'raro.xyz', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('no es una imagen ni un video');
  });
});

test.describe('Contenido/Facebook — publicación (server fake)', () => {
  test('foto de la propiedad: create SINCRÓNICO → media_info, sin upload_temp ni poll', async ({ page }) => {
    const h = await bootFb(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#fbProperty', 'prop-1');
    await page.locator('#fbPhotoGrid [data-fb-photo]').first().click();
    await page.fill('#fbCaption', 'Casa en Nueva Córdoba — #bienenhaus');
    await page.click('#fbPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en Facebook');

    const fbReqs = h.requests.filter(r => r.fn === 'facebook');
    const actions = fbReqs.map(r => r.body.action);
    expect(actions).toEqual(['create', 'media_info']); // la foto NO crea contenedor ni poll-ea
    const create = fbReqs[0].body;
    expect(create.image_url).toBe(PHOTO_URL); // URL Cloudinary original (no thumb)
    expect(create.media_type).toBe('photo');
    expect(create.caption).toContain('Casa en Nueva Córdoba');

    /* Registro previo en social_posts con traza completa */
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins.length).toBe(1);
    expect(ins[0].row.platform).toBe('facebook');
    expect(ins[0].row.status).toBe('publishing');
    expect(ins[0].row.post_type).toBe('photo');
    expect(ins[0].row.account_id).toBe('acc-fb');
    expect(ins[0].row.property_id).toBe('prop-1');
    expect(ins[0].row.created_by).toBe('user-test-1');
    expect(ins[0].row.content.caption).toContain('Casa en Nueva Córdoba');
  });

  test('subida desde PC (foto): upload_temp + create con la URL temporal + cleanup_temp', async ({ page }) => {
    const h = await bootFb(page);
    await page.click('[data-fb-mode="upload"]');
    await page.setInputFiles('#fbFile', { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
    await page.fill('#fbCaption', 'Depto Alberdi');
    await page.click('#fbPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en Facebook');
    await expect.poll(() => h.requests.filter(r => r.fn === 'facebook').map(r => r.body.action).join(',')).toContain('cleanup_temp');

    const fbReqs = h.requests.filter(r => r.fn === 'facebook');
    const actions = fbReqs.map(r => r.body.action);
    expect(actions).toEqual(['upload_temp', 'create', 'media_info', 'cleanup_temp']);
    expect(fbReqs[1].body.image_url).toContain('/social-temp/');
    expect(fbReqs[3].body.temp_path).toBe('fb_1_test.jpg'); // el temporal se borra SIEMPRE
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins[0].row.post_type).toBe('photo');
  });

  test('video desde PC: create video → poll status → media_info + cleanup del temporal', async ({ page }) => {
    const h = await bootFb(page);
    await page.click('[data-fb-mode="upload"]');
    await page.setInputFiles('#fbFile', { name: 'tour.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mp4') });
    await page.fill('#fbCaption', 'Tour del depto');
    await page.click('#fbPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Publicado en Facebook');

    const fbReqs = h.requests.filter(r => r.fn === 'facebook');
    const create = fbReqs.find(r => r.body.action === 'create');
    expect(create.body.media_type).toBe('video');
    expect(create.body.video_url).toContain('/social-temp/');
    expect(create.body.image_url).toBeUndefined();
    // el poll pregunta por el video_id que devolvió create
    const status = fbReqs.find(r => r.body.action === 'status');
    expect(status.body.video_id).toBe('fb-video-1');
    const actions = fbReqs.map(r => r.body.action);
    expect(actions).toEqual(['upload_temp', 'create', 'status', 'media_info', 'cleanup_temp']);
    const ins = await page.evaluate(() => window.__INSERTS.filter(i => i.table === 'social_posts'));
    expect(ins[0].row.post_type).toBe('video');
    expect(ins[0].row.media.type).toBe('video');
  });

  test('fallo del create (foto): toast de error, fila en failed y audit', async ({ page }) => {
    const h = await bootFb(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
      fbFailAction: 'create',
      fbFailStatus: 400,
      fbFailError: 'FB rechazó el post',
    });
    await page.selectOption('#fbProperty', 'prop-1');
    await page.locator('#fbPhotoGrid [data-fb-photo]').first().click();
    await page.fill('#fbCaption', 'Casa de prueba');
    await page.click('#fbPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('No se pudo publicar: FB rechazó el post');
    // modo propiedad (Cloudinary): no hay archivo temporal → NO hay cleanup
    const actions = h.requests.filter(r => r.fn === 'facebook').map(r => r.body.action);
    expect(actions).toEqual(['create']);
    // traza de auditoría del fallo (vía action audit_log del Studio)
    expect(h.calls.audit_log).toBeGreaterThanOrEqual(1);
    // el form queda desbloqueado tras el fallo
    await expect(page.locator('#fbPublishBtn')).toBeEnabled();
  });

  test('sin caption no se publica nada', async ({ page }) => {
    await bootFb(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#fbProperty', 'prop-1');
    // el prefill automático llena el caption → se vacía a mano para probar el gate
    await page.fill('#fbCaption', '');
    await page.locator('#fbPhotoGrid [data-fb-photo]').first().click();
    await page.click('#fbPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Escribí el caption');
    expect((await page.evaluate(() => window.__INSERTS)).length).toBe(0);
  });

  test('sin foto elegida en modo propiedad no se publica nada', async ({ page }) => {
    await bootFb(page, {
      maybeSingle: { properties: { id: 'prop-1', image_urls: [PHOTO_URL] } },
    });
    await page.selectOption('#fbProperty', 'prop-1');
    await page.fill('#fbCaption', 'caption');
    await page.click('#fbPublishBtn');
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Elegí una foto');
    expect((await page.evaluate(() => window.__INSERTS)).length).toBe(0);
  });
});

test.describe('Contenido/Facebook — historial', () => {
  const FB_POST = { id: 'post-fb-1', platform: 'facebook', status: 'published', post_type: 'photo', content: { title: 'ML-0001 — Casa' }, published_at: '2026-11-09T15:00:00Z', created_at: '2026-11-09T15:00:00Z', external_url: 'https://www.facebook.com/bienenhaus/posts/1/', external_post_id: 'fb-77', error: null, property_id: 'prop-1', social_accounts: { display_name: 'Bienenhaus Propiedades' } };

  test('post FB publicado muestra botón de eliminar (el de YouTube/IG no lo comparte)', async ({ page }) => {
    await bootFb(page, {
      posts: [
        FB_POST,
        { id: 'post-yt-1', platform: 'youtube', status: 'published', post_type: 'video', content: { title: 'Tour' }, published_at: '2026-11-08T15:00:00Z', created_at: '2026-11-08T15:00:00Z', external_url: 'https://youtube.com/watch?v=x', external_post_id: 'vid-1', error: null, property_id: 'prop-1', social_accounts: { display_name: 'Bienenhaus' } },
        { id: 'post-ig-1', platform: 'instagram', status: 'published', post_type: 'photo', content: { title: 'Post' }, published_at: '2026-11-07T15:00:00Z', created_at: '2026-11-07T15:00:00Z', external_url: 'https://www.instagram.com/p/x/', external_post_id: 'ig-1', error: null, property_id: 'prop-1', social_accounts: { display_name: 'Bienenhaus IG' } },
      ],
    });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await expect(page.locator('[data-fb-delete="post-fb-1"]')).toHaveCount(1);
    await expect(page.locator('[data-fb-delete="post-yt-1"]')).toHaveCount(0);
    await expect(page.locator('[data-fb-delete="post-ig-1"]')).toHaveCount(0);
  });

  test('eliminar pide confirmación del panel y borra de verdad en FB', async ({ page }) => {
    const h = await bootFb(page, { posts: [FB_POST] });
    await page.click('#contenidoSubTabs button[data-sub="history"]');
    await page.click('[data-fb-delete="post-fb-1"]');
    await expect.poll(() => page.evaluate(() => window.__CONFIRM_CALLS.length)).toBeGreaterThan(0);
    expect((await page.evaluate(() => window.__CONFIRM_CALLS))[0]).toContain('Eliminar de Facebook');
    const del = h.requests.find(r => r.fn === 'facebook' && r.body.action === 'delete');
    expect(del).toBeTruthy();
    expect(del.body.media_id).toBe('fb-77');    // el post REAL de Facebook
    expect(del.body.account_id).toBe('acc-fb'); // con la página activa
    await expect.poll(() => page.evaluate(() => window.__TOASTS.join('|'))).toContain('Post eliminado de Facebook');
  });
});

test.describe('Contenido/Facebook — guards estáticos', () => {
  test('el server expone create (foto sync + video multipart), status, media_info y delete', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain("body.action === 'create'");
    expect(server).toContain("body.action === 'status'");
    expect(server).toContain("body.action === 'media_info'");
    expect(server).toContain("body.action === 'delete'");
    expect(server).toContain("body.action === 'cleanup_temp'");
    // la foto va por URL (FB la descarga) y la respuesta es sincrónica
    expect(server).toContain('/photos');
    expect(server).toContain('post_id');
    expect(server).toContain("published: 'true'"); // post al feed explícito
    // el video sube multipart DIRECTO (sin file_url como parámetro — decisión del dueño)
    expect(server).toContain('/videos');
    expect(server).not.toContain("'file_url'");
    expect(server).toContain('FormData');
    // guard de tamaño ANTES de buffer (no carga en memoria un video gigante)
    expect(server).toContain('content-length');
    // el permalink pide los campos reales (posts: permalink_url · fotos: link)
    expect(server).toContain('fields=permalink_url,link,message');
  });

  test('los errores de Graph llegan en claro y el token muerto (190) pide reconectar', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    // parsea el JSON de error de FB y muestra error.message, no el crudo
    expect(server).toContain('friendlyGraphError');
    expect(server).toContain("json.error?.message");
    // code 190 = token inválido (password cambiada / app desautorizada)
    expect(server).toContain('code === 190');
    expect(server).toContain('desconectá y volvé a conectar la página');
  });

  test('el poll del video lee las fases reales de FB (uploading/processing/publishing)', () => {
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain('uploading_phase');
    expect(server).toContain('processing_phase');
    expect(server).toContain('publishing_phase');
    // el parser es tolerante: forma vieja (value) y nueva (video_status)
    expect(server).toContain('video_status');
    expect(server).toContain('complete');
    expect(server).toContain('processed');
  });

  test('el cliente habla con el endpoint social-facebook y escapa las URLs', () => {
    const js = fs.readFileSync(CLIENT_PATH, 'utf8');
    expect(js).toContain('/social-facebook');
    // el grid de fotos escapa la URL con escAttr (no hay HTML crudo)
    expect(js).toContain("data-fb-photo=\"' + escAttr(s)");
    // el thumb usa el transform Cloudinary
    expect(js).toContain('w_200,h_200,c_fill');
    // el permalink tiene fallback (posts: permalink_url · fotos: link)
    expect(js).toContain('permalink_url || info.media_info.link');
  });

  test('cero onclick inline en el módulo (CSP del panel)', () => {
    const js = fs.readFileSync(CLIENT_PATH, 'utf8');
    expect(js.includes('onclick=')).toBe(false);
  });

  test('el OAuth de FB conecta PÁGINAS (no perfiles) y el page token no vence', () => {
    const auth = fs.readFileSync(AUTH_PATH, 'utf8');
    expect(auth).toContain('pages_show_list');
    expect(auth).toContain('pages_manage_posts');
    expect(auth).toContain('pages_read_engagement');
    expect(auth).toContain('no publica en perfiles personales');
    // page token derivado de un user token largo no vence → far future (sin refresh)
    expect(auth).toContain('farFuture');
    expect(auth).toContain("onConflict: 'platform,external_id'");
  });

  test('el CI deploya social-auth-facebook sin verify_jwt y social-facebook con verify_jwt', () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(yml).toContain('"social-auth-facebook"'); // NO_VERIFY (callback de Meta)
    expect(yml).not.toContain('"social-facebook"');  // el resto de las actions va CON verify_jwt
  });

  test('el rate limiter tiene las dos funciones nuevas', () => {
    const rl = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'rate-limit.ts'), 'utf8');
    expect(rl).toContain("'social-auth-facebook'");
    expect(rl).toContain("'social-facebook'");
  });

  test('el cap de video PC es 50 MB (memoria del edge function, no la API) en FB e IG', () => {
    /* El archivo viaja base64 (~1.33×) y el decode pico usa ~2.5× el binario:
       con 256 MB de memoria por request, un video de 100 MB reventaba por OOM
       antes de decodificar. El cap correcto es 50 MB en las DOS plataformas
       (mismo bucket temporal, misma física). */
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    expect(server).toContain('MAX_VIDEO_BYTES = 50 * 1024 * 1024');
    expect(server).toContain('supera 50 MB');
    const igServer = fs.readFileSync(IG_SERVER_PATH, 'utf8');
    expect(igServer).toContain('MAX_VIDEO_BYTES = 50 * 1024 * 1024');
    const js = fs.readFileSync(CLIENT_PATH, 'utf8');
    expect(js).toContain('50 * 1024 * 1024');
    expect(js).not.toContain('100 * 1024 * 1024');
    expect(js).toContain('video ≤ 50 MB');
    expect(js).not.toContain('video ≤ 100 MB');
  });
});
