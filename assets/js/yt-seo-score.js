/* ============================================================
   BIENENHAUS — Motor de Score SEO para YouTube (estilo vidIQ)
   ------------------------------------------------------------
   Cuantifica qué tan optimizado está un video ANTES de
   publicarlo, para que el contenido del canal tenga más
   chances de aparecer en las búsquedas.

   Heurística (100 pts, inspirada en vidIQ Vision + guías de
   creadores de YouTube):
     TÍTULO (35):      keyword en los primeros 40 caracteres (18)
                       · longitud 30–70 (12)
                       · no abusar de mayúsculas (5)
     DESCRIPCIÓN (30): keyword dentro de los primeros 150
                       caracteres (12) · ≥150 palabras (12)
                       · link o contacto de CTA (6)
     TAGS (25):        ≥12 tags (10) · ≤480 chars (5)
                       · sin repetidos (5)
                       · keyword como primer tag (5)
     EXTRAS (10):      3–5 hashtags en la descripción (7)
                       · primera línea que engancha (3)

   Escala: <50 Débil · 50–69 Aceptable · 70–84 Fuerte · ≥85 Excelente

   La palabra clave objetivo viaja en `keyword`; si falta, se
   deduce del título (primera frase sin palabras de relleno).

   Standalone: sin dependencias de window.__BH. Expone:
     window.BH_YT_SEO = { calc, render, WEIGHTS }
   `calc` es puro y determinista (testeable). `render` dibuja
   el panel (gauge + miniatura SERP + checklist + chips + tags
   sugeridos) con listeners reales — cero onclick inline (CSP).
   ============================================================ */
(function () {
  'use strict';

  /* Máximo de puntos por check — la suma ES 100. */
  var WEIGHTS = {
    titleKw: 18, titleLen: 12, titleCaps: 5,
    descKw: 12, descWords: 12, descLinks: 6,
    tagsCount: 10, tags480: 5, tagsDupes: 5, tagsKwFirst: 5,
    hashtags: 7, hook: 3,
  };

  var GROUP_META = [
    { name: 'TÍTULO', max: 35 },
    { name: 'DESCRIPCIÓN', max: 30 },
    { name: 'TAGS', max: 25 },
    { name: 'EXTRAS', max: 10 },
  ];

  /* Tags listos para el nicho (inmobiliaria en Córdoba). Al hacer
     click se agregan al input de tags del formulario. */
  var PRESET_TAGS = [
    'inmobiliaria córdoba', 'bienenhaus', 'casas en venta córdoba',
    'departamentos en córdoba', 'alquileres córdoba', 'nueva córdoba',
    'villa allende', 'la calera', 'unquillo', 'cosquín', 'la cumbre',
    'villa carlos paz', 'lotes en córdoba', 'inversión inmobiliaria',
    'propiedades nueva córdoba', 'tour virtual 360', 'terrenos en córdoba',
    'barrio privado córdoba', 'departamento 2 ambientes',
  ];

  var STOPWORDS = 'de del la el los las al a y o en para con un una por que se su tu mi mas'.split(' ');

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* minúsculas + sin acentos: las comparaciones keyword/texto son insensibles */
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function parseTags(v) {
    if (Array.isArray(v)) return v.map(function (t) { return String(t).trim(); }).filter(Boolean);
    return String(v || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function countWords(s) {
    return String(s || '').split(/\s+/).filter(Boolean).length;
  }

  /* Palabra clave objetivo: primera frase del título (antes de
     separadores) sin palabras de relleno, hasta 4 términos. */
  function deriveKeyword(title) {
    var t = String(title || '').trim();
    if (!t) return '';
    var seg = t.split(/[|·:—–-]/)[0].trim();
    if (!seg) seg = t;
    var toks = norm(seg).replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    var nonStop = toks.filter(function (w) { return STOPWORDS.indexOf(w) === -1; });
    var picked = (nonStop.length ? nonStop : toks).slice(0, 4);
    return picked.join(' ');
  }

  /* ---------- cálculo del score ---------- */

  function calc(input) {
    input = input || {};
    var title = String(input.title || '').trim();
    var desc = String(input.description || '');
    var tags = parseTags(input.tags);
    var keyword = String(input.keyword || '').trim();
    var keywordDerived = false;
    if (!keyword) { keyword = deriveKeyword(title); keywordDerived = true; }
    var kw = norm(keyword);
    var titleN = norm(title);
    var descN = norm(desc);
    var empty = !title && !desc.trim() && !tags.length;

    var checks = [];
    function push(id, group, max, pts, text, hint) {
      checks.push({
        id: id, group: group, max: max, points: pts,
        state: pts >= max ? 'ok' : (pts > 0 ? 'warn' : 'fail'),
        text: text, hint: pts < max ? hint : '',
      });
    }

    /* --- TÍTULO --- */
    if (!kw) {
      push('titleKw', 'TÍTULO', 18, 0, 'El título no tiene una palabra clave objetivo',
        'Escribí la palabra clave (arriba) o un título con el término de búsqueda que querés ganar.');
    } else {
      var idxT = titleN.indexOf(kw);
      if (idxT >= 0 && idxT < 40) {
        push('titleKw', 'TÍTULO', 18, 18, 'La keyword está al inicio del título (primeros 40 caracteres)', '');
      } else if (idxT >= 0) {
        push('titleKw', 'TÍTULO', 18, 9, 'La keyword aparece, pero después del caracter 40',
          'Mové «' + keyword + '» al principio del título — los primeros 40 caracteres son los que más pesan.');
      } else {
        push('titleKw', 'TÍTULO', 18, 0, 'El título no contiene la keyword',
          'La keyword debe aparecer en el título — es la coincidencia más potente con las búsquedas.');
      }
    }

    var lenT = title.length;
    if (lenT >= 30 && lenT <= 70) {
      push('titleLen', 'TÍTULO', 12, 12, 'Longitud ideal (' + lenT + '/70): se muestra entera en el buscador', '');
    } else if (lenT > 70) {
      push('titleLen', 'TÍTULO', 12, 8, 'Muy largo (' + lenT + ' chars): se corta con "…" en los resultados',
        'A los 70 caracteres YouTube trunca el título — mové lo importante al principio.');
    } else if (lenT >= 20) {
      push('titleLen', 'TÍTULO', 12, 6, 'Algo corto (' + lenT + ' chars)',
        'Usá el espacio restante para barrio, ambientes u operación (más términos de búsqueda).');
    } else {
      push('titleLen', 'TÍTULO', 12, 0, 'Título demasiado corto (' + lenT + ' chars)',
        'Sumá barrio + ambientes + operación: es el texto más importante del video.');
    }

    var letters = (title.match(/[A-Za-z]/g) || []).length;
    var uppers = (title.match(/[A-Z]/g) || []).length;
    var ratio = letters ? uppers / letters : 0;
    if (letters === 0) {
      push('titleCaps', 'TÍTULO', 5, 0, 'El título no tiene texto', '');
    } else if (ratio > 0.6) {
      push('titleCaps', 'TÍTULO', 5, 0, 'Casi todo en mayúsculas (' + Math.round(ratio * 100) + '%)',
        'Los títulos gritones penalizan — dejá MAYÚS solo en 1–2 palabras clave (ej. TOUR).');
    } else if (ratio > 0.35) {
      push('titleCaps', 'TÍTULO', 5, 2, 'Muchas mayúsculas (' + Math.round(ratio * 100) + '%)',
        'Bajá las mayúsculas a 1–2 palabras destacadas, el resto en minúsculas.');
    } else {
      push('titleCaps', 'TÍTULO', 5, 5, 'Uso razonable de mayúsculas', '');
    }

    /* --- DESCRIPCIÓN --- */
    if (!kw) {
      push('descKw', 'DESCRIPCIÓN', 12, 0, 'Sin keyword objetivo no puedo medir la descripción',
        'Definí la palabra clave (arriba o en el título).');
    } else {
      var idxD = descN.indexOf(kw);
      if (idxD >= 0 && idxD < 150) {
        push('descKw', 'DESCRIPCIÓN', 12, 12, 'La keyword entra en las primeras 2 líneas de la descripción', '');
      } else if (idxD >= 0) {
        push('descKw', 'DESCRIPCIÓN', 12, 6, 'La keyword aparece muy abajo en la descripción',
          'Subila a los primeros 150 caracteres — es lo que YouTube lee primero.');
      } else {
        push('descKw', 'DESCRIPCIÓN', 12, 0, 'La descripción no menciona la keyword',
          'Abrí la descripción con la keyword: es la señal de relevancia más fuerte.');
      }
    }

    var words = countWords(desc);
    if (words >= 150) {
      push('descWords', 'DESCRIPCIÓN', 12, 12, words + ' palabras — excelente: da contexto al algoritmo y tiempo de lectura', '');
    } else if (words >= 80) {
      push('descWords', 'DESCRIPCIÓN', 12, 7, words + ' palabras — te faltan para llegar a 150',
        'Describí filtros, amenities, entorno y terminá con cómo contactarte.');
    } else if (words >= 30) {
      push('descWords', 'DESCRIPCIÓN', 12, 3, 'Descripción corta (' + words + ' palabras)',
        'Apuntá a 150+ palabras: la descripción larga le da contexto al algoritmo.');
    } else {
      push('descWords', 'DESCRIPCIÓN', 12, 0, 'Descripción casi vacía',
        'Sumá descripción completa: 150+ palabras con la keyword al inicio.');
    }

    var compact = desc.replace(/[\s().-]/g, '');
    var hasLinks = /https?:\/\/|wa\.me|whatsapp/i.test(desc) || /\d{10,}/.test(compact);
    if (hasLinks) {
      push('descLinks', 'DESCRIPCIÓN', 6, 6, 'Contiene link/WhatsApp: el contacto queda a un click', '');
    } else {
      push('descLinks', 'DESCRIPCIÓN', 6, 0, 'Sin link ni contacto en la descripción',
        'Sumá un link (ficha/propiedad) o el WhatsApp y generá el CTA aquí.');
    }

    /* --- TAGS --- */
    var joined = tags.join(', ');
    if (tags.length >= 12) {
      push('tagsCount', 'TAGS', 10, 10, tags.length + ' tags — buen respaldo para el matching de búsquedas', '');
    } else if (tags.length >= 5) {
      push('tagsCount', 'TAGS', 10, 5, tags.length + ' tags — apuntá a 15 o más',
        'Sumá barrios, ciudades, tipo de propiedad y operación: cada tag es una búsqueda posible.');
    } else {
      push('tagsCount', 'TAGS', 10, 0, tags.length === 0 ? 'Sin tags' : 'Muy pocos tags (' + tags.length + ')',
        'Los tags alimentan el matching de YouTube con las búsquedas — sumá 15+ (abajo tenés sugeridos).');
    }

    if (tags.length && joined.length <= 480) {
      push('tags480', 'TAGS', 5, 5, joined.length + '/480 caracteres: dentro del límite', '');
    } else if (tags.length) {
      push('tags480', 'TAGS', 5, 0, joined.length + '/480 — YouTube descarta el excedente',
        'Recortá los tags menos relevantes hasta quedar debajo de 480.');
    } else {
      push('tags480', 'TAGS', 5, 0, 'Sin tags para medir', '');
    }

    var seen = {};
    var dupes = 0;
    tags.forEach(function (t) { var k = norm(t); if (seen[k]) dupes++; else seen[k] = 1; });
    if (!tags.length) {
      push('tagsDupes', 'TAGS', 5, 0, 'Sin tags para medir', '');
    } else if (dupes === 0) {
      push('tagsDupes', 'TAGS', 5, 5, 'Sin tags repetidos', '');
    } else if (dupes <= 2) {
      push('tagsDupes', 'TAGS', 5, 2, dupes + ' tag(s) repetidos: ocupan espacio sin aportar', '');
    } else {
      push('tagsDupes', 'TAGS', 5, 0, dupes + ' tags repetidos — limpiá los duplicados', '');
    }

    if (kw && tags.length >= 1 && norm(tags[0]).indexOf(kw) >= 0) {
      push('tagsKwFirst', 'TAGS', 5, 5, 'La keyword es el primer tag: máxima prioridad', '');
    } else if (kw) {
      push('tagsKwFirst', 'TAGS', 5, 0, 'La keyword no es el primer tag',
        'Ordená los tags por importancia: la keyword primero.');
    } else {
      push('tagsKwFirst', 'TAGS', 5, 0, 'Sin keyword objetivo', '');
    }

    /* --- EXTRAS --- */
    var hashtags = desc.match(/#[A-Za-z0-9À-ÿ_]+/g) || [];
    if (hashtags.length >= 3 && hashtags.length <= 5) {
      push('hashtags', 'EXTRAS', 7, 7, hashtags.length + ' hashtags en la descripción: ideal', '');
    } else if (hashtags.length >= 1 && hashtags.length <= 2) {
      push('hashtags', 'EXTRAS', 7, 3, hashtags.length + ' hashtag(s) — lo ideal es 3–5',
        'Tres a cinco hashtags bien elegidos aparecen sobre el título del video.');
    } else if (hashtags.length > 8) {
      push('hashtags', 'EXTRAS', 7, 0, hashtags.length + ' hashtags: es spam',
        'YouTube se saltea los primeros 15 y penaliza el abuso — dejá 3–5.');
    } else if (hashtags.length > 5) {
      push('hashtags', 'EXTRAS', 7, 3, hashtags.length + ' hashtags — un poco muchos',
        'Bajá a 3–5 de los más buscados.');
    } else {
      push('hashtags', 'EXTRAS', 7, 0, 'Sin hashtags en la descripción',
        'Sumá 3–5 hashtags al final (#inmobiliariacórdoba #nuevacórdoba…).');
    }

    var firstLine = desc.split(/\r?\n/)[0].trim();
    if (firstLine.length >= 20 && firstLine.length <= 150 && !/^https?:\/\//i.test(firstLine)) {
      push('hook', 'EXTRAS', 3, 3, 'La primera línea engancha (es lo que se ve antes de "más")', '');
    } else {
      push('hook', 'EXTRAS', 3, 0, 'La primera línea no es un gancho',
        'Escribí una primer línea de 20–150 chars que invite a mirar el video.');
    }

    var score = checks.reduce(function (a, c) { return a + c.points; }, 0);

    var label, color;
    if (empty) {
      label = '—'; color = '#6b7280';
    } else if (score >= 85) { label = 'Excelente'; color = '#22c55e'; }
    else if (score >= 70) { label = 'Fuerte'; color = '#a3e635'; }
    else if (score >= 50) { label = 'Aceptable'; color = '#f59e0b'; }
    else { label = 'Débil'; color = '#ef4444'; }

    var groups = GROUP_META.map(function (g) {
      var earned = checks.filter(function (c) { return c.group === g.name; })
        .reduce(function (a, c) { return a + c.points; }, 0);
      return { name: g.name, max: g.max, earned: earned };
    });

    var suggestions = checks.filter(function (c) { return c.state !== 'ok' && c.hint; })
      .map(function (c) { return c.hint; });

    return {
      score: score, label: label, color: color, empty: empty,
      keyword: keyword, keywordDerived: keywordDerived,
      groups: groups, checks: checks, suggestions: suggestions,
    };
  }

  /* ---------- panel render (gauge + SERP + checklist + tags) ---------- */

  function render(container, opts) {
    if (!container) return;
    opts = opts || {};
    var onTags = typeof opts.onTagsChange === 'function' ? opts.onTagsChange : null;
    var r = calc({
      title: opts.title, description: opts.description,
      tags: opts.tags, keyword: opts.keyword,
    });
    var tagsArr = parseTags(opts.tags);
    var joined = tagsArr.join(', ');
    var presets = PRESET_TAGS.filter(function (p) {
      return !tagsArr.some(function (t) { return norm(t) === norm(p); });
    }).slice(0, 12);
    var channelName = String(opts.channelName || 'Bienenhaus Propiedades');

    var t = String(opts.title || '');
    var titleShown = t.length > 70 ? t.substring(0, 67) + '…' : (t || '(sin título)');
    var firstLine = String(opts.description || '').split(/\r?\n/)[0].trim();
    var lineShown = firstLine.length > 110 ? firstLine.substring(0, 107) + '…' : firstLine;
    var C = 226.2; // 2π×36 — circunferencia del gauge
    var off = (C * (1 - r.score / 100)).toFixed(1);

    var html =
      /* Gauge + veredicto */
      '<div style="display:flex;align-items:center;gap:16px;margin-bottom:14px;flex-wrap:wrap;">' +
        '<svg viewBox="0 0 84 84" width="92" height="92" style="flex-shrink:0;" aria-hidden="true">' +
          '<circle cx="42" cy="42" r="36" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="9"></circle>' +
          '<circle cx="42" cy="42" r="36" fill="none" stroke="' + r.color + '" stroke-width="9" stroke-linecap="round" ' +
            'stroke-dasharray="' + C + '" stroke-dashoffset="' + off + '" transform="rotate(-90 42 42)"></circle>' +
          '<text x="42" y="49" text-anchor="middle" font-size="22" font-weight="700" fill="#fff">' + r.score + '</text>' +
        '</svg>' +
        '<div style="min-width:0;">' +
          '<div style="font-size:15px;font-weight:700;color:' + r.color + ';line-height:1.2;">' + esc(r.label || 'Empezá a optimizar') + '</div>' +
          '<div style="font-size:11.5px;color:var(--text-dim);margin-top:3px;">' +
            'Palabra clave: ' + (r.keyword ? '«' + esc(r.keyword) + '»' : '<i>sin definir</i>') +
            (r.keywordDerived ? ' <span style="opacity:.7;">(auto)</span>' : '') +
          '</div>' +
          (r.empty ? '' : '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + suggestionsCountText(r.checks) + '</div>') +
        '</div>' +
      '</div>' +

      /* Vista previa: así aparece el video en el buscador (SERP) */
      '<div style="display:flex;gap:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px;margin-bottom:14px;">' +
        '<div style="width:118px;aspect-ratio:16/9;background:#0d1117;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fab fa-youtube" style="color:#FF0000;font-size:22px;"></i></div>' +
        '<div style="min-width:0;flex:1;">' +
          '<div style="font-size:12.5px;font-weight:600;line-height:1.35;color:var(--text-secondary);word-break:break-word;">' + esc(titleShown) + '</div>' +
          '<div style="font-size:10.5px;color:var(--text-dim);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(channelName) + ' · hoy</div>' +
          '<div style="font-size:10.5px;color:var(--text-dim);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + esc(lineShown) + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--text-dim);margin:-8px 0 12px;">Así se ve tu video en el buscador — a los 70 chars el título se corta.</div>';

    if (r.empty) {
      html +=
        '<div style="font-size:12px;color:var(--text-dim);padding:10px 0;border-top:1px dashed rgba(255,255,255,0.07);">' +
        '<i class="fas fa-pen"></i> Completá título, descripción y tags — el checklist de mejora aparece acá.</div>';
    } else {
      /* Barras por grupo */
      html += '<div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap;">' + r.groups.map(function (g) {
        var pct = g.earned / g.max * 100;
        return '<div style="flex:1;min-width:90px;">' +
          '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-bottom:2px;"><span>' + esc(g.name) + '</span><span>' + g.earned + '/' + g.max + '</span></div>' +
          '<div style="height:5px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden;">' +
            '<div style="height:100%;width:' + pct + '%;border-radius:3px;background:var(--accent);transition:width .3s;"></div>' +
          '</div></div>';
      }).join('') + '</div>';

      /* Checklist pedido por pedido */
      html += r.checks.map(function (c) {
        var icon = c.state === 'ok' ? 'fa-circle-check' : (c.state === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-xmark');
        var col = c.state === 'ok' ? '#22c55e' : (c.state === 'warn' ? '#f59e0b' : '#ef4444');
        return '<div class="yts-check" style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed rgba(255,255,255,0.05);">' +
          '<i class="fas ' + icon + '" style="color:' + col + ';font-size:13px;margin-top:2px;width:15px;text-align:center;flex-shrink:0;"></i>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:12px;line-height:1.4;color:var(--text-secondary);">' + esc(c.text) + '</div>' +
            (c.hint ? '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;line-height:1.4;"><i class="fas fa-arrow-right" style="font-size:9px;"></i> ' + esc(c.hint) + '</div>' : '') +
          '</div>' +
          '<span style="font-size:10.5px;color:' + col + ';flex-shrink:0;">' + c.points + '/' + c.max + '</span>' +
        '</div>';
      }).join('');
    }

    /* Tags actuales como chips clicables (quitar) */
    var chipsHtml = tagsArr.length
      ? tagsArr.map(function (tag, i) {
          return '<button type="button" class="yts-chip" data-yts-chip="' + i + '" title="Quitar este tag" style="font-size:10.5px;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);color:var(--text-secondary);cursor:pointer;">' + esc(tag) + ' <i class="fas fa-times" style="font-size:8px;opacity:.65;"></i></button>';
        }).join('')
      : '<span style="font-size:11px;color:var(--text-dim);">Sin tags — usá los sugeridos de abajo</span>';
    var over = joined.length > 480;
    html +=
      '<div style="margin-top:14px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;">' +
          '<span style="font-size:10.5px;color:var(--text-dim);font-weight:600;"><i class="fas fa-tags"></i> TAGS ACTUALES</span>' +
          '<span style="font-size:10px;color:' + (over ? '#ef4444' : 'var(--text-dim)') + ';">' + tagsArr.length + ' tags · ' + joined.length + '/480</span>' +
        '</div>' +
        '<div class="yts-chips" style="display:flex;flex-wrap:wrap;gap:6px;">' + chipsHtml + '</div>' +
      '</div>';

    /* Sugerencias del nicho — click agrega al formulario real */
    if (presets.length && onTags) {
      html +=
        '<div style="margin-top:12px;">' +
          '<div style="font-size:10.5px;color:var(--text-dim);font-weight:600;margin-bottom:6px;"><i class="fas fa-wand-magic-sparkles"></i> SUGERIDOS PARA EL NICHO (click para agregar)</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + presets.map(function (p) {
            return '<button type="button" class="yts-preset" data-yts-preset="' + escAttr(p) + '" style="font-size:10.5px;padding:3px 10px;border-radius:999px;background:rgba(45,212,191,0.08);border:1px solid rgba(45,212,191,0.25);color:#5eead4;cursor:pointer;">+ ' + esc(p) + '</button>';
          }).join('') + '</div>' +
        '</div>';
    }

    html +=
      '<div style="font-size:10px;color:var(--text-dim);margin-top:14px;line-height:1.5;">' +
      'Heurística propia inspirada en vidIQ Vision y en las guías de YouTube. Orientativa, no garantiza el orden en las búsquedas.' +
      '</div>';

    container.innerHTML = html;

    /* Listeners reales (los elementos viejos se descartan con el re-render) */
    if (onTags) {
      container.querySelectorAll('.yts-chip').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var i = parseInt(btn.getAttribute('data-yts-chip'), 10);
          if (isNaN(i)) return;
          var rest = tagsArr.filter(function (_, k) { return k !== i; });
          onTags(rest.join(', '));
        });
      });
      container.querySelectorAll('.yts-preset').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var p = btn.getAttribute('data-yts-preset') || '';
          if (!p) return;
          if (tagsArr.some(function (t2) { return norm(t2) === norm(p); })) return;
          var next = tagsArr.concat([p]).join(', ');
          if (next.length <= 480) onTags(next);
        });
      });
    }
  }

  function suggestionsCountText(checks) {
    var pend = checks.filter(function (c) { return c.state !== 'ok'; }).length;
    return pend ? pend + (pend === 1 ? ' punto para mejorar' : ' puntos con margen de mejora') : 'Todo optimizado';
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Exposición con el patrón guard de defineProperty (sin pisar si ya existe) */
  var API = { calc: calc, render: render, WEIGHTS: WEIGHTS };
  if (!Object.prototype.hasOwnProperty.call(window, 'BH_YT_SEO')) {
    try {
      Object.defineProperty(window, 'BH_YT_SEO', {
        get: function () { return API; },
        set: function (v) { API = v; },
        configurable: true,
      });
    } catch (_) { window.BH_YT_SEO = API; }
  } else {
    window.BH_YT_SEO = API;
  }
})();
