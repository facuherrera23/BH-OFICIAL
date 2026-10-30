// ============================================================
// Tests de la página PÚBLICA del canal (/canal.html)
// ------------------------------------------------------------
// La página lee assets/data/canal-videos.json (lo genera el CI)
// y dibuja la grilla de videos. Estos tests verifican:
//   · la grilla se arma con los datos del JSON
//   · cada card linkea al video y (si tiene) a su ficha
//   · el texto va escapado (XSS)
//   · un JSON vacío / inexistente no rompe la página
// ============================================================
const { test, expect } = require('@playwright/test');

const VIDEOS = [
  {
    id: 'vid123',
    title: 'Tour de la casa en Nueva Córdoba',
    description: 'Recorremos la casa completa con pileta y cochera.',
    published_at: '2026-10-20T10:00:00Z',
    url: 'https://www.youtube.com/watch?v=vid123',
    property_code: 'ML-0001',
    property_title: 'Casa en Nueva Córdoba',
    zone: 'Nueva Córdoba',
  },
  {
    id: 'vid456',
    title: 'Depto en el centro',
    description: 'Luminoso depto a una cuadra del río.',
    published_at: '2026-10-12T10:00:00Z',
    url: 'https://www.youtube.com/watch?v=vid456',
    property_code: '',
    property_title: '',
    zone: '',
  },
];

async function bootCanal(page, videos) {
  await page.route('**/assets/data/canal-videos.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(videos),
    }));
  await page.goto('/canal.html');
  await page.waitForSelector('#canalGrid .canal-card, #canalGrid .canal-empty');
}

test.describe('Página pública del canal', () => {
  test('la página existe y es indexable', async ({ page }) => {
    const res = await page.goto('/canal.html');
    expect(res.status()).toBe(200);
    await expect(page).toHaveTitle(/Canal de YouTube/i);
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('index');
  });

  test('dibuja una card por video con el link a YouTube', async ({ page }) => {
    await bootCanal(page, VIDEOS);
    await expect(page.locator('#canalGrid .canal-card')).toHaveCount(2);
    await expect(page.locator('#canalGrid')).toContainText('Tour de la casa en Nueva Córdoba');
    const href = await page.locator('#canalGrid .canal-thumb').first().getAttribute('href');
    expect(href).toBe('https://www.youtube.com/watch?v=vid123');
  });

  test('la miniatura sale de la URL canónica de YouTube', async ({ page }) => {
    await bootCanal(page, VIDEOS);
    const src = await page.locator('#canalGrid .canal-thumb img').first().getAttribute('src');
    expect(src).toBe('https://i.ytimg.com/vi/vid123/hqdefault.jpg');
  });

  test('si el video tiene ficha, la card linkea a la ficha', async ({ page }) => {
    await bootCanal(page, VIDEOS);
    await expect(page.locator('#canalGrid .canal-tag')).toHaveCount(1);
    const href = await page.locator('#canalGrid .canal-tag').first().getAttribute('href');
    expect(href).toBe('/fichas/ML-0001.html');
  });

  test('el texto va escapado (un título con HTML no se inyecta)', async ({ page }) => {
    await bootCanal(page, [{
      id: 'x1',
      title: '<img src=x onerror=alert(1)>Tour',
      description: 'desc',
      published_at: '2026-10-20T10:00:00Z',
      url: 'https://www.youtube.com/watch?v=x1',
      property_code: '',
    }]);
    await expect(page.locator('#canalGrid img[src="x"]')).toHaveCount(0);
    await expect(page.locator('#canalGrid')).toContainText('<img src=x onerror=alert(1)>Tour');
  });

  test('con el JSON vacío avisa que todavía no hay videos (no rompe)', async ({ page }) => {
    await bootCanal(page, []);
    await expect(page.locator('#canalGrid .canal-empty')).toContainText('Todavía no hay videos');
  });

  test('si el JSON no existe, avisa sin romper la página', async ({ page }) => {
    await page.route('**/assets/data/canal-videos.json', (route) => route.fulfill({ status: 404, body: 'nope' }));
    await page.goto('/canal.html');
    await expect(page.locator('#canalGrid .canal-empty')).toContainText('No se pudieron cargar');
  });

  test('la navbar del sitio linkea a la página del canal', async ({ page }) => {
    await page.goto('/index.html');
    const link = page.locator('.navbar-inner a[href="/canal.html"]');
    await expect(link).toHaveCount(1);
  });
});
