// Guard GLOBAL del deploy de Edge Functions (2026-11-11).
//
// Clases de bug que este spec mata (todas ocurrieron):
//
//   1. Función EXCLUIDA del deploy en silencio: contact-submit estuvo en
//      EXCLUDED_FUNCTIONS del 18/9 al 26/10 — era "experimental" y pasó a
//      ser EL punto de entrada de leads públicos sin que nadie quitara la
//      exclusión: el CI skipeaba sus fixes y producción corría una versión
//      vieja SIN consent_at (brecha legal detectada por un test E2E).
//
//   2. Función llamada SIN JWT que NO está en NO_VERIFY: la plataforma
//      Supabase la rechaza con 401 ANTES de que el código corra → feature
//      muerta en silencio. Pasó con 4 crons (fix 20261015000004) y con
//      notify-new-lead (trigger SQL → el repo decía ON, producción OFF).
//
//   3. Config zombie: nombres en EXCLUDED_FUNCTIONS / NO_VERIFY que ya no
//      existen como funciones (borradas o typos) — config que nadie audita.
//
// SEMÁNTICA DEL CLI (documentada con el incidente notify-new-lead):
// `supabase functions deploy` SIN --no-verify-jwt NO resetea un flag ya
// existente (por eso producción tenía notify-new-lead OFF aunque el repo
// decía ON) y crea funciones nuevas con verify_jwt ON. NO_VERIFY es la
// ÚNICA fuente de verdad del flag: si una función se llama sin JWT, TIENE
// que estar en NO_VERIFY.
//
// Guard estático: lee el repo, NO toca la BD ni la red. El mapa de
// llamadores sin JWT se mantiene a mano (cron.job no es legible con la
// anon key) — al agregar un cron/trigger/webhook nuevo, sumar su target
// acá y a NO_VERIFY en el mismo commit.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Extrae los nombres "quoteados" de un array de bash del workflow. */
function parseYmlArray(yml, name) {
  const m = yml.match(new RegExp(`${name}=\\(([^)]*)\\)`));
  if (!m) return null;
  const names = [];
  const re = /"([^"]+)"/g;
  let x;
  while ((x = re.exec(m[1])) !== null) names.push(x[1]);
  return names;
}

/** Directorios de funciones deployables (con index.ts, sin _shared). */
function functionDirs() {
  const base = path.join(ROOT, 'supabase', 'functions');
  return fs
    .readdirSync(base)
    .filter((d) => {
      if (d === '_shared') return false;
      try {
        return (
          fs.statSync(path.join(base, d)).isDirectory() &&
          fs.existsSync(path.join(base, d, 'index.ts'))
        );
      } catch (_) {
        return false;
      }
    })
    .sort();
}

/* ------------------------------------------------------------------
   Llamadores SIN JWT (verificado contra producción 2026-11-11).
   Cada entrada: función ← quién la llama sin Authorization Bearer.
   ------------------------------------------------------------------ */
const CALLED_WITHOUT_JWT = [
  // — Crons pg_cron (dump de cron.job 2026-11-11; net.http_post sin JWT) —
  { fn: 'backup-snapshot', caller: 'cron backup-snapshot-daily' },
  { fn: 'exclusive-expiry-alert', caller: 'cron exclusive-expiry-alert-daily' },
  { fn: 'ml-questions-sweep', caller: 'cron ml-questions-sweep' },
  { fn: 'ml-sync', caller: 'cron ml-sync-every-5-min' },
  { fn: 'ml-vis-sweep', caller: 'cron ml-vis-sweep-every-30-min' },
  { fn: 'monthly_commission_liquidation', caller: 'cron monthly-commission-liquidation' },
  { fn: 'notify-new-lead', caller: 'trigger SQL notify_new_lead() sobre leads' },
  { fn: 'owner-tasks-reminder', caller: 'cron owner-tasks-reminder' },
  { fn: 'supervision-digest', caller: 'cron supervision-digest-weekly' },
  { fn: 'visits-process-reminders', caller: 'cron visits-reminders' },
  { fn: 'zernio-sync', caller: 'cron zernio-sync-every-2-min' },
  // — Endpoints pre-login (visitante anónimo) —
  { fn: 'contact-submit', caller: 'form de contacto del landing' },
  { fn: 'tasacion-submit', caller: 'solicitud de tasación pública' },
  // — Consumidores externos que no pueden mandar JWT —
  { fn: 'ics-feed', caller: 'suscripción de calendario externa (Google/Apple/Outlook via ?token=)' },
  // — Webhooks externos (la red externa no manda JWT) —
  { fn: 'ml-webhook', caller: 'notificaciones de Mercado Libre' },
  { fn: 'social-webhook-meta', caller: 'webhook de Meta (firma X-Hub-Signature-256)' },
  { fn: 'zernio-webhook', caller: 'webhook de Zernio (HMAC)' },
  { fn: 'zernio-webhook-test', caller: 'test de configuración Zernio' },
  // — Callbacks OAuth (la red externa redirige sin JWT) —
  { fn: 'ml-callback', caller: 'callback OAuth de Mercado Libre' },
  { fn: 'ml-oauth', caller: 'inicio OAuth de Mercado Libre' },
  { fn: 'rela-callbacks', caller: 'callback OAuth de RELA/ZonaProp' },
  { fn: 'social-auth-facebook', caller: 'callback OAuth de Meta' },
  { fn: 'social-auth-instagram', caller: 'callback OAuth de Meta' },
  { fn: 'social-auth-tiktok', caller: 'callback OAuth de TikTok' },
  { fn: 'social-auth-youtube', caller: 'callback OAuth de Google' },
];

/* Exclusiones del deploy CON motivo y fecha (nada en silencio). */
const ALLOWED_EXCLUDED = [
  { fn: 'convert-image', reason: 'reemplazada por transformaciones de Cloudinary (f_auto,q_auto)' },
];

const deployYml = read('.github/workflows/deploy.yml');
const dirs = functionDirs();

function parseBoth() {
  const excluded = parseYmlArray(deployYml, 'EXCLUDED_FUNCTIONS');
  const noVerify = parseYmlArray(deployYml, 'NO_VERIFY');
  test.expect(excluded, 'deploy.yml debe tener EXCLUDED_FUNCTIONS').not.toBeNull();
  test.expect(noVerify, 'deploy.yml debe tener NO_VERIFY').not.toBeNull();
  return { excluded: excluded, noVerify: noVerify };
}

test.describe('CI — deploy de Edge Functions (guard global)', () => {
  test('NINGUNA función está excluida del deploy sin motivo documentado', () => {
    const { excluded } = parseBoth();
    const silent = excluded.filter(
      (fn) => !ALLOWED_EXCLUDED.some((a) => a.fn === fn),
    );
    expect(
      silent,
      'Funciones excluidas sin entrada en ALLOWED_EXCLUDED de tests/functions-deploy.spec.js. ' +
        'Si la exclusión es intencional, agregala acá con motivo y fecha — o sacala de ' +
        'EXCLUDED_FUNCTIONS (incidente contact-submit: 38 días de fixes skipeados en silencio).',
    ).toEqual([]);
  });

  test('las exclusiones documentadas existen como funciones', () => {
    const { excluded } = parseBoth();
    const ghosts = excluded.filter((fn) => !dirs.includes(fn));
    expect(
      ghosts,
      'EXCLUDED_FUNCTIONS tiene nombres que ya no existen — sacarlos.',
    ).toEqual([]);
  });

  test('NO_VERIFY solo contiene funciones que existen (sin zombies ni typos)', () => {
    const { noVerify } = parseBoth();
    const ghosts = noVerify.filter((fn) => !dirs.includes(fn));
    expect(
      ghosts,
      'NO_VERIFY tiene nombres sin función en el repo — un typo acá deploya la función ' +
        'con verify_jwt ON y su llamador (cron/trigger) muere con 401 en silencio.',
    ).toEqual([]);
  });

  test('TODA función llamada sin JWT está en NO_VERIFY (401 silencioso)', () => {
    const { noVerify } = parseBoth();
    const missing = CALLED_WITHOUT_JWT.filter(
      (c) => !noVerify.includes(c.fn),
    );
    expect(
      missing,
      'Funciones llamadas sin JWT (cron/trigger/webhook/callback/pre-login) fuera de ' +
        'NO_VERIFY → la plataforma responde 401 antes de que el código corra. Agregalas a ' +
        'NO_VERIFY en .github/workflows/deploy.yml — o, si el llamador ahora manda JWT, ' +
        'actualizá CALLED_WITHOUT_JWT con el motivo.',
    ).toEqual([]);
  });

  test('el mapa de llamadores sin JWT no menciona funciones inexistentes', () => {
    const ghosts = CALLED_WITHOUT_JWT.filter((c) => !dirs.includes(c.fn));
    expect(
      ghosts,
      'CALLED_WITHOUT_JWT referencia funciones borradas — actualizar el mapa.',
    ).toEqual([]);
  });

  test('las 64 funciones deployables no excluidas quedan cubiertas por el loop', () => {
    const { excluded } = parseBoth();
    const deployed = dirs.filter((fn) => !excluded.includes(fn));
    // Sanity: el CI itera supabase/functions/*/ — el universo del loop es
    // exactamente dirs − excluded. Si dirs crece (función nueva) sigue
    // cubierto; este test solo verifica que el conjunto no es vacío.
    expect(deployed.length).toBeGreaterThan(50);
  });
});
