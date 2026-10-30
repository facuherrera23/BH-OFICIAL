/* ============================================================
   BIENENHAUS PROPIEDADES — Herramientas SEO del módulo CONTENIDO
   ------------------------------------------------------------
   Todo lo que ayuda a que un video de YouTube esté bien publicado:
   validaciones previas (límites reales de YouTube), generador de
   títulos alternativos con su score, bloques de descripción
   reutilizables, plantillas por tipo de contenido y detección de
   canibalización (un video que compite con otro del canal o con
   una ficha del sitio).

   NO toca el DOM ni el servidor: son funciones puras sobre datos.
   La UI (admin-contenido.js) decide cómo mostrarlas.

   Expone: window.BH_YT.seo
   ============================================================ */
(function () {
  'use strict';

  const NS = (window.BH_YT = window.BH_YT || {});
  const utils = (NS.core && NS.core.utils) || {};

  const norm = utils.norm || function (s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  };

  /* Límites reales de YouTube (no aproximaciones). */
  const LIMITS = {
    title: 100,
    description: 5000,
    tagsChars: 480,
    tagsMax: 15,        // YouTube acepta más, pero el SEO real usa los 3 primeros
    titleMin: 30,
    descriptionWords: 150,
    hashtagsMax: 3,     // YouTube ignora el hashtag si hay más de 3
  };

  /* Rangos de emoji/pictogramas (Unicode). La API de YouTube los acepta,
     pero ML rechaza plain_text con emojis (incidente 2026-10-21) → si el
     contenido se replica a otro canal, la publicación se rompe. */
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

  const STOPWORDS = new Set(('de del la el los las al a y o en para con un una por que se su tu mi mas ' +
    'the and for you your our are was were this that con del los las').split(' '));

  /* ============================================================
     HELPERS
     ============================================================ */
  function parseTags(v) {
    if (Array.isArray(v)) return v.map(function (t) { return String(t || '').trim(); }).filter(Boolean);
    return String(v || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function countWords(s) {
    return String(s || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function keywordsOf(s) {
    return norm(s).split(/[^a-z0-9ñ]+/).filter(function (w) {
      return w.length > 3 && !STOPWORDS.has(w);
    });
  }

  /** Similitud de Jaccard entre dos textos (0..1). */
  function similarity(a, b) {
    const sa = new Set(keywordsOf(a));
    const sb = new Set(keywordsOf(b));
    if (!sa.size || !sb.size) return 0;
    let inter = 0;
    sa.forEach(function (w) { if (sb.has(w)) inter++; });
    return inter / (sa.size + sb.size - inter);
  }

  /** Tags del nicho (mismos que usa el motor de score como presets). */
  const NICHE_TAGS = [
    'inmobiliaria córdoba', 'bienenhaus', 'casas en venta córdoba',
    'departamentos en córdoba', 'alquileres córdoba', 'nueva córdoba',
    'villa allende', 'la calera', 'unquillo', 'cosquín', 'la cumbre',
    'villa carlos paz', 'lotes en córdoba', 'inversión inmobiliaria',
    'propiedades nueva córdoba', 'tour virtual 360', 'terrenos en córdoba',
  ];

  /* ============================================================
     VALIDACIÓN — antes de gastar una subida (1600 unidades de cuota)
     ============================================================ */
  function validate(meta) {
    meta = meta || {};
    const title = String(meta.title || '');
    const description = String(meta.description || '');
    const tags = parseTags(meta.tags);
    const keyword = String(meta.keyword || '');
    const errors = [];
    const warnings = [];
    const infos = [];

    if (!title.trim()) {
      errors.push({ code: 'title_required', message: 'Falta el título: YouTube no acepta un video sin título.' });
    } else {
      if (title.length > LIMITS.title) {
        errors.push({ code: 'title_long', message: 'El título tiene ' + title.length + ' caracteres (YouTube corta en ' + LIMITS.title + ').' });
      }
      if (title.length < LIMITS.titleMin) {
        warnings.push({ code: 'title_short', message: 'El título tiene menos de ' + LIMITS.titleMin + ' caracteres: es poco descriptivo para las búsquedas.' });
      }
      const letters = title.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
      const upper = letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length;
      if (letters.length > 8 && upper / letters.length > 0.5) {
        warnings.push({ code: 'title_caps', message: 'Más de la mitad del título está en mayúsculas: YouTube lo toma como spam.' });
      }
    }

    if (description.length > LIMITS.description) {
      errors.push({ code: 'desc_long', message: 'La descripción tiene ' + description.length + ' caracteres (YouTube corta en ' + LIMITS.description + ').' });
    }
    const words = countWords(description);
    if (description && words < LIMITS.descriptionWords) {
      infos.push({ code: 'desc_short', message: 'La descripción tiene ' + words + ' palabras: agregá contexto (barrio, amenities, precio orientativo) para posicionar mejor.' });
    }
    if (description && !/https?:\/\//i.test(description)) {
      infos.push({ code: 'desc_no_link', message: 'La descripción no tiene ningún link: se pierde el contacto directo con el canal.' });
    }
    if (EMOJI_RE.test(description)) {
      warnings.push({
        code: 'desc_emoji',
        message: 'La descripción tiene emojis: YouTube los acepta, pero Mercado Libre rechaza el texto con emojis (incidente 2026-10-21) y la publicación queda "sin descripción" si se replica.',
      });
    }
    const hashtags = (description.match(/#[\p{L}\p{N}_]+/gu) || []);
    if (hashtags.length > LIMITS.hashtagsMax) {
      infos.push({ code: 'hashtags_many', message: 'Hay ' + hashtags.length + ' hashtags: YouTube solo toma los ' + LIMITS.hashtagsMax + ' primeros.' });
    }

    if (tags.length > LIMITS.tagsMax) {
      warnings.push({ code: 'tags_many', message: 'Tenés ' + tags.length + ' tags: YouTube da peso SEO solo a los 3 primeros.' });
    }
    const tagsChars = tags.join(',').length;
    if (tagsChars > LIMITS.tagsChars) {
      warnings.push({ code: 'tags_long', message: 'Los tags ocupan ' + tagsChars + ' caracteres (el máximo útil es ' + LIMITS.tagsChars + ').' });
    }
    const seen = {};
    let dupes = 0;
    tags.forEach(function (t) {
      const k = norm(t);
      if (seen[k]) dupes++;
      seen[k] = 1;
    });
    if (dupes) {
      warnings.push({ code: 'tags_dupes', message: 'Hay ' + dupes + ' tag(s) repetido(s): se cuentan una sola vez.' });
    }

    if (!keyword.trim()) {
      infos.push({ code: 'keyword_missing', message: 'Sin palabra clave objetivo el score se deduce del título: definí una para medir mejor.' });
    }

    return { errors, warnings, infos, score: scoreOf({ title, description, tags, keyword }) };
  }

  /** Score del motor SEO (si está cargado). */
  function scoreOf(meta) {
    const engine = window.BH_YT_SEO;
    if (!engine || typeof engine.calc !== 'function') return null;
    try {
      const r = engine.calc({
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        keyword: meta.keyword,
      });
      return r && typeof r.score === 'number' ? r : null;
    } catch (_) {
      return null;
    }
  }

  /* ============================================================
     TÍTULOS ALTERNATIVOS — 5 variantes, cada una con su score
     ============================================================ */
  function titleVariants(meta) {
    meta = meta || {};
    const keyword = String(meta.keyword || '').trim();
    const prop = meta.property || {};
    const base = String(meta.title || '').trim();
    const zone = String(prop.zone || prop.location || 'Córdoba');
    const ptype = String(prop.property_type || prop.type || 'propiedad');
    const rooms = prop.rooms ? prop.rooms + (prop.rooms === 1 ? ' ambiente' : ' ambientes') : '';

    const candidates = [
      { title: keyword ? keyword + ' — ' + base : base, why: 'La palabra clave va primero (es lo que YouTube muestra en el resultado).' },
      { title: base + (keyword ? ' | ' + keyword : ''), why: 'El título va primero y la keyword después (igual peso, distinto formato).' },
      { title: 'Tour de ' + ptype + (rooms ? ' de ' + rooms : '') + ' en ' + zone + (keyword ? ' — ' + keyword : ''), why: 'Formato "tour + tipo + zona": es el patrón que más rinde en búsquedas locales.' },
      { title: keyword ? keyword + ': guía completa 2026' : base + ' — guía completa 2026', why: 'Formato de guía: suma la intención de búsqueda informativa.' },
      { title: '¿Cuánto vale una ' + ptype + ' en ' + zone + '?' + (keyword ? ' ' + keyword : ''), why: 'Pregunta: capta a quien busca precio y genera comentarios.' },
    ];

    return candidates
      .filter(function (c) { return c.title && c.title.length <= LIMITS.title; })
      .map(function (c) {
        const r = scoreOf({ title: c.title, description: meta.description, tags: meta.tags, keyword });
        return {
          title: c.title,
          why: c.why,
          score: r ? r.score : null,
          label: r ? r.label : null,
          isCurrent: norm(c.title) === norm(base),
        };
      })
      .sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  }

  /* ============================================================
     BLOQUES DE DESCRIPCIÓN — se insertan con un clic
     ============================================================ */
  const BLOCKS = [
    {
      id: 'contact',
      label: 'Contacto + WhatsApp',
      icon: 'fa-brands fa-whatsapp',
      build(meta) {
        const m = meta || {};
        const phone = m.whatsapp || m.phone || '';
        const lines = ['', 'Consultanos por esta propiedad:'];
        if (phone) lines.push('WhatsApp: ' + phone);
        if (m.email) lines.push('Email: ' + m.email);
        if (m.url) lines.push(m.url);
        return lines.join('\n');
      },
    },
    {
      id: 'legal',
      label: 'Aviso de precios y disponibilidad',
      icon: 'fas fa-circle-info',
      build() {
        return [
          '',
          'Los precios y la disponibilidad son orientativos y pueden variar.',
          'Consultá el valor actualizado con nuestro equipo comercial.',
        ].join('\n');
      },
    },
    {
      id: 'zones',
      label: 'Zonas donde trabajamos',
      icon: 'fas fa-map-location-dot',
      build(meta) {
        const zones = (meta && meta.zones && meta.zones.length)
          ? meta.zones
          : ['Nueva Córdoba', 'Alberdi', 'Villa Allende', 'La Calera', 'Villa Carlos Paz', 'Unquillo'];
        return '\nZonas donde trabajamos: ' + zones.join(', ') + '.';
      },
    },
    {
      id: 'hashtags',
      label: 'Hashtags del nicho',
      icon: 'fas fa-hashtag',
      build(meta) {
        const m = meta || {};
        const kw = norm(m.keyword || '').trim();
        const extra = kw ? ['#' + kw.replace(/\s+/g, '')] : [];
        return '\n' + ['#bienenhaus', '#inmobiliariacordoba', '#inmobiliaria'].concat(extra).slice(0, 3).join(' ');
      },
    },
    {
      id: 'property',
      label: 'Link a la ficha de la propiedad',
      icon: 'fas fa-house-circle-check',
      build(meta) {
        const m = meta || {};
        if (!m.propertyUrl) return '';
        return '\nFicha completa de la propiedad: ' + m.propertyUrl;
      },
    },
  ];

  function blockById(id) {
    for (let i = 0; i < BLOCKS.length; i++) if (BLOCKS[i].id === id) return BLOCKS[i];
    return null;
  }

  /* ============================================================
     PLANTILLAS POR TIPO DE CONTENIDO
     ============================================================ */
  const PRESETS = [
    {
      id: 'tour',
      label: 'Tour de propiedad',
      apply(meta) {
        const m = meta || {};
        const p = m.property || {};
        const rooms = p.rooms ? p.rooms + ' ambientes' : '';
        const surf = p.surface_total ? p.surface_total + ' m²' : '';
        const title = 'Tour ' + (p.property_type || 'propiedad') + (rooms ? ' de ' + rooms : '') +
          ' en ' + (p.zone || 'Córdoba') + (surf ? ' — ' + surf : '');
        return {
          title,
          description: 'Recorremos la propiedad completa: ambientes, cocina, baño y detalles que no se ven en las fotos.',
          tags: ['bienenhaus', 'tour virtual 360', p.zone || 'córdoba', p.property_type || 'propiedad', 'inmobiliaria córdoba'].filter(Boolean),
          privacy: 'public',
        };
      },
    },
    {
      id: 'valuation',
      label: 'Tasación / valor de mercado',
      apply(meta) {
        const m = meta || {};
        const p = m.property || {};
        const title = '¿Cuánto vale una ' + (p.property_type || 'propiedad') + ' en ' + (p.zone || 'Córdoba') + '?';
        return {
          title,
          description: 'Cuánto vale hoy una ' + (p.property_type || 'propiedad') + ' en ' + (p.zone || 'Córdoba') +
            ': comparamos precios reales de la zona y te mostramos el rango de mercado.',
          tags: ['tasación', 'valor de mercado', 'precioimmobiliaria', p.zone || 'córdoba', 'inversión inmobiliaria'].filter(Boolean),
          privacy: 'public',
        };
      },
    },
    {
      id: 'neighborhood',
      label: 'Barrio / zona',
      apply(meta) {
        const m = meta || {};
        const zone = (m.property && m.property.zone) || 'Nueva Córdoba';
        const title = zone + ': qué hay que saber antes de mudarse';
        return {
          title,
          description: 'Te mostramos ' + zone + ': servicios, accesos, schools y el rango de precios de la zona.',
          tags: ['barrios', zone, 'vida en córdoba', 'inmobiliaria córdoba', 'bienenhaus'].filter(Boolean),
          privacy: 'public',
        };
      },
    },
    {
      id: 'land',
      label: 'Terreno',
      apply(meta) {
        const m = meta || {};
        const p = m.property || {};
        const title = 'Terreno en venta en ' + (p.zone || 'Córdoba') + (p.surface_total ? ' — ' + p.surface_total + ' m²' : '');
        return {
          title,
          description: 'Terreno en venta: ubicación, superficie, servicios y potencial de construcción.',
          tags: ['terrenos en córdoba', 'terreno en venta', p.zone || 'córdoba', 'inversión inmobiliaria', 'bienenhaus'].filter(Boolean),
          privacy: 'public',
        };
      },
    },
    {
      id: 'project',
      label: 'Proyecto / obra',
      apply(meta) {
        const m = meta || {};
        const p = m.property || {};
        const title = 'Cómo es vivir en ' + (p.zone || 'este proyecto') + ': avance de obra';
        return {
          title,
          description: 'Avance de obra, amenities y fecha estimada de entrega del proyecto.',
          tags: ['proyectos', 'innovación', p.zone || 'córdoba', 'departamentos', 'bienenhaus'].filter(Boolean),
          privacy: 'public',
        };
      },
    },
  ];

  function presetById(id) {
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  /* ============================================================
     CANIBALIZACIÓN — un video que compite con otro o con una ficha
     ============================================================ */
  function canibalization(meta) {
    meta = meta || {};
    const warnings = [];
    const keyword = norm(meta.keyword || '').trim();
    const title = String(meta.title || '');

    (meta.channelVideos || []).forEach(function (v) {
      if (!v || v.id === meta.selfId) return;
      const hay = norm(String(v.title || '') + ' ' + (v.tags || []).join(' '));
      if (keyword && hay.indexOf(keyword) >= 0) {
        warnings.push({
          code: 'keyword_repeated',
          level: 'warning',
          message: 'La keyword ya aparece en otro video del canal ("' + String(v.title || '').substring(0, 60) + '").',
          videoId: v.id,
        });
      } else {
        const sim = similarity(title, v.title || '');
        if (sim >= 0.6) {
          warnings.push({
            code: 'title_similar',
            level: 'warning',
            message: 'El título es muy parecido a "' + String(v.title || '').substring(0, 60) + '" (' + Math.round(sim * 100) + '% de similitud).',
            videoId: v.id,
          });
        }
      }
    });

    (meta.sitePages || []).forEach(function (p) {
      if (!p) return;
      const hay = norm(String(p.title || '') + ' ' + String(p.code || ''));
      if (keyword && hay.indexOf(keyword) >= 0) {
        warnings.push({
          code: 'site_compete',
          level: 'info',
          message: 'La keyword también aparece en la ficha "' + String(p.code || p.title || '') + '" del sitio: los dos contents compiten por la misma búsqueda.',
        });
      }
    });

    return warnings;
  }

  /* ============================================================
     EXPORT
     ============================================================ */
  NS.seo = {
    LIMITS,
    NICHE_TAGS,
    BLOCKS,
    PRESETS,
    parseTags,
    countWords,
    similarity,
    validate,
    scoreOf,
    titleVariants,
    blockById,
    presetById,
    canibalization,
  };
})();
