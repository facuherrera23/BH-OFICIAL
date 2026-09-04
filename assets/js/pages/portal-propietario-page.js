  (function() {
    'use strict';

    /* ── Helpers ── */
    var esc = (window.BHUtils && BHUtils.esc) || function(s){ return s == null ? '' : String(s); };
    var safeUrl = (window.BHUtils && BHUtils.safeUrl) || function(s){ return s || ''; };
    var safeImageUrl = (window.BHUtils && BHUtils.safeImageUrl) || function(s){ return s || ''; };

    var FMT_USD = new Intl.NumberFormat('es-AR', { style:'currency', currency:'USD', maximumFractionDigits:0 });
    var FMT_NUM = new Intl.NumberFormat('es-AR');
    var FMT_DATE = new Intl.DateTimeFormat('es-AR', { day:'numeric', month:'short', year:'numeric' });
    var FMT_DATETIME = new Intl.DateTimeFormat('es-AR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });

    function fmtUSD(v) { return v != null ? FMT_USD.format(v) : '-'; }
    function fmtNum(v) { return v != null ? FMT_NUM.format(v) : '0'; }
    function fmtDate(v) { return v ? FMT_DATE.format(new Date(v)) : ''; }
    function fmtDateTime(v) { return v ? FMT_DATETIME.format(new Date(v)) : ''; }
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
      return ds + 'd';
    }

    function $(id) { return document.getElementById(id); }

    /* ── Token ── */
    var params = new URLSearchParams(location.search);
    var token = params.get('token');
    if (!token) { showError('Sin acceso', 'No se encontró el token de acceso. Pedí a tu asesor un link válido.'); return; }

    /* ── Init Supabase ── */
    if (!window.BH_CONFIG) { showError('Error de configuración', 'No se pudo inicializar el sistema.'); return; }
    var supabase = window.supabase.createClient(BH_CONFIG.SUPABASE_URL, BH_CONFIG.SUPABASE_ANON_KEY);

    /* ── Load ── */
    loadPortal();

    async function loadPortal() {
      try {
        var result = await supabase.rpc('portal_get_portal_data', { p_token: token });
        if (result.error) { showError('Error', 'No se pudieron cargar los datos. Intentá de nuevo más tarde.'); return; }
        var data = result.data;
        if (!data) { showError('Link inválido o expirado', 'El enlace que utilizaste ya no es válido o expiró. Pedí un nuevo link a tu asesor.'); return; }
        renderAll(data);
      } catch(e) { showError('Error inesperado', 'Ocurrió un error al cargar el portal.'); }
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
    function renderAll(d) {
      var owner = d.owner || {};
      var props = d.properties || [];

      /* Header badge */
      var name = owner.full_name || 'Propietario';
      $('userName').textContent = name;
      $('userAvatar').textContent = name.charAt(0).toUpperCase();
      $('userBadge').style.display = '';

      /* Tab badges */
      $('propCount').textContent = props.length || '';

      renderInicio(d, owner, props);
      renderPropiedades(d, props);
      renderExclusividad(d, owner);
      setupTabs();
      showContent();
    }

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
        });
      });
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
      var waBroker = (d.broker && d.broker.phone) ? 'https://wa.me/549' + esc(d.broker.phone.replace(/\D/g,'')) + '?text=' + encodeURIComponent('Hola ' + (d.broker.full_name || '') + ', te escribo desde mi portal de propietario en BIENENHAUS.') : '';

      /* ── A2: Resumen de cartera ── */
      var nVenta = props.filter(function(p){ return p.status === 'venta'; }).length;
      var nAlquiler = props.filter(function(p){ return p.status === 'alquiler'; }).length;
      var totalCarteraLeads = props.reduce(function(a,p){ return a + (p.leads_total || 0); }, 0);
      var totalCarteraVisitas = props.reduce(function(a,p){ return a + (p.visits_total || 0); }, 0);
      var totalCarteraProx = props.reduce(function(a,p){ return a + (p.visits_next || 0); }, 0);
      var summaryCards = [
        { icon:'fas fa-home', label:'Propiedades', val: props.length },
        { icon:'fas fa-tag', label:'En venta', val: nVenta },
        { icon:'fas fa-key', label:'En alquiler', val: nAlquiler },
        { icon:'fas fa-users', label:'Consultas', val: totalCarteraLeads },
        { icon:'fas fa-calendar-check', label:'Visitas', val: totalCarteraVisitas },
        { icon:'fas fa-arrow-right', label:'Próximas', val: totalCarteraProx }
      ];
      $('welcomeSlot').innerHTML =
        '<div class="welcome-header">' +
          '<div class="welcome-top">' +
            '<div class="welcome-greet">' +
              '<div class="wg-avatar">' + esc(name.charAt(0).toUpperCase()) + '</div>' +
              '<div class="wg-text">' +
                '<h2>Hola, ' + esc(firstName) + ' 👋</h2>' +
                '<div class="wg-date">' + esc(fmtDateLong(new Date())) + '</div>' +
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
      if (exclStateInicio.key === 'por_vencer' || exclStateInicio.key === 'vencida') {
        quickActions.push('<a class="quick-action primary" href="#exclusividad" data-go-tab="exclusividad"><i class="fas fa-handshake"></i> ' + (exclStateInicio.key === 'por_vencer' ? 'Renovar exclusividad' : 'Reactivar exclusividad') + '</a>');
      }
      $('quickActionsSlot').innerHTML = quickActions.length
        ? '<div class="quick-actions">' + quickActions.join('') + '</div>'
        : '';

      /* ── B1: Próxima visita (siempre visible) ── */
      if (d.next_visit) {
        var nv = d.next_visit;
        $('nextVisitSlot').innerHTML =
          '<div class="next-visit">' +
            '<div class="next-visit-icon"><i class="fas fa-calendar-check"></i></div>' +
            '<div class="next-visit-info">' +
              '<h3>Próxima visita programada</h3>' +
              '<p>' +
                '<span class="date">' + fmtDateShort(nv.visit_date) + '</span> &middot; ' +
                esc(nv.client_name || 'Cliente') + ' &middot; ' +
                esc(nv.property_code || '') + ' ' + esc(nv.property_title || '') +
              '</p>' +
            '</div>' +
          '</div>';
      } else {
        $('nextVisitSlot').innerHTML =
          '<div class="inicio-empty">' +
            '<i class="fas fa-calendar-check"></i>' +
            '<span>No tenés visitas programadas por ahora. Cuando agendes una, la vas a ver acá.</span>' +
          '</div>';
      }

      /* ── C1: Broker / asesor asignado ── */
      if (d.broker) {
        var b = d.broker;
        var photoHtml = b.photo_url
          ? '<img class="broker-photo" src="' + esc(safeImageUrl(b.photo_url)) + '" alt="' + esc(b.full_name) + '">'
          : '<div class="broker-photo-placeholder">' + esc((b.full_name || '?').charAt(0)) + '</div>';
        var actionsHtml = '<div class="broker-actions">';
        if (b.phone) actionsHtml += '<a href="https://wa.me/' + esc(b.phone.replace(/\D/g,'')) + '" target="_blank" rel="noopener" title="WhatsApp" style="background:var(--green-dim);color:var(--green);border-color:rgba(52,211,153,0.2);"><i class="fab fa-whatsapp"></i></a>';
        if (b.phone) actionsHtml += '<a href="tel:' + esc(b.phone) + '" title="Llamar"><i class="fas fa-phone"></i></a>';
        if (b.email) actionsHtml += '<a href="mailto:' + esc(b.email) + '" title="Email"><i class="fas fa-envelope"></i></a>';
        actionsHtml += '</div>';
        $('brokerSlot').innerHTML =
          '<div class="broker-card">' +
            photoHtml +
            '<div class="broker-info">' +
              '<div class="broker-role">Tu asesor asignado</div>' +
              '<h4>' + esc(b.full_name) + '</h4>' +
              '<p>' + esc(b.email || '') + (b.phone ? ' · ' + esc(b.phone) : '') + '</p>' +
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
        { icon:'fas fa-building', label:'Propiedades activas', value:fmtNum(nPropsActivas), sub: props.length ? (fmtNum(props.length) + ' en total') : '', cls:'' },
        { icon:'fas fa-tag', label:'En venta', value:fmtNum(nVenta), sub: nVenta ? 'en cartera' : '', cls:'' },
        { icon:'fas fa-key', label:'En alquiler', value:fmtNum(nAlquiler), sub: nAlquiler ? 'en cartera' : '', cls:'' },
        { icon:'fas fa-users', label:'Consultas totales', value:fmtNum(d.lead_total), sub: (d.lead_last30 != null && d.lead_last30 > 0) ? (fmtNum(d.lead_last30) + ' en 30 días') : '', cls:'' },
        { icon:'fas fa-calendar', label:'Visitas realizadas', value:fmtNum(visits.completadas || 0), sub: fmtNum(visits.total || 0) + ' totales', cls:'green' },
        { icon:'fas fa-calendar-plus', label:'Próximas visitas', value:fmtNum(visits.proximas || 0), sub: (visits.confirmadas || 0) + ' confirmadas', cls:'blue' }
      ];
      /* Añadir cards no-nulas solo para enriquecer sin ruido */
      if (visits.pendientes || visits.canceladas) {
        stats.push({ icon:'fas fa-hourglass-half', label:'Visitas pendientes', value:fmtNum(visits.pendientes || 0), cls:'' });
        stats.push({ icon:'fas fa-times-circle', label:'Visitas canceladas', value:fmtNum(visits.canceladas || 0), cls:'gold' });
      }
      stats.push({ icon:'fas fa-dollar-sign', label:'Cotización USD', value: d.usd_rate ? esc(fmtARS(d.usd_rate)) : '—', sub:'referencia', cls:'gold' });
      var cardHtml = stats.map(function(s) {
        return '<div class="stat-card">' +
          '<div class="label"><i class="' + esc(s.icon) + '"></i> ' + esc(s.label) + '</div>' +
          '<div class="value ' + esc(s.cls || '') + '">' + esc(s.value) + '</div>' +
          (s.sub ? '<div class="sub">' + esc(s.sub) + '</div>' : '') +
        '</div>';
      }).join('');
      $('statGrid').innerHTML = cardHtml;

      /* ── E1/E2: Origen de consultas (siempre visible) ── */
      var sourceNames = { landing_page:'Landing', ml:'Mercado Libre', whatsapp:'WhatsApp', portal:'Portal', facebook:'Facebook', instagram:'Instagram', telefono:'Teléfono', email:'Email', walk_in:'Visita directa', zernio:'Chat', otro:'Otro' };
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
              return '<div class="source-bar">' +
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
      if (act.length === 0) {
        $('activityList').innerHTML = '<li class="activity-item" style="justify-content:center;color:var(--text-dim);font-size:13px;">Sin novedades recientes</li>';
      } else {
        $('activityList').innerHTML = act.map(function(a) {
          return '<li class="activity-item">' +
            '<div class="activity-dot ' + esc(a.type) + '"></div>' +
            '<span class="activity-text">' + esc(a.text) + '</span>' +
            '<span class="activity-time">' + ago(a.at) + '</span>' +
          '</li>';
        }).join('');
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
      var pub = p.is_published === true ? (sold ? '' : 'Publicada') : 'Borrador';
      var txt = op;
      if (pub) txt += ' · ' + pub;
      return '<span class="prop-status-badge ' + cls + '"><i class="fas ' + (sold ? 'fa-check-circle' : (p.is_published ? 'fa-circle' : 'fa-pen')) + '"></i> ' + esc(txt) + '</span>';
    }
    function fmtARS(v) { return v != null ? new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 }).format(v) : ''; }
    function ownerContactWa(owner) {
      var ph = (owner && owner.phone || '').replace(/\D/g, '');
      return ph ? 'https://wa.me/549' + esc(ph) + '?text=' + encodeURIComponent('Hola, me comunico desde el portal de propietario de BIENENHAUS.') : '';
    }

    function renderPropiedades(d, props) {
      var owner = d.owner || {};
      var usdRate = d.usd_rate || 0;

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
        { key:'all', label:'Todas', icon:'fas fa-th-large' },
        { key:'venta', label:'En venta', icon:'fas fa-tag' },
        { key:'alquiler', label:'En alquiler', icon:'fas fa-key' },
        { key:'vendidas', label:'Vendidas', icon:'fas fa-check-circle' },
        { key:'ml', label:'Mercado Libre', icon:'fab fa-envira' }
      ];
      var activeFilter = 'all';
      function matchFilter(p, f) {
        switch (f) {
          case 'venta': return p.status === 'venta';
          case 'alquiler': return p.status === 'alquiler';
          case 'vendidas': return (p.status === 'vendida' || p.status === 'alquilada');
          case 'ml': return !!p.ml_item_id;
          default: return true;
        }
      }
      var filtersHtml = '<div class="prop-filters" id="propFilters">' +
        filters.map(function(f){
          return '<button class="prop-filter' + (f.key === activeFilter ? ' active' : '') + '" data-filter="' + f.key + '"><i class="' + f.icon + '"></i> ' + esc(f.label) + '</button>';
        }).join('') +
      '</div>';

      function renderList(list) {
        $('propList').innerHTML = summaryHtml + filtersHtml + list.map(propCardHtml).join('');
        bindPropEvents(list);
      }

      /* ── Card HTML ── */
      function propCardHtml(p) {
        var img = (p.image_urls && p.image_urls.length > 0) ? p.image_urls[0] : '';
        var badges = [];
        if (p.is_oportunidad) badges.push('<span class="prop-badge oportunidad"><i class="fas fa-tag"></i> Oportunidad</span>');
        if (p.is_retasada) badges.push('<span class="prop-badge retasada"><i class="fas fa-redo"></i> Retasada</span>');
        if (p.featured) badges.push('<span class="prop-badge destacada"><i class="fas fa-star"></i> Destacada</span>');
        if (p.ml_item_id) badges.push('<span class="prop-badge ml"><i class="fab fa-envira"></i> ML</span>');

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

        var pubDateHtml = p.created_at ? '<span><i class="fas fa-clock"></i> Publicada: ' + fmtDate(p.created_at) + '</span>' : '';

        /* Stats con matiz */
        var stats = [];
        if (p.leads_total != null) {
          stats.push({ icon:'fas fa-users', num: fmtNum(p.leads_total), label:'consultas', sub: (p.leads_30d != null && p.leads_30d > 0) ? (fmtNum(p.leads_30d) + ' últimos 30 días') : null });
        }
        if (p.visits_total != null) {
          stats.push({ icon:'fas fa-calendar', num: fmtNum(p.visits_total), label:'visitas', sub: (p.visits_done != null && p.visits_done > 0) ? (fmtNum(p.visits_done) + ' realizadas') : null });
        }
        if (p.visits_next != null) {
          stats.push({ icon:'fas fa-arrow-right', num: fmtNum(p.visits_next), label:'próximas', sub: null });
        }
        var statsHtml = '';
        if (stats.length) {
          statsHtml = '<div class="prop-stats-row">' + stats.map(function(s){
            return '<div class="prop-stat"><i class="' + s.icon + '"></i> <span class="count">' + s.num + '</span> ' + esc(s.label) +
              (s.sub ? '<span class="prop-stat-sub">' + esc(s.sub) + '</span>' : '') + '</div>';
          }).join('') + '</div>';
        }

        /* Timeline con created_at */
        var timeline = [];
        if (p.created_at) timeline.push({ date: p.created_at, text: 'Publicada', icon:'fa-home' });
        if (p.last_lead_at) timeline.push({ date: p.last_lead_at, text: 'Última consulta', icon:'fa-users' });
        if (p.last_visit_at) timeline.push({ date: p.last_visit_at, text: 'Última visita completada', icon:'fa-check-circle' });
        if (p.ml_last_sync) timeline.push({ date: p.ml_last_sync, text: 'Última sync ML', icon:'fa-sync' });
        var timelineHtml = '';
        if (timeline.length > 0) {
          timelineHtml = '<div class="prop-timeline">' +
            timeline.map(function(t) {
              return '<div class="prop-timeline-item">' +
                '<i class="fas ' + t.icon + '"></i>' +
                '<div class="prop-timeline-body"><span class="tl-text">' + esc(t.text) + '</span><span class="tl-date">' + fmtDate(t.date) + '</span></div>' +
              '</div>';
            }).join('') +
          '</div>';
        }

        /* Características completas */
        var feats = [
          { label:'Ambientes', val: p.rooms != null ? p.rooms : null },
          { label:'Dormitorios', val: p.bedrooms != null ? p.bedrooms : null },
          { label:'Baños', val: p.bathrooms != null ? p.bathrooms : null },
          { label:'Cochera', val: p.garage_spaces != null ? p.garage_spaces : null },
          { label:'Sup. cubierta', val: p.area_covered ? fmtNum(p.area_covered) + ' m²' : null },
          { label:'Sup. total', val: p.area_total ? fmtNum(p.area_total) + ' m²' : (p.area_m2 ? fmtNum(p.area_m2) + ' m²' : null) },
          { label:'Tipo', val: typeLabel },
          { label:'Código', val: p.property_code },
          { label:'ML ID', val: p.ml_item_id }
        ].filter(function(f){ return f.val != null && f.val !== '' && f.val !== '-'; });
        var featsHtml = '<div class="prop-detail-grid">' + feats.map(function(f){
          return '<div class="prop-detail-item"><div class="label">' + esc(f.label) + '</div><div class="val">' + esc(f.val) + '</div></div>';
        }).join('') + '</div>';

        /* Descripción */
        var descHtml = '';
        if (p.description && String(p.description).trim()) {
          descHtml = '<div class="prop-desc"><i class="fas fa-align-left"></i> <span>' + esc(p.description) + '</span></div>';
        }

        /* Video */
        var videoHtml = '';
        if (p.video_url && /youtube|youtu\.be|vimeo/ .test(p.video_url)) {
          videoHtml = '<div class="prop-video"><a href="' + esc(safeUrl(p.video_url)) + '" target="_blank" rel="noopener"><i class="fas fa-play-circle"></i> Ver video de la propiedad</a></div>';
        }

        /* Gallery */
        var imgs = p.image_urls || [];
        var galleryHtml = '';
        var lightboxData = '';
        if (imgs.length) {
          galleryHtml = '<div class="prop-gallery">' +
            imgs.slice(0, 6).map(function(u){
              return '<img class="prop-gallery-img" src="' + esc(safeImageUrl(u)) + '" alt="Foto" loading="lazy">';
            }).join('') +
            (imgs.length > 6 ? '<div class="prop-gallery-more" data-more="' + esc(p.id) + '">+' + (imgs.length - 6) + '</div>' : '') +
          '</div>';
          lightboxData = '<div class="prop-lightbox-data" data-id="' + esc(p.id) + '">' + imgs.map(function(u){
            return '<span data-src="' + esc(safeImageUrl(u)) + '"></span>';
          }).join('') + '</div>';
        }

        return '<div class="prop-card" data-id="' + esc(p.id) + '">' +
          '<div class="prop-card-header">' +
            (img ? '<img class="prop-card-thumb" src="' + esc(safeImageUrl(img)) + '" alt="' + esc(p.title || '') + '">' : '<div class="prop-card-thumb" style="background:var(--bg-card-hover);"></div>') +
            '<div class="prop-card-body">' +
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
              (badges.length ? '<div class="prop-card-badges">' + badges.join('') + '</div>' : '') +
            '</div>' +
            '<div class="prop-card-expand"><i class="fas fa-chevron-down"></i></div>' +
          '</div>' +
          '<div class="prop-card-detail">' +
            featsHtml +
            (statsHtml || '') +
            (descHtml || '') +
            (videoHtml || '') +
            (timelineHtml || '') +
            (galleryHtml || '') +
            lightboxData +
          '</div>' +
        '</div>';
      }

      function renderListFromFilter() {
        var filtered = props.filter(function(p){ return matchFilter(p, activeFilter); });
        if (!filtered.length) {
          $('propList').innerHTML = summaryHtml + filtersHtml +
            '<div class="empty-msg" style="margin-top:16px;"><i class="fas fa-filter"></i><h3>Sin resultados</h3><p>No hay propiedades en este filtro.</p></div>';
          bindFilterButtons();
          return;
        }
        renderList(filtered);
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
        document.querySelectorAll('.prop-card-header').forEach(function(h) {
          h.addEventListener('click', function() {
            h.closest('.prop-card').classList.toggle('expanded');
          });
        });
        bindFilterButtons();
        bindGalleryLightbox(list);
      }

      function bindGalleryLightbox(list) {
        document.querySelectorAll('.prop-gallery img, .prop-gallery-more').forEach(function(el) {
          el.addEventListener('click', function(e) {
            e.stopPropagation();
            e.preventDefault();
            var card = el.closest('.prop-card');
            var dataEl = card && card.querySelector('.prop-lightbox-data');
            if (!dataEl) return;
            var spans = dataEl.querySelectorAll('span');
            var imgs = Array.prototype.map.call(spans, function(s){ return s.getAttribute('data-src'); }).filter(Boolean);
            if (!imgs.length) return;
            var all = card.querySelectorAll('.prop-gallery img, .prop-gallery-more');
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
        box.innerHTML =
          '<div class="lightbox-content">' +
            '<button class="lightbox-close" aria-label="Cerrar"><i class="fas fa-times"></i></button>' +
            (imgs.length > 1 ? '<button class="lightbox-nav prev"><i class="fas fa-chevron-left"></i></button><button class="lightbox-nav next"><i class="fas fa-chevron-right"></i></button>' : '') +
            '<img class="lightbox-img" src="' + esc(safeImageUrl(imgs[cur])) + '" alt="Foto">' +
            '<div class="lightbox-count">' + (cur + 1) + ' / ' + imgs.length + '</div>' +
          '</div>';
        document.body.appendChild(box);
        box.style.display = 'flex';
        function show(i) {
          cur = (i + imgs.length) % imgs.length;
          box.querySelector('.lightbox-img').src = safeImageUrl(imgs[cur]);
          box.querySelector('.lightbox-count').textContent = (cur + 1) + ' / ' + imgs.length;
        }
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
    function exclCountdownParts(ms, full) {
      var seconds = Math.max(0, Math.floor(ms / 1000));
      var days = Math.floor(seconds / 86400);
      var hours = Math.floor((seconds % 86400) / 3600);
      var months = Math.floor(days / 30);
      var remDays = days % 30;
      if (full) {
        var yrs = Math.floor(months / 12);
        months = months % 12;
        return { yrs:yrs, months:months, days:days, hours:hours };
      }
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
        var phone = (owner.phone || '').replace(/\D/g, '');
        var waSin = phone
          ? '<a class="whatsapp-cta" href="https://wa.me/549' + esc(phone) + '?text=' + encodeURIComponent('Hola, me comunico desde el portal de propietario de BIENENHAUS. Me interesa conocer la exclusividad.') + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Consultar por exclusividad</a>'
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
        var parts = exclCountdownParts(end - now, true);
        var units = '';
        if (parts.yrs > 0) units += '<div class="excl-countdown-item"><div class="num">' + parts.yrs + '</div><div class="unit">años</div></div>';
        units += '<div class="excl-countdown-item"><div class="num">' + parts.months + '</div><div class="unit">meses</div></div>';
        units += '<div class="excl-countdown-item"><div class="num">' + parts.days + '</div><div class="unit">días</div></div>';
        countdownHtml = '<div class="excl-countdown">' + units + '</div>';
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
        progressHtml =
          '<div class="excl-progress-wrap">' +
            '<div class="excl-progress-label">' +
              '<span>' + fmtDate(start) + '</span>' +
              '<span>Día ' + dayX + ' de ' + dayY + '</span>' +
              '<span>' + fmtDate(end) + '</span>' +
            '</div>' +
            '<div class="excl-progress-track"><div class="excl-progress-fill phase-' + phase + '" style="width:' + pct + '%"></div></div>' +
            '<div class="excl-progress-days">' + Math.round(pct) + '% del período transcurrido</div>' +
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
      var totalLeads = d.lead_total || 0;
      var totalVisits = (d.visits && d.visits.total) || 0;
      var exLead = es.leads || 0;
      var exVisit = es.visits || 0;
      if (st.key !== 'sin' && (totalLeads > 0 || totalVisits > 0)) {
        var ls = totalLeads > 0 ? Math.round((exLead / totalLeads) * 100) : 0;
        var vs = totalVisits > 0 ? Math.round((exVisit / totalVisits) * 100) : 0;
        shareHtml = '<div class="excl-share">' +
          '<div class="excl-share-card"><span class="excl-share-num">' + ls + '%</span><span class="excl-share-label">de tus consultas llegaron en exclusividad</span></div>' +
          '<div class="excl-share-card"><span class="excl-share-num">' + vs + '%</span><span class="excl-share-label">de tus visitas se dieron en exclusividad</span></div>' +
        '</div>';
      }

      /* Renovación CTA si por vencer */
      var renewHtml = '';
      if (st.key === 'por_vencer') {
        var rp = (owner.phone || '').replace(/\D/g, '');
        renewHtml = rp
          ? '<a class="whatsapp-cta excl-renew-cta" href="https://wa.me/549' + esc(rp) + '?text=' + encodeURIComponent('Hola, me comunico desde el portal de propietario de BIENENHAUS. Mi exclusividad está por vencer y quiero conversar sobre renovarla.') + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Quiero renovar mi exclusividad</a>'
          : '<div class="excl-renew-note">Tu exclusividad está por vencer. Contactá a tu asesor para renovarla.</div>';
      }

      /* WhatsApp CTA estándar */
      var phone = (owner.phone || '').replace(/\D/g, '');
      var waHtml = phone
        ? '<a class="whatsapp-cta" href="https://wa.me/549' + esc(phone) + '?text=' + encodeURIComponent('Hola, me comunico desde el portal de propietario de BIENENHAUS.') + '" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Consultar por WhatsApp</a>'
        : '';

      /* Timeline filtrado al período */
      var timelineHtml = exclTimeline(activity, start, end);

      $('exclContent').innerHTML =
        '<div class="excl-banner excl-state-' + stLabel.cls + '">' +
          '<h3><i class="fas fa-handshake"></i> ' + bannerTxt +
            '<span class="excl-state-badge ' + stLabel.cls + '"><i class="fas ' + (st.key === 'vencida' ? 'fa-times' : (st.key === 'por_vencer' ? 'fa-clock' : 'fa-check-circle')) + '"></i> ' + stLabel.text + '</span>' +
          '</h3>' +
          '<p>Tu propiedad está bajo gestión exclusiva de BIENENHAUS.' + (start && end ? ' Período: ' + fmtDate(start) + ' — ' + fmtDate(end) : '') + '</p>' +
          countdownHtml +
          progressHtml +
          contractHtml +
        '</div>' +
        '<div class="section-title"><i class="fas fa-gift"></i> Beneficios incluidos</div>' +
        '<div class="excl-benefits">' + benefitsHtml + '</div>' +
        (shareHtml ? '<div class="section-title" style="margin-top:24px;"><i class="fas fa-chart-pie"></i> Tu exclusividad en el portfolio</div>' + shareHtml : '') +
        '<div class="section-title" style="margin-top:24px;"><i class="fas fa-chart-bar"></i> Resultados en exclusividad</div>' +
        statsHtml +
        (deltaHtml || '') +
        (renewHtml || '') +
        waHtml +
        timelineHtml;
    }

  })();
