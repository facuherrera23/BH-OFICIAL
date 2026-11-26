// Tipo de cliente "Colega / Corredor" (2026-11-26, pedido del empleador).
//
// Los colegas/corredores nos ingresan un lead porque están BUSCANDO una
// propiedad para un cliente propio. Antes ese lead se mezclaba con los
// compradores/inquilinos y no había forma de distinguirlo.
//
// Reglas del contrato:
//   · 'colega' es un valor de leads.tipo_cliente (CHECK en la DB).
//   · NO deriva operación: un colega puede buscar en venta O en alquiler →
//     la operación del lead se conserva (no se pisa con null).
//   · Tiene que aparecer en el alta, en el panel del CRM y en el chip de
//     color de la lista.
//   · Hay un filtro por tipo de cliente en la barra del CRM (pedido aparte
//     del empleador: "aca deberia aparecer un filtro de comprador/inquilino/
//     corredor").
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-app.js'), 'utf8');
const crmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-crm.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'admin.css'), 'utf8');
const migSrc = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20261126000001_leads_tipo_cliente_colega.sql'),
  'utf8',
);

test.describe('Tipo de cliente — Colega / Corredor', () => {
  test('la DB admite "colega" en el CHECK de tipo_cliente', () => {
    expect(migSrc).toContain('leads_tipo_cliente_check');
    expect(migSrc).toContain("'propietario','comprador','inversor','inquilino','colega'");
    // Aditivo: no borra ni reescribe filas (sólo el CHECK).
    expect(migSrc).not.toMatch(/DELETE\s+FROM\s+public\.leads/i);
    expect(migSrc).not.toMatch(/UPDATE\s+public\.leads/i);
  });

  test('el alta de lead ofrece la opción Colega / Corredor', async ({ page }) => {
    const start = htmlSrc.indexOf('<div class="admin-modal" id="leadModal">');
    const end = htmlSrc.indexOf('<!-- MODAL VISITA -->', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    await page.setContent(htmlSrc.slice(start, end));

    const tipo = page.locator('#leadForm select[name="tipo_cliente"]#leadTipoClienteSelect');
    await expect(tipo.locator('option[value="colega"]')).toHaveCount(1);
    await expect(tipo.locator('option[value="colega"]')).toHaveText('Colega / Corredor');
    // Sigue siendo UN solo selector visible (la operación va oculta).
    await expect(page.locator('#leadForm select[name="operation_type"]')).toHaveCount(0);
    await expect(page.locator('#leadForm input[name="operation_type"]#leadOperationType')).toHaveCount(1);
  });

  test('el Zod del alta acepta "colega" (si no, el alta muere con "Origen inválido")', () => {
    expect(appSrc).toContain("tipo_cliente: z.enum(['propietario','comprador','inversor','inquilino','colega'])");
  });

  test('"colega" NO deriva operación: se conserva la del lead', () => {
    // El alta: si el tipo no deriva operación, se preserva la legacy.
    expect(appSrc).toContain('? operationFromTipoCliente(validated.tipo_cliente) || (validated.operation_type ?? null)');
    // El panel del CRM: idem (no pisar la operación con null).
    expect(crmSrc).toContain('operation_type: (tipo ? operationFromTipoCliente(tipo) : null) || ((lead && lead.operation_type) || null)');
    // El mapa NO incluye colega (si lo incluyera, se inventaría una operación).
    const mapa = /TIPO_CLIENTE_OPERATION\s*=\s*\{([^}]*)\}/.exec(crmSrc);
    expect(mapa).toBeTruthy();
    expect(mapa[1]).not.toContain('colega');
  });

  test('el panel del CRM y la lista muestran la etiqueta "Colega / Corredor"', () => {
    expect(crmSrc).toContain("var TIPO_CLIENTE_OPTS = ['propietario','comprador','inversor','inquilino','colega'];");
    expect(crmSrc).toContain("colega:'Colega / Corredor'");
    // El select del panel lateral usa la etiqueta (no "Colega" pelado).
    expect(crmSrc).toContain("esc(TIPO_CLIENTE_LABELS[t] || t)");
    // El chip de la lista también.
    expect(crmSrc).toContain("esc(TIPO_CLIENTE_LABELS[l.tipo_cliente] || l.tipo_cliente)");
    // Y tiene color propio.
    expect(cssSrc).toContain('.crm-tipo-chip--colega{');
  });

  test('filtro por tipo de cliente en la barra del CRM', () => {
    expect(htmlSrc).toContain('id="crmTipoClienteFilter"');
    // Se aplica con eq (no con el filtro de operación: un colega no tiene
    // operación definida).
    expect(crmSrc).toContain("var tc = $id('crmTipoClienteFilter'); if (tc && tc.value) q = q.eq('tipo_cliente', tc.value);");
    // Cambia la lista al cambiar el filtro.
    expect(crmSrc).toContain("['crmStatusFilter', 'crmOriginFilter', 'crmTipoOperacionFilter', 'crmTipoClienteFilter', 'crmAgentFilter']");
    // Y se oculta en el modo propietarios (mismo que los otros de leads).
    expect(crmSrc).toContain("var leadOnly = ['crmStatusFilter', 'crmOriginFilter', 'crmTipoOperacionFilter', 'crmTipoClienteFilter', 'crmAgentFilter'");
    // El export CSV respeta el mismo filtro que la pantalla.
    expect(appSrc).toContain("const tcSel = document.getElementById('crmTipoClienteFilter');");
    expect(appSrc).toContain("if (tcSel && tcSel.value) q = q.eq('tipo_cliente', tcSel.value);");
  });

  test('behavioral: operationFromTipoCliente("colega") no inventa operación', () => {
    const from = crmSrc.indexOf('var TIPO_CLIENTE_OPTS');
    const to = crmSrc.indexOf('var PAGE_SIZE', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(crmSrc.slice(from, to), sandbox);

    expect(sandbox.operationFromTipoCliente('propietario')).toBe('venta');
    expect(sandbox.operationFromTipoCliente('inquilino')).toBe('alquiler');
    expect(sandbox.operationFromTipoCliente('colega')).toBe(null);
    /* El filtro de operación NO puede esconder a los colegas: no tienen
       operación definida (la UI no la permite), así que si no estuvieran en
       los tres, "Tipo: Colega" + "Operación: Compra" devolvería 0 filas.
       Aparecen como "operation_type IS NULL + colega" (no pisan una
       operación real). Es la misma semántica del motor de sugerencias, que
       para un colega no filtra por operación. */
    expect(sandbox.operationFilter('compra')).toContain('and(operation_type.is.null,tipo_cliente.eq.colega)');
    expect(sandbox.operationFilter('alquiler')).toContain('and(operation_type.is.null,tipo_cliente.eq.colega)');
    expect(sandbox.operationFilter('venta')).toContain('and(operation_type.is.null,tipo_cliente.eq.colega)');
    // Pero el filtro por TIPO sí los encuentra.
    expect(sandbox.TIPO_CLIENTE_OPTS).toContain('colega');
    expect(sandbox.TIPO_CLIENTE_LABELS.colega).toBe('Colega / Corredor');
  });

  /* El export CSV (admin-app.js) tiene que filtrar EXACTAMENTE igual que la
     lista (admin-crm.js): si divergen, el CSV no coincide con la pantalla. */
  test('el filtro de operación es idéntico en la lista (CRM) y en el export CSV', () => {
    const crmFrom = crmSrc.indexOf('var TIPO_CLIENTE_OPERATION');
    const crmTo = crmSrc.indexOf('var PAGE_SIZE', crmFrom);
    const crmSandbox = {};
    vm.createContext(crmSandbox);
    vm.runInContext(crmSrc.slice(crmFrom, crmTo), crmSandbox);

    const appFrom = appSrc.indexOf('const TIPO_CLIENTE_OPERATION');
    const appTo = appSrc.indexOf('// Visit validation', appFrom);
    expect(appFrom).toBeGreaterThan(-1);
    expect(appTo).toBeGreaterThan(appFrom);
    const appSandbox = {};
    vm.createContext(appSandbox);
    vm.runInContext(appSrc.slice(appFrom, appTo) + '\n;globalThis.__opFilter = operationFilter;', appSandbox);

    for (const op of ['compra', 'venta', 'alquiler']) {
      expect(appSandbox.__opFilter(op)).toBe(crmSandbox.operationFilter(op));
      expect(appSandbox.__opFilter(op)).toContain('tipo_cliente.eq.colega');
    }
  });

  /* BEHAVIORAL: la función REAL que arma la query del CRM (applyBaseFilters)
     tiene que aplicar LOS DOS filtros a la vez (operación + tipo). No alcanza
     con que operationFilter exista: si el CRM no lo aplicara, "Tipo: Colega"
     + "Operación: Compra" devolvería 0 filas.
     (PostgREST combina varios `or=` con AND — verificado contra producción.) */
  test('behavioral: applyBaseFilters aplica operación Y tipo a la vez', () => {
    const helpersFrom = crmSrc.indexOf('var TIPO_CLIENTE_OPTS');
    const helpersTo = crmSrc.indexOf('var PAGE_SIZE', helpersFrom);
    const filtersFrom = crmSrc.indexOf('function applyBaseFilters(q) {');
    const filtersTo = crmSrc.indexOf('function ownerPendingTasks', filtersFrom);
    expect(helpersFrom).toBeGreaterThan(-1);
    expect(helpersTo).toBeGreaterThan(helpersFrom);
    expect(filtersFrom).toBeGreaterThan(-1);
    expect(filtersTo).toBeGreaterThan(filtersFrom);

    const selects = {
      crmSearch: { value: '' },
      crmStatusFilter: { value: '' },
      crmOriginFilter: { value: '' },
      crmTipoOperacionFilter: { value: '' },
      crmTipoClienteFilter: { value: '' },
      crmAgentFilter: { value: '' },
    };
    const sandbox = {
      Date,
      console,
      $id: (id) => selects[id] || null,
      _mlUntouchedFilter: false,
      _hasFollowupFilter: false,
      _kpiFilter: null,
      _kpiTaskIds: null,
      _kpiPropIds: null,
      _showTrash: false,
    };
    vm.createContext(sandbox);
    vm.runInContext(crmSrc.slice(helpersFrom, helpersTo), sandbox);
    vm.runInContext(crmSrc.slice(filtersFrom, filtersTo), sandbox);

    const recorder = () => {
      const calls = [];
      const q = {
        eq: (c, v) => { calls.push(['eq', c, v]); return q; },
        neq: (c, v) => { calls.push(['neq', c, v]); return q; },
        or: (cond) => { calls.push(['or', cond]); return q; },
        is: (c, v) => { calls.push(['is', c, v]); return q; },
        not: (c, op, v) => { calls.push(['not', c, op, v]); return q; },
        in: (c, vals) => { calls.push(['in', c, vals]); return q; },
        gte: (c, v) => { calls.push(['gte', c, v]); return q; },
      };
      return { q, calls };
    };

    // 1) Operación + tipo a la vez.
    selects.crmTipoOperacionFilter.value = 'compra';
    selects.crmTipoClienteFilter.value = 'colega';
    let { q, calls } = recorder();
    sandbox.applyBaseFilters(q);
    const orCall = calls.find((c) => c[0] === 'or');
    const tipoCall = calls.find((c) => c[0] === 'eq' && c[1] === 'tipo_cliente');
    expect(orCall, 'el filtro de operación no se aplicó').toBeTruthy();
    expect(orCall[1]).toContain('and(operation_type.is.null,tipo_cliente.eq.colega)');
    expect(tipoCall, 'el filtro de tipo no se aplicó').toBeTruthy();
    expect(tipoCall[2]).toBe('colega');

    // 2) Sólo tipo (sin operación): no se mete ningún `or` de operación.
    selects.crmTipoOperacionFilter.value = '';
    selects.crmTipoClienteFilter.value = 'colega';
    ({ q, calls } = recorder());
    sandbox.applyBaseFilters(q);
    expect(calls.filter((c) => c[0] === 'or').length).toBe(0);
    expect(calls.find((c) => c[0] === 'eq' && c[1] === 'tipo_cliente')[2]).toBe('colega');

    // 3) Sólo operación: el grupo colega entra en los TRES filtros.
    selects.crmTipoOperacionFilter.value = 'alquiler';
    selects.crmTipoClienteFilter.value = '';
    ({ q, calls } = recorder());
    sandbox.applyBaseFilters(q);
    const orAlq = calls.find((c) => c[0] === 'or');
    expect(orAlq[1]).toContain('and(operation_type.is.null,tipo_cliente.eq.colega)');
    expect(calls.filter((c) => c[0] === 'eq' && c[1] === 'tipo_cliente').length).toBe(0);
  });
});
