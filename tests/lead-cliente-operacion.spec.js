// Un solo dato: tipo de cliente → operación derivada (19/11/2026).
//
// El modal "Nuevo Prospecto / Lead" pedía DOS campos casi iguales:
//   tipo_cliente   (propietario/comprador/inversor/inquilino)
//   operation_type (compra/venta/alquiler)
// En producción tipo_cliente está cargado en 76 leads contra 32 con
// operation_type, y el panel del CRM ya sólo editaba el tipo. Ahora se carga
// UNO solo y la operación se calcula. No se escribió nada en la DB.
//
// Guards estáticos + behavioral de las funciones reales (vm, sin DB).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-app.js'), 'utf8');
const crmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm.js'), 'utf8');
const propsSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-propiedades.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

function mapFrom(src) {
  const m = /TIPO_CLIENTE_OPERATION\s*=\s*\{([^}]*)\}/.exec(src);
  expect(m, 'mapa TIPO_CLIENTE_OPERATION no encontrado').toBeTruthy();
  return m[1].replace(/\s/g, '');
}

test.describe('Alta de lead — un solo campo tipo/operación', () => {
  test('el modal tiene UN selector visible y la operación va oculta', async ({ page }) => {
    const start = htmlSrc.indexOf('<div class="admin-modal" id="leadModal">');
    expect(start).toBeGreaterThan(-1);
    const end = htmlSrc.indexOf('<!-- MODAL VISITA -->', start);
    expect(end).toBeGreaterThan(start);
    await page.setContent(htmlSrc.slice(start, end));

    const tipo = page.locator('#leadForm select[name="tipo_cliente"]#leadTipoClienteSelect');
    await expect(tipo).toHaveCount(1);
    await expect(page.locator('#leadForm select[name="operation_type"]')).toHaveCount(0);
    await expect(page.locator('#leadForm input[name="operation_type"]#leadOperationType')).toHaveCount(1);
    await expect(page.locator('#leadForm input[name="operation_type"]')).toBeHidden();
    const labels = await tipo.locator('option').allInnerTexts();
    expect(labels.join(' | ')).toContain('Propietario (venta)');
    expect(labels.join(' | ')).toContain('Comprador (compra)');
    expect(labels.join(' | ')).toContain('Inversor (compra)');
    expect(labels.join(' | ')).toContain('Inquilino (alquiler)');
  });

  test('el mismo mapa rige en los 3 módulos que escriben/leen el vínculo', () => {
    const esperado = mapFrom(appSrc);
    expect(mapFrom(crmSrc)).toBe(esperado);
    expect(mapFrom(propsSrc)).toBe(esperado);
    expect(esperado).toContain("propietario:'venta'");
    expect(esperado).toContain("inquilino:'alquiler'");
  });

  test('el submit deriva la operación del tipo y preserva la legacy sin tipo', () => {
    expect(appSrc).toContain('operation_type: validated.tipo_cliente');
    expect(appSrc).toContain('? operationFromTipoCliente(validated.tipo_cliente)');
    expect(appSrc).toContain(': (validated.operation_type ?? null)');
    // Al editar se hidratan AMBOS campos (antes ni siquiera se cargaba el tipo).
    expect(appSrc).toContain("setF('tipo_cliente', lead.tipo_cliente || '')");
    expect(appSrc).toContain("setF('operation_type', lead.operation_type || '')");
  });

  test('el panel del CRM guarda la operación derivada del tipo', () => {
    expect(crmSrc).toContain('collectSideForm(panel, lead)');
    expect(crmSrc).toContain("var tipo = v('crmDtlTipoCliente');");
    expect(crmSrc).toContain('operation_type: tipo ? operationFromTipoCliente(tipo)');
    expect(crmSrc).toContain("((lead && lead.operation_type) || null)");
  });

  test('filtros y sugerencias consideran leads con tipo pero sin operación', () => {
    expect(crmSrc).toContain("q = q.or(operationFilter(tp.value))");
    expect(crmSrc).toContain('var opType = leadOperation(lead);');
    expect(appSrc).toContain('q = q.or(operationFilter(tpSel.value))');
    expect(propsSrc).toContain('budget_usd, tipo_cliente, operation_type, stage');
    expect(propsSrc).toContain('const op = l.operation_type || TIPO_CLIENTE_OPERATION[l.tipo_cliente]');
  });

  test('behavioral: mapeo, fallback y filtro con el código real del CRM', () => {
    const from = crmSrc.indexOf('var TIPO_CLIENTE_OPERATION');
    const to = crmSrc.indexOf('var PAGE_SIZE', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(crmSrc.slice(from, to), sandbox);

    expect(sandbox.operationFromTipoCliente('propietario')).toBe('venta');
    expect(sandbox.operationFromTipoCliente('comprador')).toBe('compra');
    expect(sandbox.operationFromTipoCliente('inversor')).toBe('compra');
    expect(sandbox.operationFromTipoCliente('inquilino')).toBe('alquiler');
    expect(sandbox.operationFromTipoCliente(undefined)).toBe(null);

    // La operación explícita manda; si no hay, se deriva del tipo.
    expect(sandbox.leadOperation({ tipo_cliente: 'comprador' })).toBe('compra');
    expect(sandbox.leadOperation({ tipo_cliente: 'comprador', operation_type: 'alquiler' })).toBe('alquiler');
    expect(sandbox.leadOperation({})).toBe('');

    expect(sandbox.operationFilter('compra')).toBe(
      'operation_type.eq.compra,' +
      'and(operation_type.is.null,tipo_cliente.eq.comprador),' +
      'and(operation_type.is.null,tipo_cliente.eq.inversor)'
    );
    expect(sandbox.operationFilter('venta')).toContain('tipo_cliente.eq.propietario');
    expect(sandbox.operationFilter('alquiler')).toContain('tipo_cliente.eq.inquilino');
  });
});
