/* Encuesta de visita (HOJA DE VISITA digital) — página pública por token.
 * - Autoguardado: cada cambio se persiste con debounce (900 ms).
 * - Draft en localStorage: si se cierra sin conexión, al reabrir se recupera y empuja.
 * - Flush con fetch keepalive en pagehide/visibilitychange: "si no guarda, se guardó igual".
 * - "Enviar respuestas" finaliza (lock server-side); reabrir muestra el gracias.
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token');

  var SCORES = ['ubicacion', 'tamano', 'distribucion', 'calidad', 'precio', 'conservacion', 'general'];
  var TEXTS = ['por_que', 'mas_gusto', 'menos_gusto'];
  var DRAFT_KEY = 'bh_survey_' + (token || 'x');
  var SAVE_DEBOUNCE_MS = 900;

  var supabaseClient = null;
  var DATA = null;
  var ANSWERS = {};
  var touched = {};      // sliders: solo se guardan los que se movieron
  var FINALIZED = false;
  var dirty = false;
  var saving = false;
  var pendingSave = false;
  var saveTimer = null;

  function $(id) { return document.getElementById(id); }

  function showError(title, msg) {
    $('loadingState').style.display = 'none';
    $('formState').style.display = 'none';
    $('thankState').style.display = 'none';
    $('errorState').style.display = '';
    $('errorTitle').textContent = title;
    $('errorMsg').textContent = msg;
  }

  function showThanks() {
    $('loadingState').style.display = 'none';
    $('formState').style.display = 'none';
    $('errorState').style.display = 'none';
    $('thankState').style.display = '';
  }

  function setStatus(text, kind, sticky) {
    var el = $('saveStatus');
    el.className = 'save-status' + (kind ? ' ' + kind : '');
    el.innerHTML = '';
    if (text) {
      var i = document.createElement('i');
      i.className = 'fas ' + (kind === 'ok' ? 'fa-check-circle' : kind === 'err' ? 'fa-exclamation-circle' : kind === 'warn' ? 'fa-cloud-arrow-down' : 'fa-cloud-arrow-up');
      el.appendChild(i);
      el.appendChild(document.createTextNode(' ' + text));
    }
    if (!sticky && kind === 'ok') {
      setTimeout(function () { if (!dirty && !saving) setStatus('', ''); }, 2600);
    }
  }

  /* ── Draft local (supervive cierres sin conexión) ── */
  function writeDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ answers: collectAnswers(), ts: Date.now() })); } catch (_) {}
  }
  function readDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  }

  /* Estado completo y saneado (el server vuelve a sanitizar igual) */
  function collectAnswers() {
    var out = {};
    SCORES.forEach(function (k) {
      if (touched[k]) {
        var n = parseInt($('s_' + k).value, 10);
        if (n >= 1 && n <= 10) out[k] = n;
      }
    });
    if (ANSWERS.compraria) out.compraria = ANSWERS.compraria;
    TEXTS.forEach(function (k) {
      var v = ($('t_' + k).value || '').trim();
      if (v) out[k] = v.slice(0, 1000);
    });
    return out;
  }

  function hasAnswers() { return Object.keys(collectAnswers()).length > 0; }

  /* ── Guardado ── */
  function scheduleSave() {
    dirty = true;
    writeDraft();
    setStatus('Guardando…', '');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { save(false); }, SAVE_DEBOUNCE_MS);
  }

  function handleSaveResult(data) {
    if (data && data.ok) {
      if (data.finalized) {
        FINALIZED = true;
        clearDraft();
        showThanks();
        return;
      }
      dirty = false;
      setStatus('Guardado ✓', 'ok');
    } else if (data && data.error === 'ya respondida') {
      FINALIZED = true;
      clearDraft();
      showThanks();
    } else if (data && data.error === 'encuesta no disponible') {
      showError('Encuesta no disponible', 'Esta encuesta ya no está activa.');
    } else {
      setStatus('Sin guardar — reintentando…', 'err');
      retryWhenPossible();
    }
  }

  function retryWhenPossible() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { if (dirty) save(false); }, 8000);
  }

  async function save(finalize) {
    if (FINALIZED) return;
    if (saving) { pendingSave = true; return; }
    var payload = collectAnswers();
    if (!finalize && !Object.keys(payload).length) { dirty = false; return; } // nada que guardar aún
    saving = true;
    try {
      var res = await supabaseClient.rpc('survey_submit_by_token', {
        p_token: token, p_answers: payload, p_finalize: !!finalize
      });
      saving = false;
      if (pendingSave) { pendingSave = false; save(false); return; }
      if (res.error) { handleSaveResult(null); return; }
      handleSaveResult(res.data);
    } catch (e) {
      saving = false;
      if (pendingSave) { pendingSave = false; save(false); return; }
      handleSaveResult(null);
    }
  }

  /* Flush de emergencia al cerrar la pestaña: fetch keepalive contra PostgREST
   * (mismo endpoint que usa supabase-js, con la anon key — no es un secreto). */
  function flushKeepalive() {
    if (FINALIZED || !dirty || !window.BH_CONFIG) return;
    var payload = collectAnswers();
    if (!Object.keys(payload).length) return;
    try {
      fetch(window.BH_CONFIG.SUPABASE_URL + '/rest/v1/rpc/survey_submit_by_token', {
        method: 'POST',
        keepalive: true,
        headers: {
          'apikey': window.BH_CONFIG.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + window.BH_CONFIG.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_token: token, p_answers: payload, p_finalize: false })
      }).catch(function () {});
    } catch (_) {}
  }

  window.addEventListener('pagehide', flushKeepalive);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) flushKeepalive();
  });
  window.addEventListener('online', function () {
    if (dirty && !FINALIZED) { setStatus('Conexión recuperada — guardando…', ''); save(false); }
  });
  window.addEventListener('offline', function () {
    if (!FINALIZED) setStatus('Sin conexión — no pierdas nada, se guarda al volver', 'warn', true);
  });

  /* ── Render del formulario ── */
  function fillValueDisplays(k) {
    var v = ANSWERS[k];
    var el = $('v_' + k);
    if (v != null) {
      el.textContent = v + '/10';
      el.className = 'score-val';
    } else {
      el.textContent = '—';
      el.className = 'score-val is-empty';
    }
  }

  function setCompraria(val) {
    ANSWERS.compraria = val || undefined;
    var chips = $('comprariaChips').querySelectorAll('.chip');
    chips.forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.v === val);
    });
  }

  function renderForm() {
    var p = DATA.property || {};
    var firstName = DATA.client_first_name || '';
    $('propTitle').textContent = p.title || 'Propiedad';
    $('propSub').textContent = [p.zone, p.address].filter(Boolean).join(' · ') || (p.property_code || '');
    $('surveyGreeting').textContent = (firstName ? firstName + ', t' : 'T') +
      'u opinión sobre la visita nos ayuda a mejorar el servicio. Puntúa de 1 a 10 y contanos lo que pensás.';

    SCORES.forEach(function (k) {
      var slider = $('s_' + k);
      var val = ANSWERS[k];
      if (val != null) { slider.value = val; touched[k] = true; }
      fillValueDisplays(k);
      slider.addEventListener('input', function () {
        touched[k] = true;
        ANSWERS[k] = parseInt(slider.value, 10);
        fillValueDisplays(k);
        scheduleSave();
      });
    });

    setCompraria(ANSWERS.compraria || null);

    $('comprariaChips').querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        var isActive = c.classList.contains('is-active');
        setCompraria(isActive ? null : c.dataset.v);
        scheduleSave();
      });
    });

    TEXTS.forEach(function (k) {
      var ta = $('t_' + k);
      if (ANSWERS[k]) ta.value = ANSWERS[k];
      ta.addEventListener('input', scheduleSave);
    });

    var btn = $('btnSubmit');
    btn.addEventListener('click', async function () {
      if (FINALIZED) return;
      if (!hasAnswers() && !confirm('No respondiste nada. ¿Enviar igual?')) return;
      else if (hasAnswers() && !confirm('¿Enviar tus respuestas? Después no se pueden cambiar.')) return;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner spinner"></i> Enviando…';
      dirty = true; /* fuerza flush de lo último tipeado */
      await save(true);
      if (!FINALIZED) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar respuestas';
        setStatus('No se pudo enviar — reintentá en un momento', 'err');
      }
    });

    setStatus('', '');
    $('loadingState').style.display = 'none';
    $('errorState').style.display = 'none';
    $('formState').style.display = '';
  }

  /* ── Init ── */
  (async function init() {
    if (!token) { showError('Link inválido', 'Este enlace no es válido.'); return; }
    if (!window.BH_CONFIG || !window.BH_CONFIG.SUPABASE_URL || !window.BH_CONFIG.SUPABASE_ANON_KEY) {
      showError('Configuración no disponible', 'No se pudo inicializar el sistema.');
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      showError('Error de sistema', 'No se pudo cargar el motor de datos.');
      return;
    }
    supabaseClient = window.supabase.createClient(window.BH_CONFIG.SUPABASE_URL, window.BH_CONFIG.SUPABASE_ANON_KEY);

    var res;
    try {
      res = await supabaseClient.rpc('survey_get_by_token', { p_token: token });
    } catch (e) {
      showError('Error de conexión', 'No se pudo cargar la encuesta. Probá de nuevo.');
      return;
    }
    if (res.error || !res.data) { showError('Error', 'No se pudo cargar la encuesta.'); return; }
    if (!res.data.available) { showError('Link inválido o expirado', 'Este enlace ya no está activo. Pedí uno nuevo a tu asesor.'); return; }

    DATA = res.data;
    var srv = (DATA.survey && DATA.survey.answers) || {};
    FINALIZED = !!(DATA.survey && DATA.survey.finalized);
    ANSWERS = {};

    if (FINALIZED) { clearDraft(); showThanks(); return; }

    /* Merge: respuestas del server + draft local (el local gana campo a campo —
       es lo último que tipeó el usuario aunque no llegara a sincronizarse). */
    Object.keys(srv).forEach(function (k) { ANSWERS[k] = srv[k]; if (SCORES.indexOf(k) !== -1) touched[k] = true; });
    var draft = readDraft();
    var pushed = false;
    if (draft && draft.answers) {
      Object.keys(draft.answers).forEach(function (k) {
        if (draft.answers[k] !== srv[k]) { ANSWERS[k] = draft.answers[k]; pushed = true; }
      });
    }

    renderForm();

    /* El draft traía cambios que el server no tiene → empujarlos ya. */
    if (pushed) { dirty = true; save(false); }
  })();
})();
