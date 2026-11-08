// RELA / ZonaProp — mensajes que se entienden cuando la API está caída
// (2026-11-08).
// Guards ESTÁTICOS sobre admin-portales.js. No tocan la BD ni la red.
//
// POR QUÉ: con la API de ZonaProp caída (HTTP 521 todo el 7/11), el panel
// mostraba el error crudo del proxy ("RELA GET /v1/ubicaciones → 521") y el
// toast de Reconciliar decía "N avisos consultados" en verde cuando en realidad
// no se pudo consultar ninguno. El dueño no tiene por qué leer telemetría del
// proxy: relaFriendlyError() traduce y los toasts cuentan la verdad.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORTALES = path.join(ROOT, 'assets', 'js', 'admin-portales.js');
const src = fs.readFileSync(PORTALES, 'utf8');

test.describe('RELA — mensajes amigables ante caída de la API', () => {
  test('existe la traducción y TODOS los errores de relaApiCall la atraviesan', () => {
    expect(src).toContain('function relaFriendlyError(');
    // Único embudo: el throw del !res.ok de relaApiCall va traducido.
    expect(src).toMatch(
      /throw new Error\(relaFriendlyError\(errJson\.error \|\| `Error \$\{res\.status\}`\)\)/
    );
  });

  test('la traducción cubre caída, red, login, sesión vencida y cuenta sin vincular', () => {
    // 521: Cloudflare sin origen vivo — el caso del 7/11.
    expect(src).toContain('La API de ZonaProp está caída (error 521)');
    expect(src).toContain('No se pudo conectar con la API de ZonaProp');
    expect(src).toContain('ZonaProp rechazó las credenciales de la integración');
    expect(src).toContain('La sesión con ZonaProp expiró o fue rechazada');
    // 409: binding pendiente de QuintoAndar (caso 30662083/disponibilidad).
    expect(src).toContain('ZonaProp todavía no vinculó esta cuenta a la integración');
    // Y los disparadores documentados en el comentario del helper.
    expect(src).toContain('error code: 521');
    expect(src).toContain('RELA red:');
    expect(src).toContain('login falló');
  });

  test('Catálogos: si fallan TODOS muestra el motivo, no un conteo vacío', () => {
    // Los 5 endpoints caen a la vez sólo si la API está caída → motivo real.
    const iCat = src.indexOf('if (!okCount && failCount) {');
    expect(iCat).toBeGreaterThan(-1);
    const bloqueCat = src.slice(iCat, src.indexOf('loadRelaPanel();', iCat));
    expect(bloqueCat).toContain('relaFriendlyError(Object.values(failed)[0])');
  });

  test('Reconciliar: NO dice "consultados" en verde si toda la lista falló', () => {
    expect(src).toMatch(/fallas\.length === lista\.length/);
    expect(src).toContain('relaFriendlyError(fallas[0].error)');
    // Caso intermedio: cuenta consultados y con error por separado.
    expect(src).toMatch(/avisos consultados, \$\{fallas\.length\} con error/);
  });

  test('el preflight queda intacto: su única llamada RPC es preflight', () => {
    const bloque = src.slice(
      src.indexOf('window.adminApp.relaPreflight'),
      src.indexOf('window.adminApp.relaSyncCatalogs')
    );
    const llamadas = bloque.match(/relaApiCall\('([a-z_]+)'\)/g) || [];
    expect(llamadas).toEqual(["relaApiCall('preflight')"]);
  });
});
