/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Modulo: Sitio Web (CMS) y Configuracion
   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.
   ============================================================ */
(function () {
  'use strict';
  const { logError, on, z, getAuthedClient, showToast } = window.__BH || {};

  /* ------------------------------------------------
     9. CMS EDITOR
     ------------------------------------------------ */
  let cmsData = {};
  let _cmsDirty = false;
  const _cmsDirtyFields = new Set();
  function cmsMarkDirty(key, value) {
    _cmsDirty = true;
    if (value !== undefined && String(value).trim() !== '') _cmsDirtyFields.add(key);
    else _cmsDirtyFields.delete(key);
    cmsUpdateDirtyUI();
  }
  function cmsUpdateDirtyUI() {
    const btn = $('#cmsSaveBtn');
    if (!btn) return;
    const n = _cmsDirtyFields.size;
    if (_cmsDirty && n > 0) {
      btn.classList.add('has-changes');
      btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar (' + n + ')';
    } else {
      btn.classList.remove('has-changes');
      btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar Cambios Web';
    }
  }

  const CMS_FIELD_MAP = {
    hero_line1:    { section: 'hero', path: 'title' },
    hero_line2:    { section: 'hero', path: 'subtitle' },
    hero_eyebrow:  { section: 'hero', path: 'eyebrow' },
    hero_desc:     { section: 'hero', path: 'description' },
    hero_bg:       { section: 'hero', path: 'bg_image_url' },
    hero_video:    { section: 'hero', path: 'video_url' },
    serv_title:    { section: 'services', path: 'title' },
    serv_badge:    { section: 'services', path: 'badge' },
    serv_desc:     { section: 'services', path: 'description' },
    team_title:    { section: 'team', path: 'title' },
    stat1_val:     { section: 'stats', path: 'properties_sold' },
    stat1_title:   { section: 'stats', path: 'stat1_label' },
    proc_title:    { section: 'process', path: 'title' }
  };

  const SECTION_ID_TO_DB_KEY = {
    hero: 'hero',
    catalogo: 'catalog',
    servicios: 'services',
    equipo: 'team',
    stats: 'stats',
    proceso: 'process',
    contacto: 'contact',
    formulario: 'form',
    navbar: 'navbar',
    footer: 'footer',
    seo: 'seo',
    nosotros: 'nosotros'
  };

  async function loadCMS() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('site_content')
        .select('*');

      if (error) throw error;

      cmsData = {};
      (data || []).forEach(item => {
        cmsData[item.section_key] = item;
      });

      populateCMSFields();
      cmsPopulateNested();
      cmsLastSavedInfo();
    } catch (err) {
      logError('CMS error:', err);
    }
  }

  const CMS_NESTED_SCHEMAS = {
    services_items: ['cmsServicesItems', [{ key: 'icon', label: 'Icono (clase FA)', placeholder: 'fas fa-home' }, { key: 'title', label: 'Título', placeholder: 'Venta' }, { key: 'desc', label: 'Descripción', placeholder: 'Estrategia personalizada...' }]],
    proceso_pasos: ['cmsProcessSteps', [{ key: 'num', label: 'Número', placeholder: '01' }, { key: 'title', label: 'Título', placeholder: 'Tasación' }, { key: 'desc', label: 'Descripción', placeholder: 'Analizamos tu propiedad...' }]],
    navbar_items: ['cmsNavbarItems', [{ key: 'label', label: 'Etiqueta', placeholder: 'Inicio' }, { key: 'url', label: 'URL / Ancla', placeholder: '#hero' }]],
    navbar_mobile_items: ['cmsNavbarMobileItems', [{ key: 'label', label: 'Etiqueta', placeholder: 'Inicio' }, { key: 'url', label: 'URL / Ancla', placeholder: '#hero' }]],
    form_options: ['cmsFormOptions', [{ key: 'value', label: 'Valor', placeholder: 'comprar' }, { key: 'label', label: 'Etiqueta', placeholder: 'Quiero comprar' }]],
    form_fields: ['cmsFormFields', [{ key: 'name', label: 'Nombre del campo (id)', placeholder: 'phone' }, { key: 'label', label: 'Etiqueta', placeholder: 'Teléfono' }, { key: 'type', label: 'Tipo', placeholder: 'tel' }]],
    footer_nav_links: ['cmsFooterNavLinks', [{ key: 'label', label: 'Etiqueta', placeholder: 'Propiedades' }, { key: 'url', label: 'URL / Ancla', placeholder: '#propiedades' }]],
    footer_service_links: ['cmsFooterServiceLinks', [{ key: 'label', label: 'Etiqueta', placeholder: 'Ventas' }, { key: 'url', label: 'URL / Ancla', placeholder: '#servicios' }]],
    nosotros_valores: ['cmsNosotrosValores', [{ key: 'icon', label: 'Icono (clase FA)', placeholder: 'fas fa-scale-balanced' }, { key: 'title', label: 'Título', placeholder: 'Honestidad y Transparencia' }, { key: 'desc', label: 'Descripción', placeholder: 'Hablar siempre con la verdad...' }]],
  };

  function cmsPopulateNested() {
    for (const [key, [containerId, schema]] of Object.entries(CMS_NESTED_SCHEMAS)) {
      const container = document.getElementById(containerId);
      if (!container) continue;
      container.innerHTML = '';
      const SECTION_KEYS = {
        services_items: 'services',
        proceso_pasos: 'process',
        navbar_items: 'navbar',
        navbar_mobile_items: 'navbar',
        form_options: 'form',
        form_fields: 'form',
        footer_nav_links: 'footer',
        footer_service_links: 'footer',
        nosotros_valores: 'nosotros',
      };
      const list = (cmsData[SECTION_KEYS[key]]?.content || {})[key];
      if (Array.isArray(list)) list.forEach(v => cmsAddListItem(containerId, schema, v));
    }
  }

  function cmsPopulateNested() {
    for (const [key, [containerId, schema]] of Object.entries(CMS_NESTED_SCHEMAS)) {
      const container = document.getElementById(containerId);
      if (!container) continue;
      container.innerHTML = '';
      for (const sec of Object.values(cmsData)) {
        const list = sec?.content?.[key];
        if (Array.isArray(list)) list.forEach(v => cmsAddListItem(containerId, schema, v));
      }
    }
  }

  function populateCMSFields() {
    _cmsDirty = false;
    _cmsDirtyFields.clear();
    $$('.cms-field[data-key]').forEach(input => {
      const key = input.dataset.key;
      const mapping = CMS_FIELD_MAP[key];
      if (mapping && cmsData[mapping.section]) {
        const content = cmsData[mapping.section].content || {};
        input.value = content[mapping.path] || '';
        return;
      }
      const sectionEl = input.closest('.cms-section-content');
      if (sectionEl) {
        const domId = sectionEl.id.replace('cms-', '');
        const dbSection = SECTION_ID_TO_DB_KEY[domId];
        if (dbSection && cmsData[dbSection]) {
          const content = cmsData[dbSection].content || {};
          input.value = content[key] || '';
        }
      }
    });
    cmsUpdateDirtyUI();
    if (heroBgHidden?.value && heroBgPreview) {
      heroBgPreview.innerHTML = '<img src="' + esc(heroBgHidden.value) + '" alt="Hero background" />';
    }
  }

  $$('.cms-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.cms-tab-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      $$('.cms-section-content').forEach(s => s.classList.remove('is-active'));
      const target = $(`#${btn.dataset.cms}`);
      if (target) target.classList.add('is-active');
    });
  });

  $$('.cms-field[data-key]').forEach(f => {
    const watch = () => cmsMarkDirty(f.dataset.key, f.value);
    f.addEventListener('input', watch);
    f.addEventListener('change', watch);
  });
  window.addEventListener('beforeunload', (e) => {
    if (_cmsDirty && _cmsDirtyFields.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function cmsLastSavedInfo() {
    const el = $('#cmsLastSaved');
    if (!el) return;
    const stamps = Object.values(cmsData).map(s => s?.updated_at).filter(Boolean);
    if (!stamps.length) { el.textContent = ''; return; }
    const latest = new Date(Math.max(...stamps.map(t => new Date(t).getTime())));
    el.textContent = 'Último guardado: ' + latest.toLocaleString('es-AR');
  }

  on($('#cmsPreviewBtn'), 'click', () => { window.open('/', '_blank', 'noopener'); });

  function cmsAddListItem(containerId, fields, values = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const wrap = document.createElement('div');
    wrap.className = 'cms-field';
    wrap.style.cssText = 'padding:12px; background:rgba(255,255,255,0.03); border-radius:8px; margin-bottom:12px; position:relative;';
    wrap.innerHTML = fields.map(f =>
      `<div style="margin-bottom:8px;"><label style="font-size:11px; color:var(--text-dim);">${f.label}</label><input type="text" data-subkey="${f.key}" value="${esc(values[f.key] ?? '')}" placeholder="${f.placeholder || ''}" style="width:100%; padding:8px 10px; background:rgba(255,255,255,0.04); border:1px solid var(--border-input); border-radius:6px; color:#fff; font-size:12px;" /></div>`
    ).join('') + `<button type="button" class="grupo-item-remove" style="position:absolute; top:6px; right:6px; background:none; border:none; color:var(--danger); cursor:pointer;"><i class="fas fa-trash"></i></button>`;
    wrap.querySelector('.grupo-item-remove')?.addEventListener('click', () => { wrap.remove(); cmsMarkDirty(containerId, 'x'); });
    wrap.querySelectorAll('input').forEach(i => i.addEventListener('input', () => cmsMarkDirty(containerId, 'x')));
    container.appendChild(wrap);
    if (!Object.keys(values).length) cmsMarkDirty(containerId, 'x');
  }

  function cmsItemsPack(containerId, subkeys) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return [...container.querySelectorAll('.cms-field')].map(wrap => {
      const obj = {};
      wrap.querySelectorAll('[data-subkey]').forEach(i => {
        const k = i.dataset.subkey;
        if (subkeys.includes(k)) obj[k] = i.value.trim();
      });
      return Object.keys(obj).length ? obj : null;
    }).filter(Boolean);
  }

  on($('#cmsAddServiceBtn'), 'click', () => cmsAddListItem('cmsServicesItems', [
    { key: 'icon', label: 'Icono (clase FA)', placeholder: 'fas fa-home' },
    { key: 'title', label: 'Título', placeholder: 'Venta' },
    { key: 'desc', label: 'Descripción', placeholder: 'Estrategia personalizada...' },
  ]));
  on($('#cmsAddProcessStepBtn'), 'click', () => cmsAddListItem('cmsProcessSteps', [
    { key: 'num', label: 'Número', placeholder: '01' },
    { key: 'title', label: 'Título', placeholder: 'Tasación' },
    { key: 'desc', label: 'Descripción', placeholder: 'Analizamos tu propiedad...' },
  ]));
  on($('#cmsAddNavbarItemBtn'), 'click', () => cmsAddListItem('cmsNavbarItems', [
    { key: 'label', label: 'Etiqueta', placeholder: 'Inicio' },
    { key: 'url', label: 'URL / Ancla', placeholder: '#hero' },
  ]));
  on($('#cmsAddNavbarMobileItemBtn'), 'click', () => cmsAddListItem('cmsNavbarMobileItems', [
    { key: 'label', label: 'Etiqueta', placeholder: 'Inicio' },
    { key: 'url', label: 'URL / Ancla', placeholder: '#hero' },
  ]));
  on($('#cmsAddFormOptionBtn'), 'click', () => cmsAddListItem('cmsFormOptions', [
    { key: 'value', label: 'Valor', placeholder: 'comprar' },
    { key: 'label', label: 'Etiqueta', placeholder: 'Quiero comprar' },
  ]));
  on($('#cmsAddFormFieldBtn'), 'click', () => cmsAddListItem('cmsFormFields', [
    { key: 'name', label: 'Nombre del campo (id)', placeholder: 'phone' },
    { key: 'label', label: 'Etiqueta', placeholder: 'Teléfono' },
    { key: 'type', label: 'Tipo', placeholder: 'tel' },
  ]));
  on($('#cmsAddFooterNavLinkBtn'), 'click', () => cmsAddListItem('cmsFooterNavLinks', [
    { key: 'label', label: 'Etiqueta', placeholder: 'Propiedades' },
    { key: 'url', label: 'URL / Ancla', placeholder: '#propiedades' },
  ]));
  on($('#cmsAddFooterServiceLinkBtn'), 'click', () => cmsAddListItem('cmsFooterServiceLinks', [
    { key: 'label', label: 'Etiqueta', placeholder: 'Ventas' },
    { key: 'url', label: 'URL / Ancla', placeholder: '#servicios' },
  ]));
  on($('#cmsAddValorBtn'), 'click', () => cmsAddListItem('cmsNosotrosValores', [
    { key: 'icon', label: 'Icono (clase FA)', placeholder: 'fas fa-scale-balanced' },
    { key: 'title', label: 'Título', placeholder: 'Honestidad y Transparencia' },
    { key: 'desc', label: 'Descripción', placeholder: 'Hablar siempre con la verdad...' },
  ]));

  const CMS_CHAR_LIMITS = { meta_title: 60, meta_description: 160, og_title: 60, og_description: 200, description: 500 };
  function cmsCharCounterInit() {
    $$('.cms-field[data-key]').forEach(f => {
      if (f.dataset.counterBound) return;
      f.dataset.counterBound = '1';
      const limit = CMS_CHAR_LIMITS[f.dataset.key];
      if (!limit) return;
      const counter = document.createElement('small');
      counter.style.cssText = 'display:block; margin-top:4px; font-size:10px; color:var(--text-dim);';
      counter.textContent = '0/' + limit;
      f.parentElement.appendChild(counter);
      const upd = () => {
        counter.textContent = (f.value?f.value.length:0) + '/' + limit;
        counter.style.color = (f.value?.length||0) > limit ? 'var(--danger)' : 'var(--text-dim)';
      };
      f.addEventListener('input', upd);
      upd();
    });
  }
  cmsCharCounterInit();

  $$('.cms-field[data-key]').forEach(f => {
    if (f.dataset.undoBound) return;
    f.dataset.undoBound = '1';
    f.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        const prev = f.dataset.prevValue;
        if (prev !== undefined && prev !== f.value) {
          f.value = prev;
          cmsMarkDirty(f.dataset.key, f.value);
          e.preventDefault();
        }
      }
    });
    f.addEventListener('input', () => { f.dataset.prevValue = f.value; });
  });

  on($('#cmsSaveBtn'), 'click', async () => {
    if (!_cmsDirty || _cmsDirtyFields.size === 0) {
      showToast('No hay cambios para guardar', 'info');
      return;
    }
    const btn = $('#cmsSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }

    try {
      const fields = $$('.cms-field[data-key]');
      const updatesBySection = {};

      const urlFields = ['og_url', 'og_image', 'twitter_image', 'hero_video_url', 'cta_url', 'instagram', 'facebook', 'linkedin', 'youtube', 'video_url'];
      const requiredFields = ['title', 'meta_title', 'meta_description'];
      const errors = [];
      fields.forEach(f => {
        const k = f.dataset.key;
        if (!_cmsDirtyFields.has(k)) return;
        if (requiredFields.includes(k) && !String(f.value).trim()) errors.push(`"${k}" está vacío pero es requerido`);
        if (urlFields.includes(k) && f.value && !/^(https?:\/\/|#|\/)/.test(f.value)) errors.push(`"${k}" no es una URL válida`);
      });
      if (errors.length) {
        showToast('Revisá antes de guardar: ' + errors.slice(0, 3).join(' | '), 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar Cambios Web'; }
        return;
      }

      const nested = {
        servicios_items: cmsItemsPack('cmsServicesItems', ['icon', 'title', 'desc']),
        proceso_pasos: cmsItemsPack('cmsProcessSteps', ['num', 'title', 'desc']),
        navbar_items: cmsItemsPack('cmsNavbarItems', ['label', 'url']),
        navbar_mobile_items: cmsItemsPack('cmsNavbarMobileItems', ['label', 'url']),
        form_options: cmsItemsPack('cmsFormOptions', ['value', 'label']),
        form_fields: cmsItemsPack('cmsFormFields', ['name', 'label', 'type']),
        footer_nav_links: cmsItemsPack('cmsFooterNavLinks', ['label', 'url']),
        footer_service_links: cmsItemsPack('cmsFooterServiceLinks', ['label', 'url']),
        nosotros_valores: cmsItemsPack('cmsNosotrosValores', ['icon', 'title', 'desc']),
      };
      const NESTED_TO_SECTION = {
        servicios_items: 'services',
        proceso_pasos: 'process',
        navbar_items: 'navbar',
        navbar_mobile_items: 'navbar',
        form_options: 'form',
        form_fields: 'form',
        footer_nav_links: 'footer',
        footer_service_links: 'footer',
        nosotros_valores: 'nosotros',
      };
      for (const [k, items] of Object.entries(nested)) {
        if (!items.length) continue;
        const section = NESTED_TO_SECTION[k];
        if (!updatesBySection[section]) updatesBySection[section] = {};
        updatesBySection[section][k] = items;
      }

      fields.forEach(field => {
        if (!_cmsDirtyFields.has(field.dataset.key)) return;
        const key = field.dataset.key;
        const mapping = CMS_FIELD_MAP[key];
        if (mapping) {
          if (!updatesBySection[mapping.section]) updatesBySection[mapping.section] = {};
          updatesBySection[mapping.section][mapping.path] = field.value;
          return;
        }
        const sectionEl = field.closest('.cms-section-content');
        if (sectionEl) {
          const domId = sectionEl.id.replace('cms-', '');
          const dbSection = SECTION_ID_TO_DB_KEY[domId];
          if (dbSection) {
            if (!updatesBySection[dbSection]) updatesBySection[dbSection] = {};
            updatesBySection[dbSection][key] = field.value;
          }
        }
      });

      const sectionEntries = Object.entries(updatesBySection);
      await Promise.all(sectionEntries.map(async ([sectionKey, newFields]) => {
        const existing = cmsData[sectionKey];
        const mergedContent = { ...(existing?.content || {}), ...newFields };

        if (existing) {
          const { error } = await window.supabaseClient
            .from('site_content')
            .update({ content: mergedContent })
            .eq('id', existing.id);
          if (error) throw error;
          cmsData[sectionKey].content = mergedContent;
        } else {
          const { data, error } = await window.supabaseClient
            .from('site_content')
            .insert([{ section_key: sectionKey, content: mergedContent }])
            .select()
            .single();
          if (error) throw error;
          cmsData[sectionKey] = data;
        }
      }));
      const savedCount = sectionEntries.length;
      _cmsDirty = false;
      _cmsDirtyFields.clear();
      cmsUpdateDirtyUI();
      cmsLastSavedInfo();
      showToast(`${savedCount} secciones guardadas correctamente`, 'success');
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar Cambios Web'; }
    }
  });

  const DEFAULT_CMS_CONTENT = {
    hero: {
      title: 'Encontrá tu próximo hogar',
      subtitle: 'en Córdoba',
      eyebrow: 'Bienvenidos a Bienenhaus',
      description: 'Propiedades seleccionadas, asesoramiento experto y la confianza de una inmobiliaria con trayectoria.',
      bg_image_url: '',
      video_url: ''
    },
    services: {
      title: 'Nuestros Servicios',
      badge: 'Qué ofrecemos',
      description: 'Acompañamos cada paso de tu operación inmobiliaria con profesionalidad y transparencia.'
    },
    team: {
      title: 'Nuestro Equipo'
    },
    stats: {
      title: 'Nuestros Números',
      description: 'Años de experiencia respaldan cada operación.',
      properties_sold: '500+',
      stat1_label: 'Propiedades vendidas'
    },
    process: {
      title: 'Cómo Trabajamos'
    }
  };

  async function globalResetCMS() {
    const confirmed = confirm(
      '?? REINICIO GLOBAL DE CMS\n\n' +
      'Esta acción ELIMINARÁ todo el contenido del CMS (Hero, Servicios, Equipo, Stats, Proceso) ' +
      'y restaurará los valores por defecto de fábrica.\n\n' +
      '¿Estás seguro de que querés continuar?'
    );
    if (!confirmed) return;

    const doubleConfirmed = confirm(
      '?? CONFIRMACIÓN FINAL\n\n' +
      'Se borrarán TODOS los registros de site_content.\n' +
      'Esta acción NO se puede deshacer.\n\n' +
      'Escribí "RESET" para confirmar:'
    );
    if (!doubleConfirmed) return;

    const userInput = prompt('Escribí "RESET" para confirmar el reinicio global:');
    if (userInput !== 'RESET') {
      showToast('Reinicio cancelado: texto incorrecto', 'warning');
      return;
    }

    const btn = $('#cmsResetBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reiniciando...'; }

    try {
      const { error } = await window.supabaseClient
        .from('site_content')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (error) throw error;

      cmsData = {};

      $$('.cms-field[data-key]').forEach(input => {
        input.value = '';
      });

      if (heroBgPreview) {
        heroBgPreview.innerHTML = '<i class="fas fa-cloud-arrow-up"></i><span>Sin imagen</span>';
        heroBgPreview.style.position = '';
      }
      if (heroBgHidden) heroBgHidden.value = '';

      populateCMSFieldsWithDefaults();

      invalidateRequestCache('site_content');

      showToast('? CMS reiniciado a valores de fábrica', 'success');
    } catch (err) {
      logError('Global reset error:', err);
      showToast('Error en reinicio global: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate-left"></i> Reinicio Global'; }
    }
  }

  function populateCMSFieldsWithDefaults() {
    Object.entries(DEFAULT_CMS_CONTENT).forEach(([sectionKey, content]) => {
      Object.entries(content).forEach(([path, value]) => {
        Object.entries(CMS_FIELD_MAP).forEach(([dataKey, mapping]) => {
          if (mapping.section === sectionKey && mapping.path === path) {
            const input = $(`.cms-field[data-key="${dataKey}"]`);
            if (input) input.value = value;
          }
        });
      });
    });
  }

  on($('#cmsResetBtn'), 'click', async () => {
    await globalResetCMS();
  });

  const heroBgFile = $('#cmsHeroBgFile');
  const heroBgPreview = $('#cmsHeroBgPreview');
  const heroBgHidden = $('#cms_hero_bg');

  on($('#cmsHeroBgUpload'), 'click', () => heroBgFile?.click());

  on(heroBgFile, 'change', (e) => {
    (async () => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) { showToast('Solo se permiten imágenes', 'error'); return; }

      try {
        heroBgPreview.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Subiendo...</span>';
        if (!window.BH_Cloudinary) { showToast('Cloudinary no disponible', 'error'); return; }
        const url = await window.BH_Cloudinary.uploadImage(file, 'bienenhaus/hero');
        if (heroBgHidden) heroBgHidden.value = url;
        heroBgPreview.innerHTML = '<img src="' + esc(url) + '" alt="Hero background" /><span style="position:absolute;bottom:2px;right:2px;font-size:9px;background:rgba(0,0,0,.7);padding:2px 5px;border-radius:3px;">Cloudinary ?</span>';
        heroBgPreview.style.position = 'relative';
        showToast('Imagen subida a Cloudinary', 'success');
      } catch (err) {
        logError('Upload error:', err);
        heroBgPreview.innerHTML = '<i class="fas fa-cloud-arrow-up"></i><span>Error al subir</span>';
        showToast('Error al subir imagen: ' + err.message, 'error');
      }
    })();
  });

  /* ------------------------------------------------
     9b. CONFIGURACIÓN GENERAL (site_content + app_settings)
     ------------------------------------------------ */
  let cfgData = {};

  const CFG_FIELD_MAP = {
    razon_social:     { section: 'footer',  path: 'razon_social' },
    matricula:        { section: 'footer',  path: 'matricula' },
    watermark:        { section: 'footer',  path: 'copyright' },
    cuit:             { section: 'footer',  path: 'cuit' },
    whatsapp:         { section: 'contact', path: 'whatsapp' },
    email:            { section: 'contact', path: 'email' },
    phone:            { section: 'contact', path: 'phone' },
    schedule:         { section: 'contact', path: 'schedule' },
    social_instagram: { section: 'social',  path: 'instagram' },
    social_facebook:  { section: 'social',  path: 'facebook' },
    social_linkedin:  { section: 'social',  path: 'linkedin' },
    social_youtube:   { section: 'social',  path: 'youtube' },
    zernio_api_key:   { section: 'zernio',  path: 'api_key' }
  };

  function applyCfgGuard() {
    const editable = canManageUsers();
    $$('.cfg-field, .cfg-field-pref').forEach(i => { i.disabled = !editable; });
    const saveBtn = $('#cfgSaveBtn');
    if (saveBtn) saveBtn.disabled = !editable;
    const note = $('#cfgGuardNote');
    if (note) note.style.display = editable ? 'none' : 'block';
  }

  function populateCfgFields() {
    $$('.cfg-field[data-key]').forEach(input => {
      const m = CFG_FIELD_MAP[input.dataset.key];
      if (!m || !cfgData[m.section]) return;
      input.value = (cfgData[m.section].content || {})[m.path] || '';
    });
  }

  async function loadConfig() {
    const client = await getAuthedClient();
    if (!client) return;
    try {
      const [{ data: rows, error }, prefRes, zernioRes] = await Promise.all([
        client.from('site_content').select('id, section_key, content').in('section_key', ['contact', 'footer', 'social']),
        client.from('app_settings').select('key, value, updated_at'),
        client.from('zernio_config').select('value').eq('key', 'api_key').maybeSingle()
      ]);
      if (error) throw error;
      if (!prefRes.error && Array.isArray(prefRes.data)) {
        const prefs = prefRes.data.find(r => r.key === 'preferences');
        const rateInput = $('#cfg_usd_rate');
        if (prefs?.value && typeof prefs.value.usd_rate === 'number' && rateInput) rateInput.value = prefs.value.usd_rate;
        const hint = $('#cfgUsdRateHint');
        if (hint && prefs?.updated_at) {
          const daysOld = Math.floor((Date.now() - new Date(prefs.updated_at).getTime()) / 86400000);
          hint.textContent = daysOld > 7 ? `⚠ Cotización cargada hace ${daysOld} días — conviene actualizarla` : `Actualizada hace ${daysOld} día${daysOld === 1 ? '' : 's'}`;
          hint.style.color = daysOld > 7 ? 'var(--warning)' : 'var(--text-dim)';
        }
      }
      if (zernioRes.data?.value) {
        const val = zernioRes.data.value;
        const apiKey = typeof val === 'string' ? val : val.key;
        if (apiKey) {
          const keyInput = $('#cfg_zernio_api_key');
          if (keyInput) keyInput.value = apiKey;
        }
      }
      cfgData = {};
      (rows || []).forEach(item => { cfgData[item.section_key] = item; });
      populateCfgFields();
      applyCfgGuard();
      renderCfgStatus();
      renderCfgSession();
      renderCfgCompleteness();
    } catch (err) {
      logError('Config error:', err);
      showToast('Error al cargar configuración: ' + err.message, 'error');
    }
  }

  on($('#cfgSaveBtn'), 'click', async () => {
    const btn = $('#cfgSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
    try {
      const client = await getAuthedClient();
      const rateRaw = ($('#cfg_usd_rate')?.value ?? '').trim();
      let rateVal = null;
      if (rateRaw !== '') {
        rateVal = Number(rateRaw);
        if (!Number.isFinite(rateVal) || rateVal <= 0) throw new Error('La cotización USD debe ser un número positivo.');
      }

      const updatesBySection = {};
      $$('.cfg-field[data-key]').forEach(field => {
        const m = CFG_FIELD_MAP[field.dataset.key];
        if (!m) return;
        if (!updatesBySection[m.section]) updatesBySection[m.section] = {};
        updatesBySection[m.section][m.path] = field.value.trim();
      });

      await Promise.all(Object.entries(updatesBySection).map(async ([sectionKey, newFields]) => {
        if (sectionKey === 'zernio') {
          const apiKey = newFields.api_key?.trim();
          if (apiKey) {
            const { error } = await client
              .from('zernio_config')
              .upsert({ key: 'api_key', value: apiKey, updated_at: new Date().toISOString() }, { onConflict: 'key' });
            if (error) throw error;
          }
          return;
        }
        const existing = cfgData[sectionKey];
        const mergedContent = { ...(existing?.content || {}), ...newFields };
        if (existing) {
          const { error } = await client
            .from('site_content').update({ content: mergedContent }).eq('id', existing.id);
          if (error) throw error;
          existing.content = mergedContent;
        } else {
          const { data, error } = await client
            .from('site_content').insert([{ section_key: sectionKey, content: mergedContent }]).select().single();
          if (error) throw error;
          cfgData[sectionKey] = data;
        }
      }));

      if (rateVal !== null) {
        const { error: upErr } = await client
          .from('app_settings')
          .upsert({ key: 'preferences', value: { usd_rate: rateVal }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (upErr) throw upErr;
      }

      showToast('Configuración guardada correctamente', 'success');
    } catch (err) {
      showToast('Error al guardar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar Cambios';
    }
  });

  function statusChip(label, ok, detail) {
    const color = ok ? '#4ade80' : '#f87171';
    return '<span style="display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:999px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.03); font-size:12px; color:#ddd;">'
      + '<span style="width:8px; height:8px; border-radius:50%; background:' + color + '; box-shadow:0 0 6px ' + color + ';"></span>'
      + esc(label)
      + (detail ? '&nbsp;<span style="color:var(--text-dim);">· ' + esc(detail) + '</span>' : '')
      + '</span>';
  }

  function renderCfgStatus() {
    const row = $('#cfgStatusRow');
    if (!row || !window.supabaseClient) return;
    // Chips honestos: solo marcan verde lo verificado en esta sesión
    let zernioChip = statusChip('Zernio', false, 'sin verificar');
    try {
      const probe = JSON.parse(sessionStorage.getItem('cfgZernioLastProbe') || 'null');
      if (probe && Date.now() - probe.at < 30 * 60 * 1000) {
        zernioChip = probe.ok
          ? statusChip('Zernio', true, `OK hace ${Math.floor((Date.now() - probe.at) / 60000)}min (${probe.ms}ms)`)
          : statusChip('Zernio', false, `falló ${new Date(probe.at).toLocaleTimeString('es-AR')}`);
      }
    } catch (_) {}
    row.innerHTML = statusChip('Supabase', true, 'conectado')
      + statusChip('Cloudinary', !!window.BH_Cloudinary, window.BH_Cloudinary ? 'listo' : 'no disponible')
      + statusChip('Brevo SMTP', false, 'no verificado en esta sesión')
      + statusChip('Mercado Libre', !!ml_connected, ml_configured ? 'credenciales OK' : 'sin configurar')
      + zernioChip;
  }

  function renderCfgSession() {
    const info = $('#cfgSessionInfo');
    if (!info) return;
    info.innerHTML = '<strong style="color:#fff;">' + esc(currentUser?.email || '—') + '</strong> · rol: ' + esc(currentProfile?.role || '—');
  }

  function renderCfgCompleteness() {
    const banner = $('#cfgCompletenessBanner');
    if (!banner) return;
    const missing = [];
    if (!($('#cfg_zernio_api_key')?.value || '').trim()) missing.push('API key de Zernio (chat redes)');
    if (!($('#cfg_usd_rate')?.value || '').trim()) missing.push('Cotización USD/ARS');
    if (!window.BH_CONFIG?.CLOUDINARY_CLOUD_NAME) missing.push('Cloudinary (subida de imágenes)');
    if (!ml_configured) missing.push('Credenciales Mercado Libre (Portales)');
    if (!missing.length) { banner.style.display = 'none'; return; }
    banner.style.display = 'block';
    banner.innerHTML = '<i class="fas fa-triangle-exclamation" style="color:var(--warning); margin-right:8px;"></i><strong>Configuración incompleta:</strong> ' + missing.map(esc).join(' · ');
  }

  /* Zernio Config UI helpers */
  on($('#toggleZernioKey'), 'click', () => {
    const input = $('#cfg_zernio_api_key');
    const icon = $('#toggleZernioKey i');
    if (!input || !icon) return;
    if (input.type === 'password') {
      input.type = 'text';
      icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
      input.type = 'password';
      icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
  });

  on($('#btnTestZernio'), 'click', async () => {
    const btn = $('#btnTestZernio');
    const statusEl = $('#zernioTestStatus');
    const keyInput = $('#cfg_zernio_api_key');
    const apiKey = keyInput?.value?.trim();
    if (!apiKey) { statusEl.textContent = '? Ingresá tu API Key primero'; statusEl.style.color = 'var(--warning)'; return; }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Probando...';
    statusEl.textContent = 'Conectando...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const session = await window.supabaseClient.auth.getSession();
      const t0 = performance.now();
      const res = await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/zernio-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.data.session?.access_token}` },
        body: JSON.stringify({ action: 'list_accounts' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error en respuesta');
      const ms = Math.round(performance.now() - t0);
      statusEl.textContent = `Conectado · ${data.count} cuenta(s) · ${ms}ms · ${new Date().toLocaleTimeString('es-AR')}`;
      statusEl.style.color = 'var(--success)';
      sessionStorage.setItem('cfgZernioLastProbe', JSON.stringify({ ok: true, at: Date.now(), ms, count: data.count }));
    } catch (err) {
      statusEl.textContent = '✗ ' + err.message;
      statusEl.style.color = 'var(--danger)';
      sessionStorage.setItem('cfgZernioLastProbe', JSON.stringify({ ok: false, at: Date.now(), error: err.message }));
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> Probar Conexión Zernio';
    }
  });


  window.__BH.loadCMS = loadCMS;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadCMS')) Object.defineProperty(window, 'loadCMS', { get: () => loadCMS, set: (v) => { loadCMS = v; }, configurable: true });
  window.__BH.loadConfig = loadConfig;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadConfig')) Object.defineProperty(window, 'loadConfig', { get: () => loadConfig, set: (v) => { loadConfig = v; }, configurable: true });
})();
