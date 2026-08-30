// Playwright E2E config — BH-OFICIAL
// Suite read-only: valida contra producción vía anon key (RLS protege escrituras).
// El server local se levanta (o reutiliza el ya activo en :8788) antes de los tests.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 45000,          // Supabase real tiene latencia real
  expect: { timeout: 15000 },
  fullyParallel: false,    // un solo worker: server compartido + determinismo RLS-free
  workers: 1,
  retries: 2,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: 'http://localhost:8788',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    headless: true,
  },
  webServer: {
    command: 'python -m http.server 8788',
    url: 'http://localhost:8788/index.html',
    reuseExistingServer: true,
    timeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});