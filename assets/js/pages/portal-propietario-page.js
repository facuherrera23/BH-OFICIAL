  (function() {
    'use strict';

    /* ── Helpers ── */
    var esc = (window.BHUtils && BHUtils.esc) || function(s){ return s == null ? '' : String(s); };
    var safeUrl = (window.BHUtils && BHUtils.safeUrl) || function(s){ return s || ''; };
    var safeImageUrl = (window.BHUtils && BHUtils.safeImageUrl) || function(s){ return s || ''; };

    // react-doctor-disable-next-line js-hoist-intl -- ya están hoisteados al tope del módulo (se construyen una sola vez)
    var FMT_USD = new Intl.NumberFormat('es-AR', { style:'currency', currency:'USD', maximumFractionDigits:0 });
    // react-doctor-disable-next-line js-hoist-intl -- hoisted al tope del módulo
    var FMT_NUM = new Intl.NumberFormat('es-AR');
    // react-doctor-disable-next-line js-hoist-intl -- hoisted al tope del módulo
    var FMT_DATE = new Intl.DateTimeFormat('es-AR', { day:'numeric', month:'short', year:'numeric' });
    // react-doctor-disable-next-line js-hoist-intl -- hoisted al tope del módulo
    var FMT_DATETIME = new Intl.DateTimeFormat('es-AR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    // react-doctor-disable-next-line js-hoist-intl -- hoisted al tope del módulo
    var FMT_ARS = new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });

    function fmtUSD(v) { return v != null ? FMT_USD.format(v) : '-'; }
    function fmtNum(v) { return v != null ? FMT_NUM.format(v) : '0'; }
    function fmtDate(v) { return v ? FMT_DATE.format(new Date(v)) : ''; }
    function fmtDateTime(v) { return v ? FMT_DATETIME.format(new Date(v)) : ''; }
    function fmtARS(v) { return v != null ? FMT_ARS.format(v) : ''; }
    function fmtDateTimeShort(v) {
      if (!v) return '';
      var d = new Date(v);
      return fmtDate(v) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    }
    function fmtDateShort(v) {
      if (!v) return '';
      var d = new Date(v);
      var days = ['dom','lun','mar','mié','jue','vie','sáb'];
      return days[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth()+1) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    }
    function ago(v) {
      if (!v) return '';
      var ms = Date.now() - new Date(v).getTime();
      if (ms < 0) return 'hace un momento';
      var mins = Math.floor(ms/60000);
      if (mins < 60) return mins + 'min';
      var hrs = Math.floor(mins/60);
      if (hrs < 24) return hrs + 'h';
      var ds = Math.floor(hrs/24);
      if (ds < 14) return ds + 'd';
      if (ds < 60) return Math.floor(ds/7) + ' sem';
      return Math.floor(ds/30) + (ds < 60 ? ' mes' : ' meses');
    }

    function $(id) { return document.getElementById(id); }

    /* Imágenes que fallan (404/timeout) se ocultan sin romper el layout.
       Delegado por captura para no violar la CSP (sin inline handlers). */
    document.addEventListener('error', function (ev) {
      var t = ev.target;
      if (t && t.tagName === 'IMG') t.style.display = 'none';
    }, true);

    /* ── Token ── */
    var params = new URLSearchParams(location.search);
    var token = params.get('token');

    /* Preferencias locales (favoritos, vista) — sessionStorage, no persistente */
    var PREFS_KEY = 'bh_portal_prefs';
    function prefsGet() {
      try { var raw = sessionStorage.getItem(PREFS_KEY); return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
    }
    function prefsSet(patch) {
      try { var p = prefsGet(); for (var k in patch) p[k] = patch[k]; sessionStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) {}
    }
    function toggleFav(id) {
      var p = prefsGet();
      if (!p.favs) p.favs = [];
      var i = p.favs.indexOf(id);
      if (i === -1) p.favs.push(id); else p.favs.splice(i, 1);
      prefsSet({ favs: p.favs });
      return p.favs.indexOf(id) !== -1;
    }
    function isFav(id) { var p = prefsGet(); return (p.favs || []).indexOf(id) !== -1; }

    var SESSION_KEY = 'bh_portal_token';
    function sessionGet() {
      try {
        var raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || !s.t || !s.exp || s.exp < Date.now()) { sessionStorage.removeItem(SESSION_KEY); return null; }
        return s.t;
      } catch (_) { return null; }
    }
    function sessionSave(t) {
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ t: t, exp: Date.now() + 4 * 3600 * 1000 })); } catch (_) {}
    }

    function showLogin() {
      $('loadingState').style.display = 'none';
      $('errorState').style.display = 'none';
      $('loginState').style.display = 'flex';
    }

    /* Login por token (solo si no hay token en la URL ni sesión guardada) */
    if (!token) {
      var saved = sessionGet();
      if (saved) {
        window.location.replace(location.pathname + '?token=' + encodeURIComponent(saved));
        return;
      }
      var form = $('tokenLoginForm');
      if (form) {
        form.addEventListener('submit', async function(ev) {
          ev.preventDefault();
          var input = $('tokenInput');
          var errEl = $('tokenError');
          var val = (input && input.value || '').trim();
          if (errEl) errEl.style.display = 'none';
          if (!val || val.length < 4) {
            if (errEl) { errEl.textContent = 'Ingresá tu código de acceso completo.'; errEl.style.display = 'block'; }
            if (input) input.focus();
            return;
          }
          try {
            if (!window.BH_CONFIG) throw new Error('no config');
            var sb = window.supabase.createClient(BH_CONFIG.SUPABASE_URL, BH_CONFIG.SUPABASE_ANON_KEY);
            var { data, error } = await sb.rpc('portal_validate_token', { p_token: val });
            if (error || !data) {
              if (errEl) { errEl.textContent = 'Código incorrecto o expirado. Pedí uno nuevo a tu asesor.'; errEl.style.display = 'block'; }
              return;
            }
            sessionSave(val);
            // Token válido: recargamos con él en la URL (persiste en historial/recarga)
            window.location.href = location.pathname + '?token=' + encodeURIComponent(val);
          } catch (e) {
            if (errEl) { errEl.textContent = 'Código incorrecto o expirado. Pedí uno nuevo a tu asesor.'; errEl.style.display = 'block'; }
          }
        });
      }
      showLogin();
      return;
    }

    /* ── Init Supabase ── */
    if (!window.BH_CONFIG) { showError('Error de configuración', 'No se pudo inicializar el sistema.'); return; }
    var supabase = window.supabase.createClient(BH_CONFIG.SUPABASE_URL, BH_CONFIG.SUPABASE_ANON_KEY);

    /* ── Load ── */
    loadPortal();
    /* Datos extra (próximas visitas, historial, sparklines) en paralelo; no bloquea el render */
    var EXTRA_DATA = null;
    supabase.rpc('portal_get_extra_data', { p_token: token })
      .then(function(r){ if (r && r.data) EXTRA_DATA = r.data; document.dispatchEvent(new Event('bh:portalExtra')); })
      .catch(function(){ /* opcional */ });

    /* Cuando hay https en la URL, el token queda expuesto en el historial/pestañas.
       Tras validar correctamente, reemplazamos la URL por una versión limpia
       (el token ya está en sessionStorage). */
    function cleanTokenFromUrl() {
      try {
        if (params.get('token') && history && history.replaceState) {
          var clean = location.pathname;
          history.replaceState(null, document.title, clean);
        }
      } catch (_) {}
    }

    async function loadPortal() {
      var attempts = 0;
      while (attempts < 2) {
        attempts++;
        try {
          var result = await supabase.rpc('portal_get_portal_data', { p_token: token });
          if (result.error) {
            if (attempts === 2) { showError('Error', 'No se pudieron cargar los datos. Intentá de nuevo más tarde.'); return; }
            continue;
          }
          var data = result.data;
          if (!data) { showError('Link inválido o expirado', 'El enlace que utilizaste ya no es válido o expiró. Pedí un nuevo link a tu asesor.'); return; }
          sessionSave(token);
          cleanTokenFromUrl();
          renderAll(data);
          return;
        } catch(e) {
          if (attempts === 2) showError('Error inesperado', 'Ocurrió un error al cargar el portal.');
        }
      }
    }

    /* ── Show states ── */
    function showError(title, msg) {
      $('loadingState').style.display = 'none';
      $('errorTitle').textContent = title;
      $('errorMsg').textContent = msg;
      $('errorState').style.display = '';
    }

    function showContent() {
      $('loadingState').style.display = 'none';
      $('contentState').style.display = '';
    }

    /* ── RENDER ALL ── */
    var CURRENT_DATA = null;
    function renderAll(d) {
      CURRENT_DATA = d;
      var owner = d.owner || {};
      var props = d.properties || [];

      /* Header badge */
      var name = owner.full_name || 'Propietario';
      $('userName').textContent = name;
      $('userAvatar').textContent = name.charAt(0).toUpperCase();
      $('userBadge').style.display = '';
      document.title = 'Portal — ' + name + ' | BIENENHAUS';

      /* Tab badges: ocultos si vienen en 0 */
      var pc = $('propCount');
      if (props.length > 0) { pc.textContent = props.length; pc.style.display = ''; }
      else pc.style.display = 'none';

      /* Cada panel tiene su propio try para que una falla no tumbe todo */
      try { renderInicio(d, owner, props); } catch (e) { console.error('[portal] inicio:', e); }
      try { renderPropiedades(d, props); } catch (e) { console.error('[portal] propiedades:', e); }
      try { renderExclusividad(d, owner); } catch (e) { console.error('[portal] exclusividad:', e); }
      try { renderVisitasExtras(d, owner); } catch (e) { console.error('[portal] visitas extras:', e); }
      try { renderOfflineBanner(); } catch (e) {}
      try { renderSessionChip(); } catch (e) {}
      try { renderRefreshButton(); } catch (e) {}
      try { setupPrintHeader(d); } catch (e) {}
      try { showTourIfFirst(); } catch (e) {}
      setupTabs();
      showContent();

      /* Breadcrumb en mobile */
      var bc = document.createElement('div');
      bc.className = 'portal-breadcrumb';
      bc.innerHTML = '<span>Inicio</span><i class="fas fa-chevron-right"></i><span class="current">' + esc(name) + '</span>';
      var mainEl = document.querySelector('.portal-main');
      if (mainEl) mainEl.insertBefore(bc, mainEl.firstChild);

      /* Mini-KPI sticky al scrollear */
      var leadsTotal = d.lead_total || 0;
      var visitsTotal = (d.visits && d.visits.total) || 0;
      var propsCount = props.length;
      var miniKpi = document.createElement('div');
      miniKpi.className = 'mini-kpi';
      miniKpi.innerHTML =
        '<span><span class="mk-val">' + fmtNum(propsCount) + '</span> ' + (propsCount === 1 ? 'propiedad' : 'propiedades') + '</span>' +
        '<span class="mk-sep">·</span>' +
        '<span><span class="mk-val">' + fmtNum(leadsTotal) + '</span> consultas</span>' +
        '<span class="mk-sep">·</span>' +
        '<span><span class="mk-val">' + fmtNum(visitsTotal) + '</span> visitas</span>';
      document.body.appendChild(miniKpi);
      var mkTick = false;
      window.addEventListener('scroll', function () {
        if (!mkTick) {
          mkTick = true;
          requestAnimationFrame(function () {
            miniKpi.classList.toggle('show', window.scrollY > 320);
            mkTick = false;
          });
        }
      }, { passive: true });

      /* Botón flotante de WhatsApp al asesor */
      if (d.broker && d.broker.phone) {
        var waNum = portalWaNumber(d.broker.phone);
        if (waNum && !document.getElementById('portalWaFloat')) {
          var f = document.createElement('a');
          f.id = 'portalWaFloat';
          f.className = 'portal-wa-float';
          f.href = 'https://wa.me/' + waNum + '?text=' + encodeURIComponent('Hola ' + (d.broker.full_name || '') + ', te escribo desde el portal de BIENENHAUS.');
          f.target = '_blank';
          f.rel = 'noopener';
          f.setAttribute('aria-label', 'Hablar por WhatsApp con ' + (d.broker.full_name || 'tu asesor'));
          f.innerHTML = '<i class="fab fa-whatsapp"></i>';
          document.body.appendChild(f);
        }
      }

      /* Cerrar sesión: revoca el token y limpia la sesión local */
      var logoutEl = document.getElementById('userBadge');
      if (logoutEl && !document.getElementById('portalLogoutBtn')) {
        var lo = document.createElement('button');
        lo.id = 'portalLogoutBtn';
        lo.className = 'portal-logout-btn';
        lo.type = 'button';
        lo.setAttribute('aria-label', 'Cerrar sesión');
        lo.title = 'Cerrar sesión y pedir nuevo link al asesor';
        lo.innerHTML = '<i class="fas fa-right-from-bracket"></i>';
        lo.addEventListener('click', function () {
          if (!confirm('¿Cerrar sesión? Vas a tener que pedirle un nuevo link a tu asesor si querés volver a entrar.')) return;
          try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
          try { sessionStorage.removeItem(PREFS_KEY); } catch (_) {}
          try { supabase.rpc('portal_revoke_token', { p_token: token }).catch(function(){}); } catch(_) {}
          location.href = location.pathname;
        });
        logoutEl.appendChild(lo);
      }

      /* Marca de tiempo de última actualización al pie */
      var foot = document.createElement('div');
      foot.className = 'portal-footer-meta';
      foot.textContent = 'Actualizado: ' + fmtDateTimeShort(new Date());
      var main = document.querySelector('.portal-main');
      if (main) main.appendChild(foot);

      /* Refresco del saludo si la pestaña queda abierta y cambia de día */
      var lastDay = new Date().getDate();
      var lastDataTs = Date.now();
      setInterval(function () {
        var nowD = new Date().getDate();
        if (nowD !== lastDay && lastDataTs) { lastDay = nowD; try { renderInicio(d, owner, props); } catch (e) {} }
      }, 60 * 1000);
    }

    /* Toast básico compartido para acciones (imprimir, compartir) */
    function portalToast(msg, kind) {
      var existing = document.getElementById('portalToast');
      if (existing) existing.remove();
      var t = document.createElement('div');
      t.id = 'portalToast';
      t.className = 'portal-toast ' + (kind || 'info');
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      t.innerHTML = '<i class="fas ' + (kind === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle') + '"></i> ' + esc(msg);
      document.body.appendChild(t);
      requestAnimationFrame(function(){ t.classList.add('show'); });
      setTimeout(function () { t.classList.remove('show'); setTimeout(function(){ t.remove(); }, 300); }, 2200);
    }

    /* ── OFFLINE / REFRESH / SESSION / TOUR / PRINT ── */
    function renderOfflineBanner() {
      var b = $('offlineBanner');
      if (!b) return;
      function update() { b.style.display = navigator.onLine ? 'none' : 'block'; }
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
      update();
    }

    function renderSessionChip() {
      if (document.getElementById('sessionChip')) return;
      var saved = null;
      try { var raw = sessionStorage.getItem(SESSION_KEY); if (raw) saved = JSON.parse(raw); } catch(_) {}
      if (!saved || !saved.exp) return;
      var mins = Math.max(0, Math.round((saved.exp - Date.now()) / 60000));
      var hrs = Math.floor(mins / 60);
      var rem = mins % 60;
      var txt = hrs > 0 ? hrs + 'h ' + rem + 'm' : rem + ' min';
      var chip = document.createElement('div');
      chip.id = 'sessionChip';
      chip.className = 'session-chip';
      chip.title = 'Tu sesión permanece activa por privacidad. Vence en ' + txt + '.';
      chip.innerHTML = '<i class="fas fa-shield-alt"></i> Sesión: ' + esc(txt);
      document.body.appendChild(chip);
    }

    function renderRefreshButton() {
      if (document.getElementById('headerRefreshBtn')) return;
      var badge = document.getElementById('userBadge');
      if (!badge) return;
      var btn = document.createElement('button');
      btn.id = 'headerRefreshBtn';
      btn.className = 'refresh-btn-header';
      btn.type = 'button';
      btn.style.display = 'flex';
      btn.title = 'Actualizar datos';
      btn.setAttribute('aria-label', 'Actualizar datos del portal');
      btn.innerHTML = '<i class="fas fa-sync-alt"></i>';
      btn.addEventListener('click', function () {
        btn.classList.add('spinning');
        setTimeout(function(){ btn.classList.remove('spinning'); }, 1000);
        loadPortal().then(function(){ portalToast('Datos actualizados'); });
      });
      badge.insertBefore(btn, badge.firstChild.nextSibling);
    }

    function setupPrintHeader(d) {
      var old = document.querySelector('.print-header');
      if (old) old.remove();
      var hdr = document.createElement('div');
      hdr.className = 'print-header';
      hdr.style.display = 'none';
      hdr.innerHTML =
        '<img src="assets/images/pwa-512x512.png" alt="BIENENHAUS">' +
        '<h2>Portal del Propietario</h2>' +
        '<p>Reporte para ' + esc(d.owner && d.owner.full_name || 'Propietario') + ' · ' + fmtDateTime(new Date()) + '</p>' +
        '<p style="color:#999; font-size:10px; margin-top:6px;">Documento confidencial. No compartir públicamente.</p>';
      var main = document.querySelector('.portal-main');
      if (main) main.insertBefore(hdr, main.firstChild);
      /* Solo visible en print (ver @media print). */
      var style = document.createElement('style');
      style.textContent = '@media print { .print-header { display:block !important; } }';
      document.head.appendChild(style);
    }

    function showTourIfFirst() {
      try {
        var k = 'bh_portal_tour_done';
        if (sessionStorage.getItem(k)) return;
        sessionStorage.setItem(k, '1');
        var steps = [
          { icon:'fa-home', t:'Bienvenido a tu portal', d:'Vas a ver el estado de tus propiedades, consultas y visitas en tiempo real. Todo actualizado desde tu CRM.' },
          { icon:'fa-building', t:'Mis Propiedades', d:'Cada propiedad muestra su estado, estadísticas de tráfico y próximas visitas. Tocá cada card para ver el detalle completo, incluyendo calidad de publicación y precio por m².' },
          { icon:'fa-handshake', t:'Exclusividad', d:'Si estás en gestión exclusiva ves el contrato, progreso, resultados y cuenta regresiva. Podés renovarla cuando esté por vencer.' }
        ];
        var idx = 0;
        var overlay = document.createElement('div');
        overlay.className = 'tour-overlay';
        function renderStep() {
          var s = steps[idx];
          overlay.innerHTML =
            '<div class="tour-card">' +
              '<div class="tour-step">Paso ' + (idx+1) + ' de ' + steps.length + '</div>' +
              '<i class="fas ' + s.icon + '" style="font-size:28px; color:var(--gold); margin-bottom:12px;"></i>' +
              '<h3>' + esc(s.t) + '</h3>' +
              '<p>' + esc(s.d) + '</p>' +
              '<div class="tour-btns">' +
                '<button type="button" class="tour-skip">Saltar</button>' +
                '<button type="button" class="tour-next">' + (idx === steps.length - 1 ? 'Entendido' : 'Siguiente') + '</button>' +
              '</div>' +
            '</div>';
        }
        renderStep();
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function (e) {
          if (e.target.classList.contains('tour-skip') || e.target === overlay) overlay.remove();
          if (e.target.classList.contains('tour-next')) {
            idx++;
            if (idx >= steps.length) overlay.remove(); else renderStep();
          }
        });
      } catch(_) {}
    }

    /* Countdown en vivo para la próxima visita (se re-renderiza cada minuto) */
    var visitCountdownInterval = null;
    function renderVisitCountdown(targetIso) {
      if (visitCountdownInterval) clearInterval(visitCountdownInterval);
      var slot = $('nextVisitSlot');
      if (!slot || !targetIso) return;
      function tick() {
        var el = document.querySelector('.next-visit .countdown-live');
        if (!el) { clearInterval(visitCountdownInterval); return; }
        var diff = new Date(targetIso).getTime() - Date.now();
        if (diff <= 0) { el.textContent = '¡Es ahora!'; return; }
        var d = Math.floor(diff / 86400000);
        var h = Math.floor((diff % 86400000) / 3600000);
        var m = Math.floor((diff % 3600000) / 60000);
        el.textContent = 'Faltan ' + (d > 0 ? d + 'd ' : '') + h + 'h ' + m + 'm';
      }
      visitCountdownInterval = setInterval(tick, 60000);
      tick();
    }

    /* Descarga .ics para la próxima visita */
    function downloadICS(visit) {
      if (!visit || !visit.visit_date) return;
      var d = new Date(visit.visit_date);
      var pad = function(n){ return String(n).padStart(2,'0'); };
      var icsStamp = d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00Z';
      var icsEnd = new Date(d.getTime() + 60*60000);
      var icsStampEnd = icsEnd.getUTCFullYear() + pad(icsEnd.getUTCMonth()+1) + pad(icsEnd.getUTCDate()) + 'T' + pad(icsEnd.getUTCHours()) + pad(icsEnd.getUTCMinutes()) + '00Z';
      var txt = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//BIENENHAUS//ES\r\n' +
        'BEGIN:VEVENT\r\n' +
        'UID:' + Date.now() + '@bienenhaus\r\n' +
        'DTSTAMP:' + icsStamp + '\r\n' +
        'DTSTART:' + icsStamp + '\r\n' +
        'DTEND:' + icsStampEnd + '\r\n' +
        'SUMMARY:Visita ' + (visit.property_title || '') + ' — ' + (visit.property_code || '') + '\r\n' +
        'DESCRIPTION:Visita programada en tu propiedad ' + (visit.property_code || '') + ' con ' + (visit.client_name || 'cliente') + '\r\n' +
        'LOCATION:' + (visit.property_title || '') + ', ' + (visit.property_code || '') + '\r\n' +
        'END:VEVENT\r\nEND:VCALENDAR';
      var blob = new Blob([txt], { type: 'text/calendar;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'visita-' + (visit.property_code || 'bienenshaus') + '.ics';
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ a.remove(); URL.revokeObjectURL(a.href); }, 100);
      portalToast('Evento descargado — abrilo para agendarlo');
    }

    /* Compará dos propiedades lado a lado */
    var compareSelection = [];
    function toggleCompare(propId) {
      var i = compareSelection.indexOf(propId);
      if (i !== -1) compareSelection.splice(i, 1);
      else if (compareSelection.length < 2) compareSelection.push(propId);
      else {
        compareSelection[0] = compareSelection[1];
        compareSelection[1] = propId;
      }
      updateCompareBar();
    }
    function updateCompareBar() {
      var bar = document.getElementById('compareBar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'compareBar';
        bar.className = 'compare-bar';
        document.body.appendChild(bar);
      }
      var barHtml = '<span style="font-size:13px; color:var(--text-dim);">' + compareSelection.length + '/2 seleccionadas</span>';
      if (compareSelection.length === 2) {
        barHtml += '<button type="button" class="cmp-go"><i class="fas fa-columns"></i> Comparar</button>' +
          '<button type="button" class="cmp-clear">Limpiar</button>';
      } else if (compareSelection.length === 1) {
        barHtml += '<button type="button" class="cmp-clear">Cancelar</button>';
      }
      bar.innerHTML = barHtml;
      bar.classList.toggle('show', compareSelection.length > 0);
      var goBtn = bar.querySelector('.cmp-go');
      if (goBtn) goBtn.addEventListener('click', showCompareModal);
      var clrBtn = bar.querySelector('.cmp-clear');
      if (clrBtn) clrBtn.addEventListener('click', function () {
        compareSelection = [];
        updateCompareBar();
        document.querySelectorAll('.cmp-check').forEach(function(c){ c.classList.remove('checked'); c.innerHTML = '<i class="fas fa-columns"></i>'; });
      });
    }
    function showCompareModal() {
      if (!CurrentDataProps || compareSelection.length !== 2) return;
      var a = CurrentDataProps.filter(function(p){ return p.id === compareSelection[0]; })[0];
      var b = CurrentDataProps.filter(function(p){ return p.id === compareSelection[1]; })[0];
      if (!a || !b) return;
      function cell(v) { return v == null || v === '' ? '<span style="color:var(--text-muted);">—</span>' : esc(String(v)); }
      function money(v) { return v ? fmtUSD(v) : '—'; }
      var rows = [
        { label:'Foto', a: a.image_urls && a.image_urls[0] ? '<img src="' + esc(safeImageUrl(a.image_urls[0])) + '" alt="">' : '—', b: b.image_urls && b.image_urls[0] ? '<img src="' + esc(safeImageUrl(b.image_urls[0])) + '" alt="">' : '—' },
        { label:'Título', a: a.title || '-', b: b.title || '-' },
        { label:'Código', a: a.property_code || '-', b: b.property_code || '-' },
        { label:'Zona', a: a.zone || '-', b: b.zone || '-' },
        { label:'Precio', a: money(a.price_usd), b: money(b.price_usd) },
        { label:'Ambientes', a: a.rooms, b: b.rooms },
        { label:'Dormitorios', a: a.bedrooms, b: b.bedrooms },
        { label:'Baños', a: a.bathrooms, b: b.bathrooms },
        { label:'Sup. total', a: a.area_total ? fmtNum(a.area_total) + ' m²' : null, b: b.area_total ? fmtNum(b.area_total) + ' m²' : null },
        { label:'Sup. cubierta', a: a.area_covered ? fmtNum(a.area_covered) + ' m²' : null, b: b.area_covered ? fmtNum(b.area_covered) + ' m²' : null },
        { label:'Consultas', a: fmtNum(a.leads_total || 0), b: fmtNum(b.leads_total || 0) },
        { label:'Visitas', a: fmtNum(a.visits_total || 0), b: fmtNum(b.visits_total || 0) },
        { label:'Días en mercado', a: a.created_at ? Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000) + 'd' : null, b: b.created_at ? Math.floor((Date.now() - new Date(b.created_at).getTime()) / 86400000) + 'd' : null }
      ];
      var modal = document.createElement('div');
      modal.className = 'compare-modal';
      modal.innerHTML =
        '<div class="compare-modal-inner">' +
          '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">' +
            '<h3 style="font-family:\'Playfair Display\',serif; margin:0;">Comparar propiedades</h3>' +
            '<button type="button" class="compare-close" style="background:none; border:none; color:var(--text-muted); font-size:22px; cursor:pointer;">&times;</button>' +
          '</div>' +
          '<table class="compare-table"><thead><tr><th></th><th>' + esc(a.property_code || a.title || 'A') + '</th><th>' + esc(b.property_code || b.title || 'B') + '</th></tr></thead><tbody>' +
          rows.map(function(r){ return '<tr><th scope="row">' + esc(r.label) + '</th><td>' + cell(r.a) + '</td><td>' + cell(r.b) + '</td></tr>'; }).join('') +
          '</tbody></table>' +
        '</div>';
      document.body.appendChild(modal);
      modal.querySelector('.compare-close').addEventListener('click', function(){ modal.remove(); });
      modal.addEventListener('click', function(e){ if (e.target === modal) modal.remove(); });
      document.addEventListener('keydown', function esc(e){ if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', esc); } });
      compareSelection = [];
      updateCompareBar();
      document.querySelectorAll('.cmp-check').forEach(function(c){ c.classList.remove('checked'); c.innerHTML = '<i class="fas fa-columns"></i>'; });
    }
    var CurrentDataProps = null;

    function renderVisitasExtras(d, owner) {
      if (!EXTRA_DATA || !owner) return;
      var ex = EXTRA_DATA;
      var list = [];

      /* Próximas (más de una) */
      if (ex.upcoming_visits && ex.upcoming_visits.length > 1) {
        list.push('<div class="section-title" style="margin-top:20px;"><i class="fas fa-calendar-plus"></i> Agenda de visitas (' + ex.upcoming_visits.length + ')</div>');
        list.push(ex.upcoming_visits.map(function(v) {
          var icsBtn = '<button type="button" class="v-ics-btn" data-visit-ics="' + esc(v.visit_date) + '|' + esc(v.property_code || '') + '|' + esc(v.property_title || '') + '|' + esc(v.client_name || '') + '" style="background:none; border:1px solid var(--border-accent); color:var(--gold); border-radius:8px; padding:4px 10px; font-size:11px; cursor:pointer; font-family:inherit;"><i class="fas fa-calendar-alt"></i> Agendar</button>';
          return '<div class="visit-card-next">' +
            '<div class="v-icon"><i class="fas fa-calendar-check"></i></div>' +
            '<div class="v-body">' +
              '<div style="font-weight:600;">' + esc(fmtDateShort(v.visit_date)) + ' · ' + esc(v.client_name || 'Cliente') + '</div>' +
              '<div style="font-size:12px; color:var(--text-muted);">' + esc(v.property_title || '') + ' (' + esc(v.property_code || '') + ')</div>' +
              '<div class="v-status ' + esc(v.status) + '">' + esc(v.status === 'confirmada' ? 'Confirmada' : 'Pendiente') + '</div>' +
            '</div>' + icsBtn +
          '</div>';
        }).join(''));
      }

      /* Historial */
      if (ex.visit_history && ex.visit_history.length) {
        list.push('<div class="section-title" style="margin-top:20px;"><i class="fas fa-history"></i> Historial de visitas</div>');
        list.push(ex.visit_history.map(function(v) {
          var icon = v.status === 'completada' ? 'fa-check-circle' : 'fa-times-circle';
          return '<div class="visit-card-past">' +
            '<div class="v-icon"><i class="fas ' + icon + '"></i></div>' +
            '<div class="v-body">' +
              '<div style="font-weight:600;">' + esc(fmtDate(v.visit_date)) + ' · ' + esc(v.client_name || 'Cliente') + '</div>' +
              '<div style="font-size:12px; color:var(--text-muted);">' + esc(v.property_title || '') + ' (' + esc(v.property_code || '') + ')</div>' +
              (v.notes ? '<div style="font-size:12px; margin-top:4px; font-style:italic; color:var(--text-dim);">"' + esc(v.notes) + '"</div>' : '') +
              '<div class="v-status ' + esc(v.status) + '">' + esc(v.status === 'completada' ? 'Completada' : 'Cancelada') + (v.duration_minutes ? ' · ' + v.duration_minutes + ' min' : '') + '</div>' +
            '</div>' +
          '</div>';
        }).join(''));
      }

      /* Sparklines semanales */
      var wl = (ex.weekly_leads || []);
      var wv = (ex.weekly_visits || []);
      if (wl.length || wv.length) {
        var maxL = Math.max.apply(null, wl.map(function(w){ return w.count; }).concat([1]));
        var maxV = Math.max.apply(null, wv.map(function(w){ return w.count; }).concat([1]));
        var bars = wl.map(function(w, i) {
          var h = maxL > 0 ? Math.round((w.count / maxL) * 100) : 0;
          return '<div class="w-bar' + (i === wl.length - 1 ? ' cur' : '') + '" style="height:' + h + '%" title="' + fmtNum(w.count) + ' consultas semana del ' + fmtDate(w.week) + '"></div>';
        }).join('');
        list.push('<div class="section-title" style="margin-top:20px;"><i class="fas fa-chart-column"></i> Evolución semanal</div>' +
          '<div style="background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-sm); padding:14px 16px;">' +
            '<div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">CONSULTAS POR SEMANA</div>' +
            '<div class="spark-weekly">' + bars + '</div>' +
            '<div style="font-size:10px; color:var(--text-muted); margin-top:6px;">Últimas ' + wl.length + ' semanas</div>' +
          '</div>');
      }

      var html = list.join('');
      if (html) {
        var anchor = $('nextVisitSlot');
        if (anchor) {
          var div = document.createElement('div');
          div.innerHTML = html;
          anchor.appendChild(div);
          /* Bind botón ICS */
          document.querySelectorAll('.v-ics-btn').forEach(function(b){
            b.addEventListener('click', function() {
              var parts = b.getAttribute('data-visit-ics').split('|');
              downloadICS({ visit_date: parts[0], property_code: parts[1], property_title: parts[2], client_name: parts[3] });
            });
          });
        }
      }
    }
    document.addEventListener('bh:portalExtra', function () {
      if (CURRENT_DATA) renderVisitasExtras(CURRENT_DATA, CURRENT_DATA.owner);
    });

    /* Pull-to-refresh en mobile */
    (function setupPullToRefresh() {
      var startY = 0;
      var indicator = document.createElement('div');
      indicator.className = 'pull-to-refresh';
      indicator.innerHTML = '<i class="fas fa-sync-alt"></i>';
      document.body.appendChild(indicator);
      document.addEventListener('touchstart', function (e) {
        if (window.scrollY === 0 && e.touches) startY = e.touches[0].clientY;
      }, { passive: true });
      document.addEventListener('touchmove', function (e) {
        if (window.scrollY !== 0 || !e.touches) return;
        var dy = e.touches[0].clientY - startY;
        if (dy > 90) {
          indicator.classList.add('visible', 'spinning');
        }
      }, { passive: true });
      document.addEventListener('touchend', function (e) {
        if (indicator.classList.contains('visible')) {
          indicator.classList.remove('visible');
          setTimeout(function(){ indicator.classList.remove('spinning'); }, 600);
          loadPortal().then(function(){ portalToast('Datos actualizados'); });
        }
      }, { passive: true });
      /* Auto-refresh silencioso cada 5 minutos */
      setInterval(function () {
        if (!document.hidden && navigator.onLine && CurrentDataProps) {
          loadPortal();
        }
      }, 5 * 60 * 1000);
    })();

    /* Header compacto al scrollear */
    (function setupCompactHeader() {
      var hdr = document.querySelector('.portal-header');
      if (!hdr) return;
      var tick = false;
      window.addEventListener('scroll', function () {
        if (!tick) {
          tick = true;
          requestAnimationFrame(function () {
            hdr.classList.toggle('compact', window.scrollY > 60);
            tick = false;
          });
        }
      }, { passive: true });
    })();

    /* ── TABS ── */
    function setupTabs() {
      var btns = document.querySelectorAll('.tab-btn');
      btns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          btns.forEach(function(b){ b.classList.remove('active'); });
          btn.classList.add('active');
          document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
          var panel = $('panel-' + btn.dataset.tab);
          if (panel) panel.classList.add('active');
          /* aria-current para accesibilidad */
          btns.forEach(function(b){ b.removeAttribute('aria-current'); });
          btn.setAttribute('aria-current', 'page');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          btn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        });
      });
      /* Flechas izquierda/derecha navegan tabs */
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
        var active = document.querySelector('.tab-btn.active');
        if (!active) return;
        var i = Array.prototype.indexOf.call(btns, active);
        var next = e.key === 'ArrowRight' ? btns[i + 1] : btns[i - 1];
        if (next) next.click();
      });
      /* Deep-link: si la URL trae #propiedades o #exclusividad, abrir ese tab */
      var hash = (location.hash || '').replace('#', '');
      if (hash === 'propiedades' || hash === 'exclusividad' || hash === 'inicio') {
        var target = document.querySelector('.tab-btn[data-tab="' + hash + '"]');
        if (target) target.click();
      }
    }

    /* ── INICIO ── */
    function fmtDateLong(v) {
      if (!v) return '';
      var d = new Date(v);
      var mes = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      var dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
      return dias[d.getDay()] + ', ' + d.getDate() + ' de ' + mes[d.getMonth()] + ' de ' + d.getFullYear();
    }
    function renderInicio(d, owner, props) {
      var visits = d.visits || {};
      var leadsSrc = d.leads_by_source || [];

      /* ── A1: Saludo y bienvenida personalizada ── */
      var name = owner.full_name || 'Propietario';
      var firstName = name.split(' ')[0] || name;
      var hourNow = new Date().getHours();
      var greetWord = hourNow < 12 ? 'Buen día' : (hourNow < 20 ? 'Buenas tardes' : 'Buenas noches');
      var exclNowState = exclState(owner.exclusive_start ? new Date(owner.exclusive_start) : null, owner.exclusive_end ? new Date(owner.exclusive_end) : null);
      var exclSubline = exclNowState.key === 'activa' ? '<div class="wg-excl-sub"><i class="fas fa-handshake"></i> Tu propiedad está en gestión exclusiva.</div>' : '';
      var waBroker = (d.broker && d.broker.phone && portalWaNumber(d.broker.phone)) ? 'https://wa.me/' + portalWaNumber(d.broker.phone) + '?text=' + encodeURIComponent('Hola ' + (d.broker.full_name || '') + ', te escribo desde mi portal de propietario en BIENENHAUS.') : '';

      /* ── A2: Resumen de cartera ── */
      var nVenta = props.filter(function(p){ return p.status === 'venta'; }).length;
      var nAlquiler = props.filter(function(p){ return p.status === 'alquiler'; }).length;
      var totalCarteraLeads = props.reduce(function(a,p){ return a + (p.leads_total || 0); }, 0);
      var totalCarteraVisitas = props.reduce(function(a,p){ return a + (p.visits_total || 0); }, 0);
      var totalCarteraProx = props.reduce(function(a,p){ return a + (p.visits_next || 0); }, 0);
      var leadsLast30 = d.lead_last30 != null ? d.lead_last30 : 0;
      var convPct = totalCarteraLeads > 0 ? Math.min(100, Math.round((totalCarteraVisitas / totalCarteraLeads) * 100)) : 0;
      var summaryCards = [
        { icon:'fas fa-home', label:'Propiedades', val: props.length },
        { icon:'fas fa-tag', label:'En venta', val: nVenta },
        { icon:'fas fa-key', label:'En alquiler', val: nAlquiler },
        { icon:'fas fa-users', label:'Consultas', val: totalCarteraLeads, glow: leadsLast30 > 0 },
        { icon:'fas fa-calendar-check', label:'Visitas', val: totalCarteraVisitas },
        { icon:'fas fa-arrow-right', label:'Próximas', val: totalCarteraProx }
      ];
      var topBanner = '';
      if (leadsLast30 > 0) {
        topBanner = '<div class="portal-top-banner">' +
          '<i class="fas fa-bolt"></i>' +
          '<span><strong>' + fmtNum(leadsLast30) + '</strong> ' + (leadsLast30 === 1 ? 'consulta nueva' : 'consultas nuevas') + ' en los últimos 30 días.</span>' +
        '</div>';
      }
      var convBanner = '';
      if (totalCarteraLeads > 0 && convPct > 0) {
        convBanner = '<div class="portal-conv-banner">' +
          '<i class="fas fa-chart-line"></i>' +
          '<span>De cada <strong>100 consultas</strong>, <strong>' + convPct + '</strong> terminan en visita.</span>' +
        '</div>';
      }
      $('welcomeSlot').innerHTML =
        topBanner + convBanner +
        '<div class="welcome-header">' +
          '<div class="welcome-top">' +
            '<div class="welcome-greet">' +
              '<div class="wg-avatar">' + esc(name.charAt(0).toUpperCase()) + '</div>' +
              '<div class="wg-text">' +
                '<h2>' + esc(greetWord) + ', ' + esc(firstName) + '</h2>' +
                '<div class="wg-date">' + esc(fmtDateLong(new Date())) + '</div>' +
                exclSubline +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="welcome-portfolio-summary">' +
            '<div class="prop-summary">' +
              summaryCards.map(function(c){
                return '<div class="prop-summary-item"><i class="' + c.icon + '"></i><div class="ps-num">' + fmtNum(c.val) + '</div><div class="ps-label">' + esc(c.label) + '</div></div>';
              }).join('') +
            '</div>' +
          '</div>' +
        '</div>';

      /* ── G1: Acciones rápidas ── */
      var exclStartRaw = owner.exclusive_start || null;
      var exclEndRaw = owner.exclusive_end || null;
      var exclStart = exclStartRaw ? new Date(exclStartRaw) : null;
      var exclEnd = exclEndRaw ? new Date(exclEndRaw) : null;
      var exclStateInicio = exclState(exclStart, exclEnd);
      var exclLabelInicio = exclStateLabel(exclStateInicio);
      var quickActions = [];
      if (waBroker) quickActions.push('<a class="quick-action wa" href="' + waBroker + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Contactar a mi asesor</a>');
      if (props.length > 0) {
        quickActions.push('<button type="button" class="quick-action" id="btnInicioReporte"><i class="fas fa-print"></i> Imprimir reporte</button>');
        quickActions.push('<button type="button" class="quick-action" id="btnCompartirPortal"><i class="fas fa-share-alt"></i> Compartir portal</button>');
      }
      if (exclStateInicio.key === 'por_vencer' || exclStateInicio.key === 'vencida') {
        var waRenovar = waBroker || (d.broker && d.broker.phone ? 'https://wa.me/' + portalWaNumber(d.broker.phone) : '');
        quickActions.push('<a class="quick-action primary" href="' + (waRenovar || '#exclusividad') + '"' + (waRenovar ? ' target="_blank" rel="noopener"' : ' data-go-tab="exclusividad"') + '><i class="fas fa-handshake"></i> ' + (exclStateInicio.key === 'por_vencer' ? 'Renovar exclusividad' : 'Reactivar exclusividad') + '</a>');
      }
      $('quickActionsSlot').innerHTML = quickActions.length
        ? '<div class="quick-actions">' + quickActions.join('') + '</div>'
        : '';

      /* ── B1: Próxima visita (siempre visible) ── */
      if (d.next_visit) {
        var nv = d.next_visit;
        var nvWho = nv.client_name ? esc(nv.client_name) + ' &middot; ' : '';
        var nvProp = (nv.property_code || nv.property_title)
          ? esc(nv.property_code || '') + (nv.property_code && nv.property_title ? ' ' : '') + esc(nv.property_title || '')
          : '';
        $('nextVisitSlot').innerHTML =
          '<div class="next-visit">' +
            '<div class="next-visit-icon"><i class="fas fa-calendar-check"></i></div>' +
            '<div class="next-visit-info" style="flex:1;">' +
              '<h3>Próxima visita programada</h3>' +
              '<p>' +
                '<span class="date">' + fmtDateShort(nv.visit_date) + '</span>' +
                (nvWho ? ' &middot; ' + nvWho : '') +
                (nvProp ? ' ' + nvProp : '') +
              '</p>' +
              '<span class="countdown-live"></span>' +
            '</div>' +
            '<div style="display:flex; flex-direction:column; gap:6px;">' +
              '<button type="button" class="v-ics-btn" data-visit-ics="' + esc(nv.visit_date) + '|' + esc(nv.property_code || '') + '|' + esc(nv.property_title || '') + '|' + esc(nv.client_name || '') + '" style="background:none; border:1px solid var(--border-accent); color:var(--gold); border-radius:8px; padding:6px 12px; font-size:11px; cursor:pointer; font-family:inherit; white-space:nowrap;"><i class="fas fa-calendar-alt"></i> Agendar</button>' +
            '</div>' +
          '</div>';
        /* Countdown en vivo cada minuto */
        renderVisitCountdown(nv.visit_date);
        /* Bind ICS */
        var icsSelf = document.querySelector('.next-visit .v-ics-btn');
        if (icsSelf) icsSelf.addEventListener('click', function() {
          var parts = icsSelf.getAttribute('data-visit-ics').split('|');
          downloadICS({ visit_date: parts[0], property_code: parts[1], property_title: parts[2], client_name: parts[3] });
        });
      } else {
        var waNext = (d.broker && d.broker.phone && portalWaNumber(d.broker.phone)) ? 'https://wa.me/' + portalWaNumber(d.broker.phone) + '?text=' + encodeURIComponent('Hola ' + (d.broker.full_name || '') + ', ¿cuándo agendamos la próxima visita?') : '';
        $('nextVisitSlot').innerHTML =
          '<div class="inicio-empty">' +
            '<i class="fas fa-calendar-check"></i>' +
            '<span>No tenés visitas programadas por ahora.' +
            (waNext ? ' <a href="' + waNext + '" target="_blank" rel="noopener" style="color:var(--green);font-weight:600;text-decoration:none;">Coordiná una por WhatsApp</a>' : ' Cuando agendes una, la vas a ver acá.') +
            '</span>' +
          '</div>';
      }

      /* ── C1: Broker / asesor asignado ── */
      if (d.broker) {
        var b = d.broker;
        var roleLabel = (b.role && b.role !== 'agente') ? 'Tu broker asignado' : 'Tu asesor asignado';
        var photoHtml = b.photo_url
          ? '<img class="broker-photo" src="' + esc(safeImageUrl(b.photo_url)) + '" alt="' + esc(b.full_name) + '">'
          : '<div class="broker-photo-placeholder">' + esc((b.full_name || '?').charAt(0)) + '</div>';
        var actionsHtml = '<div class="broker-actions">';
        var bWa = b.phone && portalWaNumber(b.phone);
        if (bWa) actionsHtml += '<a href="https://wa.me/' + esc(bWa) + '" target="_blank" rel="noopener" title="WhatsApp" style="background:var(--green-dim);color:var(--green);border-color:rgba(52,211,153,0.2);"><i class="fab fa-whatsapp"></i></a>';
        if (b.phone) actionsHtml += '<a href="tel:' + esc(b.phone) + '" title="Llamar"><i class="fas fa-phone"></i></a>';
        if (b.email) actionsHtml += '<a href="mailto:' + esc(b.email) + '" title="Email"><i class="fas fa-envelope"></i></a>';
        actionsHtml += '</div>';
        var reportHref = '';
        if (bWa) {
          reportHref = 'https://wa.me/' + bWa + '?text=' + encodeURIComponent('Hola ' + (b.full_name || '') + ', tengo una consulta sobre el portal: ' + location.href);
        }
        $('brokerSlot').innerHTML =
          '<div class="broker-card">' +
            photoHtml +
            '<div class="broker-info">' +
              '<div class="broker-role">' + esc(roleLabel) + '</div>' +
              '<h4>' + esc(b.full_name) + '</h4>' +
              '<p class="broker-contact">' + esc(b.email || '') + (b.phone ? ' · ' + esc(b.phone) : '') + '</p>' +
              (reportHref ? '<a href="' + reportHref + '" target="_blank" rel="noopener" class="broker-report-link">Reportar un problema con el portal</a>' : '') +
            '</div>' +
            actionsHtml +
          '</div>';
      }

      /* ── D2: Card de exclusividad en inicio ── */
      var exclInicioHtml = '';
      if (exclStateInicio.key === 'activa' || exclStateInicio.key === 'por_vencer' || exclStateInicio.key === 'vencida') {
        var eiIcon = exclStateInicio.key === 'vencida' ? 'fa-times-circle' : 'fa-handshake';
        var eiTitle = 'Tu exclusividad está ' + (exclStateInicio.key === 'activa' ? 'activa' : (exclStateInicio.key === 'por_vencer' ? 'por vencer' : 'vencida'));
        var eiText = '';
        if (exclEnd) {
          var eiDias = Math.max(0, Math.ceil((exclEnd - new Date()) / (24*60*60*1000)));
          if (exclStateInicio.key === 'activa') eiText = 'Vigente hasta el ' + fmtDate(exclEnd) + (eiDias <= 30 ? ' (' + eiDias + ' días restantes).' : '.');
          else if (exclStateInicio.key === 'por_vencer') eiText = 'Vence el ' + fmtDate(exclEnd) + ' (' + eiDias + ' días restantes). Contactá a tu asesor para renovarla.';
          else eiText = 'Vencieron el ' + fmtDate(exclEnd) + '. Renová para mantener el trato preferencial.';
        }
        var eiCtaHref = exclStateInicio.key === 'sin' ? (waBroker || '#') : '#exclusividad';
        var eiCtaTarget = exclStateInicio.key === 'sin' && waBroker ? ' target="_blank" rel="noopener"' : '';
        var eiCtaText = exclStateInicio.key === 'vencida' ? 'Reactivar exclusividad' : (exclStateInicio.key === 'por_vencer' ? 'Renovar ahora' : 'Ver detalles');
        exclInicioHtml =
          '<div class="excl-inicio-card ' + esc(exclStateInicio.key) + '">' +
            '<div class="ei-icon"><i class="fas ' + eiIcon + '"></i></div>' +
            '<div class="ei-body">' +
              '<h4>' + esc(eiTitle) + ' <span class="excl-state-badge ' + esc(exclLabelInicio.cls) + '">' + esc(exclLabelInicio.text) + '</span></h4>' +
              '<p>' + esc(eiText) + '</p>' +
            '</div>' +
            (exclStateInicio.key !== 'sin'
              ? '<a class="ei-cta" href="' + esc(eiCtaHref) + '"' + eiCtaTarget + ' data-go-tab="exclusividad">' + esc(eiCtaText) + '</a>'
              : '') +
          '</div>';
      }
      $('exclInicioSlot').innerHTML = exclInicioHtml;

      /* ── D1: Resumen general (stats optimizado) ── */
      var nPropsActivas = props.filter(function(p){ return p.is_published === true || p.status === 'venta' || p.status === 'alquiler'; }).length;
      var stats = [
        { icon:'fas fa-building', label:'Propiedades activas', value:fmtNum(nPropsActivas), sub: props.length ? (fmtNum(props.length) + ' en total') : '', cls:'', go:'propiedades' },
        { icon:'fas fa-tag', label:'En venta', value:fmtNum(nVenta), sub: nVenta ? 'en cartera' : '', cls:'', go:'propiedades' },
        { icon:'fas fa-key', label:'En alquiler', value:fmtNum(nAlquiler), sub: nAlquiler ? 'en cartera' : '', cls:'', go:'propiedades' },
        { icon:'fas fa-users', label:'Consultas totales', value:fmtNum(d.lead_total), sub: (d.lead_last30 != null && d.lead_last30 > 0) ? (fmtNum(d.lead_last30) + ' en 30 días') : '', cls:'', go:'propiedades' },
        { icon:'fas fa-calendar', label:'Visitas realizadas', value:fmtNum(visits.completadas || 0), sub: fmtNum(visits.total || 0) + ' totales', cls:'green', go:'propiedades' },
        { icon:'fas fa-calendar-plus', label:'Próximas visitas', value:fmtNum(visits.proximas || 0), sub: (visits.confirmadas || 0) > 0 ? ('+' + fmtNum(visits.confirmadas) + ' confirmadas') : '', cls:'blue', go:'propiedades' }
      ];
      /* Añadir cards no-nulas solo para enriquecer sin ruido */
      if ((visits.pendientes || 0) > 0) {
        stats.push({ icon:'fas fa-hourglass-half', label:'Visitas pendientes', value:fmtNum(visits.pendientes), sub:'', cls:'' });
      }
      if ((visits.canceladas || 0) > 0) {
        stats.push({ icon:'fas fa-times-circle', label:'Visitas canceladas', value:fmtNum(visits.canceladas), sub:'', cls:'gold' });
      }
      stats.push({ icon:'fas fa-dollar-sign', label:'Cotización USD', value: (d.usd_rate && d.usd_rate > 0) ? esc(fmtARS(d.usd_rate)) : null, sub: (d.usd_rate && d.usd_rate > 0) ? 'referencia' : null, cls:'gold' });
      var cardHtml = stats.filter(function(s){ return s.value !== null && s.value !== undefined; }).map(function(s) {
        return '<div class="stat-card' + (s.go ? ' stat-card--link' : '') + '"' + (s.go ? ' data-go-tab="' + s.go + '" role="button" tabindex="0" title="Ver detalle"' : '') + '>' +
          '<div class="label"><i class="' + esc(s.icon) + '"></i> ' + esc(s.label) + '</div>' +
          '<div class="value ' + esc(s.cls || '') + '">' + esc(s.value) + '</div>' +
          (s.sub ? '<div class="sub">' + esc(s.sub) + '</div>' : '') +
        '</div>';
      }).join('');
      $('statGrid').innerHTML = cardHtml;

      /* Stats que navegan al detalle */
      document.querySelectorAll('.stat-card--link').forEach(function(card){
        card.addEventListener('click', function(){
          var t = card.getAttribute('data-go-tab');
          var btn = document.querySelector('.tab-btn[data-tab="' + t + '"]');
          if (btn) btn.click();
        });
        card.addEventListener('keydown', function(ev){
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); card.click(); }
        });
      });

      /* ── E1/E2: Origen de consultas (siempre visible) ── */
      var sourceNames = { landing_page:'Landing', ml:'Mercado Libre', whatsapp:'WhatsApp', portal:'Portal', facebook:'Facebook', instagram:'Instagram', telefono:'Teléfono', email:'Email', walk_in:'Visita directa', zernio:'Chat', gvamax:'GvaMax', otro:'Otro' };
      var srcHtml = '<div class="section-title"><i class="fas fa-funnel-dollar"></i> Origen de consultas</div>';
      if (leadsSrc.length === 0) {
        srcHtml += '<div class="inicio-empty"><i class="fas fa-funnel-dollar"></i><span>Todavía no tenés consultas registradas. Cuando lleguen, vas a ver acá de qué canales provienen.</span></div>';
      } else {
        var sorted = leadsSrc.slice().sort(function(a,b){ return (b.count || 0) - (a.count || 0); });
        var maxCount = Math.max.apply(null, sorted.map(function(s){ return s.count; }));
        srcHtml += '<div class="stat-card" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;">' +
          '<div class="source-bars">' +
            sorted.map(function(s) {
              var pct = maxCount > 0 ? Math.round((s.count / maxCount) * 100) : 0;
              var label = sourceNames[s.source] || s.source;
              return '<div class="source-bar" title="' + esc(label) + ': ' + fmtNum(s.count) + ' consultas">' +
                '<span class="source-name">' + esc(label) + '</span>' +
                '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
                '<span class="bar-count">' + fmtNum(s.count) + '</span>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>';
      }
      $('sourcesSlot').innerHTML = srcHtml;

      /* ── F1: Novedades recientes ── */
      var act = d.activity || [];
      var todayIso = new Date().toISOString().slice(0, 10);
      /* Filtro por tipo + ver todas */
      var actFilterKey = 'all';
      var actShowAll = false;
      var actList = act;
      var ACT_FILTERS = [
        { k:'all', l:'Todas', i:'fa-list' },
        { k:'consulta', l:'Consultas', i:'fa-envelope' },
        { k:'visita_agendada', l:'Agendadas', i:'fa-calendar-plus' },
        { k:'visita_completada', l:'Completadas', i:'fa-check-circle' },
        { k:'publicacion', l:'Publicaciones', i:'fa-bullhorn' }
      ];
      var actFilterHtml = '';
      if (act.length > 0) {
        actFilterHtml = '<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;" role="group" aria-label="Filtrar novedades">' +
          ACT_FILTERS.map(function(f){
            return '<button type="button" class="act-filter-pill' + (f.k === actFilterKey ? ' active' : '') + '" data-act-filter="' + f.k + '" aria-pressed="' + (f.k === actFilterKey) + '"><i class="fas ' + f.i + '"></i> ' + esc(f.l) + '</button>';
          }).join('') +
        '</div>';
      }
      function renderActivityList() {
        actList = actFilterKey === 'all' ? act : act.filter(function(a){ return a.type === actFilterKey; });
        var visible = actShowAll ? actList : actList.slice(0, 5);
        var wasNew = prefsGet().read_act || [];
        var html = '';
        if (actList.length === 0) {
          html = '<li class="activity-item activity-item--empty"><i class="fas fa-clock"></i><span>Sin novedades en este filtro.</span></li>';
        } else {
          html = visible.map(function(a) {
            var isToday = a.at && a.at.slice(0, 10) === todayIso;
            var isUnread = wasNew.indexOf(a.type + '|' + a.at) === -1;
            return '<li class="activity-item' + (isToday ? ' is-new' : '') + (isUnread ? ' is-new' : '') + '" data-act-key="' + esc(a.type + '|' + a.at) + '">' +
              '<div class="activity-dot ' + esc(a.type) + (isToday ? ' pulse' : '') + '"></div>' +
              '<span class="activity-text">' + esc(a.text) + '</span>' +
              '<span class="activity-time">' + ago(a.at) + '</span>' +
            '</li>';
          }).join('');
        }
        /* Marcar como leídas al ver */
        if (actList.length > 0) {
          setTimeout(function(){
            var readNow = actList.map(function(a){ return a.type + '|' + a.at; });
            prefsSet({ read_act: wasNew.concat(readNow.filter(function(k){ return wasNew.indexOf(k) === -1; })) });
          }, 3000);
        }
        return html;
      }
      $('activityList').innerHTML = actFilterHtml + '<ul class="activity-list" style="list-style:none; margin:0; padding:0;" role="list" aria-label="Novedades">' + renderActivityList() + '</ul>' +
        (act.length > 5 ? '<button type="button" class="act-show-all-btn" data-act-show="' + (actShowAll ? '1' : '0') + '">' + (actShowAll ? 'Mostrar menos' : 'Ver las ' + act.length + ' novedades') + '</button>' : '');
      /* Binds del filtro */
      document.querySelectorAll('[data-act-filter]').forEach(function(b){
        b.addEventListener('click', function(){
          actFilterKey = b.dataset.actFilter;
          document.querySelectorAll('[data-act-filter]').forEach(function(x){ x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
          b.classList.add('active'); b.setAttribute('aria-pressed', 'true');
          document.querySelector('#activityList ul').innerHTML = renderActivityList();
        });
      });
      var showAllBtn = document.querySelector('.act-show-all-btn');
      if (showAllBtn) showAllBtn.addEventListener('click', function(){
        actShowAll = !actShowAll;
        showAllBtn.textContent = actShowAll ? 'Mostrar menos' : 'Ver las ' + act.length + ' novedades';
        document.querySelector('#activityList ul').innerHTML = renderActivityList();
        showAllBtn.dataset.actShow = actShowAll ? '1' : '0';
      });

      /* Digest semanal si hay datos extra */
      var digestHtml = '';
      try {
        var weekly = EXTRA_DATA && EXTRA_DATA.weekly_leads || [];
        if (weekly.length) {
          var weekNow = weekly[weekly.length - 1];
          var weekPrev = weekly.length > 1 ? weekly[weekly.length - 2] : null;
          if (weekNow && weekNow.count > 0) {
            digestHtml = '<div class="digest-banner"><i class="fas fa-chart-line"></i> Esta semana: <strong>' + fmtNum(weekNow.count) + ' consultas</strong>' + (weekPrev ? ' (la anterior tuvo ' + fmtNum(weekPrev.count) + ')' : '') + '.</div>';
            var wv = EXTRA_DATA.weekly_visits || [];
            var wvNow = wv[wv.length - 1];
            if (wvNow && wvNow.count > 0) digestHtml = digestHtml.replace('</div>', ' con ' + fmtNum(wvNow.count) + ' visitas.</div>');
          }
        }
      } catch(_){}
      var welcomeEl = $('welcomeSlot');
      if (welcomeEl && digestHtml) {
        var wEl = document.createElement('div');
        wEl.innerHTML = digestHtml;
        welcomeEl.appendChild(wEl.firstChild);
      }

      /* Glow si hay actividad de consulta hoy */
      var hasTodayConsulta = act.some(function(a){ return a.type === 'consulta' && a.at && a.at.slice(0,10) === todayIso; });
      if (hasTodayConsulta) {
        var propCards = document.querySelectorAll('.prop-card');
        propCards.forEach(function(c){ c.classList.add('glow-new'); });
      }

      /* Bind de links que navegan a tabs */
      document.querySelectorAll('[data-go-tab]').forEach(function(el) {
        el.addEventListener('click', function(ev) {
          ev.preventDefault();
          var t = el.getAttribute('data-go-tab');
          var btn = document.querySelector('.tab-btn[data-tab="' + t + '"]');
          if (btn) btn.click();
        });
      });

      /* Botón imprimir reporte */
      var btnRep = $('btnInicioReporte');
      if (btnRep) btnRep.addEventListener('click', function () { window.print(); portalToast('Preparando impresión…'); });

      /* Compartir: usa Web Share API si existe, sino copia el link */
      var btnShare = $('btnCompartirPortal');
      if (btnShare) btnShare.addEventListener('click', function () {
        var shareData = { title: document.title, text: 'Mirá el seguimiento de mi propiedad en BIENENHAUS', url: location.href };
        if (navigator.share) {
          navigator.share(shareData).then(function(){ portalToast('Compartido'); }, function () { });
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(location.href).then(function () { portalToast('Link copiado al portapapeles'); }, function () { portalToast('No se pudo copiar', 'error'); });
        }
      });

      /* Botón volver arriba */
      var scrollBtn = document.createElement('button');
      scrollBtn.id = 'scrollTopBtn';
      scrollBtn.className = 'scroll-top-btn';
      scrollBtn.setAttribute('aria-label', 'Volver arriba');
      scrollBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
      scrollBtn.style.display = 'none';
      document.body.appendChild(scrollBtn);
      scrollBtn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
      var scrollTick = false;
      window.addEventListener('scroll', function () {
        if (!scrollTick) {
          scrollTick = true;
          requestAnimationFrame(function () {
            scrollBtn.style.display = (window.scrollY > 500) ? 'flex' : 'none';
            scrollTick = false;
          });
        }
      }, { passive: true });
    }

    /* ── PROPIEDADES ── */
    var PTYPE_LABEL = {
      casa:'Casa', departamento:'Departamento', ph:'PH', terreno:'Terreno', lote:'Lote',
      local_comercial:'Local comercial', oficina:'Oficina', cochera:'Cochera', campo:'Campo'
    };
    var STATUS_LABEL = {
      venta:'En venta', alquiler:'En alquiler', vendida:'Vendida', alquilada:'Alquilada',
      pausada:'Pausada', draft:'Borrador'
    };
    function ptypeLabel(t) { return PTYPE_LABEL[t] || (t ? String(t).replace(/_/g,' ') : 'Propiedad'); }
    function statusBadge(p) {
      var sold = p.status === 'vendida' || p.status === 'alquilada';
      var cls = sold ? 'sold' : (p.is_published === true ? 'live' : 'draft');
      var op = STATUS_LABEL[p.status] || p.status || (p.is_published ? 'Activa' : 'Inactiva');
      /* 'Vendida' / 'Alquilada' van solas; solo venta/alquiler/draft combinan estado+publicación */
      var pub = sold ? '' : (p.is_published === true ? 'Publicada' : (p.status === 'draft' ? 'Borrador' : 'No publicada'));
      var txt = pub ? (op + ' · ' + pub) : op;
      return '<span class="prop-status-badge ' + cls + '"><i class="fas ' + (sold ? 'fa-check-circle' : (p.is_published ? 'fa-circle' : 'fa-pen')) + '"></i> ' + esc(txt) + '</span>';
    }
    function portalWaNumber(phone) {
      var d = String(phone || '').replace(/\D/g, '');
      if (!d) return null;
      if (d.indexOf('00') === 0) d = d.slice(2);
      if (d.indexOf('549') === 0) d = d.slice(3);
      else if (d.indexOf('54') === 0) d = d.slice(2);
      if (d.indexOf('0') === 0) d = d.slice(1);
      if (d.indexOf('9') === 0 && d.length > 9) d = '351' + d.slice(1);
      if (d.indexOf('15') === 0) d = d.slice(2);
      return d.length >= 8 && d.length <= 13 ? ('549' + d) : null;
    }
    function ownerContactWa(owner) {
      var n = portalWaNumber(owner && owner.phone);
      return n ? 'https://wa.me/' + n + '?text=' + encodeURIComponent('Hola, me comunico desde el portal de propietario de BIENENHAUS.') : '';
    }

    function renderPropiedades(d, props) {
      var owner = d.owner || {};
      var usdRate = d.usd_rate || 0;
      CurrentDataProps = props;
      compareSelection = [];
      updateCompareBar();

      if (props.length === 0) {
        var waEmpty = ownerContactWa(owner);
        $('propList').innerHTML =
          '<div class="empty-msg">' +
            '<i class="fas fa-home"></i>' +
            '<h3>Sin propiedades</h3>' +
            '<p>No tenés propiedades vinculadas a tu cuenta todavía.</p>' +
          '</div>' +
          '<div class="section-title" style="margin-top:24px;"><i class="fas fa-bullhorn"></i> ¿Querés publicar tu propiedad?</div>' +
          '<div class="excl-benefits" style="margin-top:16px;">' +
            '<div class="excl-benefit"><i class="fas fa-camera"></i><div><h4>Fotos profesionales</h4><p>Tu propiedad luce mejor con buenas imágenes.</p></div></div>' +
            '<div class="excl-benefit"><i class="fas fa-bullhorn"></i><div><h4>Difusión amplia</h4><p>Publicación en nuestro sitio y portales.</p></div></div>' +
            '<div class="excl-benefit"><i class="fas fa-handshake"></i><div><h4>Asesor dedicado</h4><p>Un broker gestiona tu venta o alquiler.</p></div></div>' +
          '</div>' +
          (waEmpty ? '<a class="whatsapp-cta" href="' + waEmpty + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Consultar por publicación</a>' : '');
        return;
      }

      /* ── Barra de resumen del portfolio ── */
      var nVenta = props.filter(function(p){ return p.status === 'venta'; }).length;
      var nAlquiler = props.filter(function(p){ return p.status === 'alquiler'; }).length;
      var nML = props.filter(function(p){ return p.ml_item_id; }).length;
      var totalLeads = props.reduce(function(a,p){ return a + (p.leads_total || 0); }, 0);
      var totalVisitas = props.reduce(function(a,p){ return a + (p.visits_total || 0); }, 0);
      var proxVisitas = props.reduce(function(a,p){ return a + (p.visits_next || 0); }, 0);
      var summaryCards = [
        { icon:'fas fa-home', label:'Propiedades', val: props.length },
        { icon:'fas fa-tag', label:'En venta', val: nVenta },
        { icon:'fas fa-key', label:'En alquiler', val: nAlquiler },
        { icon:'fab fa-envira', label:'En Mercado Libre', val: nML },
        { icon:'fas fa-users', label:'Consultas', val: totalLeads },
        { icon:'fas fa-calendar-check', label:'Visitas', val: totalVisitas },
        { icon:'fas fa-arrow-right', label:'Próximas', val: proxVisitas }
      ];
      var summaryHtml = '<div class="prop-summary">' +
        summaryCards.map(function(c){
          return '<div class="prop-summary-item"><i class="' + c.icon + '"></i><div class="ps-num">' + fmtNum(c.val) + '</div><div class="ps-label">' + esc(c.label) + '</div></div>';
        }).join('') +
      '</div>';

      /* ── Filtros por estado ── */
      var filters = [
        { key:'all', label:'Todas', icon:'fas fa-th-large', tip:'Todas las propiedades' },
        { key:'venta', label:'En venta', icon:'fas fa-tag', tip:'Solo propiedades en venta' },
        { key:'alquiler', label:'En alquiler', icon:'fas fa-key', tip:'Solo propiedades en alquiler' },
        { key:'vendidas', label:'Vendidas', icon:'fas fa-check-circle', tip:'Solo vendidas/alquiladas' },
        { key:'ml', label:'Mercado Libre', icon:'fas fa-check-circle', tip:'Publicadas en Mercado Libre' },
        { key:'fav', label:'Favoritas', icon:'fas fa-heart', tip:'Tus propiedades favoritas' }
      ];
      var activeFilter = 'all';
      var activeSort = 'reciente';
      var activeQuery = '';
      var listView = (prefsGet().view === 'list') ? 'list' : 'grid';
      function matchFilter(p, f) {
        switch (f) {
          case 'venta': return p.status === 'venta';
          case 'alquiler': return p.status === 'alquiler';
          case 'vendidas': return (p.status === 'vendida' || p.status === 'alquilada');
          case 'ml': return !!p.ml_item_id;
          case 'fav': return isFav(p.id);
          default: return true;
        }
      }
      function matchQuery(p, q) {
        if (!q) return true;
        q = q.toLowerCase();
        var text = [p.title, p.property_code, p.zone, p.address, p.description].filter(Boolean).join(' ').toLowerCase();
        return text.indexOf(q) !== -1;
      }
      function matchSort(a, b) {
        switch (activeSort) {
          case 'consultas': return (b.leads_total || 0) - (a.leads_total || 0);
          case 'visitas': return (b.visits_total || 0) - (a.visits_total || 0);
          case 'recientes':
          default: return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        }
      }
      function tempBadge(p) {
        if (!p.last_lead_at) return null;
        var days = (Date.now() - new Date(p.last_lead_at).getTime()) / (24*60*60*1000);
        if (days <= 7) return { txt:'Caliente', cls:'hot', tip:'Consulta en los últimos 7 días' };
        if (days <= 30) return { txt:'Tibia', cls:'warm', tip:'Consulta hace ' + Math.floor(days) + ' días' };
        return { txt:'Fría', cls:'cold', tip:'Sin consultas hace ' + Math.floor(days) + ' días' };
      }
      function completeness(p) {
        var parts = 0;
        if (p.image_urls && p.image_urls.length >= 6) parts += 40; else if (p.image_urls && p.image_urls.length > 0) parts += 25;
        if (p.description && String(p.description).length > 100) parts += 20;
        if (p.video_url) parts += 20;
        if (p.price_usd != null && p.price_usd > 0) parts += 20;
        return Math.min(100, parts);
      }
      function daysOnMarket(p) {
        if (!p.created_at) return null;
        return Math.floor((Date.now() - new Date(p.created_at).getTime()) / (24*60*60*1000));
      }
      function pricePerM2(p) {
        var area = p.area_covered || p.area_total || p.area_m2;
        var price = (p.price_usd != null && p.price_usd > 0) ? p.price_usd : null;
        if (!area || !price || area <= 0) return null;
        return Math.round(price / area);
      }
      var sortHtml = '<div class="prop-sort">' +
        '<span class="prop-sort-label">Ordenar:</span>' +
        '<button class="prop-sort-pill' + (activeSort === 'reciente' ? ' active' : '') + '" data-sort="reciente">Más recientes</button>' +
        '<button class="prop-sort-pill' + (activeSort === 'consultas' ? ' active' : '') + '" data-sort="consultas">Más consultas</button>' +
        '<button class="prop-sort-pill' + (activeSort === 'visitas' ? ' active' : '') + '" data-sort="visitas">Más visitas</button>' +
      '</div>';
      var filtersHtml = '<div class="prop-filters" id="propFilters">' +
        filters.map(function(f){
          return '<button class="prop-filter' + (f.key === activeFilter ? ' active' : '') + '" data-filter="' + f.key + '" title="' + esc(f.tip || '') + '" aria-label="' + esc(f.label) + '"><i class="' + f.icon + '"></i> ' + esc(f.label) + '</button>';
        }).join('') +
      '</div>';
      var searchHtml = '<div class="prop-search">' +
        '<i class="fas fa-search"></i>' +
        '<input id="propSearchInput" type="text" placeholder="Buscar por título, zona, código…" value="' + esc(activeQuery) + '" aria-label="Buscar propiedad">' +
        '<button id="propViewToggle" class="prop-view-toggle" title="Cambiar vista" aria-label="Cambiar vista">' +
          '<i class="fas ' + (listView === 'list' ? 'fa-th-large' : 'fa-list') + '"></i>' +
        '</button>' +
      '</div>';

      function renderList(list) {
        $('propList').innerHTML = summaryHtml + filtersHtml + list.map(propCardHtml).join('');
        bindPropEvents(list);
      }

      /* ── Card HTML ── */
      function propCardHtml(p) {
        var img = (p.image_urls && p.image_urls.length > 0) ? p.image_urls[0] : '';
        var imgCount = (p.image_urls && p.image_urls.length) || 0;
        var isNew = p.created_at && (Date.now() - new Date(p.created_at).getTime()) < 7*24*60*60*1000;
        var isLong = p.created_at && (Date.now() - new Date(p.created_at).getTime()) > 60*24*60*60*1000;
        var dbadges = [];
        if (p.is_oportunidad) dbadges.push('<span class="prop-badge oportunidad" title="Precio agresivo para la zona"><i class="fas fa-tag"></i> Oportunidad</span>');
        if (p.is_retasada) dbadges.push('<span class="prop-badge retasada" title="Precio ajustado recientemente"><i class="fas fa-redo"></i> Retasada</span>');
        if (p.featured) dbadges.push('<span class="prop-badge destacada" title="Aparece destacada en el sitio"><i class="fas fa-star"></i> Destacada</span>');
        if (p.ml_item_id) dbadges.push('<span class="prop-badge ml" title="Publicada también en Mercado Libre"><i class="fas fa-megaphone" style="font-style:italic;">ML</i></span>');
        if (isNew) dbadges.push('<span class="prop-badge nueva" title="Cargada en los últimos 7 días"><i class="fas fa-bolt"></i> Nueva</span>');

        var location = [p.zone, p.address].filter(Boolean).join(' · ');
        var typeLabel = ptypeLabel(p.property_type);

        /* Precio con moneda */
        var priceHtml = '';
        if (p.price_usd != null && p.price_usd > 0) {
          var main = p.price_currency === 'ARS' ? fmtARS(p.price_usd) : fmtUSD(p.price_usd);
          var sec = '';
          if (p.price_currency !== 'ARS' && usdRate > 0) sec = '<span class="prop-price-sec">' + fmtARS(p.price_usd * usdRate) + '</span>';
          priceHtml = '<span class="prop-price"><i class="fas fa-dollar-sign"></i> ' + esc(main) + sec + '</span>';
        }

        /* Próxima visita destacada */
        var nextBadge = '';
        if (p.visits_next != null && p.visits_next > 0) {
          nextBadge = '<span class="prop-next-badge"><i class="fas fa-calendar-check"></i> ' + fmtNum(p.visits_next) + (p.visits_next === 1 ? ' próxima visita' : ' próximas visitas') + '</span>';
        }

        var pubDateHtml = '';
        if (p.created_at) {
          var daysPub = Math.floor((Date.now() - new Date(p.created_at).getTime()) / (24*60*60*1000));
          pubDateHtml = '<span><i class="fas fa-clock"></i> ' + (daysPub === 0 ? 'Cargada hoy' : (daysPub === 1 ? 'Cargada ayer' : 'Cargada hace ' + daysPub + ' días')) + '</span>';
        }

        /* Stats con matiz */
        var stats = [];
        if (p.leads_total != null) {
          stats.push({ icon:'fas fa-users', num: fmtNum(p.leads_total), label:'consultas', sub: (p.leads_30d != null && p.leads_30d > 0) ? (fmtNum(p.leads_30d) + ' últimos 30 días') : null });
        }
        if (p.visits_total != null) {
          stats.push({ icon:'fas fa-calendar', num: fmtNum(p.visits_total), label:'visitas', sub: (p.visits_done != null && p.visits_done > 0) ? (fmtNum(p.visits_done) + ' realizadas') : null });
        }
        if (p.visits_next != null && p.visits_next > 0) {
          stats.push({ icon:'fas fa-arrow-right', num: fmtNum(p.visits_next), label:'próximas', sub: null });
        }
        var statsHtml = '';
        if (stats.length) {
          statsHtml = '<div class="prop-stats-row">' + stats.map(function(s){
            return '<div class="prop-stat"><i class="' + s.icon + '"></i> <span class="count">' + s.num + '</span> ' + esc(s.label) +
              (s.sub ? '<span class="prop-stat-sub">' + esc(s.sub) + '</span>' : '') + '</div>';
          }).join('') + '</div>';
        }

        /* Timeline: más reciente arriba; la publicación dice "Publicada" solo si está publicada */
        var timeline = [];
        if (p.created_at) timeline.push({ date: p.created_at, text: p.is_published ? 'Publicada' : 'Cargada', icon:'fa-home' });
        if (p.last_lead_at) timeline.push({ date: p.last_lead_at, text: 'Última consulta', icon:'fa-users', time: true });
        if (p.last_visit_at) timeline.push({ date: p.last_visit_at, text: 'Última visita completada', icon:'fa-check-circle', time: true });
        if (p.ml_last_sync) timeline.push({ date: p.ml_last_sync, text: 'Última sync ML', icon:'fa-sync', time: true });
        timeline.sort(function(a, b){ return new Date(b.date).getTime() - new Date(a.date).getTime(); });
        var timelineHtml = '';
        if (timeline.length > 0) {
          timelineHtml = '<div class="prop-timeline">' +
            timeline.map(function(t) {
              return '<div class="prop-timeline-item">' +
                '<i class="fas ' + t.icon + '"></i>' +
                '<div class="prop-timeline-body"><span class="tl-text">' + esc(t.text) + '</span><span class="tl-date">' + (t.time ? fmtDateTimeShort(t.date) : fmtDate(t.date)) + '</span></div>' +
              '</div>';
            }).join('') +
          '</div>';
        }

        /* Características completas */
        var perM2 = pricePerM2(p);
        var comp = completeness(p);
        var daysM = daysOnMarket(p);
        var temp = tempBadge(p);
        var feats = [
          { label:'Ambientes', val: p.rooms != null ? p.rooms : null },
          { label:'Dormitorios', val: p.bedrooms != null ? p.bedrooms : null },
          { label:'Baños', val: p.bathrooms != null ? p.bathrooms : null },
          { label:'Cochera', val: p.garage_spaces != null ? p.garage_spaces : null },
          { label:'Sup. cubierta', val: p.area_covered ? fmtNum(p.area_covered) + ' m²' : null },
          { label:'Sup. total', val: p.area_total ? fmtNum(p.area_total) + ' m²' : (p.area_m2 ? fmtNum(p.area_m2) + ' m²' : null) },
          { label:'Tipo', val: typeLabel },
          { label:'Código', val: p.property_code },
          { label:'ML ID', val: p.ml_item_id },
          { label:'Calidad publicación', val: comp + '%', tip: 'calidad basada en fotos, descripción, video y precio' },
          { label:'En mercado hace', val: daysM !== null ? daysM + (daysM === 1 ? ' día' : ' días') : null, tip: daysM !== null ? 'desde la carga al sistema' : '' },
          (perM2 ? { label:'Precio por m²', val: (p.price_currency === 'ARS' ? fmtARS(perM2) : fmtUSD(perM2)) } : null),
          (temp ? { label:'Actividad', val: temp.txt, tip: temp.tip, cls: temp.cls } : null)
        ].filter(function(f){ return f && f.val != null && f.val !== '' && f.val !== '-'; });
        var featsHtml = '<div class="prop-detail-grid">' + feats.map(function(f){
          return '<div class="prop-detail-item' + (f.cls ? ' item-' + f.cls : '') + '" title="' + esc(f.tip || '') + '"><div class="label">' + esc(f.label) + '</div><div class="val">' + esc(f.val) + '</div></div>';
        }).join('') + '</div>';

        /* Descripción */
        var descHtml = '';
        if (p.description && String(p.description).trim()) {
          descHtml = '<div class="prop-desc"><i class="fas fa-align-left"></i> <span>' + esc(p.description) + '</span></div>';
        }

        /* Video */
        var videoHtml = '';
        if (p.video_url && /youtube|youtu\.be|vimeo/.test(p.video_url)) {
          videoHtml = '<div class="prop-video"><a href="' + esc(safeUrl(p.video_url)) + '" target="_blank" rel="noopener"><i class="fas fa-play-circle"></i> Ver video de la propiedad</a></div>';
        }

        /* Gallery + botón compartir */
        var imgs = p.image_urls || [];
        var galleryHtml = '';
        var lightboxData = '';
        var shareBtn = '';
        if (imgs.length) {
          var shareText = 'Mirá ' + (p.title || 'esta propiedad') + (p.property_code ? ' (' + p.property_code + ')' : '') + ' en BIENENHAUS';
          var shareHref = 'https://wa.me/?text=' + encodeURIComponent(shareText + ' — ' + (location.protocol + '//' + location.host) + '/?q=' + encodeURIComponent(p.property_code || p.title || ''));
          shareBtn = '<a class="prop-share-btn" href="' + shareHref + '" target="_blank" rel="noopener" title="Compartir por WhatsApp"><i class="fab fa-whatsapp"></i> Compartir</a>';
          galleryHtml = '<div class="prop-gallery">' +
            imgs.slice(0, 6).map(function(u, i){
              return '<div class="prop-gallery-item">' +
                '<img class="prop-gallery-img" src="' + esc(safeImageUrl(u)) + '" alt="Foto ' + (i + 1) + ' de ' + esc(p.title || 'propiedad') + '" loading="lazy">' +
                (i === 0 && imgs.length > 1 ? '<span class="prop-gallery-count">+' + (imgs.length - 1) + '</span>' : '') +
              '</div>';
            }).join('') +
            (imgs.length > 6 ? '<div class="prop-gallery-more" data-more="' + esc(p.id) + '">+' + (imgs.length - 6) + '</div>' : '') +
          '</div>';
          lightboxData = '<div class="prop-lightbox-data" data-id="' + esc(p.id) + '">' + imgs.map(function(u){
            return '<span data-src="' + esc(safeImageUrl(u)) + '"></span>';
          }).join('') + '</div>';
        } else {
          galleryHtml = '<div class="prop-gallery-empty"><i class="fas fa-image"></i> Todavía no hay fotos de esta propiedad</div>';
        }

        /* Mapa (si hay dirección o zona) */
        var mapQuery = [p.address, p.zone].filter(Boolean).join(', ');
        var mapUrl = mapQuery ? 'https://www.openstreetmap.org/search?query=' + encodeURIComponent(mapQuery) + '&zoom=14' : '';
        var mapHtml = mapUrl ? '<a class="prop-map-link" href="' + esc(mapUrl) + '" target="_blank" rel="noopener" title="Ver ubicación en OpenStreetMap"><i class="fas fa-map-location-dot"></i> Ver en mapa</a>' : '';

        /* Favorito local */
        var favBtn = '';

      /* Badge "Calidad" si la publicación está incompleta */
        var qualBadge = '';
        if (comp < 60) {
          qualBadge = '<div class="prop-quality-warn"><i class="fas fa-triangle-exclamation"></i> La publicación está incompleta. Mejorala con más fotos, video o descripción para recibir más consultas.</div>';
        }

        /* Enlaces rápidos: Mercado Libre + sitio público */
        var mlLink = p.ml_item_id
          ? '<a class="prop-link-btn ml-repo" href="https://articulo.mercadolibre.com.ar/' + esc(p.ml_item_id) + '" target="_blank" rel="noopener" title="Ver publicación en Mercado Libre"><i class="fas fa-external-link-alt"></i> ML</a>'
          : '';
        var pubLink = p.property_code && p.is_published
          ? '<a class="prop-link-btn" href="/?q=' + encodeURIComponent(p.property_code) + '" target="_blank" rel="noopener" title="Ver en sitio público"><i class="fas fa-globe"></i> Sitio</a>'
          : '';
        var linksHtml = (mlLink || pubLink) ? '<div class="prop-links-row">' + mlLink + pubLink + '</div>' : '';

        /* Alquiler anual estimado si es alquiler */
        var rentHtml = '';
        if (p.status === 'alquiler' && p.price_usd && p.price_usd > 0) {
          var annual = Math.round(p.price_usd * 12);
          rentHtml = '<div class="lat-annual"><i class="fas fa-calendar-alt"></i> Alquiler anual estimado: ' + fmtUSD(annual) + (usdRate > 0 ? ' ≈ ' + fmtARS(annual * usdRate) : '') + '</div>';
        }

        /* Sugerencia de mejora si baja calidad */
        var qualTip = '';
        if (comp < 60) {
          var parts = [];
          if (!(p.image_urls && p.image_urls.length >= 6)) parts.push('agregá fotos (mínimo 6)');
          if (p.description && String(p.description).length < 100) parts.push('completá la descripción');
          if (!p.video_url) parts.push('agregá un video');
          qualTip = '<div class="prop-quality-warn" style="margin-top:10px;"><i class="fas fa-triangle-exclamation"></i> Tu publicación puede recibir más consultas: ' + esc(parts.join(', ')) + '.</div>';
        }

        return '<div class="prop-card' + (listView === 'list' ? ' prop-card--list' : '') + '" data-id="' + esc(p.id) + '">' +
          '<div class="prop-card-header">' +
            (img
              ? '<div class="prop-card-thumb-wrap"><img class="prop-card-thumb" src="' + esc(safeImageUrl(img)) + '" alt="' + esc(p.title || '') + '" decoding="async">' + (imgCount > 1 ? '<span class="prop-thumb-count">' + imgCount + ' fotos</span>' : '') + '</div>'
              : '<div class="prop-card-thumb prop-card-thumb--placeholder"><i class="fas fa-home"></i></div>') +
            '<div class="prop-card-body">' +
              '<button type="button" class="cmp-check' + (compareSelection.indexOf(p.id) !== -1 ? ' checked' : '') + '" data-cmp="' + esc(p.id) + '" aria-label="Seleccionar para comparar" title="Seleccionar para comparar"><i class="fas fa-columns"></i></button>' +
              '<button type="button" class="prop-fav-btn' + (isFav(p.id) ? ' is-fav' : '') + '" data-fav="' + esc(p.id) + '" aria-pressed="' + isFav(p.id) + '" aria-label="Marcar favorita" title="' + (isFav(p.id) ? 'Quitar de favoritas' : 'Marcar como favorita') + '"><i class="fas fa-heart"></i></button>' +
              '<div class="prop-card-title">' + esc(p.title || 'Sin título') +
                (typeLabel && typeLabel !== 'Propiedad' ? '<span class="prop-type-tag">' + esc(typeLabel) + '</span>' : '') +
              '</div>' +
              '<div class="prop-card-meta">' +
                '<span><i class="fas fa-map-marker-alt"></i> ' + esc(location || 'Sin ubicación') + '</span>' +
                priceHtml +
                pubDateHtml +
              '</div>' +
              '<div class="prop-card-row">' +
                statusBadge(p) +
                nextBadge +
              '</div>' +
              (dbadges.length || isLong ? '<div class="prop-card-badges">' + dbadges.join('') + (isLong ? '<span class="prop-badge larga" title="Lleva más de 60 días en publicación"><i class="fas fa-circle-exclamation"></i> ' + daysOnMarket(p) + ' días en mercado</span>' : '') + '</div>' : '') +
            '</div>' +
            '<div class="prop-card-expand"><i class="fas fa-chevron-down"></i></div>' +
          '</div>' +
          '<div class="prop-card-detail">' +
            featsHtml +
            (linksHtml || '') +
            (rentHtml || '') +
            (qualBadge || '') +
            (qualTip || '') +
            (statsHtml || '') +
            (descHtml || '') +
            (videoHtml || '') +
            (timelineHtml || '') +
            (galleryHtml || '') +
            '<div class="prop-card-detail-actions">' +
              (shareBtn || '') +
              (mapHtml || '') +
            '</div>' +
            lightboxData +
          '</div>' +
        '</div>';
      }

      function sortBinds() {
        document.querySelectorAll('.prop-sort-pill').forEach(function(b){
          b.addEventListener('click', function(){
            activeSort = b.dataset.sort;
            document.querySelectorAll('.prop-sort-pill').forEach(function(x){ x.classList.remove('active'); });
            b.classList.add('active');
            renderListFromFilter();
          });
        });
      }

      function sortBinds() {
        document.querySelectorAll('.prop-sort-pill').forEach(function(b){
          b.addEventListener('click', function(){
            activeSort = b.dataset.sort;
            document.querySelectorAll('.prop-sort-pill').forEach(function(x){ x.classList.remove('active'); });
            b.classList.add('active');
            renderListFromFilter();
          });
        });
        var sInput = $('propSearchInput');
        if (sInput && !sInput.dataset.bind) {
          sInput.dataset.bind = '1';
          var sT;
          sInput.addEventListener('input', function () {
            clearTimeout(sT);
            sT = setTimeout(function(){ activeQuery = sInput.value.trim(); renderListFromFilter(); }, 220);
          });
        }
        var vBtn = $('propViewToggle');
        if (vBtn && !vBtn.dataset.bind) {
          vBtn.dataset.bind = '1';
          vBtn.addEventListener('click', function () {
            listView = listView === 'list' ? 'grid' : 'list';
            prefsSet({ view: listView });
            renderListFromFilter();
          });
        }
      }

      function renderListFromFilter() {
        var filtered = props
          .filter(function(p){ return matchFilter(p, activeFilter) && matchQuery(p, activeQuery); })
          .sort(matchSort);
        var countBar = ((activeFilter !== 'all' && filtered.length !== props.length) || activeQuery)
          ? '<div class="prop-count-hint">Mostrando ' + fmtNum(filtered.length) + ' de ' + fmtNum(props.length) + '</div>'
          : '';
        if (!filtered.length) {
          $('propList').innerHTML = summaryHtml + filtersHtml + sortHtml + searchHtml + countBar +
            '<div class="empty-msg" style="margin-top:16px;"><i class="fas fa-filter"></i><h3>Sin resultados</h3><p>No hay propiedades que coincidan con tu búsqueda.</p></div>';
          bindFilterButtons(); sortBinds();
          return;
        }
        var cardsHtml = filtered.map(propCardHtml).join('');
        var listClass = listView === 'list' ? ' prop-list--list' : '';
        $('propList').innerHTML = summaryHtml + filtersHtml + sortHtml + searchHtml + countBar +
          '<div class="prop-list' + listClass + '">' + cardsHtml + '</div>';
        bindPropEvents(filtered); sortBinds();
      }

      function bindFilterButtons() {
        document.querySelectorAll('#propFilters .prop-filter').forEach(function(btn){
          btn.addEventListener('click', function(){
            activeFilter = btn.dataset.filter;
            document.querySelectorAll('#propFilters .prop-filter').forEach(function(b){ b.classList.remove('active'); });
            btn.classList.add('active');
            renderListFromFilter();
          });
        });
      }

      function bindPropEvents(list) {
        document.querySelectorAll('.cmp-check').forEach(function(b){
          if (b.dataset.bound) return;
          b.dataset.bound = '1';
          b.addEventListener('click', function(e){
            e.stopPropagation();
            toggleCompare(b.getAttribute('data-cmp'));
            b.classList.toggle('checked', compareSelection.indexOf(b.getAttribute('data-cmp')) !== -1);
          });
        });
        document.querySelectorAll('.prop-fav-btn').forEach(function(b){
          if (b.dataset.bound) return;
          b.dataset.bound = '1';
          b.addEventListener('click', function(e){
            e.stopPropagation();
            var id = b.getAttribute('data-fav');
            var on = toggleFav(id);
            b.classList.toggle('is-fav', on);
            b.setAttribute('aria-pressed', String(on));
            portalToast(on ? 'Marcada como favorita' : 'Quitada de favoritas');
          });
        });
        document.querySelectorAll('.prop-card-header').forEach(function(h) {
          h.addEventListener('click', function() {
            h.closest('.prop-card').classList.toggle('expanded');
          });
          /* Doble clic abre el detalle directo */
          h.addEventListener('dblclick', function() {
            h.closest('.prop-card').classList.add('expanded');
          });
          /* Long-press también expande (mobile) */
          var pressT;
          h.addEventListener('touchstart', function () { pressT = setTimeout(function(){ h.closest('.prop-card').classList.add('expanded'); }, 550); }, { passive: true });
          h.addEventListener('touchend', function () { clearTimeout(pressT); }, { passive: true });
          h.addEventListener('touchmove', function () { clearTimeout(pressT); }, { passive: true });
        });
        bindFilterButtons();
        bindGalleryLightbox(list);

        /* Prefetch de la 2da imagen al hover/focus de la thumb */
        document.querySelectorAll('.prop-card-thumb').forEach(function(t){
          t.addEventListener('mouseenter', function(){
            var card = t.closest('.prop-card');
            var dEl = card && card.querySelector('.prop-lightbox-data');
            if (!dEl) return;
            var spans = dEl.querySelectorAll('span');
            if (spans.length > 1) {
              var pre = new Image();
              pre.src = spans[1].getAttribute('data-src');
            }
          }, { passive: true });
        });
      }

      function bindGalleryLightbox(list) {
        document.querySelectorAll('.prop-gallery-img, .prop-gallery-more').forEach(function(el) {
          el.addEventListener('click', function(e) {
            e.stopPropagation();
            e.preventDefault();
            var card = el.closest('.prop-card');
            var dataEl = card && card.querySelector('.prop-lightbox-data');
            if (!dataEl) return;
            var spans = dataEl.querySelectorAll('span');
            var imgs = Array.prototype.map.call(spans, function(s){ return s.getAttribute('data-src'); }).filter(Boolean);
            if (!imgs.length) return;
            var all = card.querySelectorAll('.prop-gallery-img, .prop-gallery-more');
            var clickedIdx = Array.prototype.indexOf.call(all, el);
            var idx = (el.classList && el.classList.contains('prop-gallery-more')) ? 0 : clickedIdx;
            openLightbox(imgs, Math.max(0, idx));
          });
        });
      }

      function openLightbox(imgs, idx) {
        var existing = document.getElementById('propLightbox');
        if (existing) existing.remove();
        var box = document.createElement('div');
        box.id = 'propLightbox';
        box.className = 'lightbox-overlay';
        var cur = Math.max(0, Math.min(idx || 0, imgs.length - 1));
        var rotation = 0;
        var scale = 1;
        var scaleOrigin = { x: 0, y: 0 };
        box.innerHTML =
          '<div class="lightbox-content">' +
            (cur === 0 ? '<div class="portada-tag">Portada</div>' : '') +
            '<button class="lightbox-close" aria-label="Cerrar"><i class="fas fa-times"></i></button>' +
            (imgs.length > 1 ? '<button class="lightbox-nav prev" aria-label="Anterior"><i class="fas fa-chevron-left"></i></button><button class="lightbox-nav next" aria-label="Siguiente"><i class="fas fa-chevron-right"></i></button>' : '') +
            '<img class="lightbox-img" src="' + esc(safeImageUrl(imgs[cur])) + '" alt="Foto">' +
            '<div class="lightbox-count">' + (cur + 1) + ' / ' + imgs.length + '</div>' +
            '<div class="lightbox-extra-actions">' +
              '<button type="button" class="lb-rotate" title="Rotar 90°" aria-label="Rotar imagen"><i class="fas fa-rotate-right"></i></button>' +
              '<a class="lb-download" href="' + esc(safeImageUrl(imgs[cur])) + '" download="foto.jpg" target="_blank" rel="noopener" title="Descargar foto" aria-label="Descargar foto"><i class="fas fa-download"></i></a>' +
              '<button type="button" class="lb-share-photo" title="Compartir foto" aria-label="Compartir foto"><i class="fas fa-share-alt"></i></button>' +
            '</div>' +
            '<div class="lightbox-thumbs"></div>' +
          '</div>';
        document.body.appendChild(box);
        box.style.display = 'flex';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', 'Galería de fotos');
        var lightboxImg = box.querySelector('.lightbox-img');
        var thumbsStrip = box.querySelector('.lightbox-thumbs');
        var preloaded = {};
        function preload(i) {
          var n = (i + imgs.length) % imgs.length;
          if (!preloaded[n]) {
            preloaded[n] = new Image();
            preloaded[n].src = safeImageUrl(imgs[n]);
          }
        }
        preload(cur + 1);
        preload(cur - 1);

        /* Pinch zoom (mobile) */
        var initialDist = 0;
        function getDist(t) {
          if (t.touches.length < 2) return 0;
          var a = t.touches[0], b = t.touches[1];
          return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        }
        box.addEventListener('touchstart', function (e) {
          if (e.touches.length === 2) { initialDist = getDist(e); }
        }, { passive: true });
        box.addEventListener('touchmove', function (e) {
          if (e.touches.length === 2 && initialDist > 0) {
            var d = getDist(e);
            scale = Math.min(3, Math.max(1, scale * (d / initialDist)));
            initialDist = d;
            lightboxImg.style.transform = 'scale(' + scale + ') rotate(' + rotation + 'deg)';
            lightboxImg.style.transition = 'none';
          }
        }, { passive: true });
        box.addEventListener('touchend', function (e) {
          if (e.touches.length < 2 && initialDist > 0) {
            initialDist = 0;
            lightboxImg.style.transition = 'transform 0.3s';
          }
        }, { passive: true });

        function show(i) {
          cur = (i + imgs.length) % imgs.length;
          lightboxImg.src = safeImageUrl(imgs[cur]);
          box.querySelector('.lightbox-count').textContent = (cur + 1) + ' / ' + imgs.length;
          /* Reset zoom/rotación al cambiar */
          scale = 1; rotation = 0;
          lightboxImg.style.transform = '';
          var pb = box.querySelector('.portada-tag');
          if (pb) pb.remove();
          if (cur === 0) {
            var tag = document.createElement('div');
            tag.className = 'portada-tag';
            tag.textContent = 'Portada';
            box.querySelector('.lightbox-content').insertBefore(tag, box.querySelector('.lightbox-close'));
          }
          thumbsStrip.querySelectorAll('img').forEach(function(t, ti){ t.classList.toggle('active', ti === cur); });
          preload(cur + 1);
          preload(cur - 1);
        }

        /* Thumbs strip */
        thumbsStrip.innerHTML = imgs.map(function(u, i){
          return '<img src="' + esc(safeImageUrl(u)) + '" alt="Thumb ' + (i+1) + '" class="' + (i === cur ? 'active' : '') + '" loading="lazy">';
        }).join('');
        thumbsStrip.querySelectorAll('img').forEach(function(t, ti){
          t.addEventListener('click', function(){ show(ti); });
        });

        /* Rotar */
        box.querySelector('.lb-rotate').addEventListener('click', function() {
          rotation = (rotation + 90) % 360;
          lightboxImg.style.transform = 'rotate(' + rotation + 'deg)' + (scale !== 1 ? ' scale(' + scale + ')' : '');
        });

        /* Compartir foto individual */
        box.querySelector('.lb-share-photo').addEventListener('click', function() {
          var url = imgs[cur];
          if (navigator.share) {
            navigator.share({ title: 'Foto de BIENENHAUS', text: 'Foto de una propiedad en BIENENHAUS', url: url }).then(function(){}, function(){});
          } else if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(function(){ portalToast('Link de foto copiado'); }, function(){ portalToast('No se pudo copiar', 'error'); });
          } else {
            portalToast('Compartí la foto copiando el link', 'info');
          }
        });

        /* Swipe en mobile */
        var touchX = 0;
        box.addEventListener('touchstart', function (e) { var t = e.touches && e.touches[0]; if (t && t.touches && t.touches.length === 1) touchX = t.clientX; }, { passive: true });
        box.addEventListener('touchend', function (e) {
          var t = e.changedTouches && e.changedTouches[0];
          if (!t || scale > 1 || e.touches.length > 0) return;
          var dx = t.clientX - touchX;
          if (Math.abs(dx) > 40 && imgs.length > 1) show(cur + (dx < 0 ? 1 : -1));
        }, { passive: true });

        box.querySelector('.lightbox-close').addEventListener('click', function(){ box.remove(); });
        box.addEventListener('click', function(e){ if (e.target === box) box.remove(); });
        if (imgs.length > 1) {
          box.querySelector('.prev').addEventListener('click', function(){ show(cur - 1); });
          box.querySelector('.next').addEventListener('click', function(){ show(cur + 1); });
        }
        document.addEventListener('keydown', function escK(e){
          if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', escK); }
          else if (e.key === 'ArrowRight' && imgs.length > 1) show(cur + 1);
          else if (e.key === 'ArrowLeft' && imgs.length > 1) show(cur - 1);
        });
      }

      renderListFromFilter();
    }

    /* ── EXCLUSIVIDAD ── */
    function exclState(start, end) {
      var now = new Date();
      if (!start && !end) return { key:'sin' };
      if (end && now > end) return { key:'vencida', start:start, end:end };
      if (end && (end - now) <= 30*24*60*60*1000) return { key:'por_vencer', start:start, end:end };
      return { key:'activa', start:start, end:end };
    }
    function exclStateLabel(state) {
      switch (state.key) {
        case 'activa':      return { text:'Activa', cls:'activa' };
        case 'por_vencer':  return { text:'Por vencer', cls:'por-vencer' };
        case 'vencida':     return { text:'Vencida', cls:'vencida' };
        default:            return { text:'Sin exclusividad', cls:'sin' };
      }
    }
    function exclCountdownParts(ms) {
      var seconds = Math.max(0, Math.floor(ms / 1000));
      var days = Math.floor(seconds / 86400);
      var hours = Math.floor((seconds % 86400) / 3600);
      var months = Math.floor(days / 30);
      var remDays = days % 30;
      return { yrs:0, months:months, days:remDays, hours:hours };
    }
    function exclContractMonths(start, end) {
      var m = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + (end.getDate() >= start.getDate() ? 1 : 0);
      return Math.max(1, m);
    }
    function exclVariance(cur, prev) {
      if (prev <= 0) return cur > 0 ? 100 : 0;
      return Math.round(((cur - prev) / prev) * 100);
    }
    function exclDeltaCard(title, icon, cur, prev) {
      var v = exclVariance(cur, prev);
      var dir = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
      var arrow = v > 0 ? 'fa-arrow-up' : (v < 0 ? 'fa-arrow-down' : 'fa-minus');
      var label = prev > 0 ? (v > 0 ? '+' + v + '% vs. período anterior' : v + '% vs. período anterior') : (cur > 0 ? 'nuevo' : 'sin datos previos');
      return '<div class="excl-delta">' +
        '<div class="excl-delta-top"><i class="' + esc(icon) + '"></i><span class="excl-delta-title">' + esc(title) + '</span></div>' +
        '<div class="excl-delta-num">' + fmtNum(cur) + '</div>' +
        '<div class="excl-delta-foot ' + dir + '"><i class="fas ' + arrow + '"></i> ' + esc(label) + '</div>' +
        '<div class="excl-delta-prev">período anterior: ' + fmtNum(prev) + '</div>' +
      '</div>';
    }
    function exclTimeline(activity, start, end) {
      if (!activity || !activity.length) return '';
      var s = start ? start.getTime() : -Infinity;
      var e = end ? end.getTime() : Infinity;
      var items = activity.filter(function(a){ var t = a && a.at ? new Date(a.at).getTime() : NaN; return !isNaN(t) && t >= s && t <= e; });
      if (!items.length) return '';
      var html = items.map(function(a){
        var icon = 'fa-circle';
        if (a.type === 'consulta') icon = 'fa-envelope';
        else if (a.type === 'visita_agendada') icon = 'fa-calendar-plus';
        else if (a.type === 'visita_completada') icon = 'fa-check-circle';
        else if (a.type === 'publicacion' || a.type === 'ml_publicacion') icon = 'fa-bullhorn';
        else if (a.type === 'ml_sync') icon = 'fa-sync';
        return '<div class="excl-timeline-item">' +
          '<i class="fas ' + icon + '"></i>' +
          '<div class="excl-timeline-body"><div class="excl-timeline-text">' + esc(a.text || '') + '</div><div class="excl-timeline-date">' + fmtDate(a.at) + '</div></div>' +
        '</div>';
      }).join('');
      return '<div class="section-title" style="margin-top:24px;"><i class="fas fa-history"></i> Eventos del período</div>' +
        '<div class="excl-timeline">' + html + '</div>';
    }

    function renderExclusividad(d, owner) {
      var es = d.excl_stats || {};
      var activity = d.activity || [];

      /* ── Sin exclusividad: empty state enriquecido ── */
      if (!owner.exclusive) {
        var sinBenefits = [
          { icon:'fas fa-bullhorn', title:'Publicación prioritaria', desc:'Tu propiedad destaca en todos los canales.' },
          { icon:'fas fa-chart-line', title:'Reportes periódicos', desc:'Seguimiento de consultas y visitas.' },
          { icon:'fas fa-handshake', title:'Asesor dedicado', desc:'Un broker gestiona tu propiedad de forma exclusiva.' },
          { icon:'fas fa-percent', title:'Comisión preferencial', desc:'Condiciones especiales para propietarios en exclusividad.' }
        ];
        var sinHtml = sinBenefits.map(function(b){
          return '<div class="excl-benefit">' +
            '<i class="' + esc(b.icon) + '"></i>' +
            '<div><h4>' + esc(b.title) + '</h4><p>' + esc(b.desc) + '</p></div>' +
          '</div>';
        }).join('');
        var phoneOwner = portalWaNumber(owner.phone);
        var phoneBroker = d.broker && d.broker.phone ? portalWaNumber(d.broker.phone) : null;
        var phoneCXA = phoneBroker || phoneOwner;
        var waSin = phoneCXA
          ? '<a class="whatsapp-cta" href="https://wa.me/' + esc(phoneCXA) + '?text=' + encodeURIComponent('Hola, me comunico desde el portal de propietario de BIENENHAUS. Me interesa conocer la exclusividad.') + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Consultar por exclusividad</a>'
          : '';
        $('exclContent').innerHTML =
          '<div class="empty-msg">' +
            '<i class="fas fa-handshake"></i>' +
            '<h3>Sin exclusividad activa</h3>' +
            '<p>Actualmente no tenés un contrato de exclusividad vigente. Con una exclusividad tu propiedad recibe atención prioritaria y condiciones especiales.</p>' +
          '</div>' +
          '<div class="section-title" style="margin-top:24px;"><i class="fas fa-gift"></i> Qué incluye la exclusividad</div>' +
          '<div class="excl-benefits">' + sinHtml + '</div>' +
          waSin;
        return;
      }

      var start = owner.exclusive_start ? new Date(owner.exclusive_start) : null;
      var end = owner.exclusive_end ? new Date(owner.exclusive_end) : null;
      var now = new Date();
      var st = exclState(start, end);
      var stLabel = exclStateLabel(st);

      /* Banner title según estado */
      var bannerTxt;
      if (st.key === 'vencida') bannerTxt = 'Tu exclusividad ha vencido';
      else if (st.key === 'por_vencer') bannerTxt = 'Exclusividad por vencer';
      else bannerTxt = 'Exclusividad activa';

      /* Countdown (preciso por partes) */
      var countdownHtml = '';
      if (st.key === 'activa' && end) {
        var parts = exclCountdownParts(end - now);
        if (parts.months === 0 && parts.days === 0) {
          countdownHtml = '<div class="excl-countdown"><div class="excl-countdown-item"><div class="num">' + parts.hours + '</div><div class="unit">horas</div></div></div>';
        } else {
          var units = '';
          if (parts.months > 0) units += '<div class="excl-countdown-item"><div class="num">' + parts.months + '</div><div class="unit">meses</div></div>';
          units += '<div class="excl-countdown-item"><div class="num">' + parts.days + '</div><div class="unit">días</div></div>';
          units += '<div class="excl-countdown-item"><div class="num">' + parts.hours + '</div><div class="unit">horas</div></div>';
          countdownHtml = '<div class="excl-countdown">' + units + '</div>';
        }
      } else if (st.key === 'por_vencer' && end) {
        var pdays = Math.max(0, Math.ceil((end - now) / (1000*60*60*24)));
        countdownHtml = '<div class="excl-countdown excl-warn">' +
          '<div class="excl-countdown-item"><div class="num">' + pdays + '</div><div class="unit">días restantes</div></div>' +
        '</div>';
      }

      /* Progress: día X de Y + color por fase */
      var progressHtml = '';
      var pct = 0;
      var dayX = 0, dayY = 0;
      if (start && end) {
        dayY = Math.max(1, Math.round((end - start) / (1000*60*60*24)));
        var elapsedMs = now - start;
        dayX = Math.min(dayY, Math.max(0, Math.floor(elapsedMs / (1000*60*60*24)) + 1));
        pct = Math.min(100, Math.max(0, (elapsedMs / (end - start)) * 100));
        var phase = pct >= 80 ? 'danger' : (pct >= 50 ? 'warn' : 'good');
        var daysLeft = Math.max(0, Math.ceil((end - now) / (1000*60*60*24)));
        var urgencyNote = '';
        if (daysLeft <= 7) urgencyNote = '<span class="excl-urgency urgent">Últimos ' + daysLeft + ' días</span>';
        else if (daysLeft <= 15) urgencyNote = '<span class="excl-urgency soon">Quedan ' + daysLeft + ' días</span>';
        progressHtml =
          '<div class="excl-progress-wrap">' +
            '<div class="excl-progress-label">' +
              '<span>' + fmtDate(start) + '</span>' +
              '<span>Día ' + dayX + ' de ' + dayY + '</span>' +
              '<span>' + fmtDate(end) + '</span>' +
            '</div>' +
            '<div class="excl-progress-track"><div class="excl-progress-fill phase-' + phase + '" style="width:' + pct + '%"></div></div>' +
            '<div class="excl-progress-days">' + Math.round(pct) + '% del período transcurrido' + urgencyNote + '</div>' +
          '</div>';
      }

      /* Contrato: duración + comisión + notas */
      var contractBits = [];
      if (start && end) contractBits.push('Contrato de ' + exclContractMonths(start, end) + ' meses');
      else if (start && !end) contractBits.push('Inicio: ' + fmtDate(start));
      var comms = [];
      if (owner.commission_sale != null) comms.push('Venta ' + owner.commission_sale + '%');
      if (owner.commission_rent != null) comms.push('Alquiler ' + owner.commission_rent + '%');
      if (comms.length) contractBits.push('Comisión: ' + comms.join(' · '));
      var contractHtml = '';
      if (contractBits.length || owner.contract_notes) {
        contractHtml = '<div class="excl-contract">' +
          (contractBits.length ? '<div class="excl-contract-bits">' + contractBits.map(function(b){ return '<span class="excl-contract-pill">' + esc(b) + '</span>'; }).join('') + '</div>' : '') +
          (owner.contract_notes ? '<div class="excl-contract-notes">' + esc(owner.contract_notes) + '</div>' : '') +
        '</div>';
      }

      /* Benefits (estáticos) */
      var benefits = [
        { icon:'fas fa-bullhorn', title:'Publicación prioritaria', desc:'Tu propiedad aparece destacada en todos los canales.' },
        { icon:'fas fa-chart-line', title:'Reportes periódicos', desc:'Seguimiento detallado de consultas y visitas.' },
        { icon:'fas fa-handshake', title:'Asesor dedicado', desc:'Un broker de confianza gestiona tu propiedad de forma exclusiva.' },
        { icon:'fas fa-robot', title:'Sincronización ML', desc:'Publicación automática en Mercado Libre y portales.' }
      ];
      var benefitsHtml = benefits.map(function(b) {
        return '<div class="excl-benefit">' +
          '<i class="' + esc(b.icon) + '"></i>' +
          '<div><h4>' + esc(b.title) + '</h4><p>' + esc(b.desc) + '</p></div>' +
        '</div>';
      }).join('');

      /* Resultados: 3 cards + comparativa vs período anterior */
      var statsHtml =
        '<div class="excl-stats-grid">' +
          '<div class="stat-card"><div class="label"><i class="fas fa-users"></i> Consultas</div><div class="value gold">' + fmtNum(es.leads || 0) + '</div></div>' +
          '<div class="stat-card"><div class="label"><i class="fas fa-calendar"></i> Visitas</div><div class="value gold">' + fmtNum(es.visits || 0) + '</div></div>' +
          '<div class="stat-card"><div class="label"><i class="fas fa-check"></i> Realizadas</div><div class="value green">' + fmtNum(es.visits_done || 0) + '</div></div>' +
        '</div>';

      var deltaHtml = '';
      var hasPrev = es.prev_leads != null || es.prev_visits != null;
      if (hasPrev && st.key !== 'sin') {
        deltaHtml =
          '<div class="excl-deltas">' +
            exclDeltaCard('Consultas', 'fas fa-users', es.leads || 0, es.prev_leads || 0) +
            exclDeltaCard('Visitas', 'fas fa-calendar', es.visits || 0, es.prev_visits || 0) +
            exclDeltaCard('Realizadas', 'fas fa-check', es.visits_done || 0, es.prev_visits_done || 0) +
          '</div>';
      }

      /* Comparativa vs resto del portfolio */
      var shareHtml = '';
      var totalLeads = Math.max(d.lead_total || 0, es.leads || 0);
      var totalVisits = Math.max((d.visits && d.visits.total) || 0, es.visits || 0);
      var exLead = es.leads || 0;
      var exVisit = es.visits || 0;
      if (st.key !== 'sin' && (totalLeads > 0 || totalVisits > 0)) {
        var ls = totalLeads > 0 ? Math.min(100, Math.round((exLead / totalLeads) * 100)) : 0;
        var vs = totalVisits > 0 ? Math.min(100, Math.round((exVisit / totalVisits) * 100)) : 0;
        shareHtml = '<div class="excl-share">' +
          '<div class="excl-share-card"><span class="excl-share-num">' + ls + '%</span><span class="excl-share-label">de tus consultas llegaron en exclusividad</span></div>' +
          '<div class="excl-share-card"><span class="excl-share-num">' + vs + '%</span><span class="excl-share-label">de tus visitas se dieron en exclusividad</span></div>' +
        '</div>';
      }

      /* Renovación CTA si por vencer */
      var renewHtml = '';
      if (st.key === 'por_vencer') {
        var rp = portalWaNumber(owner.phone) || (d.broker && d.broker.phone ? portalWaNumber(d.broker.phone) : null);
        renewHtml = rp
          ? '<a class="whatsapp-cta excl-renew-cta" href="https://wa.me/' + esc(rp) + '?text=' + encodeURIComponent('Hola, me comunico desde el portal de propietario de BIENENHAUS. Mi exclusividad está por vencer y quiero conversar sobre renovarla.') + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Quiero renovar mi exclusividad</a>'
          : '<div class="excl-renew-note">Tu exclusividad está por vencer. Contactá a tu asesor para renovarla.</div>';
      }

      /* WhatsApp CTA estándar */
      var phone = portalWaNumber(owner.phone);
      var waHtml = phone
        ? '<a class="whatsapp-cta" href="https://wa.me/' + esc(phone) + '?text=' + encodeURIComponent('Hola, me comunico desde el portal de propietario de BIENENHAUS.') + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Consultar por WhatsApp</a>'
        : '';

      /* Timeline filtrado al período */
      var timelineHtml = exclTimeline(activity, start, end);

      /* Semáforo de estado */
      var semColor = st.key === 'activa' ? 'verde' : (st.key === 'por_vencer' ? 'ambar' : 'rojo');
      var semTxt = st.key === 'activa' ? 'Tu exclusividad está en buen estado' : (st.key === 'por_vencer' ? 'Está por vencer — contactá a tu asesor' : (st.key === 'vencida' ? 'Venció — reanudála para mantener beneficios' : 'Sin exclusividad'));
      var semHtml = '<div class="excl-semaforo"><div class="sem-luz sem-' + semColor + '"></div><div class="sem-txt">' + esc(semTxt) + '</div></div>';

      /* Estimador de honorarios */
      var calcHtml = '';
      if (st.key !== 'sin' && props && props.length) {
        var priceV = 0, priceA = 0;
        props.forEach(function(p2){
          if (p2.status === 'venta' && p2.price_usd) priceV += p2.price_usd;
          if (p2.status === 'alquiler' && p2.price_usd) priceA += p2.price_usd;
        });
        var rowsC = [];
        if (owner.commission_sale != null && priceV > 0) {
          rowsC.push('<div class="cc-row"><span>Venta (a ' + owner.commission_sale + '%):</span><span class="cc-val">≈ ' + fmtUSD(Math.round(priceV * owner.commission_sale / 100)) + '</span></div>');
        }
        if (owner.commission_rent != null && priceA > 0) {
          rowsC.push('<div class="cc-row"><span>Alquiler mensual (a ' + owner.commission_rent + '%):</span><span class="cc-val">≈ ' + fmtUSD(Math.round(priceA * owner.commission_rent / 100)) + '</span></div>');
        }
        if (rowsC.length) {
          calcHtml = '<div class="com-calc-card"><div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;"><i class="fas fa-calculator"></i> Honorarios estimados</div>' + rowsC.join('') + '<div style="font-size:11px; color:var(--text-muted); margin-top:8px;">*Basado en precios actuales publicados.</div></div>';
        }
      }

      /* Hitos del contrato */
      var hitosHtml = '';
      if (start && end) {
        var hitos = [
          { date: start, label:'Inicio', icon:'fa-play' },
          { date: new Date(start.getTime() + 30*86400000), label:'Revisión', icon:'fa-chart-line' },
          { date: end, label:'Vencimiento', icon:'fa-flag' }
        ];
        var nxt = hitos.find(function(h){ return h.date > now; });
        hitosHtml = '<div class="section-title" style="margin-top:20px;"><i class="fas fa-flag-checkered"></i> Hitos</div><div class="hitos-row">' +
          hitos.map(function(h){
            var cls = h.date < now ? ' past' : (nxt && h.date.getTime() === nxt.date.getTime() ? ' next' : '');
            return '<div class="hito-chip' + cls + '"><i class="fas ' + h.icon + '"></i> ' + esc(h.label) + ' · ' + fmtDate(h.date) + '</div>';
          }).join('') + '</div>';
      }

      /* Estimador de renovación */
      var renHtml = '';
      if (st.key === 'por_vencer' || st.key === 'vencida') {
        var newEnd = new Date(now.getTime() + ((end - start) || 90*86400000));
        renHtml = '<div style="margin-top:12px; padding:12px 16px; background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.2); border-radius:10px; font-size:13px; color:var(--text-dim);"><i class="fas fa-info-circle"></i> Si renovás hoy, tu nueva exclusividad iría del <strong style="color:var(--blue);">' + fmtDate(now) + '</strong> al <strong style="color:var(--blue);">' + fmtDate(newEnd) + '</strong>.</div>';
      }

      var chkBox = (st.key !== 'sin')
        ? '<div style="margin-top:20px; display:flex; gap:10px; flex-wrap:wrap;"><button type="button" id="btnShareExcl" class="quick-action"><i class="fas fa-share-alt"></i> Copiar resumen</button><button type="button" id="btnPrintExcl" class="quick-action" style="background:var(--purple-dim); border-color:rgba(167,139,250,0.3); color:var(--purple);"><i class="fas fa-file-pdf"></i> Descargar resumen</button></div>'
        : '';
    /* Insertar en el banner, antes de cerrarlo */
      var bannerOpen = '<div class="excl-banner excl-state-' + stLabel.cls + '">' + '<h3><i class="fas fa-handshake"></i> ' + bannerTxt + '<span class="excl-state-badge ' + stLabel.cls + '"><i class="fas ' + (st.key === 'vencida' ? 'fa-times' : (st.key === 'por_vencer' ? 'fa-clock' : 'fa-check-circle')) + '"></i> ' + stLabel.text + '</span></h3>' + '<p>Tu propiedad está bajo gestión exclusiva de BIENENHAUS.' + (start && end ? ' Período: ' + fmtDate(start) + ' — ' + fmtDate(end) : '') + '</p>' + semHtml + countdownHtml + progressHtml + contractHtml + calcHtml + hitosHtml + renHtml + '</div>';

      $('exclContent').innerHTML =
        bannerOpen +
        '<div class="section-title"><i class="fas fa-gift"></i> Beneficios incluidos</div>' +
        '<div class="excl-benefits">' + benefitsHtml + '</div>' +
          (shareHtml ? '<div class="section-title" style="margin-top:24px;"><i class="fas fa-chart-pie"></i> Tu exclusividad en el portfolio</div>' + shareHtml : '') +
        '<div class="section-title" style="margin-top:24px;"><i class="fas fa-chart-bar"></i> Resultados en exclusividad</div>' +
        statsHtml +
        (deltaHtml || '') +
        (renewHtml || '') +
        waHtml +
        timelineHtml +
        chkBox;

      /* Botón compartir resumen de exclusividad */
      var shareEx = $('btnShareExcl');
      if (shareEx) shareEx.addEventListener('click', function(){
        var prefix = st.key !== 'sin' ? 'Mi exclusividad BIENENHAUS (' + (start ? fmtDate(start) : '-') + (end ? ' — ' + fmtDate(end) : '') + '): ' : 'Portal BIENENHAUS: ';
        var txt = prefix + fmtNum(es.leads || 0) + ' consultas, ' + fmtNum(es.visits || 0) + ' visitas' + (es.prev_leads != null ? ' (vs ' + fmtNum(es.prev_leads) + ' antes)' : '') + '.';
        if (navigator.clipboard) {
          navigator.clipboard.writeText(txt).then(function(){ portalToast('Resumen copiado'); }, function(){ portalToast('No se pudo copiar', 'error'); });
        }
      });

      var pEb = $('btnPrintExcl');
      if (pEb) pEb.addEventListener('click', function(){
        document.body.classList.add('print-excl-only');
        window.print();
        setTimeout(function(){ document.body.classList.remove('print-excl-only'); }, 500);
      });
    }

  })();
