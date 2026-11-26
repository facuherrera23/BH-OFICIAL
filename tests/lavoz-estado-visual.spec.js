// Estado visual del aviso de La Voz (2026-11-26, pedido del empleador):
//
//   · el ícono de La Voz en la fila de Propiedades tiene que cambiar de
//     color: rojo = sin publicar, VERDE = ya publicado, ámbar = por vencer,
//     gris = vencido;
//   · el modal tiene que dejar cargar la FECHA REAL que muestra La Voz
//     ("Finaliza 06/12/2026") para coordinar la publicación.
//
// Guards estáticos + behavioral de la función real de color (vm, sin DB).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const propsSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-propiedades.js'), 'utf8');
const portalesSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-portales.js'), 'utf8');
const fnSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'lavoz-proxy', 'index.ts'), 'utf8');

const DIA = 86400000;

function extraerLavozEstadoDe(src) {
  const from = src.indexOf('function lavozEstadoDe(row) {');
  const to = src.indexOf('/* La Voz cambia de estado desde el panel de Portales', from);
  expect(from, 'lavozEstadoDe no encontrado').toBeGreaterThan(-1);
  expect(to, 'fin de lavozEstadoDe no encontrado').toBeGreaterThan(from);
  return src.slice(from, to);
}

test.describe('La Voz — ícono con estado real + fecha de vencimiento', () => {
  test('la fila de Propiedades lee el estado de La Voz (la tabla lavoz_listings)', () => {
    expect(propsSrc).toContain("client.from('lavoz_listings')");
    expect(propsSrc).toContain(".select('property_id, status, ad_url, published_at, expires_at')");
    // Si la tabla no se puede leer, la lista NO se rompe.
    expect(propsSrc).toContain('logWarn(\'Propiedades: no se pudo leer el estado de La Voz\'');
  });

  test('el ícono usa el color del estado (ya no es rojo fijo)', () => {
    // El botón se arma con el color calculado.
    expect(propsSrc).toContain('const lvEstado = lavozEstadoDe(lavozMap[p.id]);');
    expect(propsSrc).toContain('style="color:${lvEstado.color};"');
    // Y el botón viejo, rojo fijo, ya no está.
    expect(propsSrc).not.toContain('style="color:#E4002B;" title="Preparar aviso para Clasificados La Voz"');
  });

  test('los 4 estados tienen su color (rojo / verde / ámbar / gris)', () => {
    expect(propsSrc).toContain("color: '#E4002B'");   // sin publicar
    expect(propsSrc).toContain("color: '#4ade80'");   // publicado
    expect(propsSrc).toContain("color: '#FFB800'");   // por vencer (≤7 días)
    expect(propsSrc).toContain("color: '#94a3b8'");   // vencido
    // Verde = "ya fue publicado" (no rojo).
    expect(propsSrc).toContain("title: 'Publicado en La Voz'");
  });

  test('el ícono se refresca al confirmar/despublicar desde Portales', () => {
    expect(propsSrc).toContain('window.adminApp.refreshLavozIcons = function ()');
    expect(portalesSrc).toContain("if (typeof window.adminApp.refreshLavozIcons === 'function') window.adminApp.refreshLavozIcons();");
  });

  test('behavioral: lavozEstadoDe con los casos reales', () => {
    const sandbox = { Date, Math, console };
    vm.createContext(sandbox);
    vm.runInContext(extraerLavozEstadoDe(propsSrc), sandbox);
    const f = sandbox.lavozEstadoDe;

    // Sin aviso: rojo (falta publicar).
    expect(f(null).color).toBe('#E4002B');

    // Publicado con link y vencimiento lejos → verde.
    const lejos = new Date(Date.now() + 20 * DIA).toISOString();
    const verde = f({ status: 'published', ad_url: 'https://clasificados.lavoz.com.ar/avisos/inmuebles/terreno/5680772/x', published_at: new Date().toISOString(), expires_at: lejos });
    expect(verde.color).toBe('#4ade80');
    expect(verde.title).toContain('Publicado en La Voz');

    // Preparado pero NO publicado → rojo (con la pista de que falta marcar).
    const listo = f({ status: 'ready', ad_url: null, published_at: null, expires_at: null });
    expect(listo.color).toBe('#E4002B');
    expect(listo.title).toContain('falta marcarlo publicado');

    // Aviso con datos faltantes → rojo.
    expect(f({ status: 'failed', ad_url: null }).color).toBe('#E4002B');

    // Published que vence en ≤7 días → ámbar.
    const pronto = f({ status: 'published', ad_url: 'https://clasificados.lavoz.com.ar/avisos/inmuebles/terreno/5680772/x', published_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3 * DIA).toISOString() });
    expect(pronto.color).toBe('#FFB800');
    expect(pronto.title).toContain('vence en');

    // Vencido → gris.
    const vencido = f({ status: 'published', ad_url: 'https://clasificados.lavoz.com.ar/avisos/inmuebles/terreno/5680772/x', published_at: new Date(Date.now() - 40 * DIA).toISOString(), expires_at: new Date(Date.now() - 2 * DIA).toISOString() });
    expect(vencido.color).toBe('#94a3b8');
    expect(vencido.title).toContain('VENCIDO');

    /* Un 'prepare' viejo degradaba el estado a 'ready' pero conservaba el
       link + fecha de publicación: eso ES un aviso publicado (la prueba de
       publicación), así que el ícono va verde. */
    const degradado = f({ status: 'ready', ad_url: 'https://clasificados.lavoz.com.ar/avisos/inmuebles/terreno/5680772/x', published_at: new Date().toISOString(), expires_at: lejos });
    expect(degradado.color).toBe('#4ade80');
  });

  test('el modal ofrece el campo de fecha real y la manda al server', () => {
    expect(portalesSrc).toContain('id="lavozVenceEl"');
    expect(portalesSrc).toContain('expires_at: venceFecha || undefined');
    expect(portalesSrc).toContain('lavozFechaInput(r.expires_at, p.dias_publicacion)');
    // La fecha se escribe como 'YYYY-MM-DD' (input type=date).
    expect(portalesSrc).toContain("/^\\d{4}-\\d{2}-\\d{2}$/");
  });

  test('el server valida la fecha que le mandan', () => {
    expect(fnSrc).toContain('function validarVencimiento(valor: unknown): string | null {');
    expect(fnSrc).toContain("throw new Error('La fecha de vencimiento no es válida');");
    expect(fnSrc).toContain("throw new Error('La fecha de vencimiento tiene que ser futura');");
    expect(fnSrc).toContain('venceManual = validarVencimiento(body.expires_at);');
    expect(fnSrc).toContain('const expires = venceManual ? new Date(venceManual) : new Date(now.getTime() + dias * 86400000);');
  });

  /* La fecha manual tiene que vencer al FINAL del día local (Argentina,
     UTC-3 sin horario de verano): con 23:59:59Z el aviso vencía a las 20:59
     y el ícono ya lo pintaba vencido 3 h antes de que terminara el día. */
  test('el vencimiento manual es el final del día en hora Argentina', () => {
    expect(fnSrc).toContain("new Date(s + 'T23:59:59-03:00')");
    expect(fnSrc).not.toContain("new Date(s + 'T23:59:59.000Z')");
  });

  test('el panel avisa el tope de 400 días antes de mandarlo al server', () => {
    // El input no deja elegir una fecha fuera del rango.
    expect(portalesSrc).toContain('max="${esc(lavozFechaMax())}"');
    expect(portalesSrc).toContain('function lavozFechaMax()');
    expect(portalesSrc).toContain('400 * 86400000');
    // Y el confirm lo valida (si el navegador lo dejara pasar).
    expect(portalesSrc).toContain('La fecha de vencimiento no puede ser más de 400 días.');
  });

  /* Un aviso con link + fecha de publicación ESTÁ publicado aunque su
     status guardado diga ready/failed (un 'prepare' viejo lo degradó):
     el panel de Portales tiene que mostrarlo como publicado, igual que el
     ícono de Propiedades (si no, los dos paneles se contradicen). */
  test('el panel de Portales muestra el estado real (no el degradado)', () => {
    expect(portalesSrc).toContain('function lavozStatusEfectivo(row) {');
    expect(portalesSrc).toContain('${lavozStatusBadge(statusEf)}');
    expect(portalesSrc).toContain("${statusEf === 'published' ? `<button class=\"btn-action danger\"");
    expect(portalesSrc).toContain('const statusEf = lavozStatusEfectivo(row);');
  });

  test('behavioral: lavozStatusEfectivo con los casos reales', () => {
    const from = portalesSrc.indexOf('function lavozStatusEfectivo(row) {');
    const to = portalesSrc.indexOf('function lavozFecha(iso)', from);
    expect(from, 'lavozStatusEfectivo no encontrado').toBeGreaterThan(-1);
    expect(to, 'fin de lavozStatusEfectivo no encontrado').toBeGreaterThan(from);
    const sandbox = { Date, Math, console };
    vm.createContext(sandbox);
    vm.runInContext(portalesSrc.slice(from, to), sandbox);
    const f = sandbox.lavozStatusEfectivo;

    // Sin aviso → draft.
    expect(f(null)).toBe('draft');
    // Preparado, sin link → sigue ready (falta publicar).
    expect(f({ status: 'ready', ad_url: null, published_at: null })).toBe('ready');
    // Publicado normal.
    expect(f({ status: 'published', ad_url: 'https://x', published_at: '2026-11-20T10:00:00Z' })).toBe('published');
    // Degradado por un prepare viejo: link + fecha → PUBLISHED.
    expect(f({ status: 'ready', ad_url: 'https://x', published_at: '2026-11-20T10:00:00Z' })).toBe('published');
    expect(f({ status: 'failed', ad_url: 'https://x', published_at: '2026-11-20T10:00:00Z' })).toBe('published');
    // Vencido y expirado se respetan.
    expect(f({ status: 'expired', ad_url: 'https://x', published_at: '2026-11-20T10:00:00Z' })).toBe('expired');
  });
});
