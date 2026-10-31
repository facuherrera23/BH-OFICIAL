// ============================================================
// Propiedades: descarga de TODAS las fotos de una propiedad en ZIP
// ------------------------------------------------------------
// Feature pedida por el empleador (2026-10-31): desde el panel se
// descarga el ZIP con el nombre de la propiedad y todas las fotos
// que tenga.
//
// Este test NO toca la DB ni produccion. Valida:
//   1. El generador de ZIP (assets/js/zip.js) en un sandbox vm.
//   2. El camino real de navegador (Blob -> <a download>) con una
//      pagina harness que tiene la MISMA CSP que admin.html.
//
// La validacion del ZIP usa un parser INDEPENDIENTE escrito en este
// archivo (lee EOCD + directorio central y recalcula el CRC bit a
// bit, sin tabla). Asi el test falla si el escritor esta roto, aunque
// el CRC del escritor sea consistente consigo mismo.
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ZIP_SRC = path.join(ROOT, 'assets', 'js', 'zip.js');
const PROP_SRC = path.join(ROOT, 'assets', 'js', 'admin-propiedades.js');
const ADMIN_HTML = path.join(ROOT, 'admin.html');

/* ------------------------------------------------------------
   CRC32 de referencia: implementacion bit a bit (distinta de la
   del escritor, que usa tabla) + vectores known-answer.
   ------------------------------------------------------------ */
function crc32Ref(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------------------------------------------
   Parser de ZIP independiente: lee EOCD + directorio central y
   extrae cada entrada desde su cabecera local.
   ------------------------------------------------------------ */
function parseZip(buffer) {
  const bytes = Buffer.from(buffer);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('ZIP invalido: no se encontro el EOCD');

  const total = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > bytes.length) throw new Error('ZIP invalido: directorio central fuera de rango');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP invalido: firma de directorio central rota');
    const flags = bytes.readUInt16LE(p + 8);
    const method = bytes.readUInt16LE(p + 10);
    const crc = bytes.readUInt32LE(p + 16);
    const csize = bytes.readUInt32LE(p + 20);
    const usize = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const localOffset = bytes.readUInt32LE(p + 42);
    const name = bytes.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP invalido: firma local rota en ' + name);
    const lNameLen = bytes.readUInt16LE(localOffset + 26);
    const lExtraLen = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(dataStart, dataStart + csize);

    entries.push({ name, flags, method, crc, csize, usize, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, cdSize, cdOffset, eocdOffset: eocd };
}

/* ------------------------------------------------------------
   Carga de assets/js/zip.js en un sandbox vm.
   withTextEncoder=false ejercita el fallback manual de UTF-8.
   ------------------------------------------------------------ */
function loadZip(withTextEncoder) {
  const src = fs.readFileSync(ZIP_SRC, 'utf8');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    Blob,
  };
  if (withTextEncoder) sandbox.TextEncoder = TextEncoder;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'zip.js' });
  return sandbox.BHZip;
}

/* ============================================================
   1. Generador de ZIP (unitario)
   ============================================================ */
test.describe('ZIP: generador (assets/js/zip.js)', () => {
  test('crc32 coincide con los vectores known-answer', () => {
    const { crc32 } = loadZip(true);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(Buffer.from('a', 'utf8'))).toBe(0xE8B7BE43);
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xCBF43926);
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog', 'utf8'))).toBe(0x414FA339);
    /* El CRC de referencia (bit a bit) tiene que dar lo mismo */
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(crc32Ref(Buffer.from('123456789', 'utf8')));
  });

  test('UTF-8: acentos y superindice sobreviven (TextEncoder y fallback)', () => {
    const a = loadZip(true);
    const b = loadZip(false);
    const texto = 'Cañada 787 m² — ñandú';
    const esperado = Buffer.from(texto, 'utf8');
    expect(Buffer.from(a.utf8Encode(texto))).toEqual(esperado);
    expect(Buffer.from(b.utf8Encode(texto))).toEqual(esperado);
  });

  test('sanitizeFilename saca caracteres invalidos y protege nombres reservados', () => {
    const { sanitizeFilename } = loadZip(true);
    expect(sanitizeFilename('Terreno 787 m² a 2 Cuadras', 'x')).toBe('Terreno 787 m² a 2 Cuadras');
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a b c d e f g h i j');
    expect(sanitizeFilename('  con   espacios  ', 'x')).toBe('con espacios');
    expect(sanitizeFilename('punto final...', 'x')).toBe('punto final');
    expect(sanitizeFilename('', 'fallback')).toBe('fallback');
    expect(sanitizeFilename('///', 'fallback')).toBe('fallback');
    expect(sanitizeFilename('CON', 'x')).toBe('_CON');
    expect(sanitizeFilename('nul', 'x')).toBe('_nul');
    expect(sanitizeFilename('x'.repeat(300), 'x').length).toBeLessThanOrEqual(120);
  });

  test('toJpgUrl fuerza JPG en las DOS formas de URL de Cloudinary', () => {
    const { toJpgUrl } = loadZip(true);
    /* Forma A: con transformaciones (542 de las 555 URLs reales) */
    expect(toJpgUrl('https://res.cloudinary.com/jpyigjrh/image/upload/f_auto,q_auto/v1792455141/bienenhaus/properties/aez.png'))
      .toBe('https://res.cloudinary.com/jpyigjrh/image/upload/f_jpg,q_auto/v1792455141/bienenhaus/properties/aez.png');
    /* Forma B: sin transformaciones, arranca con la version (13 de las 555) */
    expect(toJpgUrl('https://res.cloudinary.com/jpyigjrh/image/upload/v1790387212/bienenhaus/properties/aez.png'))
      .toBe('https://res.cloudinary.com/jpyigjrh/image/upload/f_jpg,q_auto/v1790387212/bienenhaus/properties/aez.png');
    /* Conserva los demas transforms */
    expect(toJpgUrl('https://res.cloudinary.com/jpyigjrh/image/upload/w_500,c_fill,f_auto/v1/x.png'))
      .toBe('https://res.cloudinary.com/jpyigjrh/image/upload/w_500,c_fill,f_jpg/v1/x.png');
    /* URLs que no son de Cloudinary quedan intactas */
    expect(toJpgUrl('https://ejemplo.com/foto.png')).toBe('https://ejemplo.com/foto.png');
    expect(toJpgUrl('')).toBe('');
  });

  test('buildZipBytes produce un ZIP valido (parseado por un lector independiente)', () => {
    const { buildZipBytes } = loadZip(true);
    const foto = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5]);
    const bytes = buildZipBytes([
      { name: 'DA-P0026 - Terreno/01-foto.jpg', data: foto },
      { name: 'DA-P0026 - Terreno/_ficha.txt', data: 'Codigo: DA-P0026\n' },
    ]);

    const parsed = parseZip(bytes);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((e) => e.name)).toEqual([
      'DA-P0026 - Terreno/01-foto.jpg',
      'DA-P0026 - Terreno/_ficha.txt',
    ]);

    parsed.entries.forEach((e) => {
      expect(e.method).toBe(0);           // store
      expect(e.flags & 0x0800).toBe(0x0800); // bit 11 = nombre UTF-8
      expect(e.csize).toBe(e.usize);       // store: comprimido == original
      expect(e.data.length).toBe(e.usize);
      expect(e.crc).toBe(crc32Ref(e.data)); // CRC recalculado por otra implementacion
    });

    expect(parsed.entries[0].data).toEqual(foto);
    expect(parsed.entries[1].data.toString('utf8')).toBe('Codigo: DA-P0026\n');
  });

  test('buildZipBytes con nombres no-ASCII los deja legibles', () => {
    const { buildZipBytes } = loadZip(true);
    const bytes = buildZipBytes([
      { name: 'Cañada 787 m²/01-foto.jpg', data: 'x' },
    ]);
    const parsed = parseZip(bytes);
    expect(parsed.entries[0].name).toBe('Cañada 787 m²/01-foto.jpg');
  });

  test('un ZIP con 27 fotos (el maximo real) se arma y se valida', () => {
    const { buildZipBytes } = loadZip(true);
    const payload = Buffer.alloc(2048, 7);
    const entries = [];
    for (let i = 1; i <= 27; i++) {
      entries.push({ name: `Propiedad/_${String(i).padStart(2, '0')}-foto.jpg`, data: payload });
    }
    const parsed = parseZip(buildZipBytes(entries));
    expect(parsed.entries).toHaveLength(27);
    parsed.entries.forEach((e, i) => {
      expect(e.name).toBe(`Propiedad/_${String(i + 1).padStart(2, '0')}-foto.jpg`);
      expect(e.crc).toBe(crc32Ref(payload));
    });
  });
});

/* ============================================================
   2. Integracion en el panel (guardas estaticas)
   ============================================================ */
test.describe('ZIP: integracion en el modulo Propiedades', () => {
  test('admin.html habilita res.cloudinary.com en connect-src y carga zip.js antes de admin-propiedades.js', () => {
    const html = fs.readFileSync(ADMIN_HTML, 'utf8');
    const csp = (html.match(/<meta http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/) || [])[1] || '';
    expect(csp).toContain("connect-src");
    /* Sin esto el fetch a Cloudinary desde el panel queda bloqueado */
    expect(/connect-src[^;]*https:\/\/res\.cloudinary\.com/.test(csp)).toBe(true);

    const zipIdx = html.indexOf('assets/js/zip.js');
    const propIdx = html.indexOf('assets/js/admin-propiedades.js');
    expect(zipIdx).toBeGreaterThan(-1);
    expect(propIdx).toBeGreaterThan(-1);
    expect(zipIdx).toBeLessThan(propIdx);
  });

  test('el boton de ZIP y su handler existen en admin-propiedades.js', () => {
    const src = fs.readFileSync(PROP_SRC, 'utf8');
    expect(src).toContain('data-prop-act="download-zip"');
    expect(src).toContain("'download-zip'");
    expect(src).toContain('downloadPropertyZip');
    /* Consume el generador, no una libreria externa */
    expect(src).toContain('BHZip');
    expect(src).not.toContain('jszip');
    expect(src).not.toContain('fflate');
  });
});

/* ============================================================
   3. Camino real de navegador (Blob -> <a download>)
   ============================================================ */
test.describe('ZIP: descarga real en navegador', () => {
  test('el ZIP se descarga y abre con el contenido esperado', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));

    await page.goto('/tests/zip-harness.html');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.click('#go'),
    ]);

    expect(download.suggestedFilename()).toBe('DA-P0001 - Propiedad de prueba.zip');
    const ruta = await download.path();
    const bytes = fs.readFileSync(ruta);
    const parsed = parseZip(bytes);

    expect(parsed.entries.map((e) => e.name)).toEqual([
      'DA-P0001 - Propiedad de prueba/01-foto.png',
      'DA-P0001 - Propiedad de prueba/02-foto.webp',
      'DA-P0001 - Propiedad de prueba/_ficha.txt',
    ]);
    parsed.entries.forEach((e) => {
      expect(e.method).toBe(0);
      expect(e.crc).toBe(crc32Ref(e.data));
      expect(e.data.length).toBe(e.usize);
      expect(e.data.length).toBeGreaterThan(0);
    });

    /* El nombre con acentos de la ficha sobrevive */
    expect(parsed.entries[2].data.toString('utf8')).toContain('DA-P0001');

    expect(errores).toEqual([]);
  });

  test('el harness usa la MISMA connect-src que admin.html (no se puede desincronizar)', () => {
    const html = fs.readFileSync(ADMIN_HTML, 'utf8');
    const harness = fs.readFileSync(path.join(ROOT, 'tests', 'zip-harness.html'), 'utf8');
    /* Se extrae del meta tag (no del HTML entero) para que un comentario
       con la palabra no rompa la comparacion. */
    const connectSrc = (t) => {
      const csp = (t.match(/<meta http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/) || [])[1] || '';
      return (csp.match(/connect-src[^;]*/) || [''])[0];
    };
    expect(connectSrc(harness)).toBe(connectSrc(html));
    expect(connectSrc(harness)).toContain('https://res.cloudinary.com');
  });

  test('desde el navegador baja fotos REALES de Cloudinary (CSP + f_jpg) y arma el ZIP', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    const cspErrors = [];
    page.on('console', (msg) => {
      const t = msg.text();
      if (/Content Security Policy/i.test(t) || /Refused to (connect|download|execute)/i.test(t)) cspErrors.push(t);
    });

    await page.goto('/tests/zip-harness.html');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#goReal'),
    ]);

    expect(download.suggestedFilename()).toBe('FH-P0010 - Casa 2 dormitorios.zip');
    const bytes = fs.readFileSync(await download.path());
    const parsed = parseZip(bytes);

    expect(parsed.entries).toHaveLength(5);

    /* Las 4 fotos reales son JPEG de verdad (magic FF D8 FF) */
    parsed.entries.slice(0, 4).forEach((e, i) => {
      expect(e.name).toBe(`FH-P0010 - Casa 2 dormitorios/${String(i + 1).padStart(2, '0')}-foto.jpg`);
      expect(e.data[0]).toBe(0xFF);
      expect(e.data[1]).toBe(0xD8);
      expect(e.data[2]).toBe(0xFF);
      expect(e.data.length).toBeGreaterThan(1000);
      expect(e.crc).toBe(crc32Ref(e.data));
    });
    expect(parsed.entries[4].data.toString('utf8')).toContain('FH-P0010');

    /* Si la CSP de admin.html no habilitara res.cloudinary.com, el fetch
       se bloquea y esto falla. */
    expect(cspErrors).toEqual([]);
    expect(errores).toEqual([]);
  });
});

/* ============================================================
   4. Modulo REAL de Propiedades (harness con cliente Supabase falso)
   ============================================================ */
test.describe('ZIP: modulo Propiedades (harness)', () => {
  test('el boton sale solo en propiedades con fotos y baja el ZIP con el nombre de la propiedad', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));

    await page.goto('/tests/helpers/propiedades-zip-harness.html');
    await page.waitForFunction(() => window.__HARNESS_READY === true);
    await page.evaluate(() => window.__BH.loadProperties());

    await expect(page.locator('#propertiesTableBody tr')).toHaveCount(2);

    /* El boton aparece SOLO en la propiedad que tiene fotos */
    const botones = page.locator('#propertiesTableBody [data-prop-act="download-zip"]');
    await expect(botones).toHaveCount(1);
    await expect(botones).toHaveAttribute('data-prop-id', 'aaaa1111-2222-3333-4444-555555555555');

    /* El click dispara la descarga */
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      botones.click(),
    ]);

    expect(download.suggestedFilename()).toBe('DA-P0026 - Terreno 787 m² a 2 Cuadras del Lago.zip');

    const parsed = parseZip(fs.readFileSync(await download.path()));
    expect(parsed.entries.map((e) => e.name)).toEqual([
      'DA-P0026 - Terreno 787 m² a 2 Cuadras del Lago/01-foto.png',
      'DA-P0026 - Terreno 787 m² a 2 Cuadras del Lago/02-foto.png',
      'DA-P0026 - Terreno 787 m² a 2 Cuadras del Lago/_ficha.txt',
    ]);
    parsed.entries.forEach((e) => {
      expect(e.crc).toBe(crc32Ref(e.data));
      expect(e.data.length).toBe(e.usize);
      expect(e.data.length).toBeGreaterThan(0);
    });

    /* La ficha de texto lleva los datos de la propiedad */
    const ficha = parsed.entries[2].data.toString('utf8');
    expect(ficha).toContain('Codigo: DA-P0026');
    expect(ficha).toContain('Terreno 787 m² a 2 Cuadras del Lago');
    expect(ficha).toContain('San Javier del Lago');

    /* Y el panel avisa que salio el ZIP */
    await page.waitForFunction(() => window.__TOASTS.some((t) => /ZIP descargado/.test(t.msg)), null, { timeout: 10000 });

    expect(errores).toEqual([]);
  });
});
