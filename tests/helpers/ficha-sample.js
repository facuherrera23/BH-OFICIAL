/* ============================================================
   Helper de tests: genera una ficha de muestra con el MISMO
   generador de producción (scripts/generate-ficha.mjs), sin
   tocar la red ni escribir en fichas/.

   Se evalúa el generador en un sandbox: se quitan el import de
   node:fs y la llamada a main() (que exige Supabase), y se
   reemplaza por stubs. buildHtml() queda intacto → el test
   verifica el HTML REAL que se sube a producción.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

const MOCK_PROPERTY = {
  id: 'prop-test-1',
  property_code: 'ML-TEST',
  title: 'Casa en Nueva Córdoba',
  description: 'Hermosa casa con dos dormitorios.\n\nAmplio living.',
  property_type: 'casa',
  status: 'venta',
  zone: 'Nueva Córdoba',
  address: 'Av. Siempreviva 123',
  price_usd: 120000,
  price_currency: 'USD',
  surface_total: 120,
  rooms: 3,
  bedrooms: 2,
  bathrooms: 1,
  garage_spaces: 1,
  year_built: 2020,
  latitude: -31.42,
  longitude: -64.18,
  image_urls: ['https://res.cloudinary.com/demo/image/upload/v1/hero.jpg'],
  agents: { full_name: 'Ana Broker', phone: '5493511111111', photo_url: '' },
};

const MOCK_VIDEO = { id: 'dQw4w9WgXcQ', title: 'Tour de la casa', publishedAt: '2026-10-20T10:00:00Z' };

function buildSample() {
  let src = fs.readFileSync(path.join(ROOT, 'scripts', 'generate-ficha.mjs'), 'utf8');
  /* ESM → CommonJS (el repo es "type": "commonjs"): cualquier import con
     named imports se convierte en require. Las rutas relativas se resuelven
     contra la raíz del repo (el sandbox no tiene __dirname) y los módulos
     .mjs se cargan con require() (Node ≥22.12 lo soporta). */
  src = src.replace(/import \{([^}]+)\} from '([^']+)';/g, (_m, names, mod) => {
    const target = mod.startsWith('.') ? path.join(ROOT, 'scripts', mod) : mod;
    return 'const {' + names + '} = require(' + JSON.stringify(target) + ');';
  });
  /* main() real exige SUPABASE_URL + red: se la quita (TODO el bloque final,
     no solo la primera línea — el catch cierra en otra línea). */
  src = src.replace(/main\(\)\.catch\([\s\S]*$/, '');
  src = src.replace(/if \(!SUPABASE_URL \|\| !SERVICE_KEY\) \{[\s\S]*?\n\}\n/m, '');

  const sandbox = {
    console,
    require,
    process: { env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_KEY: 'test' }, exit: () => {} },
    fetch: async () => ({ ok: false, status: 500, json: async () => [], text: async () => '' }),
    mkdirSync: () => {},
    readdirSync: () => [],
    writeFileSync: () => {},
    rmSync: () => {},
    URL, Date, JSON, Math, Set, Map, Number, String, Boolean, Array, Object, encodeURIComponent,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__buildHtml = buildHtml;', sandbox, { filename: 'generate-ficha.mjs' });
  const buildHtml = sandbox.__buildHtml;

  return {
    withVideo: buildHtml(MOCK_PROPERTY, [MOCK_PROPERTY], { 'prop-test-1': MOCK_VIDEO }),
    withoutVideo: buildHtml(MOCK_PROPERTY, [MOCK_PROPERTY], {}),
  };
}

module.exports = { buildSample, MOCK_PROPERTY, MOCK_VIDEO };
