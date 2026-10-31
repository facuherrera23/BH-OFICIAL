// Harness funcional del modal "desactivar propietario" (2026-10-30).
// Carga admin-propietarios.js REAL contra un cliente Supabase falso:
// verifica el motivo obligatorio, las consecuencias, la traza en el timeline
// y el opt-in de despublicar propiedades. NO toca la base de datos.
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/helpers/owner-status-harness.html';
const OWNER_ID = '11111111-1111-1111-1111-111111111111';

async function boot(page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__HARNESS_READY === true);
  await page.waitForFunction(() => typeof window.adminApp?.setOwnerStatus === 'function');
}

function writes(log, table) {
  return (log || []).filter(e => e.op && e.table === table);
}

test.describe('CRM — modal de desactivación de propietario (harness local)', () => {
  test('desactivar abre el modal con las consecuencias y el aviso de propiedades', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.setOwnerStatus(id, 'inactivo'), OWNER_ID);

    await expect(page.locator('#ownerStatusModal')).toHaveClass(/is-open/);
    const info = await page.locator('#ownerStatusModalInfo').innerText();
    expect(info).toContain('Deja de generar alertas');
    expect(info).toContain('Se revoca su acceso al portal');
    expect(info).toContain('1 propiedad(es)');
    // Tiene 1 tarea abierta → se avisa, pero NO se borra.
    expect(info).toContain('1 tarea(s) abierta(s)');
    // Tiene 1 propiedad publicada → se avisa antes de desactivar.
    expect(info).toContain('PUBLICADA');
    expect(info).toContain('ML-777');
    // El opt-in de despublicar se muestra (hay publicadas).
    await expect(page.locator('#ownerStatusUnpublishWrap')).toBeVisible();
    // El motivo empieza vacío (obligatorio).
    await expect(page.locator('#ownerStatusReason')).toHaveValue('');
  });

  test('sin motivo NO se desactiva (queda el modal abierto con el aviso)', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.setOwnerStatus(id, 'inactivo'), OWNER_ID);
    await page.click('#ownerStatusConfirm');
    await page.waitForTimeout(150);

    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some(t => t.type === 'warning' && /motivo/i.test(t.msg))).toBe(true);
    // No se escribió nada en la base.
    const log = await page.evaluate(() => window.__HARNESS_LOG);
    expect(writes(log, 'owners')).toHaveLength(0);
    // El modal sigue abierto (el usuario completa el motivo).
    await expect(page.locator('#ownerStatusModal')).toHaveClass(/is-open/);
  });

  test('con motivo: actualiza el estado, despublica (opt-in) y deja traza', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.setOwnerStatus(id, 'inactivo'), OWNER_ID);
    await page.fill('#ownerStatusReason', 'Vendió ML-777, no posee otras');
    await page.check('#ownerStatusUnpublish');
    await page.click('#ownerStatusConfirm');
    await page.waitForFunction(() => window.__HARNESS_LOG.some(e => e.op === 'update' && e.table === 'owners'));

    const log = await page.evaluate(() => window.__HARNESS_LOG);

    // 1) UPDATE de owners: status + motivo + fecha. NUNCA deleted_at.
    const ownerWrites = writes(log, 'owners');
    expect(ownerWrites).toHaveLength(1);
    const payload = ownerWrites[0].payload;
    expect(payload.status).toBe('inactivo');
    expect(payload.status_reason).toBe('Vendió ML-777, no posee otras');
    expect(payload.status_changed_at).toBeTruthy();
    expect(payload.deleted_at).toBeUndefined();
    expect(ownerWrites[0].filters.some(f => f.t === 'eq' && f.col === 'id' && f.val === OWNER_ID)).toBe(true);

    // 2) Las propiedades publicadas se despublican SOLO por el opt-in.
    const propWrites = writes(log, 'properties');
    expect(propWrites).toHaveLength(1);
    expect(propWrites[0].payload.is_published).toBe(false);

    // 3) Traza en el timeline del expediente.
    const timelineWrites = writes(log, 'owner_timeline_entries');
    expect(timelineWrites).toHaveLength(1);
    expect(timelineWrites[0].payload[0].type).toBe('status');
    expect(timelineWrites[0].payload[0].text).toContain('desactivado');
    expect(timelineWrites[0].payload[0].text).toContain('Vendió ML-777');

    // 4) Toast de éxito + el modal se cierra.
    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some(t => t.type === 'success' && /desactivado/i.test(t.msg))).toBe(true);
    await expect(page.locator('#ownerStatusModal')).not.toHaveClass(/is-open/);
  });

  test('sin despublicar marcado, las propiedades NO se tocan', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.setOwnerStatus(id, 'inactivo'), OWNER_ID);
    await page.fill('#ownerStatusReason', 'Sin contacto');
    await page.click('#ownerStatusConfirm');
    await page.waitForFunction(() => window.__HARNESS_LOG.some(e => e.op === 'update' && e.table === 'owners'));

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    expect(writes(log, 'properties')).toHaveLength(0);
    expect(writes(log, 'owners')[0].payload.status).toBe('inactivo');
  });

  test('reactivar pide confirmación y deja status_reason vacío', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => window.adminApp.setOwnerStatus(id, 'activo'), OWNER_ID);
    await page.waitForFunction(() => window.__HARNESS_LOG.some(e => e.op === 'update' && e.table === 'owners'));

    const log = await page.evaluate(() => window.__HARNESS_LOG);
    const payload = writes(log, 'owners')[0].payload;
    expect(payload.status).toBe('activo');
    expect(payload.status_reason).toBeNull();
    expect(payload.status_changed_at).toBeTruthy();

    const timeline = writes(log, 'owner_timeline_entries')[0].payload[0];
    expect(timeline.type).toBe('status');
    expect(timeline.text).toContain('reactivado');
  });

  test('un broker NO puede cambiar el estado', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { window.currentProfile = { role: 'broker' }; });
    const res = await page.evaluate((id) => window.adminApp.setOwnerStatus(id, 'inactivo'), OWNER_ID);
    expect(res).toBe(false);
    const toasts = await page.evaluate(() => window.__TOASTS);
    expect(toasts.some(t => t.type === 'error' && /administrador/i.test(t.msg))).toBe(true);
    const log = await page.evaluate(() => window.__HARNESS_LOG);
    expect(writes(log, 'owners')).toHaveLength(0);
  });
});
