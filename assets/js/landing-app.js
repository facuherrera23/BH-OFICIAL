/* ============================================================
   BIENENHAUS PROPIEDADES — Landing Page App
   ============================================================ */

const _usdFormatter = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

(function () {
  'use strict';

  /* Security helpers (assets/js/utils.js). Fail-closed: sin BHUtils no se renderiza data dinamica. */
  if (!window.BHUtils) {
    console.error('[BH Landing] BHUtils no disponible — abortando init (fail-closed)');
    return;
  }
  const { esc, escAttr, safeUrl, safeImageUrl, safeCssUrl } = window.BHUtils;

  /* ------------------------------------------------
     0. PRELOADER & INITIALIZATION
     ------------------------------------------------ */
  window.addEventListener('load', () => {
    document.body.classList.remove('is-loading');
    setTimeout(() => {
      const pl = document.getElementById('preloader');
      if (pl) pl.classList.add('is-hidden');
    }, 800);
    initScrollAnimations();
    initCursorGlow();
    initParallax();
    loadLandingData();
  });

  /* ------------------------------------------------
     1. NAVBAR
     ------------------------------------------------ */
  const navbar = document.getElementById('mainNavbar');
  const mobileToggle = document.getElementById('mobileToggle');
  const mobileMenu = document.getElementById('mobileMenu');
  const mobileLinks = mobileMenu ? mobileMenu.querySelectorAll('a') : [];

  function onScrollNavbar() {
    if (!navbar) return;
    navbar.classList.toggle('is-scrolled', window.scrollY > 50);
  }

  if (mobileToggle) {
    mobileToggle.addEventListener('click', () => {
      const expanded = mobileToggle.getAttribute('aria-expanded') === 'true';
      mobileToggle.setAttribute('aria-expanded', String(!expanded));
      mobileMenu?.classList.toggle('is-open', !expanded);
      document.body.style.overflow = expanded ? '' : 'hidden';
    });
  }

  mobileLinks.forEach(link => {
    link.addEventListener('click', () => {
      mobileToggle?.setAttribute('aria-expanded', 'false');
      mobileMenu?.classList.remove('is-open');
      document.body.style.overflow = '';
    });
  });

  /* ------------------------------------------------
     2. SCROLL PROGRESS BAR
     ------------------------------------------------ */
  const scrollProgress = document.getElementById('scrollProgress');

  function updateScrollProgress() {
    if (!scrollProgress) return;
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    scrollProgress.style.width = docHeight > 0 ? `${(scrollTop / docHeight) * 100}%` : '0%';
  }

  /* ------------------------------------------------
     3. SECTION ANIMATIONS (IntersectionObserver)
     ------------------------------------------------ */
  function initScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          // Activate timeline dots/line
          if (entry.target.classList.contains('timeline')) {
            const progress = entry.target.querySelector('.timeline-line-progress');
            const dots = entry.target.querySelectorAll('.timeline-dot');
            if (progress) progress.classList.add('animated');
            dots.forEach(d => d.classList.add('active'));
          }
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('[data-animate], .timeline').forEach(el => observer.observe(el));
  }

  /* ------------------------------------------------
     4. CURSOR GLOW (desktop only)
     ------------------------------------------------ */
  function initCursorGlow() {
    const dot = document.getElementById('cursorDot');
    const glow = document.getElementById('cursorGlow');
    if (!dot || !glow) return;
    if (matchMedia('(hover: none)').matches || matchMedia('(pointer: coarse)').matches) return;

    let mx = 0, my = 0, cx = 0, cy = 0;

    document.addEventListener('mousemove', (e) => {
      mx = e.clientX;
      my = e.clientY;
      dot.style.left = mx + 'px';
      dot.style.top = my + 'px';
      dot.classList.add('is-visible');
      glow.classList.add('is-visible');
    });

    document.addEventListener('mouseleave', () => {
      dot.classList.remove('is-visible');
      glow.classList.remove('is-visible');
    });

    function animateGlow() {
      cx += (mx - cx) * 0.12;
      cy += (my - cy) * 0.12;
      glow.style.left = cx + 'px';
      glow.style.top = cy + 'px';
      requestAnimationFrame(animateGlow);
    }
    animateGlow();

    const hoverEls = document.querySelectorAll('a, button, .property-card, .team-card, .filter-pill, .form-pill, .stat-card, .service-card, .step-card');
    hoverEls.forEach(el => {
      el.addEventListener('mouseenter', () => glow.classList.add('is-hover'));
      el.addEventListener('mouseleave', () => glow.classList.remove('is-hover'));
    });
  }

  /* ------------------------------------------------
     5. PARALLAX ORBS
     ------------------------------------------------ */
  function initParallax() {
    const orbs = document.querySelectorAll('.hero-orb');
    if (!orbs.length) return;
    window.addEventListener('scroll', () => {
      const sy = window.scrollY;
      orbs.forEach((orb, i) => {
        const speed = i === 0 ? 0.25 : 0.15;
        orb.style.transform = `translateY(${sy * speed}px)`;
      });
    }, { passive: true });
  }

  /* ------------------------------------------------
     6. ALL LISTENERS
     ------------------------------------------------ */
  window.addEventListener('scroll', () => {
    onScrollNavbar();
    updateScrollProgress();
  }, { passive: true });

  /* ------------------------------------------------
     7. VIDEO MODAL
     ------------------------------------------------ */
  const videoModal = document.getElementById('videoModal');
  const videoModalClose = document.getElementById('videoModalClose');

  document.getElementById('openVideoModal')?.addEventListener('click', () => {
    if (!videoEmbedUrl) return;
    injectVideoIframe(videoEmbedUrl);
    videoModal?.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  });

  function closeVideoModal() {
    videoModal?.classList.remove('is-open');
    document.body.style.overflow = '';
    stopVideoModal();
  }
  videoModalClose?.addEventListener('click', closeVideoModal);
  videoModal?.addEventListener('click', (e) => {
    if (e.target === videoModal) closeVideoModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeVideoModal();
  });

  /* ------------------------------------------------
     8. FILTER PILLS
     ------------------------------------------------ */
  document.querySelectorAll('.filters-pills').forEach(group => {
    group.addEventListener('click', (e) => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      group.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      filterProperties();
    });
  });

  /* ------------------------------------------------
     9. FAVORITE BUTTONS
     ------------------------------------------------ */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.card-favorite');
    if (btn) {
      e.preventDefault();
      btn.classList.toggle('liked');
      const icon = btn.querySelector('i');
      if (icon) icon.className = btn.classList.contains('liked') ? 'fas fa-heart' : 'far fa-heart';
    }
  });

  /* ------------------------------------------------
     10. CARD MOUSE TRACKING (radial glow)
     ------------------------------------------------ */
  document.addEventListener('mousemove', (e) => {
    const card = e.target.closest('.property-card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    card.style.setProperty('--mouse-x', x + '%');
    card.style.setProperty('--mouse-y', y + '%');
  });

  /* ------------------------------------------------
     11. CONTACT FORM
     ------------------------------------------------ */
  const contactForm = document.getElementById('contactForm');
  const submitSuccess = document.getElementById('submitSuccess');
  const btnSubmit = contactForm?.querySelector('.btn-submit');

  if (contactForm) {
    contactForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btnSubmit) {
        btnSubmit.classList.add('loading');
        btnSubmit.disabled = true;
      }

      try {
        const formData = new FormData(contactForm);
        const data = Object.fromEntries(formData.entries());

        // Determine interest from active pills
        const activePills = contactForm.querySelectorAll('.form-pill.active');
        const interests = Array.from(activePills).flatMap(p => {
          const v = p.dataset.value || p.textContent.trim();
          return v ? [v] : [];
        });

        const payload = {
          full_name: data.nombre || '',
          email: data.email || '',
          phone: data.telefono || '',
          preferred_type: data.tipo_propiedad || '',
          budget_usd: parseFloat(data.presupuesto) || null,
          notes: data.mensaje || 'Consulta desde landing page',
          source: 'landing_page',
          preferred_zone: data.zona || '',
        };

        const { data: result, error } = await window.supabaseClient
          .from('leads')
          .insert([payload])
          .select()
          .single();

        if (error) throw error;

        contactForm.style.display = 'none';
        if (submitSuccess) submitSuccess.classList.add('show');
      } catch (err) {
        console.error('Error submitting form:', err);
        alert('Hubo un error al enviar tu consulta. Por favor intentá de nuevo.');
      } finally {
        if (btnSubmit) {
          btnSubmit.classList.remove('loading');
          btnSubmit.disabled = false;
        }
      }
    });
  }

  // Form pill toggles
  document.querySelectorAll('.form-pills').forEach(group => {
    group.addEventListener('click', (e) => {
      const pill = e.target.closest('.form-pill');
      if (!pill) return;
      pill.classList.toggle('active');
    });
  });

  /* ------------------------------------------------
     12. SUPABASE DATA LOADING
     ------------------------------------------------ */
  let allProperties = [];
  let allTeam = [];

  async function loadLandingData() {
    if (!window.supabaseClient) {
      console.warn('[BH Landing] Supabase client not available — data will not load');
      return;
    }
    await Promise.all([
      loadProperties(),
      loadTeam(),
      loadCMSContent(),
      loadStats()
    ]);
  }

  /* --- Properties --- */
  async function loadProperties() {
    const grid = document.getElementById('propertyGrid');
    if (!grid) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('properties')
        .select('*')
        .eq('is_published', true)
        .order('created_at', { ascending: false });

      if (error) throw error;

      allProperties = data || [];
      renderProperties(allProperties);
      updateResultsCount(allProperties.length);
    } catch (err) {
      console.error('Error loading properties:', err);
      renderEmptyState(grid, 'No hay propiedades disponibles', 'Estamos preparando nuevas opciones para vos.');
    }
  }

  function renderProperties(props) {
    const grid = document.getElementById('propertyGrid');
    if (!grid) return;

    if (!props.length) {
      renderEmptyState(grid, 'No se encontraron propiedades', 'Intentá con otros filtros.');
      return;
    }

    const FALLBACK_IMG = 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800&q=80&fit=crop';
    const cursorGlow = document.getElementById('cursorGlow');

    const makeIcon = (cls) => {
      const el = document.createElement('i');
      el.className = cls;
      return el;
    };

    const fragment = document.createDocumentFragment();

    for (const p of props) {
      const mainImg = (p.image_urls && p.image_urls.length > 0) ? p.image_urls[0] : FALLBACK_IMG;
      const locationText = [p.zone, p.address].filter(Boolean).join(', ');

      const card = document.createElement('div');
      card.className = 'property-card';
      card.dataset.type = (p.property_type || '').toLowerCase();

      const imageWrapper = document.createElement('div');
      imageWrapper.className = 'card-image-wrapper';

      const img = document.createElement('img');
      img.src = safeImageUrl(mainImg);
      img.alt = p.title || 'Propiedad';
      img.loading = 'lazy';
      imageWrapper.appendChild(img);

      if (p.featured) {
        const badge = document.createElement('span');
        badge.className = 'card-badge';
        badge.textContent = 'Destacada';
        imageWrapper.appendChild(badge);
      }

      const favBtn = document.createElement('button');
      favBtn.className = 'card-favorite';
      favBtn.setAttribute('aria-label', 'Guardar favorito');
      favBtn.appendChild(makeIcon('far fa-heart'));
      imageWrapper.appendChild(favBtn);

      const body = document.createElement('div');
      body.className = 'card-body';

      const price = document.createElement('div');
      price.className = 'card-price';
      price.textContent = formatPrice(p.price_usd);

      const title = document.createElement('h3');
      title.className = 'card-title';
      title.textContent = p.title || 'Propiedad';

      const location = document.createElement('div');
      location.className = 'card-location';
      location.appendChild(makeIcon('fas fa-map-marker-alt'));
      location.appendChild(document.createTextNode(' ' + locationText));

      const features = document.createElement('ul');
      features.className = 'card-features';
      const addFeature = (value, iconCls, label) => {
        if (!value) return;
        const li = document.createElement('li');
        li.appendChild(makeIcon(iconCls));
        li.appendChild(document.createTextNode(' ' + label));
        features.appendChild(li);
      };
      addFeature(p.bedrooms, 'fas fa-bed', `${p.bedrooms} Dorm.`);
      addFeature(p.bathrooms, 'fas fa-bath', `${p.bathrooms} Baños`);
      addFeature(p.area_m2, 'fas fa-ruler-combined', `${p.area_m2} m²`);
      addFeature(p.garage_spaces, 'fas fa-car', `${p.garage_spaces} ${p.garage_spaces === 1 ? 'Cochera' : 'Cocheras'}`);

      const desc = document.createElement('p');
      desc.className = 'card-desc';
      desc.textContent = p.description || '';

      const detailsBtn = document.createElement('button');
      detailsBtn.className = 'btn-card btn-card--coming-soon';
      detailsBtn.disabled = true;
      detailsBtn.title = 'Próximamente disponible';
      detailsBtn.appendChild(document.createTextNode('Ver Detalles '));
      detailsBtn.appendChild(makeIcon('fas fa-arrow-right'));

      body.append(price, title, location, features, desc, detailsBtn);
      card.append(imageWrapper, body);
      fragment.appendChild(card);

      card.addEventListener('mouseenter', () => cursorGlow?.classList.add('is-hover'));
      card.addEventListener('mouseleave', () => cursorGlow?.classList.remove('is-hover'));
    }

    grid.replaceChildren(fragment);
  }

  function renderEmptyState(container, title, text) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-home"></i></div>
        <h3 class="empty-state-title">${title}</h3>
        <p class="empty-state-text">${text}</p>
      </div>
    `;
  }

  function filterProperties() {
    const activeFilter = document.querySelector('.filters-pills .filter-pill.active');
    const type = activeFilter?.dataset?.type || 'todos';
    let filtered = allProperties;

    if (type !== 'todos') {
      filtered = allProperties.filter(p => (p.property_type || '').toLowerCase() === type);
    }

    renderProperties(filtered);
    updateResultsCount(filtered.length);
  }

  function updateResultsCount(count) {
    const el = document.getElementById('resultsCount');
    if (el) el.textContent = `${count} Propiedades`;
  }

  function formatPrice(price) {
    if (!price) return 'Consultar precio';
    return _usdFormatter.format(price);
  }

  /* --- Team --- */
  async function loadTeam() {
    const grid = document.getElementById('teamGrid');
    if (!grid) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('agents')
        .select('*')
        .eq('status', 'activo')
        .order('created_at', { ascending: true });

      if (error) throw error;

      allTeam = data || [];
      renderTeam(allTeam);
    } catch (err) {
      console.error('Error loading team:', err);
      renderEmptyState(grid, 'Equipo no disponible', 'Proximamente conocé a nuestro equipo.');
    }
  }

  function renderTeam(members) {
    const grid = document.getElementById('teamGrid');
    if (!grid) return;

    if (!members.length) {
      renderEmptyState(grid, 'Equipo no disponible', 'Proximamente conocé a nuestro equipo.');
      return;
    }

    grid.innerHTML = members.map(m => `
      <div class="team-card">
        <div class="team-image-wrapper">
          <img src="${escAttr(safeImageUrl(m.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=600&q=80&fit=crop'))}" 
               alt="${escAttr(m.full_name || 'Agente')}" loading="lazy" />
        </div>
        <div class="team-body">
          <h3 class="team-name">${esc(m.full_name || '')}</h3>
          <p class="team-role">${esc(m.matricula || 'Agente')}</p>
          <p class="team-bio">${esc(m.bio || '')}</p>
          <div class="team-specialties">
            ${(m.specialties || []).map(s => `<span class="team-pill">${esc(s)}</span>`).join('')}
          </div>
          <div class="team-social">
            ${m.phone ? `<a href="tel:${escAttr(String(m.phone))}" class="social-btn" aria-label="Telefono"><i class="fas fa-phone"></i></a>` : ''}
            ${m.email ? `<a href="mailto:${escAttr(String(m.email))}" class="social-btn" aria-label="Email"><i class="fas fa-envelope"></i></a>` : ''}
          </div>
        </div>
      </div>
    `).join('');
  }

  /* --- Stats --- */
  async function loadStats() {
    try {
      const [propCount, soldCount, agentCount, expYears] = await Promise.all([
        window.supabaseClient.from('properties').select('*', { count: 'exact', head: true }).eq('is_published', true),
        window.supabaseClient.from('properties').select('*', { count: 'exact', head: true }).eq('status', 'vendido'),
        window.supabaseClient.from('agents').select('*', { count: 'exact', head: true }).eq('status', 'activo'),
        Promise.resolve({ count: 15 }) // Default experience years
      ]);

      setStatNumber('statProperties', propCount.count || 0);
      setStatNumber('statSold', soldCount.count || 0);
      setStatNumber('statAgents', agentCount.count || 0);
      setStatNumber('statExperience', expYears.count || 15);
    } catch (err) {
      console.error('Error loading stats:', err);
    }
  }

  function setStatNumber(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    animateCounter(el, 0, target, 1800);
  }

  function animateCounter(el, start, end, duration) {
    const startTime = performance.now();
    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + (end - start) * eased);
      el.textContent = current.toLocaleString('es-AR');
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  /* --- CMS Content --- */
  let videoEmbedUrl = null;

  function toEmbedUrl(url) {
    if (!url) return null;
    /* YouTube watch → embed */
    let m = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
    if (m) return 'https://www.youtube.com/embed/' + m[1] + '?autoplay=1&rel=0';
    /* Already an embed URL */
    if (/youtube\.com\/embed\//.test(url)) return url.split('?')[0] + '?autoplay=1&rel=0';
    /* Vimeo */
    m = url.match(/vimeo\.com\/(\d+)/);
    if (m) return 'https://player.vimeo.com/video/' + m[1] + '?autoplay=1';
    /* Direct video file */
    if (/\.(mp4|webm|ogg)$/i.test(url)) return null; /* handled separately */
    return url;
  }

  function injectVideoIframe(url) {
    const frame = document.querySelector('.video-modal-frame');
    if (!frame) return;
    const embed = toEmbedUrl(url);
    const safeEmbed = embed ? safeUrl(embed) : '';
    if (safeEmbed) {
      frame.innerHTML = '<iframe src="' + escAttr(safeEmbed) + '" allow="autoplay; encrypted-media" allowfullscreen></iframe>';
    } else if (/\.(mp4|webm|ogg)$/i.test(url)) {
      const safeDirect = safeUrl(url);
      if (safeDirect) {
        frame.innerHTML = '<video controls autoplay src="' + escAttr(safeDirect) + '" style="width:100%;max-height:80vh;border-radius:12px;"></video>';
      }
    }
  }

  function stopVideoModal() {
    const frame = document.querySelector('.video-modal-frame');
    if (frame) {
      const iframe = frame.querySelector('iframe');
      if (iframe) iframe.src = '';
      const video = frame.querySelector('video');
      if (video) { video.pause(); video.src = ''; }
    }
  }

  async function loadCMSContent() {
    try {
      const { data, error } = await window.supabaseClient
        .from('site_content')
        .select('*');

      if (error) throw error;

      (data || []).forEach(item => {
        applySectionContent(item.section_key, item.content);
      });
    } catch (err) {
      console.error('Error loading CMS content:', err);
    }
  }

  function setText(selector, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el) el.textContent = value;
  }

  function setAttr(selector, attr, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el) el.setAttribute(attr, value);
  }

  function setContactValue(iconClass, value) {
    if (!value) return;
    const fasClass = 'fas ' + iconClass.replace('.', '');
    document.querySelectorAll('.contact-info-item').forEach(item => {
      if (item.querySelector(iconClass)) {
        const val = item.querySelector('.value');
        if (val) val.textContent = value;
      }
    });
    document.querySelectorAll('.footer-contact-item').forEach(item => {
      if (item.querySelector(iconClass)) {
        item.innerHTML = '<i class="' + escAttr(fasClass) + '"></i> ' + esc(value);
      }
    });
  }

  function setFooterValue(iconClass, value) {
    if (!value) return;
    const fasClass = 'fas ' + iconClass.replace('.', '');
    document.querySelectorAll('.footer-contact-item').forEach(item => {
      if (item.querySelector(iconClass)) {
        item.innerHTML = '<i class="' + escAttr(fasClass) + '"></i> ' + esc(value);
      }
    });
  }

  function applySectionContent(section, c) {
    if (!c || typeof c !== 'object') return;

    switch (section) {

      case 'hero':
        if (c.title) {
          const titleEl = document.querySelector('.hero-title');
          if (titleEl) titleEl.textContent = c.title;
        }
        setText('.hero-desc', c.subtitle);
        if (c.eyebrow) {
          const pill = document.querySelector('.eyebrow-pill');
          if (pill) pill.innerHTML = '<span class="pulse-live" aria-hidden="true"></span> ' + esc(c.eyebrow);
        }
        if (c.bg_image_url) {
          const cssBg = safeCssUrl(c.bg_image_url);
          const heroBg = document.querySelector('.hero-bg');
          if (heroBg && cssBg) heroBg.style.backgroundImage = 'url("' + cssBg + '")';
        }
        if (c.video_url) {
          videoEmbedUrl = c.video_url;
        }
        break;

      case 'services':
        setText('.services-title', c.title);
        setText('.services-desc', c.description);
        setText('.services-label', c.badge);
        break;

      case 'team':
        setText('.team-title', c.title);
        break;

      case 'process':
        setText('.process-title', c.title);
        break;

      case 'stats':
        setText('.stats-title', c.title);
        setText('.stats-premium .services-desc', c.description);
        if (c.properties_sold) {
          const statCards = document.querySelectorAll('.stats-premium .stat-card');
          if (statCards[0]) {
            const num = statCards[0].querySelector('.stat-card-number');
            if (num) num.innerHTML = esc(c.properties_sold) + '<span class="accent-symbol">+</span>';
          }
        }
        if (c.stat1_label) {
          const statCards = document.querySelectorAll('.stats-premium .stat-card');
          if (statCards[0]) {
            const label = statCards[0].querySelector('.stat-card-title');
            if (label) label.textContent = c.stat1_label;
          }
        }
        break;

      case 'contact':
        setText('.contact-title', c.title);
        setContactValue('.fa-envelope', c.email);
        setContactValue('.fa-phone', c.phone);
        setContactValue('.fa-clock', c.schedule);
        setFooterValue('.fa-envelope', c.email);
        setFooterValue('.fa-phone', c.phone);
        if (c.email) {
          setAttr('a[href^="mailto:"]', 'href', 'mailto:' + c.email);
        }
        if (c.whatsapp) {
          const waLinks = document.querySelectorAll('a[href*="wa.me"]');
          waLinks.forEach(a => a.href = 'https://wa.me/' + c.whatsapp.replace(/[^0-9]/g, ''));
        }
        break;

      case 'footer':
        if (c.copyright) {
          const footerBottom = document.querySelector('.footer-bottom > span');
          if (footerBottom) footerBottom.textContent = '© ' + new Date().getFullYear() + ' ' + c.copyright + '. Todos los derechos reservados.';
        }
        if (c.matricula) {
          const footerSub = document.querySelector('.footer-logo-sub');
          if (footerSub) footerSub.textContent = c.matricula;
        }
        if (c.cuit) {
          setFooterValue('.fa-id-card', 'CUIT: ' + c.cuit);
        }
        break;
    }
  }

  /* ------------------------------------------------
     13. NEWSLETTER FORM
     ------------------------------------------------ */
  const newsletterForm = document.getElementById('newsletterForm');
  if (newsletterForm) {
    newsletterForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const emailInput = document.getElementById('newsletterEmail');
      const btn = document.getElementById('newsletterBtn');
      const email = emailInput?.value?.trim();
      if (!email) return;
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Suscribiendo...'; }

      try {
        const { error } = await window.supabaseClient
          .from('leads')
          .insert([{
            email: email,
            full_name: '',
            source: 'newsletter',
            notes: 'Suscripción al newsletter desde la landing page',
          }]);
        if (error) throw error;
        newsletterForm.innerHTML = '<p style="color:var(--accent); font-size:14px; font-weight:500; padding:12px 0;"><i class="fas fa-check-circle"></i> ¡Gracias por suscribirte!</p>';
      } catch (err) {
        console.error('Newsletter error:', err);
        if (btn) { btn.disabled = false; btn.innerHTML = 'Suscribirse <i class="fas fa-arrow-right"></i>'; }
        emailInput.value = '';
        emailInput.placeholder = 'Error — intentá de nuevo';
      }
    });
  }

})();
