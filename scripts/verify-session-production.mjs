// Verificación integral en producción de todo el trabajo de la sesión.
const checks = [];
const ok = (name, cond) => checks.push([name, !!cond]);

(async () => {
  const admin = await (await fetch('https://bienenhaus.com.ar/admin.html')).text();
  ok('admin.html mojibake=0', (admin.match(/\u00c3[\u00b3\u00a9\u00ad\u00b1\u00ba]/g) || []).length === 0);
  ok('admin.html v16 del JS de propietarios', admin.includes('admin-propietarios.js?v=16'));
  ok('admin.html modal del portal', admin.includes('portalLinkModal'));

  const js16 = await (await fetch('https://bienenhaus.com.ar/assets/js/admin-propietarios.js?v=16')).text();
  ok('JS v16: openPortalLinkModal', js16.includes('openPortalLinkModal'));
  ok('JS v16: fix de mensaje revocado', js16.includes('fue cerrado por el propietario'));
  ok('JS v16: upsert limpia revocacion', js16.includes('revoked_at: null'));
  ok('JS v16: guard sin propietario', js16.includes('Primero guarde el propietario'));

  const tas = await (await fetch('https://bienenhaus.com.ar/assets/js/pages/tasacion-page.js?v=8')).text();
  ok('tasaciones: currencySymbol', tas.includes('function currencySymbol'));
  ok('tasaciones: persiste type alquiler/venta', tas.includes("type: isAlquiler ? 'alquiler' : 'venta'"));
  ok('tasaciones: persiste valuation_ars', tas.includes('valuation_ars: isAlquiler ? _lastValorFinal : null'));

  const ficha = await (await fetch('https://bienenhaus.com.ar/fichas/DA-P0009.html')).text();
  ok('fichas: CSP presente', ficha.includes('Content-Security-Policy'));

  const portal = await (await fetch('https://bienenhaus.com.ar/assets/js/pages/portal-propietario-page.js?v=19')).text();
  ok('portal: currency-aware', portal.includes("t.type === 'alquiler'"));

  const stub = await fetch('https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/supervision-notify', { method: 'POST', headers: { Authorization: 'Bearer x' }, body: '{}' });
  ok('supervision-notify: 410', stub.status === 410);

  const shim = await (await fetch('https://bienenhaus.com.ar/assets/js/admin-supervision-panel.js?v=4')).text();
  ok('supervision: shim con gate de rol', shim.includes("role !== 'super_admin'"));

  for (const [name, passed] of checks) console.log((passed ? 'PASS' : 'FAIL') + '  ' + name);
  const fails = checks.filter(c => !c[1]);
  console.log(fails.length === 0 ? '\nTODO VERIFICADO EN PRODUCCION' : '\nFALLOS: ' + fails.map(f => f[0]).join(', '));
  process.exit(fails.length === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
