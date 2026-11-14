/* ============================================================
   BIENENHAUS PROPIEDADES — Administración de Alquileres
   ------------------------------------------------------------
   Módulo integrado en el admin panel con Supabase backend.
   Multi-usuario: cada asesor ve solo sus propiedades.
   Persistencia en BD (no localStorage) para trabajo en equipo.
   ============================================================ */
(function () {
  'use strict';

  // ----- CONSTANTES Y ESTADO -----
  const MES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const SV_KEYS = ['agua','luz','gas','rentas','muni','expensas'];
  const SV_LABELS = { agua:'Agua', luz:'Luz', gas:'Gas', rentas:'Rentas provincial', muni:'Impuesto municipal', expensas:'Expensas ordinarias' };
  const FMT = n => '$ ' + (+n||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});

  let S = null;                    // Estado principal (cargado de Supabase)
  let currentUser = null;          // Usuario autenticado
  let currentProfile = null;       // Perfil del usuario
  let vista = 'res';               // res | prop | hist | config
  let HM = null;                   // Mes seleccionado en historial (YYYY-MM)
  let editingPropId = null;        // Propiedad en edición
  let DIRTY = false;
  let LAST_SAVED = null;

  // ----- HELPERS -----
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const esc = s => String(s??'').replace(/[&<>"]/g, c => ({'&':'&','<':'<','>':'>','"':'"'}[c]));
  const fmtFecha = d => d ? d.slice(8,10)+'/'+d.slice(5,7)+'/'+d.slice(0,4) : '';
  const ym = () => S?.y + '-' + String(S?.m+1).padStart(2,'0');
  const own = p => String(p.cod).split(/[^0-9a-zA-Z]+/)[0];
  const norm = p => p.modo !== 'cuenta';
  const sorted = () => [...(S?.props||[])].sort((a,b)=>String(a.cod).localeCompare(String(b.cod),undefined,{numeric:true}));

  // ----- SV DEFAULT -----
  function sv0() {
    return Object.fromEntries(SV_KEYS.map(k => [k, {on:false,n:1,monto:0,prop:false,pp:true,ka:0,kc:0,kv:0}]));
  }

  // ----- PROPIEDAD FACTORY -----
  function P(o) {
    const p = {
      id: Math.random().toString(36).slice(2),
      cod:'', dir:'', inq:'', tel:'', prop:'',
      alq:0, hon:10, svProp:true,
      ini:'', fin:'', act:4,
      ctaAgua:'', ctaLuz:'', ctaMuni:'', ctaRentas:'', ctaGas:'',
      facturas:{}, modo:'', noAviso:false,
      saldoAnt:0, notas:'', notasL:'', contrato:'', alqIni:'',
      sv: sv0(), ex:[], ult:'', ultYM:''
    };
    const v = o?.sv || {}; delete o.sv;
    Object.assign(p, o);
    for (const k in v) { Object.assign(p.sv[k], v[k]); if (v[k].pp===undefined && p.svProp===false) p.sv[k].pp=false; }
    return p;
  }

  // ----- CALCULOS -----
  function calc(p) {
    const sv = SV_KEYS.filter(k => p.sv[k].on).map(k => {
      const o = p.sv[k];
      if (k==='luz' && o.prop) return { c:`Luz proporcional (${(o.kc-o.ka)||0} kW × ${FMT(o.kv)})`, m:((o.kc-o.ka)||0)*o.kv, pp:o.pp!==false };
      return { c: SV_LABELS[k] + (o.n>1 ? ` (1/${o.n})` : ''), m:(+o.monto||0)/o.n, pp:o.pp!==false };
    });
    const sT = sv.reduce((a,x)=>a+x.m,0);
    const eI = p.ex.filter(e=>e.a==='inq'), eP = p.ex.filter(e=>e.a==='prop'), eR = p.ex.filter(e=>e.a==='rep');
    const sum = l => l.reduce((a,x)=>a+(+x.m||0),0);
    const sumA = l => l.reduce((a,x)=>a+Math.abs(+x.m||0),0);

    if (p.modo==='cuenta') {
      const dep = p.ex.filter(e=>e.a==='dep'), depT = sum(dep);
      const base = sT + sum(eI), hon = base * p.hon / 100;
      const ant = +p.saldoAnt||0, fin = ant + base + hon - depT;
      return { sv,sT,eI,eP:[],dep,depT,base,hon,ant,fin,tot:fin,neto:fin,rec:fin,cuenta:true };
    }
    const A = +p.alq||0, hon = A * p.hon / 100;
    const tot = A + sT + sum(eI) - sumA(eR);
    const neto = A + sv.filter(x=>x.pp).reduce((a,x)=>a+x.m,0) - hon - sum(eP) - sumA(eR);
    return { sv,sT,eI,eP,eR,hon,tot,neto,rec:tot*(1+(S?.corr?.rec||10)/100) };
  }

  // ----- SUPABASE HELPERS -----
  async function getSupabase() {
    if (window.supabaseClient) return window.supabaseClient;
    // Fallback: crear cliente si no existe (para testing standalone)
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    return createClient('https://rnldqiwwzhjnurkguihu.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJuZGRxaXd3emhqbnVya2d1aWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzE1NjUyMDAsImV4cCI6MjA0NzE0MTIwMH0.A7gL-ZXnVLLqZ1w7JqZQzBgR5XZlh3w4pY8Vq7pLq0M');
  }

  async function loadState() {
    const supabase = await getSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    currentUser = user;
    // Buscar perfil
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    currentProfile = profile;

    // Cargar estado del usuario (tabla alquileres_state)
    const { data } = await supabase
      .from('alquileres_state')
      .select('state')
      .eq('user_id', user.id)
      .maybeSingle();

    if (data?.state) {
      S = JSON.parse(data.state);
      S.props = S.props.map(P);
    } else {
      // Estado inicial vacío
      S = { corr:{n:'DANILO ARBO PROPIEDADES',d:'Roberto Cayol 3224 - 1 Bº Poeta Lugones Córdoba',t:'Tel 0351-156158064  danilo.arbo@gmail.com',b:'CBU: 0440007340000198300351  Alias: darboalquiler  Banco Hipotecario',v1:10,v2:20,rec:10,dAgua:10}, m:new Date().getMonth(), y:new Date().getFullYear(), vista:'res', sel:null, props:[] };
    }
    return S;
  }

  async function saveState() {
    if (!S || !currentUser) return;
    const supabase = await getSupabase();
    S.vista = vista;
    const stateStr = JSON.stringify(S);
    const { error } = await supabase
      .from('alquileres_state')
      .upsert({ user_id: currentUser.id, state: stateStr, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) { console.error('Error guardando estado:', error); showToast('Error guardando: '+error.message,'error'); return false; }
    LAST_SAVED = stateStr;
    DIRTY = false;
    updateStatus();
    return true;
  }

  // ----- UI HELPERS -----
  function showToast(msg, type='success') {
    const t = $('#toastAlq'), txt = $('#toastTextAlq');
    if (!t || !txt) return;
    txt.textContent = msg;
    t.className = 'toast-msg ' + (type==='error'?'error':type==='warning'?'warning':'success');
    t.style.display = 'flex';
    setTimeout(()=>{ t.style.display='none'; }, 4000);
  }

  function updateStatus() {
    const e = $('#estAlq'); // Agregar en HTML si no existe
    if (e) {
      e.textContent = DIRTY ? '● Cambios sin guardar' : '✔ Guardado ' + (LAST_SAVED ? new Date().toLocaleString('es-AR') : '');
      e.style.color = DIRTY ? '#fca5a5' : '#86efac';
    }
    const mesEl = $('#mesActual');
    if (mesEl) mesEl.textContent = MES[S.m] + ' ' + S.y;
  }

  function markDirty() { DIRTY = true; updateStatus(); }

  // ----- NAVEGACIÓN MES (BUG FIX) -----
  function mesMas(d) {
    if (d > 0) {
      if (!confirm('Cerrar ' + MES[S.m] + ' y pasar a ' + MES[(S.m+1)%12] + '.\n\n• ' + MES[S.m] + ' queda guardado en el Historial.\n• Se repiten los alquileres (en blanco los que hay que actualizar). Municipal y Rentas conservan su valor; el resto de los servicios queda en 0.\n• Se descarga el archivo del mes nuevo, listo para trabajar.\n\n¿Continuar?')) return;
      // Guardar mes actual en historial
      S.hist = S.hist || {};
      S.hist[ym()] = docsMes();
    } else if (d < 0) {
      // BUG FIX: Restaurar desde historial al volver atrás
      const prevKey = prevMonthKey();
      if (S.hist && S.hist[prevKey]) {
        if (!confirm('Volver a ' + MES[(S.m-1+12)%12] + '.\n\nSe restaurarán los datos guardados de ese mes.\n\n¿Continuar?')) return;
        restoreFromHist(prevKey);
      }
    }
    S.m += d;
    if (S.m > 11) { S.m = 0; S.y++; }
    if (S.m < 0) { S.m = 11; S.y--; }
    if (d > 0) {
      for (const p of S.props) {
        if (p.modo==='cuenta') p.saldoAnt = Math.round(calc(p).fin*100)/100;
        for (const k in p.sv) if (p.modo==='cuenta' || (k!=='muni' && k!=='rentas')) p.sv[k].monto = 0;
        p.sv.luz.ka = p.sv.luz.kc;
        p.ex = [];
        const r = restoAct(p);
        if (r!==null && r<=0) p.alq = '';
      }
    }
    await saveState();
    render();
  }

  function prevMonthKey() {
    let m = S.m - 1, y = S.y;
    if (m < 0) { m = 11; y--; }
    return y + '-' + String(m+1).padStart(2,'0');
  }

  function restoreFromHist(key) {
    const data = S.hist[key];
    if (!data) return;
    // Restaurar propiedades desde snapshot
    for (const doc of data) {
      const p = S.props.find(x => x.cod === doc.cod);
      if (p) {
        if (doc.k === 'o') {
          p.alq = doc.L.find(l=>l[0]==='ALQUILER')?.[3] || 0;
          for (const l of doc.L) {
            const svKey = SV_KEYS.find(s => l[0].toLowerCase().includes(s));
            if (svKey && p.sv[svKey]) p.sv[svKey].monto = l[3];
          }
        } else if (doc.k === 'c') {
          p.saldoAnt = doc.L.find(l=>l[0]==='SALDO ANTERIOR')?.[3] || 0;
          for (const l of doc.L) {
            const svKey = SV_KEYS.find(s => l[0].toLowerCase().includes(s));
            if (svKey && p.sv[svKey]) p.sv[svKey].monto = l[3];
          }
        }
      }
    }
  }

  // ----- DOCUMENTOS / SNAPSHOTS -----
  function docsMes() {
    return [...sorted().map(p => norm(p) ? snapO(p) : snapC(p)), ...[...new Set(sorted().filter(norm).map(own))].map(snapL)];
  }

  function snapO(p) {
    const c = calc(p), [mm,yy] = [MES[S.m].toUpperCase(), S.y];
    return { k:'o', cod:p.cod, n:p.inq, p:p.dir+' ('+p.cod+')', ps:[],
      L:[['ALQUILER',mm,yy,+p.alq||0], ...c.sv.map(x=>[x.c.toUpperCase(),mm,yy,x.m]), ...c.eI.map(e=>[(e.c||'').toUpperCase(),mm,yy,+e.m||0]), ...c.eR.map(e=>[(e.c||'').toUpperCase(),mm,yy,-Math.abs(+e.m||0)])],
      T:[],
      V:[['Vencimiento sin Recargo',S.corr.v1,S.m+1,yy,c.tot],['Vencimiento Con Recargo',S.corr.v2,S.m+1,yy,c.rec]],
      N:[p.notas,...avisosAuto(p)].filter(Boolean).join('\n'), std:1 };
  }

  function snapL(o) {
    const G = sorted().filter(p => own(p)===o && norm(p)), [mm,yy] = [MES[S.m].toUpperCase(), S.y], multi = G.length>1;
    let T=0, H=0; const I=[], D=[];
    for (const p of G) {
      const c = calc(p), s = multi ? ' '+p.dir.toUpperCase() : '';
      T += c.neto; I.push(['ALQUILER'+s,mm,yy,+p.alq||0]);
      c.sv.filter(x=>x.pp).forEach(x=>I.push([x.c.toUpperCase()+s,mm,yy,x.m]));
      H += c.hon; c.eP.forEach(e=>D.push([(e.c||'').toUpperCase()+s,mm,yy,+e.m||0]));
      c.eR.forEach(e=>D.push([(e.c||'').toUpperCase()+s,mm,yy,Math.abs(+e.m||0)]));
    }
    D.unshift(['HONORARIOS',mm,yy,H]);
    const ti = I.reduce((a,x)=>a+x[3],0), td = D.reduce((a,x)=>a+x[3],0);
    const nn0 = [...new Set(G.map(p=>(p.notasL||'').trim()).filter(Boolean))].join('\n');
    return { k:'l', cod:G[0].cod, n:G[0].prop, p:'', ps:G.map(p=>p.dir+' ('+p.cod+')'),
      L:[...I,...D], T:[['TOTAL ALQUILERES',mm,yy,ti],['TOTAL DEDUCCIONES',mm,yy,td],['TOTAL','',yy,T]],
      V:[], N: nn0 || `RECIBI LA SUMA DE ${FMT(T)} EN CONCEPTO DE ALQUILER ${G.map(p=>p.dir.toUpperCase()).join(' / ')}` };
  }

  function snapC(p) {
    const c = calc(p), [mm,yy] = [MES[S.m].toUpperCase(), S.y];
    return { k:'c', cod:p.cod, n:p.prop, p:p.dir+' ('+p.cod+')', ps:[],
      L:[['SALDO ANTERIOR',mm,yy,c.ant], ...c.sv.map(x=>[x.c.toUpperCase(),mm,yy,x.m]), ...c.eI.map(e=>[(e.c||'GASTO').toUpperCase(),mm,yy,+e.m||0]), ['HONORARIOS',mm,yy,c.hon], ...c.dep.map(e=>[(e.c||'DEPOSITO').toUpperCase(),mm,yy,-(+e.m||0)])],
      T:[['SALDO',mm,yy,c.fin]], V:[],
      N: (c.fin<=0?'SALDO A FAVOR DEL CLIENTE':'SALDO A COBRAR AL CLIENTE')+': '+FMT(Math.abs(c.fin))+(p.notas?'\n'+p.notas:'') };
  }

  // ----- RENDER PRINCIPAL -----
  async function render() {
    if (!S) return;
    updateStatus();
    $('#mesActual').textContent = MES[S.m] + ' ' + S.y;

    // Tabs
    $$('#sidebar .nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.tab === 'tab-'+vista));

    // Contenido
    switch(vista) {
      case 'res': renderResumen(); break;
      case 'prop': renderPropiedades(); break;
      case 'hist': renderHistorial(); break;
      case 'config': renderConfig(); break;
    }
    renderSidebar();
  }

  function renderSidebar() {
    const go = null;
    let o = '<option value="">— Elegí una propiedad —</option>';
    for (const p of sorted()) {
      if (own(p) !== go) { if (go!==null) o+='</optgroup>'; go=own(p); o+=`<optgroup label="Propietario ${go}: ${p.prop||'sin nombre'}">`; }
      o += `<option value="${p.id}">${p.cod} · ${p.dir}${p.inq?' — '+p.inq:''}</option>`;
    }
    $('#selAlq').innerHTML = o + (go!==null?'</optgroup>':'');
    $('#selAlq').value = editingPropId || '';
  }

  // ----- RESUMEN -----
  function renderResumen() {
    const rows = sorted().map(p => {
      const c = calc(p);
      return `<tr>
        <td>${p.cod} ${p.dir}</td>
        <td>${p.inq}${p.alq===''?'<br><small style="color:#b42318">falta alquiler</small>':''}</td>
        <td>${c.cuenta?'Saldo '+(c.fin<=0?'a favor: ':'a cobrar: ')+FMT(Math.abs(c.fin)):FMT(c.tot)}</td>
        <td>${FMT(c.hon)}</td>
        <td>${c.cuenta?'—':FMT(c.neto)}</td>
        <td>${c.cuenta?'—':cobroTxt('inq:'+p.cod,ym(),c.tot)}</td>
        <td>${c.cuenta?'—':liqTxt('prop:'+own(p),ym())}</td>
      </tr>`;
    }).join('');
    $('#resumenContent').innerHTML = `
      <table class="t"><tr><th>Propiedad</th><th>Inquilino</th><th>Orden</th><th>Honorarios</th><th>Neto Prop.</th><th>Cobrado</th><th>Liquidado</th></tr>
      ${rows}
      <tr class="tot"><td>Total</td><td></td><td>${FMT(sorted().reduce((a,p)=>a+calc(p).tot,0))}</td><td>${FMT(sorted().reduce((a,p)=>a+calc(p).hon,0))}</td><td>${FMT(sorted().reduce((a,p)=>a+calc(p).neto,0))}</td><td></td><td></td></tr>
      </table>`;
  }

  // ----- PROPIEDADES LIST -----
  function renderPropiedades() {
    const html = sorted().map(p => {
      const c = calc(p);
      return `<div class="glass-panel" style="margin-bottom:12px;padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div><strong>${p.cod}</strong> ${p.dir} <span style="color:var(--text-dim);">— ${p.inq}</span></div>
          <div style="display:flex;gap:8px;">
            <button class="btn-luxury-action" onclick="editProp('${p.id}')"><i class="fas fa-edit"></i> Editar</button>
            <button class="btn-luxury-action" onclick="verOrden('${p.id}')"><i class="fas fa-file-invoice"></i> Orden</button>
            <button class="btn-luxury-action" onclick="verLiq('${p.id}')"><i class="fas fa-file-invoice-dollar"></i> Liq.</button>
            <button class="btn-ghost" onclick="deleteProp('${p.id}')"><i class="fas fa-trash"></i></button>
          </div>
        </div>
        <div style="margin-top:8px;color:var(--text-dim);font-size:12px;">
          Alquiler: ${FMT(p.alq)} | Honorarios: ${p.hon}% | ${p.modo==='cuenta'?'Cuenta corriente':'Alquiler'} | ${p.ini?'Desde '+fmtFecha(p.ini):''}${p.fin?' Hasta '+fmtFecha(p.fin):''}
        </div>
      </div>`;
    }).join('');
    $('#propiedadesList').innerHTML = html || '<div class="empty-state"><i class="fas fa-building"></i><div class="empty-state-title">No hay propiedades</div><button class="btn-luxury-action" onclick="newProp()"><i class="fas fa-plus"></i> Agregar primera</button></div>';
  }

  // ----- HISTORIAL -----
  async function renderHistorial() {
    const ks = [...new Set([ym(), ...Object.keys(S.hist||{})])].sort().reverse();
    HM = HM || ks[0];
    $('#histMesSelect').innerHTML = ks.map(x => `<option value="${x}" ${x===HM?'selected':''}>${MES[+x.slice(5)-1]} ${x.slice(0,4)}${x===ym()?' (actual)':''}</option>`).join('');
    const ds = docsOf(HM);
    $('#historialContent').innerHTML = `
      <table class="t"><tr><th>Doc</th><th>Código</th><th>Nombre</th><th>Propiedad</th><th>Importe</th><th>Estado</th><th></th></tr>
      ${ds.map((d,i)=>`<tr><td>${KN[d.k]}</td><td>${esc(d.cod)}</td><td>${esc(String(d.n).replace(/\s{2,}/g,' '))}</td><td>${esc(d.p||(d.ps||[]).join(' / '))}</td><td>${FMT(monto(d))}</td><td>${d.k==='o'?cobroTxt('inq:'+d.cod,HM,monto(d)||0,1):d.k==='l'?liqTxt('prop:'+String(d.cod).split('-')[0],HM,1):'—'}</td><td><button class="btn-luxury-action" onclick="verDoc('${HM}',${i})">Ver/PDF</button> ${d.k==='c'?'':`<button class="btn-luxury-action" onclick="verPagos('${HM}',${i})">Pagos</button>`}</td></tr>`).join('')}</table>`;
  }

  function docsOf(k) {
    return [...(k===ym()?docsMes():(S.hist||{})[k]||[])].sort((a,b)=>String(a.cod).localeCompare(String(b.cod),undefined,{numeric:true})||a.k.localeCompare(b.k));
  }

  const KN = {o:'Orden de pago',l:'Liquidación',c:'Rendición de cuenta'};
  function monto(d) { return d.k==='o'?(d.V[0]||[])[4]:(d.T.length?d.T[d.T.length-1][3]:null); }

  function cobroTxt(k, mes, total, html) { /* implementación simplificada */ return '—'; }
  function liqTxt(k, mes, html) { return '—'; }

  // ----- CONFIG -----
  function renderConfig() {
    if (!S.corr) S.corr = {n:'',d:'',t:'',b:'',v1:10,v2:20,rec:10,dAgua:10};
    ['cfgNombre','cfgDireccion','cfgTelefono','cfgBancarios','cfgV1','cfgV2','cfgRecargo','cfgDAgua'].forEach(id => {
      const key = id.replace('cfg','').toLowerCase();
      const map = {nombre:'n', direccion:'d', telefono:'t', bancarios:'b', v1:'v1', v2:'v2', recargo:'rec', dagua:'dAgua'};
      const el = $('#'+id); if (el) el.value = S.corr[map[key]] || '';
    });
  }

  // ----- MODAL PROPIEDAD -----
  function newProp() { editingPropId = null; $('#propModalTitleAlq').textContent='Nueva Propiedad'; $('#propiedadFormAlq')[0].reset(); $('#propIdAlq').value=''; buildServiciosForm(); $('#propiedadModalAlq').classList.add('is-open'); }
  function editProp(id) { editingPropId=id; const p=S.props.find(x=>x.id===id); if(!p)return; $('#propModalTitleAlq').textContent='Editar Propiedad'; fillPropForm(p); $('#propiedadModalAlq').classList.add('is-open'); }
  function fillPropForm(p) {
    $('#propIdAlq').value=p.id; $('#propCodAlq').value=p.cod; $('#propDirAlq').value=p.dir; $('#propInqAlq').value=p.inq; $('#propTelAlq').value=p.tel;
    $('#propPropAlq').value=p.prop; $('#propAlqAlq').value=p.alq; $('#propHonAlq').value=p.hon; $('#propActAlq').value=p.act;
    $('#propIniAlq').value=p.ini; $('#propFinAlq').value=p.fin;
    $('#propCtaAguaAlq').value=p.ctaAgua; $('#propCtaLuzAlq').value=p.ctaLuz; $('#propCtaGasAlq').value=p.ctaGas; $('#propCtaMuniAlq').value=p.ctaMuni; $('#propCtaRentasAlq').value=p.ctaRentas;
    $('#propAlqIniAlq').value=p.alqIni; $('#propNotasAlq').value=p.notas; $('#propNotasLAlq').value=p.notasL;
    buildServiciosForm(p);
  }
  function buildServiciosForm(p) {
    const cont = $('#serviciosContainerAlq');
    cont.innerHTML = SV_KEYS.map(k => {
      const o = p?.sv?.[k] || sv0()[k];
      return `<div class="form-grid-2" style="margin-bottom:8px;">
        <div class="form-field"><label>${SV_LABELS[k]}</label><input type="checkbox" data-sv="${k}.on" ${o.on?'checked':''}></div>
        <div class="form-field"><label>Repartir en</label><select data-sv="${k}.n">${[1,2,3,4,5].map(n=>`<option value="${n}" ${o.n===n?'selected':''}>${n===1?'Total':'1/'+n}</option>`).join('')}</select></div>
        <div class="form-field"><label>Monto $</label><input type="number" step="0.01" data-sv="${k}.monto" value="${o.monto||''}"></div>
        <div class="form-field"><label><input type="checkbox" data-sv="${k}.prop" ${o.prop?'checked':''}> Por medidor (solo Luz)</label></div>
        <div class="form-field"><label><input type="checkbox" data-sv="${k}.pp" ${o.pp!==false?'checked':''}> Propietario paga</label></div>
        ${k==='luz'?`<div class="form-field"><label>kW Anterior</label><input type="number" data-sv="${k}.ka" value="${o.ka||0}"></div><div class="form-field"><label>kW Actual</label><input type="number" data-sv="${k}.kc" value="${o.kc||0}"></div><div class="form-field"><label>Valor kW $</label><input type="number" step="0.01" data-sv="${k}.kv" value="${o.kv||0}"></div>`:''}
      </div>`;
    }).join('');
    // Bind inputs
    $$('#serviciosContainerAlq [data-sv]').forEach(inp => {
      inp.addEventListener('change', e => {
        if (!editingPropId) return;
        const p = S.props.find(x=>x.id===editingPropId); if(!p)return;
        const [k, field] = e.target.dataset.sv.split('.');
        p.sv[k][field] = e.target.type==='checkbox'?e.target.checked:(e.target.type==='number'?parseFloat(e.target.value)||0:e.target.value);
        markDirty();
      });
    });
  }

  // ----- EVENTOS -----
  function bindEvents() {
    // Tabs
    $$('#sidebar .nav-item').forEach(b => b.addEventListener('click', () => { vista = b.dataset.tab.replace('tab-',''); render(); }));

    // Botones header
    $('#btnMesAnterior')?.addEventListener('click', () => mesMas(-1));
    $('#btnMesSiguiente')?.addEventListener('click', () => mesMas(1));
    $('#btnImprimirOrdenes')?.addEventListener('click', () => imprimirTodo('o'));
    $('#btnImprimirLiquidaciones')?.addEventListener('click', () => imprimirTodo('l'));
    $('#btnExportarExcel')?.addEventListener('click', () => excelMes(ym()));

    // Historial
    $('#histMesSelect')?.addEventListener('change', e => { HM = e.target.value; renderHistorial(); });
    $('#btnVerOrdenesHist')?.addEventListener('click', () => verDocs(HM,'o'));
    $('#btnVerLiqHist')?.addEventListener('click', () => verDocs(HM,'l'));
    $('#btnExcelHist')?.addEventListener('click', () => excelMes(HM));

    // Config
    $('#btnGuardarConfig')?.addEventListener('click', saveConfig);

    // Propiedades
    $('#btnNuevaPropiedadAlq')?.addEventListener('click', newProp);
    $('#propiedadFormAlq')?.addEventListener('submit', saveProp);
    $$('.modal-close-btn, .btn-ghost').forEach(b => b.addEventListener('click', closeModals));
    $('#propiedadModalAlq')?.addEventListener('click', e => { if(e.target===e.currentTarget) closeModals(); });

    // Logout
    $('#logoutBtnAlq')?.addEventListener('click', logout);
    $('#btnVolverAdmin')?.addEventListener('click', () => window.location.href = '/admin.html');
  }

  function closeModals() {
    $$('.admin-modal').forEach(m => m.classList.remove('is-open'));
    editingPropId = null;
  }

  // ----- GUARDAR -----
  async function saveProp(e) {
    e.preventDefault();
    const p = editingPropId ? S.props.find(x=>x.id===editingPropId) : P({});
    if (!p) return;

    // Leer form
    p.cod = $('#propCodAlq').value.trim();
    p.dir = $('#propDirAlq').value.trim();
    p.inq = $('#propInqAlq').value.trim();
    p.tel = $('#propTelAlq').value.trim();
    p.prop = $('#propPropAlq').value.trim();
    p.alq = parseFloat($('#propAlqAlq').value)||0;
    p.hon = parseFloat($('#propHonAlq').value)||10;
    p.act = parseInt($('#propActAlq').value)||4;
    p.ini = $('#propIniAlq').value||'';
    p.fin = $('#propFinAlq').value||'';
    p.ctaAgua = $('#propCtaAguaAlq').value.trim();
    p.ctaLuz = $('#propCtaLuzAlq').value.trim();
    p.ctaGas = $('#propCtaGasAlq').value.trim();
    p.ctaMuni = $('#propCtaMuniAlq').value.trim();
    p.ctaRentas = $('#propCtaRentasAlq').value.trim();
    p.alqIni = parseFloat($('#propAlqIniAlq').value)||0;
    p.notas = $('#propNotasAlq').value;
    p.notasL = $('#propNotasLAlq').value;

    // Servicios
    $$('#serviciosContainerAlq [data-sv]').forEach(inp => {
      const [k, field] = inp.dataset.sv.split('.');
      p.sv[k] = p.sv[k] || sv0()[k];
      p.sv[k][field] = inp.type==='checkbox'?inp.checked:(inp.type==='number'?parseFloat(inp.value)||0:inp.value);
    });

    if (!editingPropId) S.props.push(p);
    await saveState();
    closeModals();
    render();
    showToast('Propiedad guardada');
  }

  function deleteProp(id) {
    if (!confirm('¿Eliminar esta propiedad?')) return;
    S.props = S.props.filter(p=>p.id!==id);
    saveState();
    render();
  }

  function saveConfig() {
    const map = {cfgNombre:'n',cfgDireccion:'d',cfgTelefono:'t',cfgBancarios:'b',cfgV1:'v1',cfgV2:'v2',cfgRecargo:'rec',cfgDAgua:'dAgua'};
    for (const [id,key] of Object.entries(map)) {
      const val = $('#'+id)?.value;
      if (val!==undefined) S.corr[key] = isNaN(val)?val:parseFloat(val);
    }
    saveState();
    showToast('Configuración guardada');
  }

  // ----- IMPRESIÓN / PDF -----
  function imprimirTodo(t) { /* usar docsOf y pv/rD del original */ }
  function excelMes(k) { /* usar exceljs CDN */ showToast('Excel en desarrollo'); }
  function verDocs(k,t) { /* usar docsOf y pv/rD */ }
  function verDoc(k,i) { /* verDoc */ }
  function verPagos(k,i) { /* pagos */ }

  // ----- AUTH -----
  async function logout() {
    const supabase = await getSupabase();
    await supabase.auth.signOut();
    window.location.href = 'alquileres.html';
  }

  async function initAuth() {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { showLogin(); return; }
    currentUser = session.user;
    await loadState();
    hideLogin();
    bindEvents();
    render();
  }

  function showLogin() {
    $('#loginScreen').style.display = 'flex';
    $('#appLayout').style.display = 'none';
    $('#loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#loginEmail').value, pass = $('#loginPassword').value;
      const supabase = await getSupabase();
      const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
      if (error) { $('#loginError').textContent = error.message; return; }
      hideLogin();
      await initAuth();
    });
  }

  function hideLogin() {
    $('#loginScreen').style.display = 'none';
    $('#appLayout').style.display = 'flex';
    $('#sidebarUserNameAlq').textContent = currentProfile?.full_name || currentUser?.email?.split('@')[0] || 'Admin';
    $('#sidebarUserRoleAlq').textContent = currentProfile?.role || 'Administrador';
  }

  // ----- INIT -----
  document.addEventListener('DOMContentLoaded', initAuth);

  // Exponer funciones globales para onclick inline
  window.mesMas = mesMas;
  window.newProp = newProp;
  window.editProp = editProp;
  window.deleteProp = deleteProp;
  window.verOrden = verOrden;
  window.verLiq = verLiq;
  window.verDoc = verDoc;
  window.verDocs = verDocs;
  window.verPagos = verPagos;
  window.imprimirTodo = imprimirTodo;
  window.excelMes = excelMes;
  window.logout = logout;

})();