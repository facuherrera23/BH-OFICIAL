const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Simular caída de Supabase
  await page.route('**/rnldqiwwzhjnurkguihu.supabase.co/**', route => route.abort());
  await page.goto('http://localhost:8788/index.html?t=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const bannerVisible = await page.locator('#serviceBanner').isVisible();
  const emptyText = await page.locator('#propertyGrid .empty-state-title').textContent().catch(() => null);
  const retryVisible = await page.locator('#propertyGrid .empty-state button').isVisible().catch(() => false);
  await page.screenshot({ path: 'test-results/fallback-banner.png' });

  console.log(JSON.stringify({ bannerVisible, emptyText, retryVisible }));
  await browser.close();

  // Verificación 2: página sana (sin bloqueo)
  const b2 = await chromium.launch();
  const p2 = await b2.newPage();
  await p2.goto('http://localhost:8788/index.html?t=' + Date.now(), { waitUntil: 'networkidle' });
  await p2.waitForTimeout(2500);
  const banner2 = await p2.locator('#serviceBanner').count();
  const cards = await p2.locator('#propertyGrid .property-card').count();
  console.log(JSON.stringify({ saneNoFalla: banner2 === 0, cardsEnCatalogo: cards }));
  await b2.close();
})();
