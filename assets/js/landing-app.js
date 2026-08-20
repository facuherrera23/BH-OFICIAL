/* ============================================================
   BIENENHAUS PROPIEDADES — Landing Page App
   ============================================================ */

(function () {
  'use strict';

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
    if (videoEmbedUrl) injectVideoIframe(videoEmbedUrl);
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
        const interests = Array.from(activePills).map(p => p.dataset.value || p.textContent.trim()).filter(Boolean);

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

    grid.innerHTML = props.map(p => {
      const mainImg = (p.image_urls && p.image_urls.length > 0) ? p.image_urls[0] : 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800&q=80&fit=crop';
      const locationText = [p.zone, p.address].filter(Boolean).join(', ');
      return `
      <div class="property-card" data-type="${(p.property_type || '').toLowerCase()}" data-status="${(p.status || '').toLowerCase()}">
        <div class="card-image-wrapper">
          <img src="${mainImg}" 
               alt="${p.title || 'Propiedad'}" loading="lazy" />
          ${p.featured ? '<span class="card-badge">Destacada</span>' : ''}
          <button class="card-favorite" aria-label="Guardar favorito"><i class="far fa-heart"></i></button>
        </div>
        <div class="card-body">
          <div class="card-price">${formatPrice(p.price_usd)}</div>
          <h3 class="card-title">${p.title || 'Propiedad'}</h3>
          <div class="card-location"><i class="fas fa-map-marker-alt"></i> ${locationText}</div>
          <ul class="card-features">
            ${p.bedrooms ? `<li><i class="fas fa-bed"></i> ${p.bedrooms} ${p.bedrooms === 1 ? 'Dorm.' : 'Dorm.'}</li>` : ''}
            ${p.bathrooms ? `<li><i class="fas fa-bath"></i> ${p.bathrooms} Baños</li>` : ''}
            ${p.area_m2 ? `<li><i class="fas fa-ruler-combined"></i> ${p.area_m2} m²</li>` : ''}
            ${p.garage_spaces ? `<li><i class="fas fa-car"></i> ${p.garage_spaces} ${p.garage_spaces === 1 ? 'Cochera' : 'Cocheras'}</li>` : ''}
          </ul>
          <p class="card-desc">${p.description || ''}</p>
          <a href="#" class="btn-card" onclick="return false;">
            Ver Detalles <i class="fas fa-arrow-right"></i>
          </a>
        </div>
      </div>
    `}).join('');

    // Re-init hover effects on new cards
    grid.querySelectorAll('.property-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        document.getElementById('cursorGlow')?.classList.add('is-hover');
      });
      card.addEventListener('mouseleave', () => {
        document.getElementById('cursorGlow')?.classList.remove('is-hover');
      });
    });
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
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(price);
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
          <img src="${m.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=600&q=80&fit=crop'}" 
               alt="${m.full_name || 'Agente'}" loading="lazy" />
        </div>
        <div class="team-body">
          <h3 class="team-name">${m.full_name || ''}</h3>
          <p class="team-role">${m.matricula || 'Agente'}</p>
          <p class="team-bio">${m.bio || ''}</p>
          <div class="team-specialties">
            ${(m.specialties || []).map(s => `<span class="team-pill">${s}</span>`).join('')}
          </div>
          <div class="team-social">
            ${m.phone ? `<a href="tel:${m.phone}" class="social-btn" aria-label="Telefono"><i class="fas fa-phone"></i></a>` : ''}
            ${m.email ? `<a href="mailto:${m.email}" class="social-btn" aria-label="Email"><i class="fas fa-envelope"></i></a>` : ''}
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
    if (embed) {
      frame.innerHTML = '<iframe src="' + embed + '" allow="autoplay; encrypted-media" allowfullscreen></iframe>';
    } else if (/\.(mp4|webm|ogg)$/i.test(url)) {
      frame.innerHTML = '<video controls autoplay src="' + url + '" style="width:100%;max-height:80vh;border-radius:12px;"></video>';
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
        item.innerHTML = '<i class="' + fasClass + '"></i> ' + value;
      }
    });
  }

  function setFooterValue(iconClass, value) {
    if (!value) return;
    const fasClass = 'fas ' + iconClass.replace('.', '');
    document.querySelectorAll('.footer-contact-item').forEach(item => {
      if (item.querySelector(iconClass)) {
        item.innerHTML = '<i class="' + fasClass + '"></i> ' + value;
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
          if (pill) pill.innerHTML = '<span class="pulse-live" aria-hidden="true"></span> ' + c.eyebrow;
        }
        if (c.bg_image_url) {
          const heroBg = document.querySelector('.hero-bg');
          if (heroBg) heroBg.style.backgroundImage = 'url(' + c.bg_image_url + ')';
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
            if (num) num.innerHTML = c.properties_sold + '<span class="accent-symbol">+</span>';
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
        setContactValue('.fa-map-marker-alt', c.address);
        setContactValue('.fa-clock', c.schedule);
        setFooterValue('.fa-envelope', c.email);
        setFooterValue('.fa-phone', c.phone);
        setFooterValue('.fa-map-marker-alt', c.address);
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

})();
