/* ============================================================
   BIENENHAUS PROPIEDADES - ZIP
   ------------------------------------------------------------
   Generador de ZIP minimo (modo STORE) sin dependencias externas.

   Por que existe: el modulo Propiedades necesita descargar TODAS
   las fotos de una propiedad en un solo archivo ZIP, con el nombre
   de la propiedad.

   Decisiones tecnicas:
   - Modo STORE (sin compresion): JPEG/PNG/WebP ya son formatos
     comprimidos; deflarlos otra vez gasta CPU y no ahorra nada.
   - Sin librerias externas (JSZip/fflate): el panel se sirve desde
     el repo, sin CDN y sin sumar ~100 KB al bundle.
   - Bit 11 (EFS) activado: los nombres internos se escriben en
     UTF-8, asi "Cañada" o "m2" con superindice no se rompen.
   - Sin ZIP64: el techo real es ~30 MB (27 fotos x ~900 KB).
   ============================================================ */
(function (global) {
  'use strict';

  /* ------------------------------------------------
     CRC32 (requerido por el formato ZIP)
     ------------------------------------------------ */
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    if (!bytes || !bytes.length) return 0;
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ------------------------------------------------
     UTF-8 (TextEncoder con fallback manual)
     ------------------------------------------------ */
  function utf8Encode(str) {
    const text = String(str == null ? '' : str);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let cp = text.codePointAt(i);
      if (cp > 0xFFFF) i++;
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      } else if (cp < 0x10000) {
        out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return new Uint8Array(out);
  }

  function toBytes(data) {
    if (data == null) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data;
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'string') return utf8Encode(data);
    throw new TypeError('BHZip: tipo de dato no soportado en una entrada del ZIP');
  }

  /* ------------------------------------------------
     Fecha/hora en formato DOS (el que usa ZIP)
     ------------------------------------------------ */
  function dosDateTime(input) {
    const d = input instanceof Date && !isNaN(input.getTime()) ? input : new Date();
    const year = d.getFullYear();
    const dosYear = Math.max(0, Math.min(127, year - 1980));
    const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
    const date = ((dosYear & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  /* ------------------------------------------------
     Nombres de archivo seguros (Windows/macOS/Linux)
     ------------------------------------------------ */
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function sanitizeFilename(name, fallback) {
    let s = String(name == null ? '' : name);
    /* Caracteres prohibidos en Windows + controles + separadores */
    s = s.replace(/[\\/:*?"<>|]/g, ' ');
    s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    /* Windows no permite puntos ni espacios al final */
    s = s.replace(/[. ]+$/g, '');
    if (!s) s = String(fallback || 'archivo');
    if (WINDOWS_RESERVED.test(s)) s = '_' + s;
    /* Techo practico para nombres largos en Windows + rutas */
    if (s.length > 120) s = s.slice(0, 120).replace(/[. ]+$/g, '').trim();
    return s || String(fallback || 'archivo');
  }

  /* ------------------------------------------------
     Cloudinary: forzar JPG real
     ------------------------------------------------
     Las URLs guardadas en properties.image_urls tienen dos formas:
       A) /upload/f_auto,q_auto/v1792455141/carpeta/archivo.png   (542 de 555)
       B) /upload/v1790387212/carpeta/archivo.png                 (13 de 555)
     En A se reemplaza f_auto -> f_jpg. En B se inserta f_jpg,q_auto
     antes del segmento de version.
     Un segmento de transformacion SIEMPRE lleva underscore
     (f_auto, w_200, c_fill); uno de version es "v1790387212" (no lo lleva).
     ------------------------------------------------ */
  function toJpgUrl(url) {
    const raw = String(url || '');
    if (!raw || raw.indexOf('res.cloudinary.com') === -1) return raw;

    const marker = '/upload/';
    const idx = raw.indexOf(marker);
    if (idx === -1) return raw;

    const head = raw.slice(0, idx + marker.length);
    const segments = raw.slice(idx + marker.length).split('/');
    const first = segments[0] || '';
    const isTransform = /^[a-z]+_[^/]+$/.test(first);

    if (isTransform) {
      const parts = first.split(',').map(function (part) {
        return part.split('_')[0] === 'f' ? 'f_jpg' : part;
      });
      if (!parts.some(function (p) { return p.split('_')[0] === 'f'; })) parts.unshift('f_jpg');
      segments[0] = parts.join(',');
    } else {
      segments.unshift('f_jpg,q_auto');
    }
    return head + segments.join('/');
  }

  /* ------------------------------------------------
     Escritura del ZIP
     ------------------------------------------------ */
  function buildZipBytes(entries, options) {
    const opts = options || {};
    const stamp = dosDateTime(opts.date);
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    let count = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] || {};
      const nameBytes = utf8Encode(entry.name == null ? '' : entry.name);
      const data = toBytes(entry.data);
      const crc = crc32(data);

      /* Cabecera local (30 bytes + nombre) */
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // firma
      lv.setUint16(4, 20, true);           // version necesaria
      lv.setUint16(6, 0x0800, true);       // flags: bit 11 = nombre UTF-8
      lv.setUint16(8, 0, true);            // metodo: 0 = store
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // comprimido (store = igual)
      lv.setUint32(22, data.length, true); // original
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra field
      local.set(nameBytes, 30);
      localParts.push(local, data);

      /* Directorio central (46 bytes + nombre) */
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);           // version creador (0x0014 = 2.0, MS-DOS)
      cv.setUint16(6, 20, true);           // version necesaria
      cv.setUint16(8, 0x0800, true);       // flags
      cv.setUint16(10, 0, true);           // metodo: store
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // extra
      cv.setUint16(32, 0, true);           // comentario
      cv.setUint16(34, 0, true);           // numero de disco
      cv.setUint16(36, 0, true);           // atributos internos
      cv.setUint32(38, 0, true);           // atributos externos
      cv.setUint32(42, offset, true);      // offset de la cabecera local
      cd.set(nameBytes, 46);
      centralParts.push(cd);

      offset += local.length + data.length;
      count++;
    }

    let cdSize = 0;
    for (let i = 0; i < centralParts.length; i++) cdSize += centralParts[i].length;

    /* EOCD (22 bytes) */
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, count, true);
    ev.setUint16(10, count, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);             // longitud del comentario

    let total = 22 + cdSize;
    for (let i = 0; i < localParts.length; i++) total += localParts[i].length;

    const out = new Uint8Array(total);
    let pos = 0;
    for (let i = 0; i < localParts.length; i++) {
      out.set(localParts[i], pos);
      pos += localParts[i].length;
    }
    for (let i = 0; i < centralParts.length; i++) {
      out.set(centralParts[i], pos);
      pos += centralParts[i].length;
    }
    out.set(eocd, pos);
    return out;
  }

  function buildZipBlob(entries, options) {
    const bytes = buildZipBytes(entries, options);
    return new Blob([bytes], { type: 'application/zip' });
  }

  /* ------------------------------------------------
     Descarga en el navegador
     ------------------------------------------------ */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filename || 'descarga.zip');
    a.setAttribute('aria-hidden', 'true');
    /* Fuera de pantalla (no `display:none`): hay navegadores que ignoran el
       click de un ancla totalmente oculta. */
    a.style.position = 'fixed';
    a.style.left = '-9999px';
    a.style.top = '0';
    a.style.width = '1px';
    a.style.height = '1px';
    a.style.opacity = '0';
    document.body.appendChild(a);
    a.click();
    /* Revocar tarde: en Firefox revocar en el mismo tick corta la descarga */
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 30000);
    return filename;
  }

  global.BHZip = {
    version: 1,
    crc32: crc32,
    utf8Encode: utf8Encode,
    sanitizeFilename: sanitizeFilename,
    toJpgUrl: toJpgUrl,
    buildZipBytes: buildZipBytes,
    buildZipBlob: buildZipBlob,
    downloadBlob: downloadBlob
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
