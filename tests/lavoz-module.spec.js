// Clasificados La Voz — publicación asistida (2026-11-04).
// Guards ESTÁTICOS del módulo: migración + edge function + UI + paquete de
// fotos. No tocan la BD ni la red.
//
// POR QUÉ ASISTIDA: La Voz NO tiene API pública ni carga masiva (verificado
// 2026-11-04 contra el portal: sin API en FAQ/Términos/sitemap/bundles; la
// única ruta JSON del front es /api/auth/me; el portal está detrás de
// Cloudflare Turnstile y su robots.txt bloquea AI crawlers). El CRM arma el
// aviso completo y una persona lo carga en el panel de La Voz.
//
// El punto sensible del módulo: la foto PORTADA (la PRIMERA de image_urls,
// la misma que usa la ficha pública) tiene que ser la primera que se sube.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations', '20261104000001_lavoz_publicacion.sql');
const FN = path.join(ROOT, 'supabase', 'functions', 'lavoz-proxy', 'index.ts');
const MAPPER = path.join(ROOT, 'supabase', 'functions', '_shared', 'lavoz.mapper.ts');

const migSrc = fs.readFileSync(MIG, 'utf8');
const fnSrc = fs.readFileSync(FN, 'utf8');
const mapperSrc = fs.readFileSync(MAPPER, 'utf8');
const portalesSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-portales.js'), 'utf8');
const propsSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-propiedades.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const deploySrc = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');

test.describe('La Voz — módulo de publicación asistida', () => {
  test('migración: tablas aditivas + RLS + RPC con grants', () => {
    expect(migSrc).toContain('CREATE TABLE IF NOT EXISTS public.lavoz_config');
    expect(migSrc).toContain('CREATE TABLE IF NOT EXISTS public.lavoz_listings');

    // Aditiva: nunca borra datos (producción real).
    expect(migSrc).not.toMatch(/DELETE\s+FROM/i);
    expect(migSrc).not.toMatch(/TRUNCATE/i);
    expect(migSrc).not.toMatch(/DROP\s+TABLE/i);

    // RLS en las dos tablas.
    expect(migSrc).toContain('ALTER TABLE public.lavoz_config ENABLE ROW LEVEL SECURITY;');
    expect(migSrc).toContain('ALTER TABLE public.lavoz_listings ENABLE ROW LEVEL SECURITY;');

    // Lectura autenticados; la config sólo la escribe super_admin.
    expect(migSrc).toContain('CREATE POLICY lavoz_config_read ON public.lavoz_config');
    expect(migSrc).toContain('CREATE POLICY lavoz_config_write ON public.lavoz_config');
    expect(migSrc).toContain('public.is_super_admin(auth.uid())');
    expect(migSrc).toContain('CREATE POLICY lavoz_listings_read ON public.lavoz_listings');

    // Estados del aviso (incluye el vencimiento a 10/30 días).
    expect(migSrc).toMatch(/CHECK\s*\(status IN \('draft','ready','published','expired','failed'\)\)/);
    expect(migSrc).toContain('expires_at TIMESTAMPTZ');
    expect(migSrc).toContain('CONSTRAINT lavoz_listings_property_key UNIQUE (property_id)');

    // RPC del tab Portales: sin anon, con authenticated.
    expect(migSrc).toContain('CREATE OR REPLACE FUNCTION public.lavoz_portal_status()');
    expect(migSrc).toContain('REVOKE ALL ON FUNCTION public.lavoz_portal_status() FROM PUBLIC, anon;');
    expect(migSrc).toContain('GRANT EXECUTE ON FUNCTION public.lavoz_portal_status() TO authenticated;');
  });

  test('migración: los mapeos de tipo y barrio son los medidos contra el portal', () => {
    // 9 subrubros reales de La Voz (fuente: /inmuebles).
    for (const sub of ['casas', 'departamentos', 'terrenos-y-lotes', 'locales', 'galpones-y-depositos', 'oficinas', 'cocheras']) {
      expect(migSrc).toContain(`"subrubro":"${sub}"`);
    }
    // Barrios medidos (con su slug de La Voz).
    for (const b of ['nueva-cordoba', 'centro', 'alberdi', 'alta-cordoba', 'san-vicente', 'poeta-lugones', 'urca', 'obrero', 'villa-allende-parque', 'la-reserva']) {
      expect(migSrc).toContain(`"barrio":"${b}"`);
    }
    // Las ciudades con tilde (el slug no alcanza para mostrarlas).
    expect(migSrc).toContain('"ciudad_label":"Córdoba"');
    expect(migSrc).toContain('"ciudad_label":"Villa Carlos Paz"');
  });

  test('edge function: usa el mapper puro (sin lógica duplicada)', () => {
    expect(fnSrc).toContain("from '../_shared/lavoz.mapper.ts'");
    expect(fnSrc).toContain('buildLavozPayload');
    expect(fnSrc).toContain('buildLavozFicha');
    // Si alguien vuelve a copiar el armado del aviso adentro de la función,
    // los tests unitarios dejan de cubrir la lógica real.
    expect(fnSrc).not.toContain('function buildPayload(');
    expect(fnSrc).not.toContain('function buildFicha(');
    expect(fnSrc).not.toMatch(/function resizeFoto\(/);
  });

  test('edge function: permisos por rol y acciones del flujo', () => {
    expect(fnSrc).toContain("const WRITE_ROLES = ['super_admin', 'broker'];");
    expect(fnSrc).toContain("const CONFIG_ROLES = ['super_admin'];");
    for (const action of ['status', 'config_get', 'config_set', 'list', 'prepare', 'prepare_all', 'confirm', 'unpublish', 'expire']) {
      expect(fnSrc).toContain(`'${action}'`);
    }
    // Los avisos bloqueantes (sin operación / sin precio / sin subrubro)
    // dejan la fila en 'failed' en vez de 'ready'.
    expect(fnSrc).toContain('const BLOQUEANTES =');
    expect(fnSrc).toContain("status: bloqueante.length ? 'failed' : 'ready'");
    // Confirmar calcula el vencimiento (10 o 30 días).
    expect(fnSrc).toContain('expires_at: expires.toISOString()');
  });

  test('CI: lavoz-proxy se deploya y CON verify_jwt', () => {
    // Ni excluida (bug histórico de contact-submit) ni sin verify_jwt:
    // es una función autenticada del panel.
    expect(deploySrc).not.toMatch(/EXCLUDED_FUNCTIONS=\([^)]*lavoz-proxy/s);
    expect(deploySrc).not.toMatch(/NO_VERIFY=\([^)]*lavoz-proxy/s);
  });

  test('UI: panel en Portales + modal + botón en la fila de Propiedades', () => {
    expect(htmlSrc).toContain('id="lavozPortalPanel"');
    expect(htmlSrc).toContain('id="lavozModal"');
    expect(htmlSrc).toContain('id="lavozModalBody"');
    expect(htmlSrc).toContain('id="lavozModalSub"');

    expect(portalesSrc).toContain('functions/v1/lavoz-proxy');
    expect(portalesSrc).toContain('loadLavozPanel()');
    expect(portalesSrc).toContain('window.adminApp.lavozPrepare = async function (propertyId)');
    expect(portalesSrc).toContain('data-lavoz-prepare-all');
    expect(portalesSrc).toContain('data-lavoz-confirm');

    // El botón de la fila (una sola acción para el empleador).
    expect(propsSrc).toContain('data-lavoz-action="prepare"');
    expect(propsSrc).toContain("closest('[data-lavoz-action]')");
    // La CSP no tiene unsafe-inline: cero onclick inline en el módulo.
    const lavozSection = portalesSrc.slice(portalesSrc.indexOf('13D. CLASIFICADOS LA VOZ'));
    expect(lavozSection).not.toMatch(/onclick\s*=/i);
  });

  test('UI: la despublicación pide confirmación (nada de confirm() nativo)', () => {
    const lavozSection = portalesSrc.slice(portalesSrc.indexOf('13D. CLASIFICADOS LA VOZ'));
    expect(lavozSection).toContain('showConfirmDialog');
    expect(lavozSection).not.toMatch(/\bconfirm\s*\(/);
    expect(lavozSection).not.toMatch(/\bprompt\s*\(/);
  });

  test('el paquete de fotos arranca con la PORTADA (01-portada)', () => {
    expect(propsSrc).toContain('window.adminApp.downloadLavozPackage = async function (payload, ficha)');
    // 01-portada, 02-foto, 03-foto… (el payload ya viene en orden: portada primero).
    expect(propsSrc).toContain("String(i + 1).padStart(2, '0') + (i === 0 ? '-portada' : '-foto')");
    // El ZIP incluye la ficha de texto para copiar y pegar.
    expect(propsSrc).toContain("aviso-lavoz.txt");
  });

  test('mapper: la portada es la primera de image_urls y NO se reordena', () => {
    expect(mapperSrc).toContain('export const MAX_FOTOS = 25;');
    // Si el mapper ordenara las fotos, la portada dejaría de ser la primera.
    expect(mapperSrc).not.toMatch(/\.sort\(/);
    // La foto se reescala a JPG (La Voz no acepta webp).
    expect(mapperSrc).toContain('f_jpg');
    expect(mapperSrc).toContain('w_1200');
    // El aviso avisa cuando el barrio no existe en La Voz (medido 2026-11-04).
    expect(mapperSrc).toContain('sin_equivalencia');
    expect(mapperSrc).toContain('no tiene barrio equivalente en La Voz');
  });
});

/* ================================================================
   AUTOMATIZACIÓN (2026-11-04): el asistente publica la cola sola.
   ================================================================ */

const SCRIPT = path.join(ROOT, 'scripts', 'lavoz-publisher.mjs');
const MAPPING = path.join(ROOT, 'scripts', 'lavoz-mapping.mjs');
const scriptSrc = fs.readFileSync(SCRIPT, 'utf8');
const mappingSrc = fs.readFileSync(MAPPING, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test.describe('La Voz — automatización de la publicación', () => {
  test('el asistente tiene los 3 modos y usa el perfil persistente', () => {
    expect(scriptSrc).toContain("'--discover'");
    expect(scriptSrc).toContain("'--run'");
    expect(scriptSrc).toContain("'--renew'");
    // headed + perfil persistente: el Turnstile de La Voz bloquea headless.
    expect(scriptSrc).toContain('launchPersistentContext');
    expect(scriptSrc).toContain('headless: soloLectura');
    // Sólo el modo de lectura va headless: publicar necesita ventana real.
    expect(scriptSrc).toContain("const soloLectura = args.mode === 'estado'");
    expect(scriptSrc).toContain('.lavoz-publisher-profile');
  });

  test('el asistente NO tiene credenciales escritas (el login es humano)', () => {
    // Ni contraseñas, ni tokens, ni claves de La Voz hardcodeadas.
    expect(scriptSrc).not.toMatch(/password\s*[:=]\s*['"][^'"]+['"]/i);
    expect(scriptSrc).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i);
    expect(scriptSrc).not.toMatch(/secret\s*[:=]\s*['"][^'"]+['"]/i);
    // La sesión sale del perfil (o de BH_ACCESS_TOKEN por entorno).
    expect(scriptSrc).toContain('BH_ACCESS_TOKEN');
    expect(scriptSrc).toContain('sb-rnldqiwwzhjnurkguihu-auth-token');
  });

  test('el asistente lee la cola del CRM y confirma el resultado ahí', () => {
    expect(scriptSrc).toContain('functions/v1/lavoz-proxy');
    expect(scriptSrc).toContain("crmCall(token, 'list')");
    expect(scriptSrc).toContain("crmCall(token, 'prepare'");
    expect(scriptSrc).toContain("crmCall(token, 'prepare_all')");
    expect(scriptSrc).toContain("crmCall(token, 'confirm'");
  });

  test('no rompe con las APIs SINCRÓNAS de Playwright (bug del login)', () => {
    // BUG REAL 2026-11-06: `page.url()` es SÍNCRONO en Playwright (devuelve
    // un string). El motor lo usaba como `await page.url().catch(...)` →
    // "page.url(...).catch is not a function" → el piloto moría justo en el
    // camino del login humano (el único que no se probaba en seco).
    // Mismo error con page.title() / page.content().
    // (Se chequea el CÓDIGO, sin comentarios: el comentario que explica el
    // bug menciona el patrón roto.)
    const codigo = scriptSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(codigo).not.toMatch(/\.url\(\)\s*\.catch/);
    expect(codigo).not.toMatch(/\.title\(\)\s*\.catch/);
    expect(codigo).not.toMatch(/\.content\(\)\s*\.catch/);
    // Y el helper seguro existe (try/catch, sin promesa).
    expect(scriptSrc).toContain('function urlActual(');
    expect(scriptSrc).toContain('try { return p.url() || ');
  });

  test('el asistente NO publica avisos con datos bloqueantes', () => {
    // Los 'failed' entran en la cola (se re-preparan), pero si el aviso
    // sigue bloqueante se omiten con el motivo.
    expect(scriptSrc).toContain('tieneBloqueante');
    expect(scriptSrc).toContain('OMITIDO (datos incompletos)');
    expect(mappingSrc).toContain('RE_BLOQUEANTE');
  });

  test('el mapper usa el estado comercial cuando falta listing_type', () => {
    // 9 propiedades publicadas tienen listing_type NULL pero status venta/alquiler.
    expect(mapperSrc).toContain('OPERACION_DESDE_STATUS');
    expect(mapperSrc).toContain('OPERACION_DESDE_STATUS[norm(p.status)]');
  });

  test('el asistente sube las fotos con la PORTADA de primera', () => {
    expect(scriptSrc).toContain('setInputFiles');
    expect(scriptSrc).toContain("i === 0 ? '-portada' : '-foto'");
    expect(scriptSrc).toContain('bajarFotos');
  });

  test('el asistente maneja el wizard de varios pasos y captura la URL', () => {
    expect(scriptSrc).toContain('RE_SIGUIENTE');
    expect(scriptSrc).toContain('RE_PUBLICAR');
    expect(scriptSrc).toContain('capturarUrlAviso');
    // La URL capturada tiene que ser de La Voz (nunca una externa).
    expect(scriptSrc).toContain('lavoz\\.com\\.ar');
  });

  test('el wizard real de La Voz: 6 pasos, /publicar/inmuebles y modal de borradores', () => {
    // ESTRUCTURA REAL (verificada 2026-11-06 con login humano):
    // /publicar → sección → /publicar/inmuebles → 6 pasos.
    expect(scriptSrc).toContain('/publicar/inmuebles');
    expect(scriptSrc).toContain('PASOS_LAVOZ');
    for (const nombre of ['Tipo de inmueble', 'Ubicación', 'Contacto', 'Precio', 'Datos del aviso', 'Multimedia']) {
      expect(scriptSrc).toContain(nombre);
    }
    // Al entrar hay un modal "Tenés borradores sin publicar" que TAPA el
    // formulario: si no se cierra, el motor no avanza nunca.
    expect(scriptSrc).toContain('cerrarModalBorradores');
    expect(scriptSrc).toContain('empezar un aviso nuevo');
  });

  test('el clic de publicar/acceder está ACOTADO al cuerpo del wizard', () => {
    // TRAMPA REAL: el HEADER tiene un botón "Publicá" y el FOOTER un link
    // "Publicar". Sin acotar la búsqueda a <main>, el motor hace clic en
    // el menú y pierde el formulario.
    expect(scriptSrc).toContain("scope: 'main'");
    expect(scriptSrc).toMatch(/clickTexto\(page, RE_PUBLICAR, \{ scope: 'main' \}\)/);
    // Y el avance usa un botón EXACTO ("Siguiente"), no cualquier verbo.
    expect(scriptSrc).toContain('RE_AVANZAR');
  });

  test('los comboboxes de La Voz (Base UI) se llenan por opción', () => {
    // La Voz NO usa <select>: usa role="combobox" con popup de opciones.
    expect(scriptSrc).toContain("[role=\"combobox\"]");
    expect(scriptSrc).toContain('[role="option"]');
    expect(scriptSrc).toContain('elegirEnCombo');
    expect(mappingSrc).toContain("c.tag === 'combo'");
  });

  test('el login de La Voz puede ser automático (LAVOZ_EMAIL/LAVOZ_PASSWORD)', () => {
    // Las credenciales viven FUERA del repo (variables de entorno).
    expect(scriptSrc).toContain('process.env.LAVOZ_EMAIL');
    expect(scriptSrc).toContain('process.env.LAVOZ_PASSWORD');
    expect(scriptSrc).toContain('loginAutomaticoLaVoz');
    // Nunca se guardan en un archivo del repo.
    expect(scriptSrc).not.toMatch(/writeFileSync\([^)]*LAVOZ_PASSWORD/);
  });

  test('el mapeo del formulario es un módulo PURO (testeable sin navegador)', () => {
    expect(mappingSrc).toContain('export function elegirControl');
    expect(mappingSrc).toContain('export function indiceOpcion');
    expect(mappingSrc).toContain('export function planLlenado');
    // Sin I/O ni navegador: se importa en node --test.
    expect(mappingSrc).not.toContain('playwright');
    expect(mappingSrc).not.toMatch(/require\(|from 'node:/);
    expect(mappingSrc).not.toMatch(/readFileSync|writeFileSync/);
    // Y el asistente lo usa (no duplica la lógica).
    expect(scriptSrc).toContain("from './lavoz-mapping.mjs'");
  });

  test('npm scripts: publicar la cola y renovar vencidos', () => {
    expect(pkg.scripts.lavoz).toContain('lavoz-publisher.mjs --run');
    expect(pkg.scripts['lavoz:renovar']).toContain('--renew');
    expect(pkg.scripts['lavoz:discover']).toContain('--discover');
  });

  test('modo --estado: consulta la cola SIN abrir La Voz ni publicar', () => {
    expect(pkg.scripts['lavoz:estado']).toContain('--estado');
    expect(scriptSrc).toContain('modoEstado');
    // No espera login: falla rápido con un mensaje claro.
    expect(scriptSrc).toContain('esperar: false');
    // Y el estado corre headless (sólo lee la sesión del CRM).
    expect(scriptSrc).toContain('soloLectura');
  });

  test('la edge function devuelve el payload y auto-venece los avisos', () => {
    // El asistente necesita el payload para llenar el formulario.
    expect(fnSrc).toContain('payload, properties!inner');
    // Vencimiento self-healing (avisos de 10 o 30 días).
    expect(fnSrc).toContain('expireVencidos');
    expect(fnSrc).toContain(".eq('status', 'published')");
  });

  test('el panel de Portales explica el comando de publicación en lote', () => {
    expect(portalesSrc).toContain('npm run lavoz');
    expect(portalesSrc).toContain('npm run lavoz:renovar');
    expect(portalesSrc).toContain('npm run lavoz:discover');
    expect(portalesSrc).toContain('npm run lavoz:estado');
    expect(portalesSrc).toContain('data-lavoz-copy="npm run lavoz"');
    // Copia con fallback (la clipboard API exige contexto seguro).
    expect(portalesSrc).toContain('copiarTexto');
    expect(portalesSrc).toContain("execCommand('copy')");
  });

  test('el asistente acepta los términos y condiciones antes de publicar', () => {
    expect(scriptSrc).toContain('aceptarTerminos');
    expect(mappingSrc).toContain('esTextoTerminos');
    // El Turnstile NO se toca (vive en un iframe, no es un input nativo).
    expect(scriptSrc).toContain('no soy un robot');
  });

  test('el mapeo completa los selects que La Voz exige y no tenemos dato', () => {
    expect(mappingSrc).toContain('export const DEFAULTS');
    expect(mappingSrc).toContain('export function planDefaults');
    // Provincia, tipo de barrio, tipo de vendedor y duración.
    expect(mappingSrc).toContain('tipo_barrio');
    expect(mappingSrc).toContain('Inmobiliaria');
    expect(mappingSrc).toContain('Abierto');
    expect(mappingSrc).toContain('dias_publicacion');
    // Y el motor los usa.
    expect(scriptSrc).toContain('planDefaults');
  });

  test('los campos del aviso NO se comen los selects parecidos', () => {
    // "Tipo" vs "Tipo de barrio", "Ciudad" vs "Provincia", "Barrio" vs "Tipo de barrio".
    expect(mappingSrc).toContain('exclude');
    expect(mappingSrc).toContain('tipo de barrio');
    expect(mappingSrc).toContain('candidatosDeControl');
  });
});
