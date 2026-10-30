// ============================================================
// Privacidad de los videos del canal (página pública /canal.html)
// ------------------------------------------------------------
// La página pública del canal es INDEXABLE y comparte links: sólo
// puede mostrar videos PÚBLICOS de YouTube.
//
// Un row de social_posts con status='published' NO implica que el
// video sea público: puede ser "unlisted" (oculto, sólo con link) o
// incluso privado (un video programado queda en privado hasta la fecha
// de publicación; un borrador se promueve desde el Studio).
//
// La fuente de verdad es metrics.youtube_privacy — lo escribe el
// server con el status REAL que reporta YouTube (no lo que pidió el
// dueño al publicar). Si no existe, se usa content.privacy (la
// visibilidad con la que se publicó). Si no hay ninguno de los dos,
// NO se publica (fail closed): ante la duda, no se filtra.
//
// Exporta: isPublicChannelVideo(row), splitChannelVideos(rows)
// ============================================================

/**
 * ¿Este video puede aparecer en la página pública?
 * @param {{ metrics?: object|null, content?: object|null }} row
 * @returns {boolean}
 */
export function isPublicChannelVideo(row) {
  const r = row || {};
  const metrics = r.metrics || {};
  const content = r.content || {};
  const privacy = String(metrics.youtube_privacy || content.privacy || '').toLowerCase();
  return privacy === 'public';
}

/**
 * Parte las filas en las que se pueden publicar y las excluidas.
 * @param {Array<object>} rows
 * @returns {{ visibles: Array<object>, excluidas: Array<{ id: string, privacy: string }> }}
 */
export function splitChannelVideos(rows) {
  const visibles = [];
  const excluidas = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = String((r && r.external_post_id) || '');
    if (!id) continue;
    if (isPublicChannelVideo(r)) visibles.push(r);
    else {
      const metrics = (r && r.metrics) || {};
      const content = (r && r.content) || {};
      const privacy = String(metrics.youtube_privacy || content.privacy || '').toLowerCase();
      excluidas.push({ id, privacy: privacy || 'sin_dato' });
    }
  }
  return { visibles, excluidas };
}
