/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Ficha HTML (editor y generador)
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { $, $$, on, esc, logError, logWarn, showToast, openModal, closeModal, showConfirmDialog, showInputPrompt, downloadCSV, getAuthedClient, uploadToCloudinary, loadAgentSelect, setBtnLoading, restoreBtn, navigateTo, formatPrice, updateSidebarBadges, invalidateSearchCache } = window.__BH || {};

  const FICHA_FOOTER_MESSAGES = [
    { before: '¿Querés ', highlight: 'vender', after: ' tu propiedad?' },
    { before: '¿Querés ', highlight: 'comprar', after: ' tu próxima casa?' },
    { before: '¿Buscás ', highlight: 'alquilar', after: ' rápido y sin vueltas?' },
    { before: '¿Necesitás ', highlight: 'tasar', after: ' tu propiedad?' }
  ];

  async function loadFichaHtml() {
    if (!window.supabaseClient) return;
    try {
      const [propsRes, agentsRes] = await Promise.all([
        window.supabaseClient.from('properties').select('id, title, property_code, zone, address, price_usd, rooms, area_m2, description, image_urls, agent_id').order('created_at', { ascending: false }),
        window.supabaseClient.from('agents').select('id, full_name, phone, email').eq('status', 'activo')
      ]);
      if (propsRes.error) throw propsRes.error;
      if (agentsRes.error) throw agentsRes.error;
      _fichaPropsCache = propsRes.data || [];
      _fichaAgentsCache = agentsRes.data || [];
    } catch (err) {
      logError('Ficha:', err);
      showToast('No se pudieron cargar los datos de la ficha', 'error');
    }
    startFichaFooterRotator();
  }

  function fichaFieldVal(id) {
    const el = $('#' + id);
    return el ? el.value.trim() : '';
  }

  function fichaHighlightLastWord(text) {
    const clean = String(text || '').trim() || 'Propiedad disponible';
    const parts = clean.split(/\s+/);
    if (parts.length === 1) return esc(clean);
    const last = parts.pop();
    return `${esc(parts.join(' '))} <span>${esc(last)}</span>`;
  }

  function fichaRenderPhotos() {
    const cover = $('#fichaCoverPhoto');
    const grid = $('#fichaPhotoGrid');
    if (!cover || !grid) return;
    cover.innerHTML = '';
    if (_fichaPhotos[0]) {
      const img = document.createElement('img');
      img.src = _fichaPhotos[0];
      img.alt = 'Foto principal de la propiedad';
      cover.appendChild(img);
    } else {
      cover.textContent = 'Foto principal';
    }
    grid.innerHTML = '';
    const secondary = _fichaPhotos.slice(1);
    const slots = Math.max(3, secondary.length);
    for (let i = 0; i < slots; i += 1) {
      const tile = document.createElement('div');
      tile.className = 'ficha-photo';
      if (secondary[i]) {
        const img = document.createElement('img');
        img.src = secondary[i];
        img.alt = `Foto ${i + 2} de la propiedad`;
        tile.appendChild(img);
      } else {
        tile.textContent = `Foto ${i + 2}`;
      }
      grid.appendChild(tile);
    }
  }

  function fichaUpdatePreview() {
    const titleEl = $('#fichaPreviewTitle');
    if (!titleEl) return;
    titleEl.innerHTML = fichaHighlightLastWord(fichaFieldVal('fichaTitle'));
    $('#fichaPreviewLocation').textContent = fichaFieldVal('fichaLocation') || 'A confirmar';
    $('#fichaPreviewPrice').textContent = fichaFieldVal('fichaPrice') || 'Consultar';
    $('#fichaPreviewRooms').textContent = fichaFieldVal('fichaRooms') || 'A confirmar';
    $('#fichaPreviewSurface').textContent = fichaFieldVal('fichaSurface') || 'A confirmar';
    $('#fichaPreviewDescription').textContent = fichaFieldVal('fichaDescription') || 'Sin descripción cargada.';
    $('#fichaPreviewContact').textContent = fichaFieldVal('fichaContact') || 'Contacto a confirmar';
    fichaRenderPhotos();
  }

  function fichaHideSuggestions() {
    const box = $('#fichaSuggestions');
    if (!box) return;
    box.innerHTML = '';
    box.style.display = 'none';
  }

  function fichaRenderSuggestions(rawQuery) {
    const box = $('#fichaSuggestions');
    if (!box) return;
    const q = String(rawQuery || '').toLowerCase().trim();
    if (!q) { fichaHideSuggestions(); return; }
    const matches = _fichaPropsCache.filter(p => [p.title, p.property_code, p.zone].some(f => f && String(f).toLowerCase().includes(q))).slice(0, 8);
    box.innerHTML = matches.length
      ? matches.map(p => `
        <button type="button" class="ficha-suggestion" data-prop-id="${esc(p.id)}">
          <strong>${esc(p.title || 'Sin título')}</strong>
          <small>${esc([p.property_code, p.zone].filter(Boolean).join(' · ') || 'Sin código')}</small>
        </button>`).join('')
      : '<div class="ficha-suggestion-empty">Sin resultados en el CRM</div>';
    box.style.display = 'block';
  }

  function fillFichaFromProperty(p) {
    const set = (id, val) => { const el = $('#' + id); if (el) el.value = val; };
    set('fichaTitle', p.title || '');
    set('fichaLocation', [p.zone, p.address].filter(Boolean).join(', '));
    set('fichaPrice', p.price_usd != null ? formatPrice(p.price_usd, p.price_currency) : 'Consultar');
    set('fichaRooms', p.rooms != null ? String(p.rooms) : '');
    set('fichaSurface', p.area_m2 != null ? `${p.area_m2} m²` : '');
    set('fichaDescription', p.description || '');
    const agent = _fichaAgentsCache.find(a => a.id === p.agent_id);
    set('fichaContact', agent ? [agent.full_name, agent.phone || agent.email].filter(Boolean).join(' · ') : '');
    _fichaPhotos = Array.isArray(p.image_urls) ? p.image_urls.filter(Boolean).slice() : [];
    fichaUpdatePreview();
  }

  function fichaGetShareText() {
    return [
      fichaFieldVal('fichaTitle') || 'Propiedad disponible',
      `Ubicación: ${fichaFieldVal('fichaLocation') || 'A confirmar'}`,
      `Precio: ${fichaFieldVal('fichaPrice') || 'Consultar'}`,
      `Ambientes: ${fichaFieldVal('fichaRooms') || 'A confirmar'}`,
      `Superficie: ${fichaFieldVal('fichaSurface') || 'A confirmar'}`,
      '',
      fichaFieldVal('fichaDescription') || 'Sin descripción cargada.',
      '',
      `Contacto: ${fichaFieldVal('fichaContact') || 'A confirmar'}`
    ].join('\n');
  }

  async function fichaShareText() {
    const text = fichaGetShareText();
    if (navigator.share) {
      try {
        await navigator.share({ title: fichaFieldVal('fichaTitle') || 'Propiedad Bienenhaus', text });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('Texto copiado para reenviar', 'success');
    } catch (err) {
      showToast('No se pudo copiar el texto', 'error');
    }
  }

  function fichaSlug(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'propiedad';
  }

  function fichaDownloadHtml() {
    const blob = new Blob([fichaBuildStaticHtml()], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ficha-${fichaSlug($('#fichaTitle')?.value)}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('Ficha descargada como HTML autocontenido', 'success');
  }

  function fichaBuildStaticHtml() {
    const titleRaw = ($('#fichaTitle')?.value || '').trim() || 'Propiedad disponible';
    const coverSrc = _fichaPhotos[0] || '';
    const coverHtml = coverSrc
      ? `<img src="${esc(coverSrc)}" alt="Foto principal de la propiedad">`
      : 'Foto principal';
    const gridHtml = _fichaPhotos.slice(1)
      .map((src, i) => `<div class="ficha-photo"><img src="${esc(src)}" alt="Foto ${i + 2} de la propiedad"></div>`)
      .join('');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titleRaw)} | Bienenhaus</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f4f4f2;color:#111;font-family:Arial,Helvetica,sans-serif;padding:36px 16px}
.ficha-sheet{width:min(920px,100%);margin:0 auto;background:#fff;color:#000;box-shadow:0 18px 50px rgba(0,0,0,.28)}
.ficha-sheet-hero{background:#000;color:#fff;padding:34px 38px 32px;position:relative;overflow:hidden}
.ficha-sheet-hero::before{content:"";position:absolute;left:30px;bottom:28px;width:4px;height:100px;background:#14b8a6}
.ficha-sheet-hero::after{content:"";position:absolute;right:34px;top:34px;width:250px;height:4px;background:#14b8a6}
.ficha-kicker{color:#14b8a6;font-weight:900;text-transform:uppercase;letter-spacing:1.5px;font-size:15px;margin-bottom:12px}
.ficha-sheet-title{margin:0;font-size:clamp(34px,6vw,68px);line-height:.95;text-transform:uppercase;max-width:760px;word-break:break-word}
.ficha-sheet-title span{color:#14b8a6}
.ficha-sheet-body{padding:28px 34px 34px}
.ficha-photo-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:24px}
.ficha-photo{background:#e8e8e4;aspect-ratio:4/3;min-height:120px;display:flex;align-items:center;justify-content:center;color:#555;font-weight:800;text-transform:uppercase;letter-spacing:.8px;overflow:hidden}
.ficha-cover-photo{min-height:430px;aspect-ratio:16/9;margin-bottom:24px}
.ficha-photo img{width:100%;height:100%;object-fit:cover;display:block}
.ficha-content-grid{display:grid;grid-template-columns:1fr;gap:26px;margin-top:26px}
.ficha-description h2,.ficha-data-card h2{margin:0 0 12px;font-size:18px;text-transform:uppercase;letter-spacing:1px}
.ficha-description p{margin:0;white-space:pre-wrap;line-height:1.55;color:#222}
.ficha-data-card{background:#000;color:#fff;padding:22px;border-radius:6px;display:grid;grid-template-columns:repeat(4,1fr);gap:0 18px}
.ficha-data-card h2{grid-column:1/-1}
.ficha-detail{display:grid;gap:4px;padding:11px 0;border-bottom:1px solid #282828}
.ficha-detail:last-child{border-bottom:0}
.ficha-detail strong{color:#2dd4bf;text-transform:uppercase;font-size:12px;letter-spacing:.7px}
.ficha-detail span{overflow-wrap:anywhere}
.ficha-contact-band{margin-top:26px;background:#f4f4f2;padding:22px 26px;display:grid;grid-template-columns:1fr auto;gap:20px;align-items:end}
.ficha-contact-band h2{margin:0 0 10px;text-transform:uppercase;font-size:22px}
.ficha-contact-list{display:grid;gap:7px;font-weight:800}
.ficha-short-logo{font-weight:900;letter-spacing:-2px;font-size:32px}
.ficha-footer-hero{background:#000;color:#fff;padding:40px 38px 46px;position:relative;overflow:hidden}
.ficha-footer-arrow{position:absolute;top:26px;right:34px;line-height:0}
.ficha-footer-arrow svg{width:170px;height:14px;display:block}
.ficha-footer-headline{margin:30px 0 0;font-size:clamp(26px,4.6vw,44px);line-height:1.08;text-transform:uppercase;font-weight:900;min-height:2.3em;max-width:640px;transition:opacity .35s ease}
.ficha-footer-headline.is-fading{opacity:0}
.ficha-footer-headline span{color:#14b8a6}
.ficha-footer-contact{background:#fff;color:#000;padding:34px 38px}
.ficha-footer-contact h3{margin:0 0 20px;font-size:19px;text-transform:uppercase;letter-spacing:.4px;font-weight:900}
.ficha-footer-contact-list{display:grid;gap:16px}
.ficha-footer-contact-item{display:flex;align-items:center;gap:14px;font-weight:800;font-size:16px;overflow-wrap:anywhere}
.ficha-footer-contact-item svg{flex:none;width:28px;height:28px}
.ficha-footer-brand{background:#000;color:#fff;padding:42px 38px 40px;text-align:center;position:relative;overflow:hidden}
.ficha-footer-brand-arrow{position:absolute;bottom:30px;left:38px;line-height:0}
.ficha-footer-brand-arrow svg{width:14px;height:74px;display:block}
.ficha-footer-bh{font-weight:900;letter-spacing:-3px;font-size:42px;line-height:.85}
.ficha-footer-brand-name{margin-top:12px;font-weight:900;letter-spacing:3px;text-transform:uppercase;font-size:19px}
.ficha-footer-brand-sub{margin-top:5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-size:11.5px;color:#2dd4bf}
@media(max-width:680px){body{padding:12px 8px}.ficha-sheet-hero,.ficha-sheet-body{padding-left:22px;padding-right:22px}.ficha-sheet-hero::before,.ficha-sheet-hero::after{display:none}.ficha-cover-photo{min-height:240px}.ficha-photo-grid{grid-template-columns:repeat(2,1fr)}.ficha-data-card{grid-template-columns:1fr 1fr}.ficha-contact-band{grid-template-columns:1fr}.ficha-footer-hero,.ficha-footer-contact,.ficha-footer-brand{padding-left:22px;padding-right:22px}.ficha-footer-arrow,.ficha-footer-brand-arrow{display:none}}
@media print{@page{margin:12mm}body{background:#fff;padding:0}.ficha-sheet{width:100%;box-shadow:none}.ficha-sheet-hero,.ficha-footer-hero,.ficha-footer-brand{background:#fff;color:#000}.ficha-sheet-hero::before,.ficha-sheet-hero::after{print-color-adjust:exact;-webkit-print-color-adjust:exact}.ficha-kicker,.ficha-sheet-title span,.ficha-footer-headline span,.ficha-footer-brand-sub{color:#0f766e}.ficha-detail strong{color:#0f766e}.ficha-contact-band{background:#fff;border-top:2px solid #14b8a6}.ficha-photo{border:1px solid #e5e5e2}.ficha-photo-grid{grid-template-columns:repeat(3,1fr);gap:14px}.ficha-site-footer{break-inside:avoid}.ficha-footer-hero,.ficha-footer-contact,.ficha-footer-brand{page-break-inside:avoid}}
</style>
</head>
<body>
<article class="ficha-sheet">
<section class="ficha-sheet-hero">
<div class="ficha-kicker">Bienenhaus propiedades</div>
<h1 class="ficha-sheet-title">${fichaHighlightLastWord(titleRaw)}</h1>
</section>
<section class="ficha-sheet-body">
<div class="ficha-photo ficha-cover-photo">${coverHtml}</div>
<div class="ficha-photo-grid">${gridHtml}</div>
<div class="ficha-content-grid">
<div class="ficha-description">
<h2>Descripción</h2>
<p>${esc(fichaFieldVal('fichaDescription') || 'Sin descripción cargada.')}</p>
</div>
<div class="ficha-data-card">
<h2>Detalles</h2>
<div class="ficha-detail"><strong>Ubicación</strong><span>${esc(fichaFieldVal('fichaLocation') || 'A confirmar')}</span></div>
<div class="ficha-detail"><strong>Precio</strong><span>${esc(fichaFieldVal('fichaPrice') || 'Consultar')}</span></div>
<div class="ficha-detail"><strong>Ambientes</strong><span>${esc(fichaFieldVal('fichaRooms') || 'A confirmar')}</span></div>
<div class="ficha-detail"><strong>Superficie</strong><span>${esc(fichaFieldVal('fichaSurface') || 'A confirmar')}</span></div>
</div>
</div>
<div class="ficha-contact-band">
<div>
<h2>Contacto</h2>
<div class="ficha-contact-list">${esc(fichaFieldVal('fichaContact') || 'Contacto a confirmar')}</div>
</div>
<div class="ficha-short-logo">BH</div>
</div>
</section>
<footer class="ficha-site-footer">
<section class="ficha-footer-hero">
<div class="ficha-footer-arrow" aria-hidden="true"><svg viewBox="0 0 200 16" xmlns="http://www.w3.org/2000/svg"><path d="M2 8h190" stroke="#14b8a6" stroke-width="3" stroke-linecap="round"/><path d="M15 1L2 8l13 7" stroke="#14b8a6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>
<h2 class="ficha-footer-headline" id="footerHeadline"></h2>
</section>
<section class="ficha-footer-contact">
<h3>Contáctanos y te asesoramos</h3>
<div class="ficha-footer-contact-list">
<div class="ficha-footer-contact-item"><svg viewBox="0 0 24 24" fill="#101010" xmlns="http://www.w3.org/2000/svg"><path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.23.2 2.23.2v2.45h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12Z"/></svg><span>Bienenhaus.prop</span></div>
<div class="ficha-footer-contact-item"><svg viewBox="0 0 24 24" fill="none" stroke="#101010" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.1" fill="#101010" stroke="none"/></svg><span>bienenhaus.prop</span></div>
<div class="ficha-footer-contact-item"><svg viewBox="0 0 24 24" fill="none" stroke="#101010" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3.5 6.5 12 13l8.5-6.5"/></svg><span>bienenhaus.propiedades@gmail.com</span></div>
</div>
</section>
<section class="ficha-footer-brand">
<div class="ficha-footer-brand-arrow" aria-hidden="true"><svg viewBox="0 0 16 100" xmlns="http://www.w3.org/2000/svg"><path d="M8 98V12" stroke="#14b8a6" stroke-width="3" stroke-linecap="round"/><path d="M1 25L8 12l7 13" stroke="#14b8a6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>
<div class="ficha-footer-bh">BH</div>
<div class="ficha-footer-brand-name">Bienenhaus</div>
<div class="ficha-footer-brand-sub">Propiedades &middot; CPI. 1.834</div>
</section>
</footer>
</article>
<script>
(function(){
var messages=[["¿Querés ","vender"," tu propiedad?"],["¿Querés ","comprar"," tu próxima casa?"],["¿Buscás ","alquilar"," rápido y sin vueltas?"],["¿Necesitás ","tasar"," tu propiedad?"]];
var el=document.getElementById("footerHeadline");
if(!el)return;
var i=0;
function render(){el.innerHTML=messages[i][0]+"<span>"+messages[i][1]+"</span>"+messages[i][2];}
render();
setInterval(function(){el.classList.add("is-fading");setTimeout(function(){i=(i+1)%messages.length;render();el.classList.remove("is-fading");},350);},3800);
})();
</script>
</body>
</html>`;
  }

  function startFichaFooterRotator() {
    const headline = $('#fichaFooterHeadline');
    if (!headline || _fichaFooterTimer) return;
    let index = 0;
    const render = () => {
      const m = FICHA_FOOTER_MESSAGES[index];
      headline.innerHTML = `${esc(m.before)}<span>${esc(m.highlight)}</span>${esc(m.after)}`;
    };
    render();
    _fichaFooterTimer = setInterval(() => {
      headline.classList.add('is-fading');
      setTimeout(() => {
        index = (index + 1) % FICHA_FOOTER_MESSAGES.length;
        render();
        headline.classList.remove('is-fading');
      }, 350);
    }, 3800);
  }

  on($('#fichaPropertySearch'), 'input', e => fichaRenderSuggestions(e.target.value));
  on($('#fichaPropertySearch'), 'blur', () => setTimeout(fichaHideSuggestions, 150));
  on($('#fichaSuggestions'), 'mousedown', e => {
    const btn = e.target.closest('.ficha-suggestion');
    if (!btn) return;
    e.preventDefault();
    const prop = _fichaPropsCache.find(p => p.id === btn.dataset.propId);
    if (prop) {
      fillFichaFromProperty(prop);
      const search = $('#fichaPropertySearch');
      if (search) search.value = prop.title || '';
    }
    fichaHideSuggestions();
  });

  ['fichaTitle', 'fichaLocation', 'fichaPrice', 'fichaRooms', 'fichaSurface', 'fichaDescription', 'fichaContact'].forEach(id => {
    $('#' + id)?.addEventListener('input', fichaUpdatePreview);
  });

  $('#fichaPhotos')?.addEventListener('change', e => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ url: String(reader.result), file });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }))).then(results => {
      _fichaPhotos = _fichaPhotos.concat(results.map(r => r.url));
      fichaUpdatePreview();
      renderFichaFilePreviews(results.map(r => r.url));
    }).catch(err => {
      logError('Ficha fotos:', err);
      showToast('No se pudieron cargar las fotos', 'error');
    });
  });

  const fichaFileBox = $('.ficha-file-box');
  if (fichaFileBox) {
    ['dragenter', 'dragover'].forEach(ev => {
      on(fichaFileBox, ev, e => { e.preventDefault(); e.stopPropagation(); fichaFileBox.classList.add('is-dragover'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      on(fichaFileBox, ev, e => { e.preventDefault(); e.stopPropagation(); fichaFileBox.classList.remove('is-dragover'); });
    });
    on(fichaFileBox, 'drop', e => {
      const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
      if (files.length) {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        const input = $('#fichaPhotos');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    on(fichaFileBox, 'click', e => {
      if (e.target === fichaFileBox || e.target.closest('.file-icon') || e.target.closest('.file-text') || e.target.closest('.file-sub')) {
        $('#fichaPhotos')?.click();
      }
    });
  }

  function renderFichaFilePreviews(urls) {
    const preview = $('#fichaFilePreview');
    if (!preview) return;
    preview.innerHTML = urls.map((url, i) => `
      <div class="ficha-file-preview-item" data-index="${i}">
        <img src="${url}" alt="Preview ${i + 1}" />
        <button type="button" class="remove" aria-label="Eliminar foto"><i class="fas fa-times"></i></button>
      </div>
    `).join('');
    preview.querySelectorAll('.remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.closest('.ficha-file-preview-item').dataset.index, 10);
        _fichaPhotos.splice(idx, 1);
        fichaUpdatePreview();
        renderFichaFilePreviews(_fichaPhotos);
      });
    });
  }

  $('#fichaForm')?.addEventListener('reset', () => {
    setTimeout(() => {
      _fichaPhotos = [];
      fichaUpdatePreview();
      const preview = $('#fichaFilePreview');
      if (preview) preview.innerHTML = '';
    }, 0);
  });

  $('#fichaShareBtn')?.addEventListener('click', () => { fichaShareText(); });
  $('#fichaPrintBtn')?.addEventListener('click', () => window.print());
  $('#fichaDownloadBtn')?.addEventListener('click', fichaDownloadHtml);


  window.__BH.loadFichaHtml = loadFichaHtml;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadFichaHtml')) Object.defineProperty(window, 'loadFichaHtml', { get: () => loadFichaHtml, set: (v) => { loadFichaHtml = v; }, configurable: true });
})();
