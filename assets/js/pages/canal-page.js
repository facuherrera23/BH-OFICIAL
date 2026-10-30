/* ============================================================
   Página pública del canal (/canal.html)
   ------------------------------------------------------------
   Lee assets/data/canal-videos.json (lo genera el CI con
   scripts/generate-ficha.mjs desde social_posts) y dibuja la
   grilla de videos.

   Decisiones:
   · El JSON es la fuente: si el video se borra de YouTube, el
     Studio lo pasa a 'failed' y desaparece de la página (no
     queda un embed muerto).
   · La miniatura se deriva del id de YouTube (URL canónica).
   · Sin inline scripts: la CSP de la página es script-src 'self'.
   ============================================================ */
(function () {
  'use strict';

  var DATA_URL = 'assets/data/canal-videos.json';
  var grid = document.getElementById('canalGrid');

  /* Escape de HTML. OJO: las entidades se arman con String.fromCharCode
     porque escribir '<' literal en el archivo es frágil (una pasada
     de encoding lo puede dejar en '<' y romper el escape). */
  function esc(s) {
    var AMP = String.fromCharCode(38);
    var LT = String.fromCharCode(60);
    var GT = String.fromCharCode(62);
    var QT = String.fromCharCode(34);
    var AP = String.fromCharCode(39);
    return String(s == null ? '' : s)
      .split(AMP).join(AMP + 'amp;')
      .split(LT).join(AMP + 'lt;')
      .split(GT).join(AMP + 'gt;')
      .split(QT).join(AMP + 'quot;')
      .split(AP).join(AMP + '#39;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function thumbUrl(id) {
    return 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg';
  }

  function cardHtml(v) {
    var id = String(v.id || '');
    var title = v.title || 'Video del canal';
    var url = v.url || ('https://www.youtube.com/watch?v=' + encodeURIComponent(id));
    var desc = v.description || '';
    var fecha = fmtDate(v.published_at);
    var ficha = '';
    if (v.property_code) {
      ficha = '<a class="canal-tag" href="/fichas/' + encodeURIComponent(v.property_code) + '.html">' +
        '<i class="fas fa-house"></i> ' + esc(v.property_code) + '</a>';
    }
    return '<article class="canal-card">' +
      '<a class="canal-thumb" href="' + esc(url) + '" target="_blank" rel="noopener" aria-label="' + esc(title) + '">' +
        '<img src="' + esc(thumbUrl(id)) + '" alt="" loading="lazy" width="480" height="360">' +
        '<span class="canal-play"><i class="fas fa-play"></i></span>' +
      '</a>' +
      '<div class="canal-body">' +
        '<a class="canal-title" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(title) + '</a>' +
        (desc ? '<p class="canal-desc">' + esc(desc) + '</p>' : '') +
        '<div class="canal-meta">' +
          (fecha ? '<span><i class="far fa-calendar"></i> ' + esc(fecha) + '</span>' : '') +
          ficha +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderEmpty(msg) {
    if (!grid) return;
    grid.setAttribute('aria-busy', 'false');
    grid.innerHTML = '<p class="canal-empty">' + esc(msg) + '</p>';
  }

  function render(videos) {
    if (!grid) return;
    if (!videos.length) {
      renderEmpty('Todavía no hay videos publicados. Mirá el canal en YouTube.');
      return;
    }
    grid.setAttribute('aria-busy', 'false');
    grid.innerHTML = videos.map(cardHtml).join('');
  }

  function load() {
    if (!grid) return;
    fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        render(Array.isArray(data) ? data : []);
      })
      .catch(function (err) {
        renderEmpty('No se pudieron cargar los videos del canal (' + err.message + ').');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
