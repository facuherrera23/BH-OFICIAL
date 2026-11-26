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
    // Las fotos viejas tienen /image/upload/v1790.../... (sin transforms): la
    // versión NO puede confundirse con un transform (daba 404 en Cloudinary).
    expect(mapperSrc).toContain("const version = segmento && /^v\\d+$/.test(segmento)");
    expect(mapperSrc).toContain("return `/image/upload/${parts.join(',')}/${version}`;");
  });

  test('edge function: permisos por rol y acciones del flujo', () => {
    expect(fnSrc).toContain("const WRITE_ROLES = ['super_admin', 'broker'];");
    expect(fnSrc).toContain("const CONFIG_ROLES = ['super_admin'];");
    for (const action of ['status', 'config_get', 'config_set', 'list', 'prepare', 'prepare_all', 'confirm', 'unpublish', 'expire']) {
      expect(fnSrc).toContain(`'${action}'`);
    }
    // Los avisos bloqueantes (sin operación / sin precio / sin subrubro)
    // dejan la fila en 'failed' en vez de 'ready'.
    expect(mapperSrc).toContain('export const RE_BLOQUEANTE_LAVOZ');
    expect(fnSrc).toContain('payload.avisos.filter((a) => RE_BLOQUEANTE_LAVOZ.test(a))');
    expect(fnSrc).toContain("const statusFinal = vencido ? 'expired'");
    // Confirmar calcula el vencimiento (10 o 30 días).
    expect(fnSrc).toContain('expires_at: expires.toISOString()');
  });

  test('config_set sanea y valida contacto/tipo_map/ubicacion_map server-side', () => {
    expect(fnSrc).toContain("patch.tipo_map = mapa;");
    expect(fnSrc).toContain("mapa[k] = { subrubro, label: v.label.trim() };");
    expect(fnSrc).toContain("patch.ubicacion_map = mapa;");
    expect(fnSrc).toContain("patch.contacto = limpio;");
    expect(fnSrc).toContain("['ciudad', 'ciudad_label', 'barrio', 'label', 'provincia', 'nota']");
    expect(fnSrc).toContain("limpio[campo] = txt || null;");
    expect(fnSrc).toContain("limpio.mostrar_whatsapp = body.contacto.mostrar_whatsapp;");
  });

  test('prepare NO degrada un aviso ya publicado (link y vencimiento se preservan)', () => {
    expect(fnSrc).toContain("const yaPublicado = estadoPrevio === 'published' || degradado || vencido");
    expect(fnSrc).toContain("const degradado = ['ready', 'failed'].includes(estadoPrevio) && conLink");
    expect(fnSrc).toContain("const vencido = estadoPrevio === 'expired'");
    expect(fnSrc).toContain("const statusFinal = vencido ? 'expired'");
    expect(fnSrc).toContain('patch.ad_url = existing?.ad_url ?? null');
    expect(fnSrc).toContain('patch.remote_id = existing?.remote_id ?? null');
    expect(fnSrc).toContain('patch.published_at = existing?.published_at ?? null');
    expect(fnSrc).toContain('patch.expires_at = existing?.expires_at ?? null');
    expect(fnSrc).toContain('preserved_published');
    expect(fnSrc).toContain('preserved_expired');
    // Si la lectura falla, NO se escribe a ciegas (un error de RLS/red no
    // puede borrar el link de un aviso ya publicado).
    expect(fnSrc).toContain('if (existingError) throw existingError;');
    // El modal recibe el estado real para precargar la URL guardada.
    expect(fnSrc).toContain('ad_url: patch.ad_url');
  });

  test('ciclo de vencimiento: prepare_all NO reprocesa vencidos y expireVencidos repara degradados', () => {
    // Un vencido conserva su ad_url: es la ÚNICA forma de encontrarlo para
    // renovarlo desde el panel (npm run lavoz:renovar). Reprocesarlo en el
    // prepare en lote le borraba el link y la renovación moría.
    expect(fnSrc).toContain("r.status === 'published' || r.status === 'expired'");
    // Los degradados a ready/failed por un prepare viejo (DA-P0013/DA-P0002)
    // se autocorrigen a 'expired' cuando su fecha ya pasó.
    expect(fnSrc).toContain(".in('status', ['ready', 'failed'])");
    expect(fnSrc).toContain(".not('ad_url', 'is', null)");
  });

  test('config_set y confirm validan la entrada (no confian en el cliente)', () => {
    // Un config_set descuidado (dias publicitarios inventados, mapas como
    // array) rompia TODOS los prepares en silencio.
    expect(fnSrc).toContain('function validarConfigPatch(');
    expect(fnSrc).toContain("throw new Error('dias_publicacion debe ser 10 o 30')");
    expect(fnSrc).toContain('const patch = validarConfigPatch(body);');
    // tipo_map: subrubro debe existir en el catalogo real de La Voz.
    expect(fnSrc).toContain('SUBRUBROS_LAVOZ.has(subrubro)');
    expect(mapperSrc).toContain('export const SUBRUBROS_LAVOZ = new Set([');
    for (const sub of ['casas', 'departamentos', 'terrenos-y-lotes', 'locales', 'galpones-y-depositos', 'oficinas', 'cocheras', 'campos', 'fondo-de-comercio']) {
      expect(mapperSrc).toContain(`'${sub}'`);
    }
    // ubicacion_map: ciudad/barrio son slugs de La Voz, no texto libre.
    expect(fnSrc).toContain('esSlugLavoz');
    expect(fnSrc).toContain('debe ser slug de La Voz (minúsculas, números y guiones)');
    // contacto: email y telefono con formato minimo (evita romper el aviso).
    expect(fnSrc).toContain('contacto.email no tiene formato válido');
    expect(fnSrc).toContain('contacto.${campo} debe contener un teléfono válido');
    // La URL del aviso la valida tambien el server (ademas del panel).
    expect(fnSrc).toContain('function validarAdUrl(');
    expect(fnSrc).toContain('adUrl = validarAdUrl(body.ad_url) || existing?.ad_url || null');
    // Re-confirmar sin URL/plan/remote_id conserva los reales guardados (con validación de plan).
    expect(fnSrc).toContain('PLANES_CONFIRM.has(p)');
    expect(fnSrc).toContain("plan = existing?.plan || null");
    expect(fnSrc).toContain("const remoteId = String(body.remote_id ?? '').trim() || existing?.remote_id || null");
  });

  test('bloqueantes: el mapper y el asistente usan el MISMO regex (guard de drift)', () => {
    const rxMapper = mapperSrc.match(/export const RE_BLOQUEANTE_LAVOZ = (\/.*\/i);/);
    const rxAsistente = mappingSrc.match(/export const RE_BLOQUEANTE = (\/.*\/i);/);
    expect(rxMapper).not.toBeNull();
    expect(rxAsistente).not.toBeNull();
    expect(rxAsistente[1]).toBe(rxMapper[1]);
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

    // El botón lleva el property_id en el DOM: si se pierde el estado en
    // memoria del módulo, el confirm NO muere con un 400 sin auditoría.
    expect(portalesSrc).toContain('data-lavoz-confirm="${esc(pid)}"');
    expect(portalesSrc).toContain('confirm.dataset.lavozConfirm');
    // Validación estricta ANTES de llamar al servidor (no confía en el cliente).
    expect(portalesSrc).toContain('if (!lavozEsUrlAviso(url)) {');
    expect(portalesSrc).toContain("logError('lavoz confirm', err)");

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

  test('la URL capturada es un AVISO real: dominio estricto + id + no wizard', () => {
    /* BUG real 2026-11-22 (encontrado en la auditoría final): el regex de
       sufijo /lavoz\.com\.ar$/ acepta dominios AJENOS como notlavoz.com.ar o
       evillavoz.com.ar → el CRM guardaría un link que no es de La Voz como
       prueba de publicación. El límite es el PUNTO antes del dominio. */
    expect(scriptSrc).toContain("const host = parsed.hostname.toLowerCase();");
    expect(scriptSrc).toContain("if (host !== 'lavoz.com.ar' && !host.endsWith('.lavoz.com.ar')) return false;");
    // El wizard (/publicar/inmuebles) también es de La Voz pero NO es un aviso.
    expect(scriptSrc).toContain('if (/\\/publicar(\\/|$)/.test(parsed.pathname)) return false;');
    // Y el id numérico del aviso (5680772, 5676473… en producción).
    expect(scriptSrc).toContain('return /\\/\\d{5,}(?:\\/|$)/.test(parsed.pathname);');
    // El link encontrado se prueba ANTES que la URL actual (que suele ser el wizard).
    expect(scriptSrc).toContain('for (const candidato of [link, url])');
  });

  test('las TRES validaciones de URL (asistente, servidor, panel) no se divergen', () => {
    /* La URL del aviso se valida en 3 lugares porque ninguno es confiable
       por sí solo: el asistente captura el link, el panel lo pega a mano y
       el servidor recibe llamadas de ambos. Si una copia se relaja, un link
       ajeno o del wizard vuelve a guardarse como "publicado". Guard de drift
       (mismo patrón que el mapper de bloqueantes). */
    const fnAsistente = (scriptSrc.match(/function esUrlAvisoLaVoz\([\s\S]*?\n\}/) || [''])[0];
    const fnServidor = (fnSrc.match(/function validarAdUrl\([\s\S]*?\n\}/) || [''])[0];
    const fnPanel = (portalesSrc.match(/function lavozEsUrlAviso\([\s\S]*?\n  \}/) || [''])[0];
    for (const [nombre, fn] of [
      ['asistente', fnAsistente], ['servidor', fnServidor], ['panel', fnPanel],
    ]) {
      expect(fn, `${nombre}: no se encontró la validación`).not.toBe('');
      expect(fn, `${nombre}: dominio estricto`).toContain("host !== 'lavoz.com.ar' && !host.endsWith('.lavoz.com.ar')");
      expect(fn, `${nombre}: rechazar wizard`).toContain('/\\/publicar(\\/|$)/');
      expect(fn, `${nombre}: exigir id numérico`).toContain('/\\/\\d{5,}(?:\\/|$)/');
    }
    // El servidor NO confía en el panel: devuelve 400 con mensaje accionable.
    expect(fnServidor).toContain("throw new Error('La URL del aviso debe ser de clasificados.lavoz.com.ar')");
    expect(fnServidor).toContain("throw new Error('Esa URL es del formulario, no del aviso publicado')");
    expect(fnServidor).toContain("throw new Error('La URL del aviso no incluye el id del aviso')");
    // Y el panel usa esa validación ANTES de llamar al servidor.
    expect(portalesSrc).toContain('if (!lavozEsUrlAviso(url)) {');
  });

  test('el asistente NO duplica avisos: respeta published/expired del CRM', () => {
    /* El prepare viejo degradaba a 'ready' un aviso vivo y el asistente lo
       publicaba OTRA VEZ con créditos reales. Hoy el resultado del prepare
       trae el status real y se omite salvo --force-new explícito. */
    expect(scriptSrc).toContain("if (refrescado && (refrescado.status === 'published' || refrescado.status === 'expired') && !args.forceNew)");
    expect(scriptSrc).toContain("'--force-new'");
    expect(scriptSrc).toContain('args.forceNew');
    // En renovación, un aviso aún vigente también se omite sin --force-new.
    expect(scriptSrc).toContain("if (refrescado?.status === 'published' && !args.forceNew)");
    // Los bloqueantes se cuentan como OMITIDOS, no como fallos de publicación.
    expect(scriptSrc).toContain('if (tieneBloqueante(payload)) {');
  });

  test('el asistente reinicia el wizard y no hereda el formulario anterior', () => {
    // goto directo a /publicar/inmuebles (antes iba a /publicar y en --dry
    // el siguiente aviso heredaba los datos del anterior).
    expect(scriptSrc).toContain('await page.goto(INMUEBLES_URL,');
    expect(scriptSrc).toContain("const INMUEBLES_URL = `${PORTAL}/publicar/inmuebles`;");
  });

  test('--dry es un preview: NO renueva, NO publica y NO cuenta fallo', () => {
    expect(scriptSrc).toContain('if (args.renew && row?.ad_url && !args.dry)');
    expect(scriptSrc).toContain('submit: args.submit && !args.dry');
    expect(scriptSrc).toContain('simulados++;');
    expect(scriptSrc).toContain('} else if (args.dry) {');
    expect(scriptSrc).toContain('${simulados} simulado(s) (--dry)');
  });

  test('clickTexto es FAIL-CLOSED: un click fallido NO reporta éxito', () => {
    /* BUG real 2026-11-22: `await el.click().catch(() => {})` devolvía
       clicked:true aunque el botón estuviera tapado/arger → el CRM se
       marcaba como publicado un aviso que nunca se publicó. */
    /* Acotado a clickTexto: los otros `.click().catch()` del asistente son
       tolerantes por diseño (login, cerrar modal de borradores, abrir un
       combobox) y NO marcan un aviso como publicado. El falso positivo sólo
       vivía en clickTexto, que es el que usan RE_PUBLICAR/RE_RENOVAR. */
    const fnClick = (scriptSrc.match(/async function clickTexto\([\s\S]*?\r?\n\}/) || [''])[0];
    expect(fnClick).not.toMatch(/\.click\([^)]*\)\s*\.catch\(/);
    expect(fnClick).toMatch(/try \{\s*await el\.click\(\{ timeout: 8000 \}\);/);
    expect(fnClick).toContain('ultimoError = err;');
    expect(fnClick).toContain('return { clicked: false, ...(ultimoError ? { motivo: ultimoError.message } : {}) };');
  });

  test('el plan confirmado es el REAL del prepare (nunca una recomendación)', () => {
    expect(scriptSrc).toContain('const planConfirm = refrescado ? refrescado.plan : payload.plan_recomendado;');
    expect(scriptSrc).toContain("ad_url: url || undefined, plan: planConfirm");
    // El servidor devuelve `plan` en cada resultado del prepare.
    expect(fnSrc).toContain('const planFinal = yaPublicado ? (existing?.plan ?? null) : payload.plan_recomendado;');
    expect(fnSrc).toContain('plan: planFinal,');
    // Los avisos vivos/degradados no llevan el bloqueante del CRM actual en last_error.
    expect(fnSrc).toContain("last_error: yaPublicado || !bloqueante.length ? null : bloqueante.join(' | ')");
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

  test('el token del CRM se puede pedir por API (sin navegador)', () => {
    // Si el navegador queda con la sesión del panel perdida (o se cierra con
    // kill), el token se pide directo a Supabase con email + contraseña.
    expect(scriptSrc).toContain('tokenCrmPorCredenciales');
    expect(scriptSrc).toContain('/auth/v1/token?grant_type=password');
    expect(scriptSrc).toContain('process.env.BH_ADMIN_EMAIL');
    expect(scriptSrc).toContain('process.env.BH_ADMIN_PASSWORD');
    // La clave anon es pública (está en assets/js/config.js).
    expect(scriptSrc).toContain('SUPABASE_ANON_KEY');
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
    expect(portalesSrc).toContain('copiarTexto');
    expect(portalesSrc).toContain("execCommand('copy')");
  });

  test('modal: muestra plan sugerido y duración para coherencia con el aviso armado', () => {
    expect(portalesSrc).toContain("['Plan sugerido', p.plan_recomendado ? String(p.plan_recomendado).replace(/_/g, ' ') : null]");
    expect(portalesSrc).toContain("['Duración del aviso', p.dias_publicacion ? `${p.dias_publicacion} días` : null]");
  });

  test('panel UX: muestra motivo/avisos, badge Sin URL y acciones rápidas de copia', () => {
    expect(portalesSrc).toContain('const lastError = String(row.last_error || \'\').trim();');
    expect(portalesSrc).toContain('const avisosPayload = Array.isArray(row.payload?.avisos)');
    expect(portalesSrc).toContain('Sin URL');
    expect(portalesSrc).toContain('data-lavoz-copy-title');
    expect(portalesSrc).toContain('data-lavoz-copy-code');
    expect(portalesSrc).toContain("copiarTexto((_lavozPrepared?.payload?.titulo) || '')");
    expect(portalesSrc).toContain("copiarTexto((_lavozPrepared?.payload?.property_code) || _lavozPrepared?.property_code || '')");
  });

  test('confirm manual permite dias/plan/fecha real, advierte plan distinto y proxy valida', () => {
    expect(portalesSrc).toContain('id="lavozConfirmDias"');
    expect(portalesSrc).toContain('id="lavozConfirmPlan"');
    expect(portalesSrc).toContain('data-recommended=');
    expect(portalesSrc).toContain("dias !== 10 && dias !== 30");
    expect(portalesSrc).toContain("['basico', 'estandar', 'premium', 'super_premium']");
    expect(portalesSrc).toContain("lavozApiCall('confirm', { property_id: propertyId, ad_url: url, dias, plan: plan || undefined, expires_at: venceFecha || undefined })");
    expect(portalesSrc).toContain('lavozPlanWarn');
    expect(fnSrc).toContain("const PLANES_CONFIRM = new Set(['basico', 'estandar', 'premium', 'super_premium']);");
    expect(fnSrc).toContain("throw new Error('dias debe ser 10 o 30');");
    expect(fnSrc).toContain("throw new Error('plan debe ser basico, estandar, premium o super_premium');");
    expect(fnSrc).toContain('ad_url: adUrl,');
  });

  /* La fecha REAL que muestra La Voz ("Finaliza 06/12/2026") tiene que poder
     cargarse a mano: si no, el CRM la calculaba y cualquier diferencia con el
     portal lo dejaba mintiendo (2026-11-26, pedido del empleador). */
  test('el modal permite cargar la fecha real de vencimiento y el server la valida', () => {
    expect(portalesSrc).toContain('id="lavozVenceEl"');
    expect(portalesSrc).toContain('<input type="date" id="lavozVenceEl"');
    expect(portalesSrc).toContain('lavozFechaInput(r.expires_at, p.dias_publicacion)');
    expect(portalesSrc).toContain('expires_at: venceFecha || undefined');
    expect(portalesSrc).toContain('La fecha de vencimiento no puede ser anterior a hoy');
    expect(fnSrc).toContain('function validarVencimiento(valor: unknown): string | null {');
    expect(fnSrc).toContain("throw new Error('La fecha de vencimiento tiene que ser futura');");
    expect(fnSrc).toContain('venceManual = validarVencimiento(body.expires_at);');
    expect(fnSrc).toContain('const expires = venceManual ? new Date(venceManual) : new Date(now.getTime() + dias * 86400000);');
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

  test('el asistente intenta completar la moneda del precio (evidencia bundles La Voz)', () => {
    // Evidencia 2026-11-22: bundles públicos de La Voz exponen
    // filters[price_currency] (label "Moneda", backendField currency, radio
    // dinámico) en el paso Precio. El mapping no adivina IDs: prueba labels
    // visibles y deja la opción actual si no puede confirmar.
    expect(mappingSrc).toContain("key: 'moneda'");
    expect(mappingSrc).toContain('filters[price_currency]');
    expect(mappingSrc).toContain('candidatos');
    expect(mappingSrc).toContain("['Dólar', 'Dólares', 'Dolar', 'Dolares', 'USD', 'U$S']");
    expect(mappingSrc).toContain("['Peso', 'Pesos', 'ARS', '$']");
    expect(scriptSrc).toContain('op.candidatos');
    expect(scriptSrc).toContain("op.key === 'moneda'");
    expect(scriptSrc).toContain('no pude confirmar la moneda');
  });


  test('observabilidad: --json y resumen de corrida con faltantes/moneda/url/captura', () => {
    expect(scriptSrc).toContain("else if (a === '--json') args.json = true");
    expect(scriptSrc).toContain('[--json]');
    expect(scriptSrc).toContain('run-${stamp}.json');
    expect(scriptSrc).toContain('monedaNoConfirmada');
    expect(scriptSrc).toContain('moneda_no_confirmada: r.monedaNoConfirmada || null');
    expect(scriptSrc).toContain("status: 'dry_run'");
    expect(scriptSrc).toContain("status: 'failed'");
    expect(scriptSrc).toContain('captura');
    expect(scriptSrc).toContain('faltantes: r.faltantes || []');
  });

  test('renovarAviso no re-clickea Renovar en el paso de confirmación', () => {
    expect(scriptSrc).toContain('const conf = await clickTexto(page, /confirmar|aceptar|\\bs[ií]\\b/i);');
    expect(scriptSrc).not.toContain('clickTexto(page, /confirmar|aceptar|s[ií]|renovar/i)');
  });
});
