const SUPABASE_URL = window.BH_CONFIG?.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.BH_CONFIG?.SUPABASE_ANON_KEY || '';
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


let _authToken = null;
// Security: validate event.origin for postMessage
const ALLOWED_ORIGINS = [
  window.location.origin,
  'https://rnldqiwwzhjnurkguihu.supabase.co',
  'https://bienenhaus.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

window.addEventListener('message', (e) => {
  // Validate origin
  if (!ALLOWED_ORIGINS.includes(e.origin)) {
    console.warn('postMessage rejected: unauthorized origin', e.origin);
    return;
  }
  if (e.data?.type === 'auth-session' && e.data?.token) {
    _authToken = e.data.token;
  }
});


const urlParams = new URLSearchParams(window.location.search);

const TASACION_ID = urlParams.get('id');

const PESOS = {
  CASA:   {label:'Casa',    vars:[['Calidad de ubicación',0.30],['Cantidad de habitaciones',0.20],['Estado de mantenimiento',0.20],['Antigüedad',0.15],['Comodidades',0.10],['Estacionamiento',0.05]]},
  DEPTO:  {label:'Depto',   vars:[['Calidad de ubicación (barrio)',0.30],['Cantidad de habitaciones',0.20],['Ubicación piso',0.15],['Antigüedad',0.15],['Comodidades (edificio)',0.12],['Ubicación planta',0.08]]},
  LOTE:   {label:'Lote',    vars:[['Calidad de ubicación',0.35],['Superficie',0.25],['Servicios',0.20],['Acceso',0.10],['Forma',0.06],['Orientación',0.04]]},
  GALPON: {label:'Galpón',  vars:[['Calidad de ubicación',0.25],['Superficie y altura libre',0.25],['Acceso',0.20],['Instalaciones',0.15],['Estado / antigüedad',0.10],['Oficinas y servicios anexos',0.05]]},
  OFICINA:{label:'Oficina', vars:[['Calidad de ubicación',0.30],['Superficie y layout',0.20],['Ubicación piso / vista',0.15],['Comodidades del edificio',0.15],['Antigüedad / estado',0.12],['Estacionamiento',0.08]]},
  LOCAL:  {label:'Local',   vars:[['Calidad de ubicación',0.35],['Frente / vidriera',0.20],['Superficie y forma',0.15],['Instalaciones',0.12],['Estado de mantenimiento',0.10],['Estacionamiento / carga y descarga',0.08]]},
  OTRO:   {label:'Otro',    vars:[['Calidad de ubicación',0.30],['Superficie',0.15],['Servicios',0.15],['Acceso',0.15],['Instalaciones',0.15],['Estado de mantenimiento',0.10]]},
};
const SLOT_ORDER = [3,2,5,0,4,1];

const NIVELES = {'Mucho Mejor':-0.75, 'Mejor':-0.3, 'Igual':0, 'Peor':0.3, 'Mucho Peor':0.75};
const NIVELES_LIST = Object.keys(NIVELES);

const RUBROS = {
  'Electricidad':        {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.010, 'Moderada (Parcial / Funcional)':0.03, 'Grave (Deterioro Estructural)':0.065,'A Nuevo (Rediseño Total)':0.10},
  'Agua Sanitaria':      {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.0075,'Moderada (Parcial / Funcional)':0.03, 'Grave (Deterioro Estructural)':0.07, 'A Nuevo (Rediseño Total)':0.11},
  'Cloacas y Desagües':  {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.0075,'Moderada (Parcial / Funcional)':0.03, 'Grave (Deterioro Estructural)':0.08, 'A Nuevo (Rediseño Total)':0.115},
  'Gas Natural':         {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.0075,'Moderada (Parcial / Funcional)':0.03, 'Grave (Deterioro Estructural)':0.09, 'A Nuevo (Rediseño Total)':0.125},
  'Techos y Cubiertas':  {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.015, 'Moderada (Parcial / Funcional)':0.045,'Grave (Deterioro Estructural)':0.115,'A Nuevo (Rediseño Total)':0.20},
  'Internet / Redes':    {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.0035,'Moderada (Parcial / Funcional)':0.01, 'Grave (Deterioro Estructural)':0.03, 'A Nuevo (Rediseño Total)':0.045},
};
const RUBRO_NIVELES = ['Óptimo / Impecable (Listo para Habitar)','Sencilla (Cosmética / Menor)','Moderada (Parcial / Funcional)','Grave (Deterioro Estructural)','A Nuevo (Rediseño Total)'];
const SERVICIOS_MAP = [
  {key:'electricidad', label:'Electricidad', rubro:'Electricidad'},
  {key:'gas',           label:'Gas',            rubro:'Gas Natural'},
  {key:'internet',      label:'Internet',       rubro:'Internet / Redes'},
  {key:'agua',          label:'Agua',           rubro:'Agua Sanitaria'},
  {key:'cloaca',        label:'Cloaca',         rubro:'Cloacas y Desagües'},
  {key:'techos',        label:'Techos y Desagües', rubro:'Techos y Cubiertas'},
];

let comparableCount = 0;
let finalized = false;
let _saving = false;

function renderServicios(){
  const grid = document.getElementById('serviciosGrid');
  grid.innerHTML = '';
  SERVICIOS_MAP.forEach(s=>{
    const div = document.createElement('div');
    div.className='field';
    div.innerHTML = '<label>'+s.label+'</label>'+
      '<select id="serv_'+s.key+'" class="serv-select">'+
        '<option value="">— Seleccionar —</option>'+
        RUBRO_NIVELES.map(n=>'<option value="'+n+'">'+n+'</option>').join('')+
      '</select>';
    grid.appendChild(div);
  });
  grid.querySelectorAll('.serv-select').forEach(sel=>sel.addEventListener('change', recalcAll));
}

function addComparable(prefill){
  comparableCount++;
  const id = comparableCount;
  const wrap = document.createElement('div');
  wrap.className = 'comp-block';
  wrap.dataset.id = id;
  wrap.dataset.included = 'true';
  wrap.innerHTML = `
    <button type="button" class="remove" data-remove-id="${id}">Quitar</button>
    <h3>Comparable N° <span class="comp-index">${id}</span></h3>
    <div class="grid cols-3">
      <div class="field"><label>Dirección</label><input type="text" class="c_direccion"></div>
      <div class="field"><label>Barrio</label><input type="text" class="c_barrio"></div>
      <div class="field"><label>Precio (U$S)</label><input type="number" class="c_precio"></div>
      <div class="field"><label>Superficie Terreno (m²)</label><input type="number" class="c_supTerreno"></div>
      <div class="field"><label>Superficie Cubierta (m²)</label><input type="number" class="c_supCubierta"></div>
      <div class="field"><label>Días en Mercado</label><input type="number" class="c_dias"></div>
      <div class="field"><label>Tipo de Construcción</label>
        <select class="c_tipoConstruccion"><option value=""></option><option>Ladrillo</option><option>Metálica</option><option>Madera</option><option>Bloques de hormigón</option><option>N/A</option></select>
      </div>
      <div class="field"><label>Antigüedad (años)</label><input type="number" class="c_antiguedad"></div>
      <div class="field"><label>Precio por m² (calculado)</label><input type="text" class="c_precioM2" readonly style="background:#1c1c1c; color:var(--ink); font-weight:700;"></div>
    </div>
    <div class="field" style="margin:14px 0;">
      <label>Página web de origen (aviso / publicación)</label>
      <div style="display:flex; gap:8px;">
        <input type="url" class="c_url" placeholder="https://..." style="flex:1;">
        <button type="button" class="add-btn c_extract" style="width:auto; white-space:nowrap; padding:9px 16px;">⇩ Extraer datos</button>
      </div>
      <div class="c_extract_status" style="font-size:11.5px; color:var(--muted); margin-top:6px; font-family:'Poppins',sans-serif;"></div>
    </div>
    <p style="font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); margin:14px 0 8px; font-family:'Poppins',sans-serif;">Foto del comparable</p>
    <div class="photo-box c_photo_box">
      <input type="file" class="c_foto_input" accept="image/*" style="display:none;">
      <img class="c_foto_preview" style="display:none;">
      <div class="photo-placeholder c_foto_placeholder">
        <span>📷 Click para subir foto</span>
      </div>
      <button type="button" class="remove c_foto_remove" style="display:none;">Quitar foto</button>
    </div>
    <p style="font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); margin:16px 0 8px; font-family:'Poppins',sans-serif;">Comparación de características</p>
    <div class="char-body"></div>
    <div class="coef-box">
      <span>Coeficiente de Condiciones</span>
      <span class="num c_coef">1.000</span>
    </div>
  `;
  document.getElementById('comparablesContainer').appendChild(wrap);
  renderCharacteristics(wrap);
  wrap.querySelectorAll('input,select').forEach(el=>el.addEventListener('input', recalcAll));
  wrap.querySelectorAll('input,select').forEach(el=>el.addEventListener('change', recalcAll));
  wrap.querySelector('.c_extract').addEventListener('click', ()=>extractFromUrl(wrap));
  setupComparablePhoto(wrap);
  recalcAll();
}

async function extractFromUrl(wrap){
  const urlInput = wrap.querySelector('.c_url');
  const status = wrap.querySelector('.c_extract_status');
  const url = urlInput.value.trim();
  if(!url){ status.textContent = 'Pegá primero el link del aviso.'; return; }
  status.textContent = 'Buscando datos en la página\u2026';

  const proxy = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);

  try{
    const res = await fetch(proxy);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const html = await res.text();

    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const titleTag = html.match(/<title>([^<]+)<\/title>/i);
    const titleText = (ogTitle && ogTitle[1]) || (titleTag && titleTag[1]) || '';

    const priceMatch = html.match(/(?:U\$S|USD|US\$)\s?([\d.,]{4,12})/i);
    const surfaceMatches = [...html.matchAll(/([\d.,]{2,6})\s?m[²2]/gi)].map(m=>m[1]);

    let found = [];

    if(titleText){
      wrap.querySelector('.c_direccion').value = wrap.querySelector('.c_direccion').value || titleText.trim().slice(0,120);
      found.push('título/dirección');
    }
    if(priceMatch){
      const num = parseFloat(priceMatch[1].replace(/\./g,'').replace(',','.'));
      if(!isNaN(num)){ wrap.querySelector('.c_precio').value = num; found.push('precio'); }
    }
    if(surfaceMatches.length){
      const num = parseFloat(surfaceMatches[0].replace(/\./g,'').replace(',','.'));
      if(!isNaN(num)){ wrap.querySelector('.c_supCubierta').value = num; found.push('superficie'); }
    }

    if(found.length){
      status.textContent = '✓ Se completaron automáticamente: ' + found.join(', ') + '. Revisá y corregí si hace falta.';
    } else {
      status.textContent = 'No se pudieron identificar datos automáticamente en esta página. Cargalos a mano.';
    }
    recalcAll();
  }catch(e){
    status.textContent = 'No se pudo leer esta página automáticamente (bloqueo del sitio o conexión). Cargá los datos a mano.';
  }
}

function removeComparable(id){
  const el = document.querySelector('.comp-block[data-id="'+id+'"]');
  if(el) el.remove();
  renumberComparables();
  recalcAll();
}
function renumberComparables(){
  document.querySelectorAll('.comp-block').forEach((el,i)=>{
    el.querySelector('.comp-index').textContent = i+1;
  });
}

function renderCharacteristics(wrap){
  const tipo = document.getElementById('f_tipo').value;
  const vars = PESOS[tipo].vars;
  const body = wrap.querySelector('.char-body');
  body.innerHTML = '<div class="char-grid"></div>';
  const grid = body.querySelector('.char-grid');
  SLOT_ORDER.forEach(idx=>{
    const [name] = vars[idx];
    const cell = document.createElement('div');
    cell.className = 'char-cell';
    cell.innerHTML =
      '<span class="label">'+name+'</span>'+
      '<select class="c_char" data-varindex="'+idx+'">'+
        '<option value="">\u2014</option>'+
        NIVELES_LIST.map(n=>'<option value="'+n+'" '+(n==='Igual'?'selected':'')+'>'+n+'</option>').join('')+
      '</select>';
    grid.appendChild(cell);
  });
  body.querySelectorAll('select').forEach(el=>{el.addEventListener('change', recalcAll);});
}

function refreshAllCharacteristics(){
  document.querySelectorAll('.comp-block').forEach(wrap=>renderCharacteristics(wrap));
  recalcAll();
}

function coefCondicionesFor(wrap){
  const tipo = document.getElementById('f_tipo').value;
  const vars = PESOS[tipo].vars;
  let product = 1;
  wrap.querySelectorAll('.c_char').forEach(sel=>{
    const idx = parseInt(sel.dataset.varindex,10);
    const peso = vars[idx][1];
    const nivel = sel.value;
    const ajuste = NIVELES[nivel] || 0;
    product *= (1 + peso*ajuste);
  });
  return product;
}

function coefDepreciacionPropia(){
  let sum=0, n=0;
  SERVICIOS_MAP.forEach(s=>{
    const sel = document.getElementById('serv_'+s.key);
    const val = sel ? sel.value : '';
    const pct = (val && RUBROS[s.rubro][val]!==undefined) ? RUBROS[s.rubro][val] : 0;
    sum += pct; n++;
  });
  return 1 - (sum/n);
}

const AMBIENTE_IDS = ['f_ambCocina','f_ambComedor','f_ambCocinaComedor','f_ambLiving','f_ambLivingComedor','f_ambEscritorio',
  'f_ambDormitorios','f_ambSuite','f_ambSuiteVestidor','f_ambDormitVestidor','f_ambBanoServicio','f_ambBano',
  'f_ambTerraza','f_ambPatio','f_ambBalcon','f_ambLavadero','f_ambCuartoGuardado','f_ambGarage'];
function recalcAmbientes(){
  let total = 0;
  AMBIENTE_IDS.forEach(id=>{
    const el = document.getElementById(id);
    total += parseFloat(el && el.value) || 0;
  });
  document.getElementById('f_ambTotalCuartos').value = total;
}

function recalcUsoTerreno(){
  const r = parseFloat(document.getElementById('f_usoResidencial').value)||0;
  const c = parseFloat(document.getElementById('f_usoComercial').value)||0;
  const i = parseFloat(document.getElementById('f_usoIndustrial').value)||0;
  const otro = Math.max(0, 100 - r - c - i);
  document.getElementById('f_usoOtro').value = otro.toFixed(1) + '%';
}

function recalcAll(){
  recalcUsoTerreno();
  recalcAmbientes();
  let precios = [];
  let coefs = [];
  document.querySelectorAll('.comp-block').forEach(wrap=>{
    const coef = coefCondicionesFor(wrap);
    wrap.querySelector('.c_coef').textContent = coef.toFixed(3);
    const precio = parseFloat(wrap.querySelector('.c_precio').value)||0;
    const supCub = parseFloat(wrap.querySelector('.c_supCubierta').value)||0;
    const supTer = parseFloat(wrap.querySelector('.c_supTerreno').value)||0;
    const base = supCub>0? supCub : supTer;
    const precioM2Field = wrap.querySelector('.c_precioM2');
    if(precioM2Field) precioM2Field.value = (precio>0 && base>0) ? 'U$S ' + (precio/base).toFixed(2) : '';
    const included = wrap.dataset.included !== 'false';
    if(precio>0 && base>0 && included){
      precios.push(precio/base);
      coefs.push(coef);
    }
  });

  const precioPromedio = precios.length ? precios.reduce((a,b)=>a+b,0)/precios.length : 0;
  const coefPromedio = coefs.length ? coefs.reduce((a,b)=>a+b,0)/coefs.length : 1;

  document.getElementById('v_precioPromedio').textContent = 'U$S ' + precioPromedio.toFixed(2);
  document.getElementById('v_coefPromedio').textContent = coefPromedio.toFixed(3);

  const precioAjustado = precioPromedio * coefPromedio;

  const terrM2 = parseFloat(document.getElementById('f_supTerreno').value)||0;
  const terrPrecio = parseFloat(document.getElementById('v_terrenoPrecio').value)||0;
  const terrTotal = terrM2*terrPrecio;
  document.getElementById('v_terrenoM2').textContent = terrM2? terrM2.toLocaleString('es-AR') : '—';
  document.getElementById('v_terrenoTotal').textContent = terrTotal? 'U$S '+terrTotal.toLocaleString('es-AR',{maximumFractionDigits:0}) : '—';

  const depreciacion = coefDepreciacionPropia();
  document.getElementById('v_depreciacionServicios').textContent = depreciacion.toFixed(3);
  const cubM2 = parseFloat(document.getElementById('f_supConstruida').value)||0;
  const precioCubiertaM2 = precioAjustado * depreciacion;
  const cubTotal = cubM2 * precioCubiertaM2;
  document.getElementById('v_cubiertaM2').textContent = cubM2? cubM2.toLocaleString('es-AR') : '—';
  document.getElementById('v_cubiertaPrecio').textContent = precioCubiertaM2? 'U$S '+precioCubiertaM2.toFixed(2) : '—';
  document.getElementById('v_cubiertaTotal').textContent = cubTotal? 'U$S '+cubTotal.toLocaleString('es-AR',{maximumFractionDigits:0}) : '—';

  const valorFinal = terrTotal + cubTotal;
  document.getElementById('v_valorFinal').textContent = 'U$S ' + valorFinal.toLocaleString('es-AR',{maximumFractionDigits:0});

  renderAnalisisComparativo();
}

function collectFormData(){
  const data = {tipo: document.getElementById('f_tipo').value, fields:{}, servicios:{}, comparables:[], valuacion:{}, photo: photoDataUrl};
  document.querySelectorAll('main [id^="f_"]:not(#f_fotoFachada)').forEach(el=>{ data.fields[el.id] = el.value; });
  SERVICIOS_MAP.forEach(s=>{ data.servicios[s.key] = document.getElementById('serv_'+s.key).value; });
  document.querySelectorAll('.comp-block').forEach(wrap=>{
    const comp = {
      url: wrap.querySelector('.c_url').value,
      direccion: wrap.querySelector('.c_direccion').value,
      barrio: wrap.querySelector('.c_barrio').value,
      precio: wrap.querySelector('.c_precio').value,
      supTerreno: wrap.querySelector('.c_supTerreno').value,
      supCubierta: wrap.querySelector('.c_supCubierta').value,
      dias: wrap.querySelector('.c_dias').value,
      tipoConstruccion: wrap.querySelector('.c_tipoConstruccion').value,
      antiguedad: wrap.querySelector('.c_antiguedad').value,
      photo: wrap.dataset.photo || null,
      chars: Array.from(wrap.querySelectorAll('.c_char')).map(s=>s.value)
    };
    data.comparables.push(comp);
  });
  ['v_terrenoPrecio'].forEach(id=>{ data.valuacion[id] = document.getElementById(id).value; });
  return data;
}

function applyFormData(data){
  if(!data) return;
  if(data.fields){
    Object.keys(data.fields).forEach(id=>{
      if(id === 'f_fotoFachada') return;
      const el = document.getElementById(id);
      if(el) el.value = data.fields[id];
    });
  }
  if(data.photo){ setPhoto(data.photo); }
  renderServicios();
  if(data.servicios){
    Object.keys(data.servicios).forEach(k=>{
      const el = document.getElementById('serv_'+k);
      if(el) el.value = data.servicios[k];
    });
  }
  document.getElementById('comparablesContainer').innerHTML='';
  comparableCount = 0;
  if(data.comparables && data.comparables.length){
    data.comparables.forEach(c=>{
      addComparable();
      const wrap = document.querySelector('.comp-block:last-child');
      wrap.querySelector('.c_url').value = c.url||'';
      wrap.querySelector('.c_direccion').value = c.direccion||'';
      wrap.querySelector('.c_barrio').value = c.barrio||'';
      wrap.querySelector('.c_precio').value = c.precio||'';
      wrap.querySelector('.c_supTerreno').value = c.supTerreno||'';
      wrap.querySelector('.c_supCubierta').value = c.supCubierta||'';
      wrap.querySelector('.c_dias').value = c.dias||'';
      wrap.querySelector('.c_tipoConstruccion').value = c.tipoConstruccion||'';
      wrap.querySelector('.c_antiguedad').value = c.antiguedad||'';
      if(c.photo) setComparablePhotoFromData(wrap, c.photo);
      const chars = wrap.querySelectorAll('.c_char');
      (c.chars||[]).forEach((v,i)=>{ if(chars[i]) chars[i].value = v; });
    });
  } else {
    addComparable();
  }
  if(data.valuacion){
    Object.keys(data.valuacion).forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.value = data.valuacion[id];
    });
  }
  recalcAll();
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2600);
}

function setLocked(locked){
  finalized = locked;
  document.getElementById('formFieldset').disabled = locked;
  document.getElementById('btnFinish').disabled = locked;
  document.getElementById('btnEdit').disabled = !locked;
  document.getElementById('addComparable').style.display = locked? 'none':'block';
  const bar = document.getElementById('statusBar');
  const txt = document.getElementById('statusText');
  if(locked){
    bar.classList.add('locked');
    txt.textContent = 'Documento finalizado (solo lectura)';
  } else {
    bar.classList.remove('locked');
    txt.textContent = 'Documento en edición';
  }
}

async function saveToSupabase(finalize){
  if(_saving) return;
  if(!_authToken){
    showToast('Sesión no válida. Volvé al panel y abrí de nuevo.');
    return;
  }
  _saving = true;
  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';

  try{
    const formData = collectFormData();
    const title = formData.fields.f_direccion || formData.fields.f_barrio || 'Sin título';
    const status = finalize ? 'finalized' : 'draft';

    if(TASACION_ID){
      const { error } = await _supabase.from('tasaciones').update({
        title, data: formData, status, updated_at: new Date().toISOString()
      }).eq('id', TASACION_ID);
      if(error) throw error;
    } else {
      const { data, error } = await _supabase.from('tasaciones').insert({
        title, data: formData, status
      }).select('id').single();
      if(error) throw error;
      if(data && data.id){
        const url = new URL(window.location);
        url.searchParams.set('id', data.id);
        window.history.replaceState({}, '', url);
      }
    }
    document.getElementById('lastSaved').textContent = 'Guardado ' + new Date().toLocaleTimeString('es-AR');
    showToast(finalize ? 'Tasación finalizada y guardada' : 'Guardado correctamente');
    if (finalize) {
      window.parent?.postMessage({ type: 'tasaciones-finalized', id: TASACION_ID }, window.location.origin);
    }
  }catch(e){
    showToast('Error al guardar: ' + (e.message || e));
  }finally{
    _saving = false;
    btn.disabled = false;
    btn.innerHTML = '💾 Guardar';
  }
}

document.getElementById('btnSave').addEventListener('click', ()=> saveToSupabase(false));

document.getElementById('btnFinish').addEventListener('click', async ()=>{
  await saveToSupabase(true);
  setLocked(true);
});

document.getElementById('btnEdit').addEventListener('click', ()=>{
  setLocked(false);
  showToast('Documento habilitado para edición');
});

document.getElementById('btnPdf').addEventListener('click', ()=>{
  window.print();
});

document.getElementById('addComparable').addEventListener('click', ()=>addComparable());

/* --- Security hardening: sin handlers inline (CSP-safe), postMessage con targetOrigin explicito --- */
const _bhEsc = (s) => (window.BHUtils && typeof window.BHUtils.esc === 'function') ? window.BHUtils.esc(s) : '';
document.getElementById('btnBack').addEventListener('click', () => {
  try {
    window.parent?.postMessage({ type: 'tasaciones-back' }, window.location.origin);
  } catch (err) {
    console.error('[TAS] btnBack postMessage failed:', err);
  }
});
document.getElementById('comparablesContainer').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-id]');
  if (!btn) return;
  const rid = parseInt(btn.dataset.removeId, 10);
  if (!Number.isNaN(rid)) removeComparable(rid);
});
const brandLogoEl = document.getElementById('brandLogo');
if (brandLogoEl) brandLogoEl.addEventListener('error', () => {
  brandLogoEl.src = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22><rect fill=%22%2314b8a6%22 width=%2248%22 height=%2248%22 rx=%228%22/><text x=%2224%22 y=%2232%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2220%22 font-weight=%22bold%22>BH</text></svg>";
});
const footerLogoEl = document.querySelector('footer img');
if (footerLogoEl) footerLogoEl.addEventListener('error', () => { footerLogoEl.style.display = 'none'; });

let acChartInstance = null;
function renderAnalisisComparativo(){
  const tbody = document.getElementById('ac_tbody');
  if(!tbody) return;
  const dispersion = parseFloat(document.getElementById('ac_dispersion').value) || 0;
  tbody.innerHTML = '';

  const rows = [];
  document.querySelectorAll('.comp-block').forEach((wrap,i)=>{
    const precio = parseFloat(wrap.querySelector('.c_precio').value)||0;
    const supCub = parseFloat(wrap.querySelector('.c_supCubierta').value)||0;
    const supTer = parseFloat(wrap.querySelector('.c_supTerreno').value)||0;
    const base = supCub>0? supCub : supTer;
    const precioM2 = (precio>0 && base>0) ? precio/base : 0;
    const included = wrap.dataset.included !== 'false';
    rows.push({wrap, label:'Comparable '+(i+1), precioM2, included});
  });

  rows.forEach(r=>{
    const low = r.precioM2 * (1 - dispersion/100);
    const high = r.precioM2 * (1 + dispersion/100);
    const tr = document.createElement('tr');
    if(!r.included) tr.classList.add('ac-excluded');
    tr.innerHTML =
      '<td><input type="checkbox" class="ac_check" '+(r.included?'checked':'')+'></td>'+
      '<td>'+r.label+'</td>'+
      '<td>'+(r.precioM2? 'U$S '+r.precioM2.toFixed(2) : '—')+'</td>'+
      '<td>'+(r.precioM2? 'U$S '+low.toFixed(2) : '—')+'</td>'+
      '<td>'+(r.precioM2? 'U$S '+high.toFixed(2) : '—')+'</td>';
    tr.querySelector('.ac_check').addEventListener('change', (e)=>{
      r.wrap.dataset.included = e.target.checked ? 'true' : 'false';
      recalcAll();
    });
    tbody.appendChild(tr);
  });

  const included = rows.filter(r=>r.included && r.precioM2>0);
  let valMin=0, valProm=0, valMax=0;
  if(included.length){
    const vals = included.map(r=>r.precioM2);
    valProm = vals.reduce((a,b)=>a+b,0)/vals.length;
    valMin = Math.min(...vals) * (1 - dispersion/100);
    valMax = Math.max(...vals) * (1 + dispersion/100);
  }
  document.getElementById('ac_valMin').textContent = valMin? 'U$S '+valMin.toFixed(2) : '—';
  document.getElementById('ac_valProm').textContent = valProm? 'U$S '+valProm.toFixed(2) : '—';
  document.getElementById('ac_valMax').textContent = valMax? 'U$S '+valMax.toFixed(2) : '—';

  const canvas = document.getElementById('ac_chart');
  if(!canvas || typeof Chart === 'undefined') return;
  const labels = rows.map(r=>r.label).concat(included.length ? ['Promedio'] : []);
  const dataRanges = rows.map(r=> r.precioM2 ? [r.precioM2*(1-dispersion/100), r.precioM2*(1+dispersion/100)] : [0,0]);
  if(included.length) dataRanges.push([valMin, valMax]);
  const colors = rows.map(r=> r.included ? '#14b8a6' : '#555').concat(included.length ? ['#f59e0b'] : []);

  if(acChartInstance) acChartInstance.destroy();
  acChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Rango U$S/m² (± '+dispersion+'%)',
        data: dataRanges,
        backgroundColor: colors,
        borderRadius: 4,
        barPercentage: 0.6
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display:false },
        tooltip: {
          callbacks:{
            label: (ctx)=> 'U$S ' + ctx.raw[0].toFixed(2) + ' \u2014 U$S ' + ctx.raw[1].toFixed(2) + ' /m²'
          }
        }
      },
      scales: {
        x: { ticks:{color:'#b8b3aa'}, grid:{color:'#2a2a2a'}, title:{display:true, text:'U$S / m²', color:'#b8b3aa'} },
        y: { ticks:{color:'#f5f5f4', font:{family:'Poppins'}}, grid:{color:'#2a2a2a'} }
      }
    }
  });
}
document.getElementById('ac_dispersion').addEventListener('input', renderAnalisisComparativo);

let photoDataUrl = null;
function setPhoto(dataUrl){
  photoDataUrl = dataUrl;
  const img = document.getElementById('photoPreview');
  img.src = dataUrl;
  img.style.display = 'block';
  document.getElementById('photoPlaceholder').style.display = 'none';
  document.getElementById('photoRemove').style.display = 'block';
}
function clearPhoto(){
  photoDataUrl = null;
  const img = document.getElementById('photoPreview');
  img.style.display = 'none';
  img.src = '';
  document.getElementById('photoPlaceholder').style.display = 'flex';
  document.getElementById('photoRemove').style.display = 'none';
  document.getElementById('f_fotoFachada').value = '';
}
document.getElementById('photoBox').addEventListener('click', (e)=>{
  if(e.target.id === 'photoRemove') return;
  document.getElementById('f_fotoFachada').click();
});
document.getElementById('f_fotoFachada').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=> setPhoto(reader.result);
  reader.readAsDataURL(file);
});
document.getElementById('photoRemove').addEventListener('click', (e)=>{
  e.stopPropagation();
  clearPhoto();
});
document.getElementById('f_tipo').addEventListener('change', refreshAllCharacteristics);

let leafletMapInstance = null;
const MARKER_COLOR_PROPIEDAD = '#2563eb';
const MARKER_COLOR_COMPARABLE = '#dc2626';

function buildPropiedadQuery(){
  const parts = [
    document.getElementById('f_direccion').value,
    document.getElementById('f_barrio').value,
    document.getElementById('f_localidad').value,
    document.getElementById('f_provincia').value
  ].filter(Boolean);
  return parts.join(', ');
}

const _geocodeCache = new Map(); // query normalizada -> {lat, lon} | null

async function geocode(query){
  const key = query.trim().toLowerCase();
  if(_geocodeCache.has(key)) return _geocodeCache.get(key);

  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
  const res = await fetch(url, {headers:{'Accept':'application/json'}});
  if(!res.ok) throw new Error('geocode failed');
  const data = await res.json();
  const result = data.length ? {lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon)} : null;
  _geocodeCache.set(key, result);
  return result;
}

async function updateMainMap(){
  const statusEl = document.getElementById('mapStatus');
  const legendEl = document.getElementById('mapLegend');
  const container = document.getElementById('leafletMap');
  const placeholder = document.getElementById('mainMapPlaceholder');

  const points = [];
  const propQuery = buildPropiedadQuery();
  if(propQuery) points.push({label:'Propiedad', query: propQuery, color: MARKER_COLOR_PROPIEDAD});

  document.querySelectorAll('.comp-block').forEach((wrap,i)=>{
    const dir = wrap.querySelector('.c_direccion').value;
    const barrio = wrap.querySelector('.c_barrio').value;
    const q = [dir, barrio].filter(Boolean).join(', ');
    if(q) points.push({label:'Comparable '+(i+1), query:q, color: MARKER_COLOR_COMPARABLE});
  });

  if(!points.length){
    statusEl.textContent = 'Cargá al menos una dirección (propiedad o comparable).';
    return;
  }

  statusEl.textContent = 'Ubicando ' + points.length + ' dirección(es)...';
  placeholder.style.display = 'none';

  if(!leafletMapInstance){
    container.innerHTML = '';
    leafletMapInstance = L.map(container).setView([-31.4201,-64.1888], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(leafletMapInstance);
  } else {
    leafletMapInstance.eachLayer(layer=>{ if(layer instanceof L.Marker) leafletMapInstance.removeLayer(layer); });
  }

  const bounds = [];
  legendEl.innerHTML = '';
  let okCount = 0;

  for(const p of points){
    const wasCached = _geocodeCache.has(p.query.trim().toLowerCase());
    try{
      const geo = await geocode(p.query);
      if(!geo){ continue; }
      const icon = L.divIcon({
        className:'', html:'<div style="width:16px;height:16px;border-radius:50%;background:'+p.color+';border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.2)"></div>',
        iconSize:[16,16], iconAnchor:[8,8]
      });
      L.marker([geo.lat, geo.lon], {icon}).addTo(leafletMapInstance).bindPopup('<b>'+_bhEsc(p.label)+'</b><br>'+_bhEsc(p.query));
      bounds.push([geo.lat, geo.lon]);
      okCount++;
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = '<span class="swatch" style="background:'+p.color+'"></span>'+_bhEsc(p.label);
      legendEl.appendChild(chip);
    }catch(e){}
    /* Solo esperamos si hubo un request real a Nominatim (respeta su limite de 1 req/seg) */
    if(!wasCached) await new Promise(r=>setTimeout(r, 1100));
  }

  if(bounds.length){
    leafletMapInstance.fitBounds(bounds, {padding:[30,30]});
    statusEl.textContent = okCount+' de '+points.length+' ubicación(es) encontradas.';
  } else {
    statusEl.textContent = 'No se pudo ubicar ninguna dirección. Revisá que estén completas (calle, barrio, ciudad).';
    placeholder.style.display = 'flex';
  }
  setTimeout(()=>{ if(leafletMapInstance) leafletMapInstance.invalidateSize(); }, 200);
}
document.getElementById('btnUpdateMap').addEventListener('click', updateMainMap);

function setupComparablePhoto(wrap){
  const box = wrap.querySelector('.c_photo_box');
  const input = wrap.querySelector('.c_foto_input');
  const img = wrap.querySelector('.c_foto_preview');
  const placeholder = wrap.querySelector('.c_foto_placeholder');
  const removeBtn = wrap.querySelector('.c_foto_remove');

  box.addEventListener('click', (e)=>{ if(e.target !== removeBtn) input.click(); });
  input.addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      wrap.dataset.photo = reader.result;
      img.src = reader.result;
      img.style.display = 'block';
      placeholder.style.display = 'none';
      removeBtn.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });
  removeBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    delete wrap.dataset.photo;
    img.style.display = 'none'; img.src = '';
    placeholder.style.display = 'flex';
    removeBtn.style.display = 'none';
    input.value = '';
  });
}
function setComparablePhotoFromData(wrap, dataUrl){
  if(!dataUrl) return;
  wrap.dataset.photo = dataUrl;
  const img = wrap.querySelector('.c_foto_preview');
  img.src = dataUrl; img.style.display = 'block';
  wrap.querySelector('.c_foto_placeholder').style.display = 'none';
  wrap.querySelector('.c_foto_remove').style.display = 'block';
}
document.querySelectorAll('main input, main select, main textarea').forEach(el=>{
  el.addEventListener('input', recalcAll);
});

function makeAccordions(){
  document.querySelectorAll('section.card').forEach(section=>{
    const h2 = section.querySelector('h2');
    if(!h2 || h2.querySelector('.accordion-arrow')) return;
    const body = document.createElement('div');
    body.className = 'accordion-body';
    let sibling = h2.nextSibling;
    while(sibling){
      const next = sibling.nextSibling;
      body.appendChild(sibling);
      sibling = next;
    }
    section.appendChild(body);
    const arrow = document.createElement('span');
    arrow.className = 'accordion-arrow';
    arrow.textContent = '\u25BE';
    h2.appendChild(arrow);
    h2.addEventListener('click', ()=>{
      section.classList.toggle('collapsed');
    });
  });
}

async function init(){
  document.getElementById('dateStamp').textContent = new Date().toLocaleDateString('es-AR', {year:'numeric',month:'long',day:'numeric'});
  document.querySelectorAll('.field label').forEach(l=>{ l.title = l.textContent; });
  renderServicios();

  setTimeout(() => {
    if(!_authToken){
      const statusBar = document.getElementById('statusBar');
      if(statusBar){
        statusBar.style.background = '#7f1d1d';
        statusBar.style.display = 'block';
      }
      const statusText = document.getElementById('statusText');
      if(statusText) statusText.textContent = '⚠ Sin sesión — Abrí desde el panel de administración';
    }
  }, 2000);

  if(TASACION_ID){
    try{
      const { data, error } = await _supabase.from('tasaciones').select('data, status').eq('id', TASACION_ID).single();
      if(error) throw error;
      if(data && data.data){
        applyFormData(data.data);
        if(data.status === 'finalized') setLocked(true);
        showToast('Tasación cargada correctamente');
      } else {
        addComparable();
      }
    }catch(e){
      console.error('Error loading tasacion:', e);
      addComparable();
    }
  } else {
    addComparable();
  }
  recalcAll();
  makeAccordions();
}

init();

/* Auto-print when opened with ?print=1 (PDF export from admin) */
if (new URLSearchParams(window.location.search).get('print') === '1') {
  /* Wait for data to load then trigger print dialog */
  const _origSave = saveToSupabase;
  const _autoPrintCheck = setInterval(() => {
    /* Check if the form has been populated (data loaded) */
    const hasData = document.getElementById('comparablesContainer')?.children?.length > 0
      || document.getElementById('dirDomicilio')?.value;
    if (hasData) {
      clearInterval(_autoPrintCheck);
      setTimeout(() => window.print(), 600);
    }
  }, 500);
  /* Fallback: print after 4s even if data check hasn't triggered */
  setTimeout(() => { clearInterval(_autoPrintCheck); window.print(); }, 4000);
}
