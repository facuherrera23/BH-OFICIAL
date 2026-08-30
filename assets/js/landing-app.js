/* ============================================================
   BIENENHAUS PROPIEDADES — Landing Page App
   ============================================================ */

const _usdFormatter = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const _arsFormatter = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

(function () {
  'use strict';

  /* ------------------------------------------------
     DEBUG FLAG — false en producción, true solo en desarrollo
     ------------------------------------------------ */
  const DEBUG = false;

  function logError(...args) {
    if (DEBUG) console.error(...args);
  }

  /* Security helpers (assets/js/utils.js). Fail-closed: sin BHUtils no se renderiza data dinamica. */
  if (!window.BHUtils) {
    logError('[BH Landing] BHUtils no disponible — abortando init (fail-closed)');
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
    if (e.key === 'Escape' && videoModal?.classList.contains('is-open')) closeVideoModal();
  });

  /* ------------------------------------------------
     7b. PROPERTY DETAIL MODAL
     ------------------------------------------------ */
  const propertyModal = document.getElementById('propertyModal');
  const propertyModalClose = document.getElementById('propertyModalClose');
  let currentProperty = null;
  let currentGalleryImages = [];
  let currentImageIndex = 0;

  const STATUS_LABELS = { venta: 'Venta', alquiler: 'Alquiler', vendido: 'Vendido', alquilado: 'Alquilado', pausado: 'Pausado' };
  const TYPE_LABELS = { casa: 'Casa', departamento: 'Departamento', terreno: 'Terreno', local: 'Local', oficina: 'Oficina', galpon: 'Galpón', quinta: 'Quinta', otro: 'Otro' };

  function renderGalleryImage() {
    const mainImg = document.getElementById('propertyGalleryMain');
    const counter = document.getElementById('galleryCounter');
    const url = currentGalleryImages[currentImageIndex];
    if (!mainImg || !counter || !url) return;
    mainImg.src = safeImageUrl(url);
    mainImg.alt = `${currentProperty?.title || 'Propiedad'} — imagen ${currentImageIndex + 1}`;
    counter.textContent = `${currentImageIndex + 1} / ${currentGalleryImages.length}`;
    document.querySelectorAll('#propertyGalleryThumbs .gallery-thumb').forEach((thumb, i) => {
      thumb.classList.toggle('is-active', i === currentImageIndex);
      if (i === currentImageIndex) thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    });
  }

  function buildGalleryThumbs() {
    const thumbsWrap = document.getElementById('propertyGalleryThumbs');
    if (!thumbsWrap) return;
    const frag = document.createDocumentFragment();
    currentGalleryImages.forEach((url, i) => {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'gallery-thumb' + (i === currentImageIndex ? ' is-active' : '');
      thumb.setAttribute('aria-label', `Ver imagen ${i + 1}`);
      const img = document.createElement('img');
      img.src = safeImageUrl(url);
      img.alt = '';
      img.loading = 'lazy';
      thumb.appendChild(img);
      thumb.addEventListener('click', () => { currentImageIndex = i; renderGalleryImage(); });
      frag.appendChild(thumb);
    });
    thumbsWrap.replaceChildren(frag);
  }

  function fillPropertyInfo(p) {
    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

    setText('propertyDetailStatus', STATUS_LABELS[p.status] || p.status || '');
    setText('propertyDetailCode', p.property_code ? 'Cód. ' + p.property_code : '');
    setText('propertyDetailTitle', p.title || 'Propiedad');

    const locationEl = document.getElementById('propertyDetailLocation');
    if (locationEl) {
      locationEl.replaceChildren();
      locationEl.appendChild(makeIcon('fas fa-map-marker-alt'));
      locationEl.appendChild(document.createTextNode(' ' + [p.zone, p.address].filter(Boolean).join(', ')));
    }

    setText('propertyDetailPrice', formatPrice(p.price_usd, p.price_currency));

    const featuresEl = document.getElementById('propertyDetailFeatures');
    if (featuresEl) {
      featuresEl.replaceChildren();
      const addDetail = (value, iconCls, label) => {
        if (!value) return;
        const li = document.createElement('li');
        li.appendChild(makeIcon(iconCls));
        li.appendChild(document.createTextNode(' ' + label));
        featuresEl.appendChild(li);
      };
      const typeLabel = TYPE_LABELS[(p.property_type || '').toLowerCase()] || p.property_type;
      addDetail(typeLabel, 'fas fa-home', typeLabel);
      addDetail(p.rooms, 'fas fa-door-open', `${p.rooms} Ambiente${p.rooms === 1 ? '' : 's'}`);
      addDetail(p.bedrooms, 'fas fa-bed', `${p.bedrooms} Dormitorio${p.bedrooms === 1 ? '' : 's'}`);
      addDetail(p.bathrooms, 'fas fa-bath', `${p.bathrooms} Baño${p.bathrooms === 1 ? '' : 's'}`);
      addDetail(p.area_m2, 'fas fa-ruler-combined', `${p.area_m2} m² totales`);
      addDetail(p.garage_spaces, 'fas fa-car', `${p.garage_spaces} ${p.garage_spaces === 1 ? 'Cochera' : 'Cocheras'}`);
      addDetail(p.year_built, 'far fa-calendar-alt', `Año ${p.year_built}`);
    }

    setText('propertyDetailDesc', p.description || 'Sin descripción disponible.');
  }

  function openPropertyModal(propertyId) {
    const p = allProperties.find(x => x.id === propertyId);
    if (!p || !propertyModal) return;
    currentProperty = p;

    currentGalleryImages = Array.isArray(p.image_urls) ? p.image_urls.filter(Boolean) : [];
    if (!currentGalleryImages.length) currentGalleryImages = [FALLBACK_IMG];
    currentImageIndex = 0;

    fillPropertyInfo(p);
    buildGalleryThumbs();
    renderGalleryImage();

    const videoWrap = document.getElementById('propertyDetailVideoWrap');
    const videoFrame = document.getElementById('propertyVideoFrame');
    if (videoFrame) videoFrame.replaceChildren();

    const rawVideo = (p.video_url || '').trim();
    let injected = false;
    if (rawVideo && videoFrame) {
      const embed = toEmbedUrl(rawVideo);
      const safeEmbed = embed ? safeUrl(embed) : '';
      if (safeEmbed) {
        videoFrame.innerHTML = '<iframe src="' + escAttr(safeEmbed) + '" allow="autoplay; encrypted-media; fullscreen" loading="lazy" title="Video de la propiedad"></iframe>';
        injected = true;
      } else if (/\.(mp4|webm|ogg)$/i.test(rawVideo)) {
        const safeDirect = safeUrl(rawVideo);
        if (safeDirect) {
          videoFrame.innerHTML = '<video controls preload="metadata" src="' + escAttr(safeDirect) + '"></video>';
          injected = true;
        }
      }
    }
    if (videoWrap) videoWrap.hidden = !injected;

    propertyModal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closePropertyModal() {
    propertyModal?.classList.remove('is-open');
    document.body.style.overflow = '';
    document.getElementById('propertyVideoFrame')?.replaceChildren();
  }

  propertyModalClose?.addEventListener('click', closePropertyModal);
  propertyModal?.addEventListener('click', (e) => {
    if (e.target === propertyModal) closePropertyModal();
  });
  document.addEventListener('keydown', (e) => {
    if (!propertyModal?.classList.contains('is-open')) return;
    if (e.key === 'Escape') closePropertyModal();
    else if (e.key === 'ArrowRight') {
      currentImageIndex = (currentImageIndex + 1) % currentGalleryImages.length;
      renderGalleryImage();
    } else if (e.key === 'ArrowLeft') {
      currentImageIndex = (currentImageIndex - 1 + currentGalleryImages.length) % currentGalleryImages.length;
      renderGalleryImage();
    }
  });
  document.getElementById('galleryPrev')?.addEventListener('click', () => {
    currentImageIndex = (currentImageIndex - 1 + currentGalleryImages.length) % currentGalleryImages.length;
    renderGalleryImage();
  });
  document.getElementById('galleryNext')?.addEventListener('click', () => {
    currentImageIndex = (currentImageIndex + 1) % currentGalleryImages.length;
    renderGalleryImage();
  });

  document.getElementById('propertyGrid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-card[data-property-id]');
    if (btn) openPropertyModal(btn.dataset.propertyId);
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

        const { error } = await window.supabaseClient
          .from('leads')
          .insert([payload]);

        if (error) throw error;

        contactForm.style.display = 'none';
        if (submitSuccess) submitSuccess.classList.add('show');
      } catch (err) {
        logError('Error submitting form:', err);
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

  const FALLBACK_IMG = 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800&q=80&fit=crop';
  const makeIcon = (cls) => {
    const el = document.createElement('i');
    el.className = cls;
    return el;
  };

  /* ------------------------------------------------
   PERFORMANCE OPTIMIZATIONS
   ------------------------------------------------ */

// Request deduplication cache
const _requestCache = new Map();
const _requestInFlight = new Map();

// Deduplicated fetch with automatic deduplication
async function dedupedFetch(key, fetchFn, ttl = 30000) {
  const now = Date.now();
  const cached = _requestCache.get(key);
  if (cached && now - cached.timestamp < ttl) {
    return cached.data;
  }

  const inFlight = _requestInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const promise = fetchFn().then(data => {
    _requestCache.set(key, { data, timestamp: Date.now() });
    _requestInFlight.delete(key);
    return data;
  }).catch(err => {
    _requestInFlight.delete(key);
    throw err;
  });

  _requestInFlight.set(key, promise);
  return promise;
}

// Clear cache on mutation
function invalidateRequestCache(pattern) {
  if (!pattern) {
    _requestCache.clear();
    return;
  }
  for (const key of _requestCache.keys()) {
    if (key.includes(pattern)) {
      _requestCache.delete(key);
    }
  }
}

// Image lazy loading with IntersectionObserver
function initLazyLoading() {
  if (!('IntersectionObserver' in window)) return;

  const imageObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        }
        if (img.dataset.srcset) {
          img.srcset = img.dataset.srcset;
          img.removeAttribute('data-srcset');
        }
        img.classList.add('loaded');
        observer.unobserve(img);
      }
    });
  }, {
    rootMargin: '50px 0px',
    threshold: 0.01
  });

  document.querySelectorAll('img[data-src]').forEach(img => {
    imageObserver.observe(img);
  });
}

// Virtual scrolling for large lists
function createVirtualScroller(containerId, items, renderItem, itemHeight = 120) {
  if (!items.length) return { destroy: () => {} };

  const container = document.getElementById(containerId);
  if (!container) return { destroy: () => {} };

  const visibleCount = Math.ceil(container.clientHeight / itemHeight) + 2;
  let startIndex = 0;
  let endIndex = Math.min(startIndex + visibleCount, items.length);

  const render = () => {
    const fragment = document.createDocumentFragment();
    for (let i = startIndex; i < endIndex; i++) {
      const item = items[i];
      const element = renderItem(item, i);
      element.style.position = 'absolute';
      element.style.top = `${i * itemHeight}px`;
      element.style.width = '100%';
      fragment.appendChild(element);
    }
    container.innerHTML = '';
    container.appendChild(fragment);
    container.style.height = `${items.length * itemHeight}px`;
  };

  const handleScroll = () => {
    const scrollTop = container.scrollTop;
    const newStart = Math.max(0, Math.floor(container.scrollTop / itemHeight) - 1);
    const newEnd = Math.min(items.length, newStart + visibleCount + 2);

    if (newStart !== startIndex || newEnd !== endIndex) {
      startIndex = newStart;
      endIndex = newEnd;
      render();
    }
  };

  container.addEventListener('scroll', () => {
    if (!container._scrollTimeout) {
      container._scrollTimeout = setTimeout(() => {
        handleScroll();
        container._scrollTimeout = null;
      }, 16);
    }
  });

  render();
  return { destroy: () => container.removeEventListener('scroll', handleScroll) };
}

// Debounce utility
function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, arguments), delay);
  };
}

// Throttle utility
function throttle(fn, limit) {
  let inThrottle;
  return (...args) => {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// CMS Content Cache
const _cmsCache = new Map();
const _cmsCacheTTL = 5 * 60 * 1000; // 5 minutes

async function getCachedCMS(sectionKey, fetchFn) {
  const cached = _cmsCache.get(sectionKey);
  if (cached && Date.now() - cached.timestamp < _cmsCacheTTL) {
    return cached.data;
  }

  const data = await fetchFn();
  _cmsCache.set(sectionKey, { data, timestamp: Date.now() });
  return data;
}

function invalidateCmsCache(sectionKey) {
  if (sectionKey) {
    _cmsCache.delete(sectionKey);
  } else {
    _cmsCache.clear();
  }
}

// Image lazy loading initialization
function initLazyLoading() {
  if (!('IntersectionObserver' in window)) return;

  const imageObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        }
        if (img.dataset.srcset) {
          img.srcset = img.dataset.srcset;
          img.removeAttribute('data-srcset');
        }
        img.classList.add('loaded');
        observer.unobserve(img);
      }
    });
  }, {
    rootMargin: '50px 0px',
    threshold: 0.01
  });

  document.querySelectorAll('img[data-src]').forEach(img => {
    imageObserver.observe(img);
  });
}

// Request deduplication for API calls
const _apiInFlight = new Map();

async function dedupedApiCall(key, fn) {
  const inFlight = _apiInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = fn().finally(() => _apiInFlight.delete(key));
  _apiInFlight.set(key, promise);
  return promise;
}

/* ------------------------------------------------
   HELPER FUNCTIONS FOR NEW CMS SECTIONS
   ------------------------------------------------ */

function renderHeroStats(stats) {
  if (!stats || !stats.length) return;
  const container = document.querySelector('.hero-stats');
  if (!container) return;
  container.innerHTML = stats.map(s => {
    if (!s.enabled) return '';
    return `
      <div class="stat-row">
        <div class="stat-icon"><i class="${esc(s.icon)}"></i></div>
        <div>
          <div class="stat-number" id="${esc(s.value_key)}">—</div>
          <div class="stat-label">${esc(s.label)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderTrustBlock(trust) {
  if (!trust) return;
  const container = document.querySelector('.trust-block');
  if (!container) return;
  container.innerHTML = `
    <div class="trust-title">${esc(trust.title)}</div>
    <div class="trust-desc">${esc(trust.description)}</div>
  `;
}

function renderFeatureBar(features) {
  if (!features || !features.length) return;
  const container = document.querySelector('.feature-bar');
  if (!container) return;
  container.innerHTML = features.map(f => {
    if (!f.enabled) return '';
    return `
      <div class="feature-item">
        <i class="${esc(f.icon)} feature-icon" aria-hidden="true"></i>
        <div>
          <div class="feature-title">${esc(f.title)}</div>
          <div class="feature-desc">${esc(f.description)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderCatalogFilters(filters) {
  if (!filters) return;
  const opsSelect = document.getElementById('searchOperacion');
  const typesSelect = document.getElementById('searchTipo');
  const zonesSelect = document.getElementById('searchZona');
  const pricesSelect = document.getElementById('searchPrecio');

  if (filters.operations && opsSelect) {
    opsSelect.innerHTML = '<option value="">Todas las operaciones</option>' + filters.operations.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  }
  if (filters.types && typesSelect) {
    typesSelect.innerHTML = '<option value="">Todos los tipos</option>' + filters.types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  }
  if (filters.zones && zonesSelect) {
    zonesSelect.innerHTML = '<option value="">Todas las zonas</option>' + filters.zones.map(z => `<option value="${esc(z)}">${esc(z)}</option>`).join('');
  }
  if (filters.prices && pricesSelect) {
    pricesSelect.innerHTML = '<option value="">Todos los precios</option>' + filters.prices.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
}

function renderServicesItems(items) {
  if (!items || !items.length) return;
  const grid = document.querySelector('.services-grid');
  if (!grid) return;
  grid.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(s => `
    <div class="service-card" data-animate>
      <div class="service-icon"><i class="${esc(s.icon)}"></i></div>
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.description)}</p>
      <a href="${escAttr(s.link_url)}" class="service-link">${esc(s.link_text)} <i class="fas fa-arrow-right"></i></a>
    </div>
  `).join('');
}

function renderTeamMembers(members) {
  if (!members || !members.length) return;
  const grid = document.getElementById('teamGrid');
  if (!grid) return;
  grid.innerHTML = members.filter(m => m.enabled).sort((a, b) => a.order - b.order).map(m => `
    <div class="team-card" data-animate>
      <div class="team-image-wrapper">
        <img src="${escAttr(safeImageUrl(m.photo_url || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=600&q=80&fit=crop'))}" alt="${escAttr(m.full_name || 'Agente')}" loading="lazy" />
      </div>
      <div class="team-body">
        <h3 class="team-name">${esc(m.full_name || '')}</h3>
        <p class="team-role">${esc(m.role || m.matricula || 'Agente')}</p>
        <p class="team-bio">${esc(m.bio || '')}</p>
        <div class="team-specialties">
          ${(m.specialties || []).map(s => `<span class="team-pill">${esc(s)}</span>`).join('')}
        </div>
        <div class="team-social">
          ${m.phone ? `<a href="tel:${escAttr(String(m.phone))}" class="social-btn" aria-label="Teléfono"><i class="fas fa-phone"></i></a>` : ''}
          ${m.email ? `<a href="mailto:${escAttr(String(m.email))}" class="social-btn" aria-label="Email"><i class="fas fa-envelope"></i></a>` : ''}
        </div>
      </div>
    `).join('');
}

function renderStatsItems(items) {
  if (!items || !items.length) return;
  const grid = document.querySelector('.stats-grid');
  if (!grid) return;
  grid.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(s => `
    <div class="stat-card" data-animate>
      <div class="stat-icon"><i class="${esc(s.icon)}"></i></div>
      <div class="stat-value" style="font-family:var(--font-heading); font-size:36px; color:#fff; font-weight:700;">${esc(s.value)}${esc(s.suffix || '')}</div>
      <div class="stat-label">${esc(s.title)}</div>
      <div class="stat-desc">${esc(s.description)}</div>
    </div>
  `).join('');
}

function renderStatsCTA(cta) {
  if (!cta) return;
  const container = document.querySelector('.stats-cta');
  if (!container) return;
  container.innerHTML = `
    <div class="stats-cta-icon">
      <i class="fas fa-phone-volume"></i>
      <span>${esc(cta.label)}</span>
    </div>
    <a href="${escAttr(cta.button_url)}" class="btn-stats">
      ${esc(cta.button_text)} <i class="fas fa-arrow-right"></i>
    </a>
  `;
}

function renderProcessSteps(steps) {
  if (!steps || !steps.length) return;
  const grid = document.querySelector('.steps-grid');
  if (!grid) return;
  grid.innerHTML = steps.filter(s => s.enabled).sort((a, b) => a.order - b.order).map(s => `
    <div class="step-card" data-animate>
      <div class="step-number">${esc(s.number)}</div>
      <div class="step-icon"><i class="${esc(s.icon)}"></i></div>
      <h3 class="step-title">${esc(s.title)}</h3>
      <p class="step-desc">${esc(s.description)}</p>
    </div>
  `).join('');
}

function renderCommitment(commitment) {
  if (!commitment) return;
  const container = document.querySelector('.commitment-bar');
  if (!container) return;
  container.innerHTML = `
    <div class="commitment-icon">
      <i class="fas fa-handshake"></i>
      <span>${esc(commitment.title)}</span>
    </div>
    <p class="commitment-text">${esc(commitment.description)}</p>
    <div class="commitment-signature">${esc(commitment.signature)}</div>
  `;
}

function renderCatalogFilters(filters) {
  if (!filters) return;
  const opsSelect = document.getElementById('searchOperacion');
  const typesSelect = document.getElementById('searchTipo');
  const zonesSelect = document.getElementById('searchZona');
  const pricesSelect = document.getElementById('searchPrecio');

  if (filters.operations && opsSelect) {
    opsSelect.innerHTML = '<option value="">Todas las operaciones</option>' + filters.operations.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  }
  if (filters.types && typesSelect) {
    typesSelect.innerHTML = '<option value="">Todos los tipos</option>' + filters.types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  }
  if (filters.zones && zonesSelect) {
    zonesSelect.innerHTML = '<option value="">Todas las zonas</option>' + filters.zones.map(z => `<option value="${esc(z)}">${esc(z)}</option>`).join('');
  }
  if (filters.prices && pricesSelect) {
    pricesSelect.innerHTML = '<option value="">Todos los precios</option>' + filters.prices.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
}

function renderFormOptions(options) {
  if (!options || !options.length) return;
  const container = document.querySelector('.form-pills');
  if (!container) return;
  container.innerHTML = options.map(o => `
    <button type="button" class="form-pill" data-value="${esc(o.value)}">${esc(o.label)}</button>
  `).join('');
  document.querySelectorAll('.form-pills .form-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      pill.classList.toggle('active');
    });
  });
}

function renderFormFields(fields) {
  if (!fields) return;
  Object.entries(fields).forEach(([key, field]) => {
    const input = document.querySelector(`#${key}`);
    if (!input) return;
    if (field.label) {
      const label = document.querySelector(`label[for="${key}"]`);
      if (label) label.textContent = field.label;
    }
    if (field.placeholder) {
      const input = document.getElementById(key);
      if (input) input.placeholder = field.placeholder;
    }
    if (field.required !== undefined) {
      const input = document.getElementById(key);
      if (input) input.required = field.required;
    }
    if (field.options && field.options.length) {
      const select = document.getElementById(key);
      if (select) {
        const placeholder = select.querySelector('option[value=""]');
        if (placeholder) placeholder.textContent = field.placeholder || 'Seleccionar...';
        field.options.forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          select.appendChild(option);
        });
      }
    }
  });
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: c.instagram },
    { cls: 'fa-facebook-f', url: c.facebook },
    { cls: 'fa-linkedin-in', url: c.linkedin },
    { cls: 'fa-youtube', url: c.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function renderNavbarItems(items) {
  if (!items || !items.length) return;
  const nav = document.querySelector('.nav-menu');
  if (!nav) return;
  nav.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}" class="nav-item" data-tab="${esc(i.url.replace('#', ''))}" role="menuitem">
      <div class="nav-item-left">
        <i class="fas fa-home"></i>
        <span>${esc(i.label)}</span>
      </div>
    </a>
  `).join('');
  // Re-bind click handlers
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });
}

function renderMobileNavbarItems(items) {
  if (!items || !items.length) return;
  const mobileMenu = document.getElementById('mobileMenu');
  if (!mobileMenu) return;
  mobileMenu.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}">${esc(i.label)}</a>
  `).join('');
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderCatalogFilters(filters) {
  if (!filters) return;
  const opsSelect = document.getElementById('searchOperacion');
  const typesSelect = document.getElementById('searchTipo');
  const zonesSelect = document.getElementById('searchZona');
  const pricesSelect = document.getElementById('searchPrecio');

  if (filters.operations && opsSelect) {
    opsSelect.innerHTML = '<option value="">Todas las operaciones</option>' + filters.operations.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  }
  if (filters.types && typesSelect) {
    typesSelect.innerHTML = '<option value="">Todos los tipos</option>' + filters.types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  }
  if (filters.zones && zonesSelect) {
    zonesSelect.innerHTML = '<option value="">Todas las zonas</option>' + filters.zones.map(z => `<option value="${esc(z)}">${esc(z)}</option>`).join('');
  }
  if (filters.prices && pricesSelect) {
    pricesSelect.innerHTML = '<option value="">Todos los precios</option>' + filters.prices.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
}

function renderFormOptions(options) {
  if (!options || !options.length) return;
  const container = document.querySelector('.form-pills');
  if (!container) return;
  container.innerHTML = options.map(o => `
    <button type="button" class="form-pill" data-value="${esc(o.value)}">${esc(o.label)}</button>
  `).join('');
  document.querySelectorAll('.form-pills .form-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      pill.classList.toggle('active');
    });
  });
}

function renderFormFields(fields) {
  if (!fields) return;
  Object.entries(fields).forEach(([key, field]) => {
    const input = document.getElementById(key);
    if (!input) return;
    if (field.label) {
      const label = document.querySelector(`label[for="${key}"]`);
      if (label) label.textContent = field.label;
    }
    if (field.placeholder) {
      const input = document.getElementById(key);
      if (input) input.placeholder = field.placeholder;
    }
    if (field.required !== undefined) {
      const input = document.getElementById(key);
      if (input) input.required = field.required;
    }
    if (field.options && field.options.length) {
      const select = document.getElementById(key);
      if (select) {
        const placeholder = select.querySelector('option[value=""]');
        if (placeholder) placeholder.textContent = field.placeholder || 'Seleccionar...';
        field.options.forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          select.appendChild(option);
        });
      }
    }
  });
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: social.instagram },
    { cls: 'fa-facebook-f', url: social.facebook },
    { cls: 'fa-linkedin-in', url: social.linkedin },
    { cls: 'fa-youtube', url: social.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function renderNavbarItems(items) {
  if (!items || !items.length) return;
  const nav = document.querySelector('.nav-menu');
  if (!nav) return;
  nav.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}" class="nav-item" data-tab="${esc(i.url.replace('#', ''))}" role="menuitem">
      <div class="nav-item-left">
        <i class="fas fa-home"></i>
        <span>${esc(i.label)}</span>
      </div>
    </a>
  `).join('');
  // Re-bind click handlers
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });
}

function renderMobileNavbarItems(items) {
  if (!items || !items.length) return;
  const mobileMenu = document.getElementById('mobileMenu');
  if (!mobileMenu) return;
  mobileMenu.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}">${esc(i.label)}</a>
  `).join('');
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: social.instagram },
    { cls: 'fa-facebook-f', url: social.facebook },
    { cls: 'fa-linkedin-in', url: social.linkedin },
    { cls: 'fa-youtube', url: social.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function renderNavbarItems(items) {
  if (!items || !items.length) return;
  const nav = document.querySelector('.nav-menu');
  if (!nav) return;
  nav.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}" class="nav-item" data-tab="${esc(i.url.replace('#', ''))}" role="menuitem">
      <div class="nav-item-left">
        <i class="fas fa-home"></i>
        <span>${esc(i.label)}</span>
      </div>
    </a>
  `).join('');
  // Re-bind click handlers
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });
}

function renderMobileNavbarItems(items) {
  if (!items || !items.length) return;
  const mobileMenu = document.getElementById('mobileMenu');
  if (!mobileMenu) return;
  mobileMenu.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}">${esc(i.label)}</a>
  `).join('');
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: social.instagram },
    { cls: 'fa-facebook-f', url: social.facebook },
    { cls: 'fa-linkedin-in', url: social.linkedin },
    { cls: 'fa-youtube', url: social.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function renderNavbarItems(items) {
  if (!items || !items.length) return;
  const nav = document.querySelector('.nav-menu');
  if (!nav) return;
  nav.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}" class="nav-item" data-tab="${esc(i.url.replace('#', ''))}" role="menuitem">
      <div class="nav-item-left">
        <i class="fas fa-home"></i>
        <span>${esc(i.label)}</span>
      </div>
    </a>
  `).join('');
  // Re-bind click handlers
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });
}

function renderMobileNavbarItems(items) {
  if (!items || !items.length) return;
  const mobileMenu = document.getElementById('mobileMenu');
  if (!mobileMenu) return;
  mobileMenu.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}">${esc(i.label)}</a>
  `).join('');
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: social.instagram },
    { cls: 'fa-facebook-f', url: social.facebook },
    { cls: 'fa-linkedin-in', url: social.linkedin },
    { cls: 'fa-youtube', url: social.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function renderNavbarItems(items) {
  if (!items || !items.length) return;
  const nav = document.querySelector('.nav-menu');
  if (!nav) return;
  nav.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}" class="nav-item" data-tab="${esc(i.url.replace('#', ''))}" role="menuitem">
      <div class="nav-item-left">
        <i class="fas fa-home"></i>
        <span>${esc(i.label)}</span>
      </div>
    </a>
  `).join('');
  // Re-bind click handlers
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });
}

function renderMobileNavbarItems(items) {
  if (!items || !items.length) return;
  const mobileMenu = document.getElementById('mobileMenu');
  if (!mobileMenu) return;
  mobileMenu.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}">${esc(i.label)}</a>
  `).join('');
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: social.instagram },
    { cls: 'fa-facebook-f', url: social.facebook },
    { cls: 'fa-linkedin-in', url: social.linkedin },
    { cls: 'fa-youtube', url: social.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function renderNavbarItems(items) {
  if (!items || !items.length) return;
  const nav = document.querySelector('.nav-menu');
  if (!nav) return;
  nav.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}" class="nav-item" data-tab="${esc(i.url.replace('#', ''))}" role="menuitem">
      <div class="nav-item-left">
        <i class="fas fa-home"></i>
        <span>${esc(i.label)}</span>
      </div>
    </a>
  `).join('');
  // Re-bind click handlers
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });
}

function renderMobileNavbarItems(items) {
  if (!items || !items.length) return;
  const mobileMenu = document.getElementById('mobileMenu');
  if (!mobileMenu) return;
  mobileMenu.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}">${esc(i.label)}</a>
  `).join('');
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: social.instagram },
    { cls: 'fa-facebook-f', url: social.facebook },
    { cls: 'fa-linkedin-in', url: social.linkedin },
    { cls: 'fa-youtube', url: social.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function renderNavbarItems(items) {
  if (!items || !items.length) return;
  const nav = document.querySelector('.nav-menu');
  if (!nav) return;
  nav.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}" class="nav-item" data-tab="${esc(i.url.replace('#', ''))}" role="menuitem">
      <div class="nav-item-left">
        <i class="fas fa-home"></i>
        <span>${esc(i.label)}</span>
      </div>
    </a>
  `).join('');
  // Re-bind click handlers
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });
}

function renderMobileNavbarItems(items) {
  if (!items || !items.length) return;
  const mobileMenu = document.getElementById('mobileMenu');
  if (!mobileMenu) return;
  mobileMenu.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}">${esc(i.label)}</a>
  `).join('');
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: social.instagram },
    { cls: 'fa-facebook-f', url: social.facebook },
    { cls: 'fa-linkedin-in', url: social.linkedin },
    { cls: 'fa-youtube', url: social.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function renderNavbarItems(items) {
  if (!items || !items.length) return;
  const nav = document.querySelector('.nav-menu');
  if (!nav) return;
  nav.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}" class="nav-item" data-tab="${esc(i.url.replace('#', ''))}" role="menuitem">
      <div class="nav-item-left">
        <i class="fas fa-home"></i>
        <span>${esc(i.label)}</span>
      </div>
    </a>
  `).join('');
  // Re-bind click handlers
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      navigateTo(tab);
    });
  });
}

function renderMobileNavbarItems(items) {
  if (!items || !items.length) return;
  const mobileMenu = document.getElementById('mobileMenu');
  if (!mobileMenu) return;
  mobileMenu.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(i => `
    <a href="${escAttr(i.url)}">${esc(i.label)}</a>
  `).join('');
}

function renderFooterLinks(links) {
  if (!links) return;
  if (links.navigation) {
    const navList = document.querySelector('.footer-col:nth-child(2) ul');
    if (navList) {
      navList.innerHTML = links.navigation.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
  if (links.services) {
    const servList = document.querySelector('.footer-col:nth-child(3) ul');
    if (servList) {
      servList.innerHTML = links.services.map(l => `<li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>`).join('');
    }
  }
}

function renderSocialLinks(social) {
  if (!social) return;
  const platforms = [
    { cls: 'fa-instagram', url: social.instagram },
    { cls: 'fa-facebook-f', url: social.facebook },
    { cls: 'fa-linkedin-in', url: social.linkedin },
    { cls: 'fa-youtube', url: social.youtube }
  ];
  document.querySelectorAll('a.social-circle').forEach(a => {
    const icon = a.querySelector('i.fab');
    const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
    const raw = match ? String(match.url || '').trim() : '';
    if (!raw) {
      a.style.display = 'none';
      return;
    }
    a.style.display = '';
    a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
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
      populateZoneOptions();
      renderProperties(allProperties);
      updateResultsCount(allProperties.length);
    } catch (err) {
      logError('Error loading properties:', err);
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

    const cursorGlow = document.getElementById('cursorGlow');

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
        badge.className = 'card-badge card-badge--featured';
        badge.textContent = 'Destacada';
        imageWrapper.appendChild(badge);
      }
      if (p.is_retasada) {
        const badge = document.createElement('span');
        badge.className = 'card-badge card-badge--retasada';
        badge.textContent = 'Retasada';
        imageWrapper.appendChild(badge);
      }
      if (p.is_oportunidad) {
        const badge = document.createElement('span');
        badge.className = 'card-badge card-badge--oportunidad';
        badge.textContent = 'Oportunidad';
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
      price.textContent = formatPrice(p.price_usd, p.price_currency);

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
      detailsBtn.className = 'btn-card';
      detailsBtn.type = 'button';
      detailsBtn.dataset.propertyId = p.id;
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

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function populateZoneOptions() {
    const zoneSelect = document.getElementById('searchZona');
    if (!zoneSelect) return;

    const zones = [...new Set(
      allProperties.map(p => (p.zone || '').trim()).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'es'));

    const previousZone = zoneSelect.value;
    while (zoneSelect.options.length > 1) zoneSelect.remove(1);

    const fragment = document.createDocumentFragment();
    for (const zone of zones) {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = zone;
      fragment.appendChild(option);
    }
    zoneSelect.appendChild(fragment);

    if (previousZone && zones.includes(previousZone)) {
      zoneSelect.value = previousZone;
    }
  }

  function filterProperties() {
    const activeFilter = document.querySelector('.filters-pills .filter-pill.active');
    const type = activeFilter?.dataset?.type || 'todos';
    const operacion = (document.getElementById('searchOperacion')?.value || '').toLowerCase();
    const zona = (document.getElementById('searchZona')?.value || '').trim();
    const precioValue = document.getElementById('searchPrecio')?.value || '';
    const beds = document.querySelector('.bedroom-pills .bed-pill.active')?.dataset.beds || '';
    const query = normalizeText(document.getElementById('catalogSearchInput')?.value);

    let priceMin = null;
    let priceMax = null;
    if (precioValue) {
      const [minRaw, maxRaw] = precioValue.split('-');
      priceMin = minRaw === '' ? null : Number(minRaw);
      priceMax = maxRaw === '' ? null : Number(maxRaw);
    }

    const filtered = allProperties.filter(p => {
      if (type !== 'todos' && (p.property_type || '').toLowerCase() !== type) return false;
      if (operacion && (p.status || '').toLowerCase() !== operacion) return false;
      if (zona && (p.zone || '').trim() !== zona) return false;

      const price = Number(p.price_usd) || 0;
      if (priceMin !== null && price < priceMin) return false;
      if (priceMax !== null && price > priceMax) return false;

      if (beds) {
        const bedroomsCount = Number(p.bedrooms) || 0;
        const matchesBedrooms = beds === '4'
          ? bedroomsCount >= 4
          : bedroomsCount === Number(beds);
        if (!matchesBedrooms) return false;
      }

      if (query) {
        const haystack = normalizeText([p.title, p.zone, p.address, p.description].filter(Boolean).join(' '));
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    renderProperties(filtered);
    updateResultsCount(filtered.length);
  }

  function initSearchBar() {
    const searchInput = document.getElementById('catalogSearchInput');
    const searchButton = document.getElementById('searchBtn');
    let debounceTimer = 0;
    const debounceDelay = 250;

    const debouncedFilter = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(filterProperties, debounceDelay);
    };

    searchInput?.addEventListener('input', debouncedFilter);
    document.getElementById('searchOperacion')?.addEventListener('change', filterProperties);
    document.getElementById('searchZona')?.addEventListener('change', filterProperties);
    document.getElementById('searchPrecio')?.addEventListener('change', filterProperties);

    document.querySelectorAll('.bedroom-pills .bed-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.bedroom-pills .bed-pill').forEach(otherPill => {
          const isActive = otherPill === pill;
          otherPill.classList.toggle('active', isActive);
          otherPill.setAttribute('aria-pressed', String(isActive));
        });
        filterProperties();
      });
    });

    searchButton?.addEventListener('click', () => {
      filterProperties();
      const grid = document.getElementById('propertyGrid');
      if (!grid) return;
      const targetTop = grid.getBoundingClientRect().top + window.scrollY - 110;
      window.scrollTo({ top: Math.max(targetTop, 0), behavior: 'smooth' });
    });
  }

  initSearchBar();

  function updateResultsCount(count) {
    const el = document.getElementById('resultsCount');
    if (el) el.textContent = `${count} Propiedades`;
  }

  function formatPrice(price, currency) {
    if (!price) return 'Consultar precio';
    return currency === 'ARS' ? _arsFormatter.format(price) : _usdFormatter.format(price);
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
      logError('Error loading team:', err);
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
      logError('Error loading stats:', err);
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
      logError('Error loading CMS content:', err);
    }
  }

  async function loadLandingData() {
    await Promise.all([
      loadCMSContent(),
      loadProperties(),
      loadTeam(),
      loadStats()
    ]);
    initLazyLoading();
  }

  function setText(selector, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el) el.textContent = value;
  }

  function setHTML(selector, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el) {
      const safe = String(value)
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/&lt;span class="highlight"&gt;/gi, '<span class="highlight">')
        .replace(/&lt;\/span&gt;/gi, '</span>')
        .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
      el.innerHTML = safe;
    }
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
          if (titleEl) {
            const safe = String(c.title).replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/&lt;span class="highlight"&gt;/gi, '<span class="highlight">')
              .replace(/&lt;\/span&gt;/gi, '</span>');
            titleEl.innerHTML = safe;
          }
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
        if (c.cta_text) setText('.hero-cta', c.cta_text);
        if (c.cta_url) setAttr('.hero-cta', 'href', c.cta_url);
        if (c.video_cta) setText('.hero-video-cta', c.video_cta);
        if (c.video_url) {
          videoEmbedUrl = c.video_url;
        }
        break;

      case 'services':
        setHTML('.services-title', c.title);
        setText('.services-desc', c.description);
        setText('.services-label', c.badge);
        if (c.cta_text) setText('.services-cta', c.cta_text);
        if (c.cta_url) setAttr('.services-cta', 'href', c.cta_url);
        if (c.items && Array.isArray(c.items)) {
          renderServicesItems(c.items);
        }
        break;

      case 'team':
        setHTML('.team-title', c.title);
        if (c.badge) setText('.team-label', c.badge);
        if (c.cta_text) setText('.team-cta', c.cta_text);
        if (c.cta_url) setAttr('.team-cta', 'href', c.cta_url);
        break;

      case 'process':
        setHTML('.process-title', c.title);
        if (c.badge) setText('.process-label', c.badge);
        if (c.cta_text) setText('.process-cta', c.cta_text);
        if (c.cta_url) setAttr('.process-cta', 'href', c.cta_url);
        if (c.steps && Array.isArray(c.steps)) {
          renderProcessSteps(c.steps);
        }
        if (c.commitment_title) setText('.commitment-title', c.commitment_title);
        if (c.commitment_description) setText('.commitment-description', c.commitment_description);
        if (c.commitment_signature) setText('.commitment-signature', c.commitment_signature);
        break;

      case 'stats':
        setHTML('.stats-title', c.title);
        setText('.stats-premium .services-desc', c.description);
        if (c.badge) setText('.stats-label', c.badge);
        if (c.cta_label) setText('.stats-cta-label', c.cta_label);
        if (c.button_text) setText('.stats-cta-button', c.button_text);
        if (c.button_url) setAttr('.stats-cta-button', 'href', c.button_url);
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
        if (c.items && Array.isArray(c.items)) {
          renderStatsItems(c.items);
        }
        break;

      case 'contact':
        setHTML('.contact-title', c.title);
        if (c.badge) setText('.contact-label', c.badge);
        if (c.phone_label) setText('.contact-phone-label', c.phone_label);
        if (c.phone) {
          setContactValue('.fa-phone', c.phone);
          setFooterValue('.fa-phone', c.phone);
        }
        if (c.email_label) setText('.contact-email-label', c.email_label);
        if (c.email) {
          setContactValue('.fa-envelope', c.email);
          setFooterValue('.fa-envelope', c.email);
          setAttr('a[href^="mailto:"]', 'href', 'mailto:' + c.email);
        }
        if (c.schedule_label) setText('.contact-schedule-label', c.schedule_label);
        if (c.schedule) setContactValue('.fa-clock', c.schedule);
        if (c.whatsapp) {
          const waLinks = document.querySelectorAll('a[href*="wa.me"]');
          waLinks.forEach(a => a.href = 'https://wa.me/' + c.whatsapp.replace(/[^0-9]/g, ''));
        }
        if (c.instagram) updateSocialLink('.fa-instagram', c.instagram);
        if (c.facebook) updateSocialLink('.fa-facebook-f', c.facebook);
        if (c.linkedin) updateSocialLink('.fa-linkedin-in', c.linkedin);
        if (c.youtube) updateSocialLink('.fa-youtube', c.youtube);
        if (c.weekday_label) setText('.contact-weekday-label', c.weekday_label);
        if (c.weekday_response) setText('.contact-weekday-response', c.weekday_response);
        if (c.saturday_label) setText('.contact-saturday-label', c.saturday_label);
        if (c.saturday_response) setText('.contact-saturday-response', c.saturday_response);
        break;

      case 'footer':
        if (c.description) setText('.footer-description', c.description);
        if (c.copyright) {
          const footerBottom = document.querySelector('.footer-bottom > span');
          if (footerBottom) footerBottom.textContent = '© ' + new Date().getFullYear() + ' ' + c.copyright + '. Todos los derechos reservados.';
        }
        if (c.matricula) {
          const footerSub = document.querySelector('.footer-logo-sub');
          if (footerSub) footerSub.textContent = c.matricula;
        }
        if (c.razon_social) setText('.footer-razon-social', c.razon_social);
        if (c.cuit) setFooterValue('.fa-id-card', 'CUIT: ' + c.cuit);
        if (c.phone) setFooterValue('.fa-phone', c.phone);
        if (c.email) setFooterValue('.fa-envelope', c.email);
        if (c.schedule) setFooterValue('.fa-clock', c.schedule);
        if (c.privacy) setText('.footer-privacy', c.privacy);
        if (c.terms) setText('.footer-terms', c.terms);
        if (c.faq) setText('.footer-faq', c.faq);
        if (c.cta_text) setText('.footer-cta-text', c.cta_text);
        if (c.cta_url) setAttr('.footer-cta', 'href', c.cta_url);
        if (c.nav_links && Array.isArray(c.nav_links)) {
          renderFooterNavLinks(c.nav_links);
        }
        if (c.service_links && Array.isArray(c.service_links)) {
          renderFooterServiceLinks(c.service_links);
        }
        break;

      case 'social': {
        const platforms = [
          { cls: 'fa-instagram', url: c.instagram },
          { cls: 'fa-facebook-f', url: c.facebook },
          { cls: 'fa-linkedin-in', url: c.linkedin },
          { cls: 'fa-youtube', url: c.youtube }
        ];
        document.querySelectorAll('a.social-circle').forEach(a => {
          const icon = a.querySelector('i.fab');
          const match = icon ? platforms.find(p => icon.classList.contains(p.cls)) : null;
          const raw = match ? String(match.url || '').trim() : '';
          if (!raw) {
            a.style.display = 'none';
            return;
          }
          a.style.display = '';
          a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        });
        break;
      }

      case 'seo':
        updateSEOMeta(c);
        break;

      case 'navbar':
        if (c.items && Array.isArray(c.items)) {
          renderNavbarItems(c.items, 'desktop');
        }
        if (c.mobile_items && Array.isArray(c.mobile_items)) {
          renderNavbarItems(c.mobile_items, 'mobile');
        }
        break;

      case 'catalog':
        if (c.badge) setText('.catalog-label', c.badge);
        if (c.title) setText('.catalog-title', c.title);
        if (c.highlight) {
          const highlightEl = document.querySelector('.catalog-title .highlight');
          if (highlightEl) highlightEl.textContent = c.highlight;
        }
        if (c.cta_text) setText('.catalog-cta', c.cta_text);
        if (c.cta_url) setAttr('.catalog-cta', 'href', c.cta_url);
        break;

      case 'form':
        if (c.initial_question) setText('.form-initial-question', c.initial_question);
        if (c.select_initial_text) {
          const select = document.querySelector('.form-select');
          if (select) {
            const firstOpt = select.querySelector('option');
            if (firstOpt) firstOpt.textContent = c.select_initial_text;
          }
        }
        if (c.consent) setText('.form-consent', c.consent);
        if (c.button_text) setText('.form-submit-btn', c.button_text);
        if (c.success_title) setText('.form-success-title', c.success_title);
        if (c.success_description) setText('.form-success-description', c.success_description);
        if (c.options && Array.isArray(c.options)) {
          renderFormOptions(c.options);
        }
        if (c.fields && Array.isArray(c.fields)) {
          renderFormFields(c.fields);
        }
        break;
    }
  }

  /* ------------------------------------------------
     HELPER FUNCTIONS FOR DYNAMIC CMS SECTIONS
     ------------------------------------------------ */

  function renderServicesItems(items) {
    const grid = document.querySelector('.services-grid');
    if (!grid) return;
    grid.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(s => {
      const iconCls = /^(fas|far|fab|fa-solid|fa-regular|fa-brands)\s/.test(s.icon) ? s.icon : 'fas ' + s.icon;
      return `
      <div class="service-card" data-animate>
        <div class="service-icon"><i class="${esc(iconCls)}"></i></div>
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.description)}</p>
        <a href="${escAttr(s.link_url)}" class="service-link">${esc(s.link_text)} <i class="fas fa-arrow-right"></i></a>
      </div>`;
    }).join('');
  }

  function renderProcessSteps(steps) {
    const container = document.querySelector('.process-steps');
    if (!container) return;
    container.innerHTML = steps.filter(s => s.enabled).sort((a, b) => a.order - b.order).map(step => {
      const iconCls = /^(fas|far|fab|fa-solid|fa-regular|fa-brands)\s/.test(step.icon) ? step.icon : 'fas ' + step.icon;
      return `
      <div class="step-card" data-animate>
        <div class="step-number">${esc(step.number || '')}</div>
        <div class="step-icon"><i class="${esc(iconCls)}"></i></div>
        <h3>${esc(step.title)}</h3>
        <p>${esc(step.description)}</p>
      </div>`;
    }).join('');
  }

  function renderStatsItems(items) {
    const grid = document.querySelector('.stats-grid');
    if (!grid) return;
    grid.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(item => {
      const suffix = item.suffix || '+';
      return `
      <div class="stat-card" data-animate>
        <div class="stat-card-number">${esc(item.value)}<span class="accent-symbol">${esc(suffix)}</span></div>
        <div class="stat-card-title">${esc(item.title)}</div>
      </div>`;
    }).join('');
  }

  function updateSocialLink(iconSelector, url) {
    const links = document.querySelectorAll(`a.social-circle ${iconSelector}`);
    links.forEach(icon => {
      const a = icon.closest('a');
      if (a) {
        const raw = String(url || '').trim();
        if (!raw) {
          a.style.display = 'none';
        } else {
          a.style.display = '';
          a.href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
      }
    });
  }

  function updateSEOMeta(c) {
    if (c.title) document.title = c.title;
    if (c.description) setAttr('meta[name="description"]', 'content', c.description);
    if (c.og_title) setAttr('meta[property="og:title"]', 'content', c.og_title);
    if (c.og_description) setAttr('meta[property="og:description"]', 'content', c.og_description);
    if (c.og_image) setAttr('meta[property="og:image"]', 'content', c.og_image);
    if (c.og_url) setAttr('meta[property="og:url"]', 'content', c.og_url);
    if (c.og_type) setAttr('meta[property="og:type"]', 'content', c.og_type);
    if (c.og_locale) setAttr('meta[property="og:locale"]', 'content', c.og_locale);
    if (c.og_site_name) setAttr('meta[property="og:site_name"]', 'content', c.og_site_name);
    if (c.twitter_card) setAttr('meta[name="twitter:card"]', 'content', c.twitter_card);
    if (c.twitter_title) setAttr('meta[name="twitter:title"]', 'content', c.twitter_title);
    if (c.twitter_description) setAttr('meta[name="twitter:description"]', 'content', c.twitter_description);
    if (c.twitter_image) setAttr('meta[name="twitter:image"]', 'content', c.twitter_image);
  }

  function renderNavbarItems(items, type) {
    const container = type === 'mobile'
      ? document.querySelector('.mobile-nav-items')
      : document.querySelector('.desktop-nav-items');
    if (!container) return;
    container.innerHTML = items.filter(i => i.enabled).sort((a, b) => a.order - b.order).map(item => `
      <a href="${escAttr(item.url)}" class="nav-item">${esc(item.label)}</a>
    `).join('');
  }

  function renderFooterNavLinks(links) {
    const container = document.querySelector('.footer-nav-links');
    if (!container) return;
    container.innerHTML = links.filter(l => l.enabled).sort((a, b) => a.order - b.order).map(l => `
      <li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>
    `).join('');
  }

  function renderFooterServiceLinks(links) {
    const container = document.querySelector('.footer-service-links');
    if (!container) return;
    container.innerHTML = links.filter(l => l.enabled).sort((a, b) => a.order - b.order).map(l => `
      <li><a href="${escAttr(l.url)}">${esc(l.label)}</a></li>
    `).join('');
  }

  function renderFormOptions(options) {
    const container = document.querySelector('.form-options');
    if (!container) return;
    container.innerHTML = options.filter(o => o.enabled).sort((a, b) => a.order - b.order).map(opt => `
      <label class="form-option">
        <input type="radio" name="interest" value="${esc(opt.value)}">
        <span>${esc(opt.label)}</span>
      </label>
    `).join('');
  }

  function renderFormFields(fields) {
    const container = document.querySelector('.form-fields');
    if (!container) return;
    container.innerHTML = fields.filter(f => f.enabled).sort((a, b) => a.order - b.order).map(field => `
      <div class="form-field">
        <label>${esc(field.label)}${field.required ? ' <span class="required">*</span>' : ''}</label>
        ${field.type === 'textarea'
          ? `<textarea name="${esc(field.name)}" placeholder="${esc(field.placeholder || '')}"${field.required ? ' required' : ''}></textarea>`
          : `<input type="${esc(field.type)}" name="${esc(field.name)}" placeholder="${esc(field.placeholder || '')}"${field.required ? ' required' : ''}>`
        }
      </div>
    `).join('');
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
            full_name: 'Suscriptor Newsletter',
            source: 'newsletter',
            notes: 'Suscripción al newsletter desde la landing page',
          }]);
        if (error) throw error;
        newsletterForm.innerHTML = '<p style="color:var(--accent); font-size:14px; font-weight:500; padding:12px 0;"><i class="fas fa-check-circle"></i> ¡Gracias por suscribirte!</p>';
      } catch (err) {
        logError('Newsletter error:', err);
        if (btn) { btn.disabled = false; btn.innerHTML = 'Suscribirse <i class="fas fa-arrow-right"></i>'; }
        emailInput.value = '';
        emailInput.placeholder = 'Error — intentá de nuevo';
      }
    });
  }

})();