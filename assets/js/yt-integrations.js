/* ============================================================
   BIENENHAUS PROPIEDADES — Integraciones del canal (módulo CONTENIDO)
   ------------------------------------------------------------
   Puente entre el canal de YouTube y el resto del panel:

     · #32  Mapa video → publicación del CRM: el Studio puede
            ofrecer "Ver ficha" de la propiedad del video.
     · #34  Compartir el video por WhatsApp con el contacto del
            agente (el contexto va DENTRO del mensaje: un video de
            YouTube no tiene página propia en el sitio que lo muestre,
            como sí la tienen las fichas).
     · #36  Republicar: clonar la metadata de un video del canal
            al formulario de publicación (con tweaks).
     · #15  Atajo desde una propiedad: dejar lista la publicación
            de un tour con los datos de la propiedad.

   Expone: window.BH_YT.integrations
   ============================================================ */
(function () {
  'use strict';

  const NS = (window.BH_YT = window.BH_YT || {});
  const core = NS.core;

  /* ============================================================
     #32 — Mapa video → post del CRM
     ============================================================ */

  /**
   * Indexa las publicaciones de YouTube por videoId.
   * rows = [{ external_post_id, property_id, property_code, ... }]
   */
  function indexPosts(rows) {
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || !r.external_post_id) return;
      map[String(r.external_post_id)] = r;
    });
    return map;
  }

  /** ¿Este video tiene ficha? (property_code del post). */
  function fichaDe(videoId, map) {
    const post = map && map[String(videoId || '')];
    if (!post) return '';
    return post.property_code || '';
  }

  /** Link a la ficha estática del video (si la hay). */
  function linkFicha(videoId, map) {
    const code = fichaDe(videoId, map);
    return code ? '/fichas/' + encodeURIComponent(code) + '.html' : '';
  }

  /* ============================================================
     #34 — Compartir por WhatsApp con el contacto del agente
     ============================================================ */

  /**
   * Link de WhatsApp con el video y el agente.
   *
   * A diferencia de las fichas (que llevan ?de=&tel= para mostrar el
   * contacto del agente), un video de YouTube no tiene página propia
   * en el sitio: el contexto va DENTRO del mensaje (nombre del agente
   * y su teléfono), que es lo que el destinatario puede usar.
   */
  function whatsappLink(videoId, agente, tel) {
    const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(String(videoId || ''));
    let texto = 'Mirá este video de Bienenhaus: ' + url;
    const nombre = String(agente || '').trim();
    if (nombre) texto += '\nConsultá con ' + nombre;
    const telTxt = String(tel || '').trim();
    if (telTxt) texto += ' (WhatsApp ' + telTxt + ')';
    return 'https://wa.me/?text=' + encodeURIComponent(texto);
  }

  /* ============================================================
     #36 — Republicar (clonar metadata al formulario)
     ============================================================ */

  /**
   * Convierte un video del canal (inventario de YouTube) en la
   * metadata del formulario de publicación.
   */
  function clonePayload(video, extra) {
    const v = video || {};
    const e = extra || {};
    return {
      title: String(v.title || '').substring(0, 100),
      description: String(v.description || '').substring(0, 5000),
      tags: Array.isArray(v.tags) ? v.tags.join(', ') : (v.tags || ''),
      keyword: e.keyword || '',
      propertyId: e.propertyId || '',
      privacy: v.privacy === 'public' ? 'public' : (v.privacy || 'public'),
      categoryId: v.category_id || '22',
    };
  }

  /* ============================================================
     #15 — Atajo desde una propiedad
     ------------------------------------------------------------
     Esta es la ÚNICA fuente de la metadata que se arma a partir de
     una propiedad del CRM: el orquestador (fillFromProperty) la
     consume. No se inventan datos: todo sale de la propiedad.
     ============================================================ */

  /* Hashtags institucionales (los usa también el bloque de CTA del
     orquestador: se exportan para que no haya dos textos distintos). */
  const CTA_HASHTAGS = '#bienenhaus #inmobiliariacordoba #propiedades';

  /** URL pública de la ficha (vacía si la propiedad no tiene código). */
  function fichaUrl(code) {
    const c = String(code || '').trim();
    if (!c) return '';
    return 'https://bienenhaus.com.ar/fichas/' + encodeURIComponent(c) + '.html';
  }

  /** Normaliza para comparar (minúsculas sin acentos). */
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  /** Datos cortos de la propiedad (ambientes, baños, m², zona). */
  function propertyDetails(p) {
    return [
      p.rooms ? p.rooms + ' ambientes' : (p.bedrooms ? p.bedrooms + ' dormitorios' : ''),
      p.bathrooms ? p.bathrooms + ' baño(s)' : '',
      p.surface_total ? p.surface_total + ' m²' : '',
      p.zone || '',
    ].filter(Boolean);
  }

  /**
   * Descripción base desde la ficha real (bullets que siempre son ciertos).
   */
  function descriptionFromProperty(p) {
    const dets = propertyDetails(p).slice(0, 3).join(', ');
    const ficha = fichaUrl(p.property_code);
    const fichaBlock = ficha
      ? 'Ficha completa con fotos, medidas y precio actualizado:\n' + ficha + '\n\n'
      : 'Ficha completa con fotos, medidas y precio actualizado en bienenhaus.com.ar.\n\n';
    return 'Recorremos paso a paso esta ' + (p.property_type || 'propiedad') + (dets ? ': ' + dets + '.' : '.') + '\n' +
      'En el video mostramos todos los ambientes y detalles de construcción.\n\n' +
      fichaBlock +
      'Consultas y visitas sin compromiso — respondemos por WhatsApp o desde bienenhaus.com.ar.\n\n' +
      CTA_HASHTAGS;
  }

  /**
   * Arma la metadata de publicación a partir de una propiedad del CRM.
   * @returns { title, description, tags, keyword, propertyId, privacy }
   */
  function payloadFromProperty(prop, extra) {
    const p = prop || {};
    const e = extra || {};
    const dets = propertyDetails(p);
    const title = ((p.property_type || 'Propiedad') + (dets.length ? ' en ' + dets.join(', ') : '') + ' — Tour completo 4K')
      .substring(0, 100);
    const keyword = ((p.property_type || '') + (p.zone ? ' en ' + p.zone : '')).toLowerCase().trim();
    /* Tags sugeridos, sin duplicados (comparación sin acentos). */
    const suggested = [
      p.property_type || '', p.zone || '', dets[0] || '',
      'bienenhaus', 'inmobiliaria córdoba',
    ].map(function (t) { return String(t).trim().toLowerCase(); }).filter(Boolean);
    const uniq = [];
    suggested.forEach(function (t) {
      if (uniq.every(function (u) { return norm(u) !== norm(t); })) uniq.push(t);
    });
    return {
      title: title,
      description: e.description || descriptionFromProperty(p),
      tags: uniq.join(', ').substring(0, 480),
      keyword: e.keyword || keyword,
      propertyId: p.id || '',
      privacy: 'public',
    };
  }

  NS.integrations = {
    CTA_HASHTAGS: CTA_HASHTAGS,
    indexPosts: indexPosts,
    fichaDe: fichaDe,
    linkFicha: linkFicha,
    whatsappLink: whatsappLink,
    clonePayload: clonePayload,
    payloadFromProperty: payloadFromProperty,
    descriptionFromProperty: descriptionFromProperty,
    propertyDetails: propertyDetails,
    fichaUrl: fichaUrl,
  };
})();
