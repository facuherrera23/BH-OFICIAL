-- ============================================================
-- BIENENHAUS - CMS Completo para Landing Page
-- Migración para agregar todos los campos necesarios
-- ============================================================

-- ============================================================
-- 1. HERO - Extender campos existentes
-- ============================================================
-- hero ya existe con: title, subtitle, eyebrow, description, bg_image_url, video_url
-- Agregar campos faltantes

-- ============================================================
-- 2. CATÁLOGO - Nueva sección
-- ============================================================
INSERT INTO site_content (section_key, content) VALUES (
  'catalog',
  '{
    "badge": "Catálogo",
    "title": "Propiedades",
    "highlight": "disponibles",
    "cta_text": "Contactar Asesor",
    "cta_url": "#contacto",
    "filters": {
      "operaciones": ["venta", "alquiler"],
      "tipos": ["departamento", "casa", "ph", "terreno", "local", "oficina"],
      "zonas": [],
      "precios": ["0-100000", "100000-200000", "200000-500000", "500000-"]
    }
  }'::jsonb
) ON CONFLICT (section_key) DO UPDATE SET content = EXCLUDED.content;

-- ============================================================
-- 3. SERVICIOS - Extender estructura existente
-- ============================================================
-- services ya existe con: badge, title, description
-- Agregar items array y campos por servicio

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{items}',
  '[
    {"id": "serv_1", "enabled": true, "order": 1, "icon": "fa-home", "title": "Venta de Propiedades", "description": "Estrategia de marketing digital, fotos profesionales y publicación en los principales portales inmobiliarios para maximizar el valor de tu propiedad.", "link_text": "Saber más", "link_url": "#contacto"},
    {"id": "serv_2", "enabled": true, "order": 2, "icon": "fa-key", "title": "Alquileres", "description": "Gestión integral: selección de inquilinos con verificación crediticia, contratos jurídicos y administración del condominio.", "link_text": "Saber más", "link_url": "#contacto"},
    {"id": "serv_3", "enabled": true, "order": 3, "icon": "fa-chart-line", "title": "Inversión", "description": "Análisis de rentabilidad y tendencias del mercado para que cada inversión inmobiliaria rinda al máximo.",    "link_text": "Saber más", "link_url": "#contacto"},
    {"id": "serv_4", "enabled": true, "order": 4, "icon": "fa-file-contract", "title": "Créditos Hipotecarios", "description": "Tramitación de tu crédito hipotecario con los mejores bancos. Te asesoramos en cada paso del proceso.",
    "link_text": "Saber más", "link_url": "#contacto"},
    {"id": "serv_5", "enabled": true, "order": 5, "icon": "fa-balance-scale", "title": "Asesoramiento Legal", "description": "Equipo jurídico especializado que verifica documentación, títulos y sobrepasos para operaciones 100% seguras.",
    "link_text": "Saber más", "link_url": "#contacto"},
    {"id": "serv_6", "enabled": true, "order": 6, "icon": "fa-calculator", "title": "Tasaciones", "description": "Valuaciones certificadas con metodología de mercado y datos comparativos para que tengas el precio justo.",
    "link_text": "Saber más", "link_url": "#contacto"}
  ]'::jsonb,
  '{items}',
  true
) WHERE section_key = 'services';

-- ============================================================
-- 4. EQUIPO - Extender estructura existente
-- ============================================================
-- team ya existe con title
-- Agregar badge, highlighted_title, cta_text, cta_url

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{badge}',
  '"Nuestro Equipo"'::jsonb,
  true
) WHERE section_key = 'team';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{title}',
  '"Conocé a <span class=\"highlight\">nuestros</span> asesores"'::jsonb,
  true
) WHERE section_key = 'team';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_text}',
  '"Contactar"'::jsonb,
  true
) WHERE section_key = 'team';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_url}',
  '"#contacto"'::jsonb,
  true
) WHERE section_key = 'team';

-- ============================================================
-- 5. ESTADÍSTICAS - Extender estructura existente
-- ============================================================
-- stats ya existe con stat1_val, stat1_title, etc.
-- Rediseñar para 4 tarjetas configurables

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{badge}',
  '"Estadísticas"'::jsonb,
  true
) WHERE section_key = 'stats';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{title}',
  '"Números que <span class=\"highlight\">hablan</span>"'::jsonb,
  true
) WHERE section_key = 'stats';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{description}',
  '"Más de 15 años de trayectoria respaldados por resultados reales."'::jsonb,
  true
) WHERE section_key = 'stats';

-- Agregar items array para 4 tarjetas configurables
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{items}',
  '[
    {"id": "stat_1", "enabled": true, "order": 1, "icon": "fa-home", "value": "150", "suffix": "+", "title": "Propiedades Vendidas", "description": "Operaciones exitosas en los últimos años."},
    {"id": "stat_2", "enabled": true, "order": 2, "icon": "fa-users", "value": "300", "suffix": "+", "title": "Clientes Satisfechos", "description": "Familias que confiaron en nosotros."},
    {"id": "stat_3", "enabled": true, "order": 3, "icon": "fa-award", "value": "15", "suffix": "+", "title": "Años de Experiencia", "description": "Trayectoria en el mercado inmobiliario."},
    {"id": "stat_4", "enabled": true, "order": 4, "icon": "fa-star", "value": "4.9", "suffix": "★", "title": "Calificación Promedio", "description": "Basada en reseñas de Google."}
  ]'::jsonb,
  '{items}',
  true
) WHERE section_key = 'stats';

-- Agregar CTA
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta}',
  '{"label": "Contactar Ahora", "button_text": "Contactar Ahora", "button_url": "#contacto"}'::jsonb,
  true
) WHERE section_key = 'stats';

-- ============================================================
-- 6. PROCESO - Extender estructura existente
-- ============================================================
-- process ya existe con title
-- Agregar badge, highlighted_title, cta_text, cta_url, steps array, commitment

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{badge}',
  '"Proceso"'::jsonb,
  true
) WHERE section_key = 'process';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{title}',
  '"¿Cómo <span class=\"highlight\">trabajamos</span>?"'::jsonb,
  true
) WHERE section_key = 'process';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_text}',
  '"Empezar"'::jsonb,
  true
) WHERE section_key = 'process';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_url}',
  '"#contacto"'::jsonb,
  true
) WHERE section_key = 'process';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{steps}',
  '[
    {"id": "step_1", "enabled": true, "order": 1, "number": "01", "icon": "fa-comments", "title": "Consulta Inicial", "description": "Nos reunimos para entender tus necesidades y presupuesto."},
    {"id": "step_2", "enabled": true, "order": 2, "icon": "fa-search", "title": "Búsqueda", "description": "Seleccionamos las mejores opciones para vos."},
    {"id": "step_3", "enabled": true, "order": 3, "icon": "fa-eye", "title": "Visitas", "description": "Te acompañamos a conocer cada propiedad."},
    {"id": "step_4", "enabled": true, "order": 4, "icon": "fa-file-signature", "title": "Documentación", "description": "Verificamos y preparamos toda la documentación."},
    {"id": "step_5", "enabled": true, "order": 5, "icon": "fa-key", "title": "Entrega", "description": "Cerramos la operación y te entregamos las llaves."}
  ]'::jsonb,
  '{steps}',
  true
) WHERE section_key = 'process';

-- Agregar commitment block
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{commitment}',
  '{"title": "Compromiso Total", "description": "Tu satisfacción es nuestra prioridad. Trabajamos con transparencia, honestidad y profesionalismo en cada operación.", "signature": "Bienenhaus"}'::jsonb,
  true
) WHERE section_key = 'process';

-- ============================================================
-- 7. CONTACTO - Nueva sección completa
-- ============================================================
INSERT INTO site_content (section_key, content) VALUES (
  'contact',
  '{
    "badge": "Contacto",
    "title": "Hablemos de tu <span class=\"highlight\">próximo hogar</span>",
    "info_panel": {
      "title": "Información de Contacto",
      "phone": {"label": "Teléfono", "value": "+54 11 0000-0000"},
      "email": {"label": "Email", "value": "info@bienenhaus.com.ar"},
      "address": {"label": "Dirección", "value": "Av. Corrientes 1234, CABA"},
      "schedule": {"label": "Horario", "value": "Lun - Vie: 9:00 - 18:00"}
    },
    "response_time": {
      "title": "Tiempo de Respuesta",
      "weekday": {"label": "Lunes a Viernes", "response": "Menos de 2 horas"},
      "saturday": {"label": "Sábados", "response": "Menos de 4 horas"}
    },
    "social": {
      "instagram": "https://instagram.com/bienenhaus",
      "facebook": "https://facebook.com/bienenhaus",
      "linkedin": "https://linkedin.com/company/bienenhaus",
      "youtube": "https://youtube.com/@bienenhaus"
    }
  }'::jsonb
) ON CONFLICT (section_key) DO UPDATE SET content = EXCLUDED.content;

-- ============================================================
-- 8. FORMULARIO - Nueva sección
-- ============================================================
INSERT INTO site_content (section_key, content) VALUES (
  'form',
  '{
    "initial_question": "¿Qué estás buscando?",
    "options": [
      {"value": "comprar", "label": "Comprar"},
      {"value": "vender", "label": "Vender"},
      {"value": "alquilar", "label": "Alquilar"},
      {"value": "invertir", "label": "Invertir"}
    ],
    "fields": {
      "nombre": {"label": "Nombre completo", "placeholder": "Tu nombre", "required": true},
      "email": {"label": "Email", "placeholder": "tu@email.com", "required": true},
      "telefono": {"label": "Teléfono", "placeholder": "+54 11 0000-0000", "required": true},
      "tipo_propiedad": {
        "label": "Tipo de propiedad",
        "placeholder": "Seleccionar...",
        "options": [
          {"value": "departamento", "label": "Departamento"},
          {"value": "casa", "label": "Casa"},
          {"value": "ph", "label": "PH"},
          {"value": "terreno", "label": "Terreno"},
          {"value": "local", "label": "Local Comercial"}
        ]
      },
      "presupuesto": {"label": "Presupuesto estimado (USD)", "placeholder": "Ej: 150000", "required": false},
      "mensaje": {"label": "Mensaje", "placeholder": "Contanos sobre lo que buscás...", "required": false}
    },
    "select": {
      "initial_text": "Seleccionar..."
    },
    "consent": "Acepto la política de privacidad y el tratamiento de mis datos.",
    "button_text": "Enviar Consulta",
    "success": {
      "title": "¡Consulta Enviada!",
      "description": "Nuestro equipo te contactará a la brevedad."
    }
  }'::jsonb
) ON CONFLICT (section_key) DO UPDATE SET content = EXCLUDED.content;

-- ============================================================
-- 9. NAVBAR - Nueva sección
-- ============================================================
INSERT INTO site_content (section_key, content) VALUES (
  'navbar',
  '{
    "items": [
      {"id": "nav_propiedades", "enabled": true, "order": 1, "label": "Propiedades", "url": "#propiedades"},
      {"id": "nav_servicios", "enabled": true, "order": 2, "label": "Servicios", "url": "#servicios"},
      {"id": "nav_equipo", "enabled": true, "order": 3, "label": "Equipo", "url": "#equipo"},
      {"id": "nav_proceso", "enabled": true, "order": 4, "label": "Proceso", "url": "#proceso"},
      {"id": "nav_contacto", "enabled": true, "order": 5, "label": "Contacto", "url": "#contacto"},
      {"id": "nav_publicar", "enabled": true, "order": 6, "label": "Publicar", "url": "admin.html"}
    ],
    "mobile_items": [
      {"id": "mob_propiedades", "enabled": true, "order": 1, "label": "Propiedades", "url": "#propiedades"},
      {"id": "mob_servicios", "enabled": true, "order": 2, "label": "Servicios", "url": "#servicios"},
      {"id": "mob_equipo", "enabled": true, "order": 3, "label": "Equipo", "url": "#equipo"},
      {"id": "mob_proceso", "enabled": true, "order": 4, "label": "Proceso", "url": "#proceso"},
      {"id": "mob_contacto", "enabled": true, "order": 5, "label": "Contacto", "url": "#contacto"},
      {"id": "mob_admin", "enabled": true, "order": 6, "label": "Panel Admin", "url": "admin.html"}
    ]
  }'::jsonb
) ON CONFLICT (section_key) DO UPDATE SET content = EXCLUDED.content;

-- ============================================================
-- 10. FOOTER - Extender existente
-- ============================================================
-- footer ya existe con copyright, matricula, razon_social, cuit
-- Agregar description, links, copyright, legal, cta

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{description}',
  '"Inmobiliaria premium en Buenos Aires. Más de 15 años de experiencia brindando asesoramiento personalizado."'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{links}',
  '{"navigation": [{"label": "Propiedades", "url": "#propiedades"}, {"label": "Servicios", "url": "#servicios"}, {"label": "Equipo", "url": "#equipo"}, {"label": "Proceso", "url": "#proceso"}, {"label": "Contacto", "url": "#contacto"}], "services": [{"label": "Venta", "url": "#servicios"}, {"label": "Alquiler", "url": "#servicios"}, {"label": "Inversión", "url": "#servicios"}, {"label": "Créditos", "url": "#servicios"}, {"label": "Tasaciones", "url": "#servicios"}]}'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{contact}',
  '{"phone": "+54 11 0000-0000", "email": "info@bienenhaus.com.ar", "schedule": "Lun - Vie: 9:00 - 18:00", "address": "Av. Corrientes 1234, CABA", "cuit": "30-00000000-0"}'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{copyright}',
  '"© 2025 Bienenhaus Propiedades. Todos los derechos reservados."'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{legal}',
  '{"privacy": "Política de Privacidad", "terms": "Términos y Condiciones", "faq": "FAQ"}'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta}',
  '{"text": "Encontrá tu hogar", "url": "#propiedades"}'::jsonb,
  true
) WHERE section_key = 'footer';

-- ============================================================
-- 11. SEO - Nueva sección
-- ============================================================
INSERT INTO site_content (section_key, content) VALUES (
  'seo',
  '{
    "title": "Bienenhaus Propiedades | Inmobiliaria Premium en Buenos Aires",
    "description": "Inmobiliaria premium en Buenos Aires. Departamentos, casas, ph y propiedades en venta y alquiler en las zonas más exclusivas. Asesoramiento personalizado y tasaciones profesionales.",
    "og_title": "Bienenhaus Propiedades | Inmobiliaria Premium en Buenos Aires",
    "og_description": "Departamentos, casas y ph en las zonas más exclusivas de Buenos Aires. Asesoramiento personalizado por expertos del mercado inmobiliario.",
    "og_image": "https://bienenhaus.com.ar/og-image.png",
    "og_url": "https://bienenhaus.com.ar",
    "og_type": "website",
    "og_locale": "es_AR",
    "og_site_name": "Bienenhaus Propiedades",
    "twitter_card": "summary_large_image",
    "twitter_title": "Bienenhaus Propiedades | Inmobiliaria Premium en Buenos Aires",
    "twitter_description": "Departamentos, casas y ph en las zonas más exclusivas de Buenos Aires. Tasaciones y asesoramiento personalizado.",
    "twitter_image": "https://bienenhaus.com.ar/og-image.png"
  }'::jsonb
) ON CONFLICT (section_key) DO UPDATE SET content = EXCLUDED.content;

-- ============================================================
-- 12. CATÁLOGO - Nueva sección completa
-- ============================================================
INSERT INTO site_content (section_key, content) VALUES (
  'catalog',
  '{
    "badge": "Catálogo",
    "title": "Propiedades",
    "highlight": "disponibles",
    "cta_text": "Contactar Asesor",
    "cta_url": "#contacto",
    "filters": {
      "operations": ["venta", "alquiler"],
      "types": ["departamento", "casa", "ph", "terreno", "local", "oficina"],
      "zones": [],
      "prices": ["0-100000", "100000-200000", "200000-500000", "500000-"]
    }
  }'::jsonb
) ON CONFLICT (section_key) DO UPDATE SET content = EXCLUDED.content;

-- ============================================================
-- 13. VIDEO - Extender hero existente
-- ============================================================
-- El hero ya tiene video_url, solo asegurar que se use correctamente

-- ============================================================
-- 14. HERO - Completar campos faltantes
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_text}',
  '"Ver Propiedades"'::jsonb,
  true
) WHERE section_key = 'hero';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_url}',
  '"#propiedades"'::jsonb,
  true
) WHERE section_key = 'hero';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{video_cta}',
  '"Ver Video"'::jsonb,
  true
) WHERE section_key = 'hero';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{video_url}',
  '"https://www.youtube.com/watch?v=FqiMrEoUjBI"'::jsonb,
  true
) WHERE section_key = 'hero';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{bg_image_alt}',
  '"Propiedad destacada Bienenhaus"'::jsonb,
  true
) WHERE section_key = 'hero';

-- Hero stats
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{stats}',
  '[
    {"id": "hero_stat_1", "enabled": true, "order": 1, "icon": "fa-home", "label": "Propiedades Activas", "value_key": "statProperties"},
    {"id": "hero_stat_2", "enabled": true, "order": 2, "icon": "fa-handshake", "label": "Operaciones Cerradas", "value_key": "statSold"},
    {"id": "hero_stat_3", "enabled": true, "order": 3, "icon": "fa-users", "label": "Agentes Activos", "value_key": "statAgents"}
  ]'::jsonb,
  '{stats}',
  true
) WHERE section_key = 'hero';

-- Trust block
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{trust}',
  '{"title": "Excelencia Comprobada", "description": "Calificaciones máximas de nuestros clientes."}'::jsonb,
  true
) WHERE section_key = 'hero';

-- Feature bar
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{features}',
  '[
    {"id": "feat_1", "enabled": true, "order": 1, "icon": "fa-shield-halved", "title": "Títulos Verificados", "description": "Documentación legal revisada por expertos."},
    {"id": "feat_2", "enabled": true, "order": 2, "icon": "fa-key", "title": "Llaves en el Día", "description": "Trámites ágiles para tu tranquilidad."},
    {"id": "feat_3", "enabled": true, "order": 3, "icon": "fa-coins", "title": "Créditos Pre-Aprobados", "description": "Financiación flexible y accesible."},
    {"id": "feat_4", "enabled": true, "order": 4, "icon": "fa-headset", "title": "Asesoramiento 24/7", "description": "Siempre disponibles para vos."}
  ]'::jsonb,
  '{features}',
  true
) WHERE section_key = 'hero';

-- ============================================================
-- 15. CATÁLOGO FILTROS - Configuración
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{filters}',
  '{"operations": ["venta", "alquiler"], "types": ["departamento", "casa", "ph", "terreno", "local", "oficina"], "zones": [], "prices": ["0-100000", "100000-200000", "200000-500000", "500000-"]}'::jsonb,
  true
) WHERE section_key = 'catalog';

-- ============================================================
-- 16. HERO STATS - Configurar claves de valor dinámico
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{stats}',
  '[
    {"id": "hero_stat_1", "enabled": true, "order": 1, "icon": "fa-home", "label": "Propiedades Activas", "value_key": "statProperties"},
    {"id": "hero_stat_2", "enabled": true, "order": 2, "icon": "fa-handshake", "label": "Operaciones Cerradas", "value_key": "statSold"},
    {"id": "hero_stat_3", "enabled": true, "order": 3, "icon": "fa-users", "label": "Agentes Activos", "value_key": "statAgents"}
  ]'::jsonb,
  '{stats}',
  true
) WHERE section_key = 'hero';

-- ============================================================
-- 17. CATÁLOGO CTA
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_text}',
  '"Contactar Asesor"'::jsonb,
  true
) WHERE section_key = 'catalog';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_url}',
  '"#contacto"'::jsonb,
  true
) WHERE section_key = 'catalog';

-- ============================================================
-- 17. SERVICES CTA
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_text}',
  '"Saber más"'::jsonb,
  true
) WHERE section_key = 'services';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_url}',
  '"#contacto"'::jsonb,
  true
) WHERE section_key = 'services';

-- ============================================================
-- 18. PROCESS CTA
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_text}',
  '"Empezar"'::jsonb,
  true
) WHERE section_key = 'process';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta_url}',
  '"#contacto"'::jsonb,
  true
) WHERE section_key = 'process';

-- ============================================================
-- 18. STATS CTA
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta}',
  '{"label": "Contactar Ahora", "button_text": "Contactar Ahora", "button_url": "#contacto"}'::jsonb,
  true
) WHERE section_key = 'stats';

-- ============================================================
-- 19. FOOTER CTA
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta}',
  '{"text": "Encontrá tu hogar", "url": "#propiedades"}'::jsonb,
  true
) WHERE section_key = 'footer';

-- ============================================================
-- 20. STATS - Asegurar items array completo
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{items}',
  '[
    {"id": "stat_1", "enabled": true, "order": 1, "icon": "fa-home", "value": "150", "suffix": "+", "title": "Propiedades Vendidas", "description": "Operaciones exitosas en los últimos años."},
    {"id": "stat_2", "enabled": true, "order": 2, "icon": "fa-users", "value": "300", "suffix": "+", "title": "Clientes Satisfechos", "description": "Familias que confiaron en nosotros."},
    {"id": "stat_3", "enabled": true, "order": 3, "icon": "fa-award", "value": "15", "suffix": "+", "title": "Años de Experiencia", "description": "Trayectoria en el mercado inmobiliario."},
    {"id": "stat_4", "enabled": true, "order": 4, "icon": "fa-star", "value": "4.9", "suffix": "★", "title": "Calificación Promedio", "description": "Basada en reseñas de Google."}
  ]'::jsonb,
  '{items}',
  true
) WHERE section_key = 'stats';

-- ============================================================
-- 21. PROCESS STEPS - Asegurar pasos completos
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{steps}',
  '[
    {"id": "step_1", "enabled": true, "order": 1, "number": "01", "icon": "fa-comments", "title": "Consulta Inicial", "description": "Nos reunimos para entender tus necesidades y presupuesto."},
    {"id": "step_2", "enabled": true, "order": 2, "icon": "fa-search", "title": "Búsqueda", "description": "Seleccionamos las mejores opciones para vos."},
    {"id": "step_3", "enabled": true, "order": 3, "icon": "fa-eye", "title": "Visitas", "description": "Te acompañamos a conocer cada propiedad."},
    {"id": "step_4", "enabled": true, "order": 4, "icon": "fa-file-signature", "title": "Documentación", "description": "Verificamos y preparamos toda la documentación."},
    {"id": "step_5", "enabled": true, "order": 5, "icon": "fa-key", "title": "Entrega", "description": "Cerramos la operación y te entregamos las llaves."}
  ]'::jsonb,
  '{steps}',
  true
) WHERE section_key = 'process';

-- ============================================================
-- 22. CONTACT FORM - Validar estructura completa
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{fields}',
  '{
    "nombre": {"label": "Nombre completo", "placeholder": "Tu nombre", "required": true},
    "email": {"label": "Email", "placeholder": "tu@email.com", "required": true},
    "telefono": {"label": "Teléfono", "placeholder": "+54 11 0000-0000", "required": true},
    "tipo_propiedad": {
      "label": "Tipo de propiedad",
      "placeholder": "Seleccionar...",
      "options": [
        {"value": "departamento", "label": "Departamento"},
        {"value": "casa", "label": "Casa"},
        {"value": "ph", "label": "PH"},
        {"value": "terreno", "label": "Terreno"},
        {"value": "local", "label": "Local Comercial"}
      ]
    },
    "presupuesto": {"label": "Presupuesto estimado (USD)", "placeholder": "Ej: 150000", "required": false},
    "mensaje": {"label": "Mensaje", "placeholder": "Contanos sobre lo que buscás...", "required": false}
  }'::jsonb,
  '{fields}',
  true
) WHERE section_key = 'form';

-- ============================================================
-- 23. NAVBAR - Validar items
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{items}',
  '[
    {"id": "nav_propiedades", "enabled": true, "order": 1, "label": "Propiedades", "url": "#propiedades"},
    {"id": "nav_servicios", "enabled": true, "order": 2, "label": "Servicios", "url": "#servicios"},
    {"id": "nav_equipo", "enabled": true, "order": 3, "label": "Equipo", "url": "#equipo"},
    {"id": "nav_proceso", "enabled": true, "order": 4, "label": "Proceso", "url": "#proceso"},
    {"id": "nav_contacto", "enabled": true, "order": 5, "label": "Contacto", "url": "#contacto"},
    {"id": "nav_publicar", "enabled": true, "order": 6, "label": "Publicar", "url": "admin.html"}
  ]'::jsonb,
  '{items}',
  true
) WHERE section_key = 'navbar';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{mobile_items}',
  '[
    {"id": "mob_propiedades", "enabled": true, "order": 1, "label": "Propiedades", "url": "#propiedades"},
    {"id": "mob_servicios", "enabled": true, "order": 2, "label": "Servicios", "url": "#servicios"},
    {"id": "mob_equipo", "enabled": true, "order": 3, "label": "Equipo", "url": "#equipo"},
    {"id": "mob_proceso", "enabled": true, "order": 4, "label": "Proceso", "url": "#proceso"},
    {"id": "mob_contacto", "enabled": true, "order": 5, "label": "Contacto", "url": "#contacto"},
    {"id": "mob_admin", "enabled": true, "order": 6, "label": "Panel Admin", "url": "admin.html"}
  ]'::jsonb,
  '{mobile_items}',
  true
) WHERE section_key = 'navbar';

-- ============================================================
-- 24. FOOTER - Completar campos
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{description}',
  '"Inmobiliaria premium en Buenos Aires. Más de 15 años de experiencia brindando asesoramiento personalizado."'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{links}',
  '{"navigation": [{"label": "Propiedades", "url": "#propiedades"}, {"label": "Servicios", "url": "#servicios"}, {"label": "Equipo", "url": "#equipo"}, {"label": "Proceso", "url": "#proceso"}, {"label": "Contacto", "url": "#contacto"}], "services": [{"label": "Venta", "url": "#servicios"}, {"label": "Alquiler", "url": "#servicios"}, {"label": "Inversión", "url": "#servicios"}, {"label": "Créditos", "url": "#servicios"}, {"label": "Tasaciones", "url": "#servicios"}]}'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{contact}',
  '{"phone": "+54 11 0000-0000", "email": "info@bienenhaus.com.ar", "schedule": "Lun - Vie: 9:00 - 18:00", "address": "Av. Corrientes 1234, CABA", "cuit": "30-00000000-0"}'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{copyright}',
  '"© 2025 Bienenhaus Propiedades. Todos los derechos reservados."'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{legal}',
  '{"privacy": "Política de Privacidad", "terms": "Términos y Condiciones", "faq": "FAQ"}'::jsonb,
  true
) WHERE section_key = 'footer';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{cta}',
  '{"text": "Encontrá tu hogar", "url": "#propiedades"}'::jsonb,
  true
) WHERE section_key = 'footer';

-- ============================================================
-- 25. SEO - Validar estructura completa
-- ============================================================
UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{title}',
  '"Bienenhaus Propiedades | Inmobiliaria Premium en Buenos Aires"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{description}',
  '"Inmobiliaria premium en Buenos Aires. Departamentos, casas, ph y propiedades en venta y alquiler en las zonas más exclusivas. Asesoramiento personalizado y tasaciones profesionales."'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{og_title}',
  '"Bienenhaus Propiedades | Inmobiliaria Premium en Buenos Aires"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{og_description}',
  '"Departamentos, casas y ph en las zonas más exclusivas de Buenos Aires. Asesoramiento personalizado por expertos del mercado inmobiliario."'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{og_image}',
  '"https://bienenhaus.com.ar/og-image.png"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{og_url}',
  '"https://bienenhaus.com.ar"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{og_type}',
  '"website"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{og_locale}',
  '"es_AR"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{og_site_name}',
  '"Bienenhaus Propiedades"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{twitter_card}',
  '"summary_large_image"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{twitter_title}',
  '"Bienenhaus Propiedades | Inmobiliaria Premium en Buenos Aires"'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{twitter_description}',
  '"Departamentos, casas y ph en las zonas más exclusivas de Buenos Aires. Tasaciones y asesoramiento personalizado."'::jsonb,
  true
) WHERE section_key = 'seo';

UPDATE site_content SET content = jsonb_set(
  COALESCE(content, '{}'::jsonb),
  '{twitter_image}',
  '"https://bienenhaus.com.ar/og-image.png"'::jsonb,
  true
) WHERE section_key = 'seo';