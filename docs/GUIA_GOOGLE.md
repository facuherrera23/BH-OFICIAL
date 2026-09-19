# 📱 Guía: Vincular el sitio con Google
**Objetivo:** que Google indexe bienenhaus.com.ar, aparezca en búsquedas de inmobiliarias en Córdoba, y el perfil de Google Maps genere visitas.

**Tiempo total estimado:** 15-20 minutos (sin contar verificación DNS que puede tardar hasta 24h)

---

## PARTE 1: Google Search Console (5 minutos)

### Qué hace
Le dice a Google que tu sitio existe, le muestra qué páginas indexar, y te da estadísticas de búsquedas.

### Paso a paso

1. **Ir a** [search.google.com/search-console](https://search.google.com/search-console)
2. **Iniciar sesión** con tu cuenta de Gmail (la misma que uses para el negocio)
3. **Hacer clic en "Añadir propiedad"**
4. **Elegir "Dominio"** (no "Prefijo de URL") — es más completo
   - Escribir: `bienenhaus.com.ar` (sin https:// ni www)
   - Hacer clic en "Continuar"
5. **Verificar dominio** — Google te va a dar un registro TXT como este:
   ```
   google-site-verification=xxxxxxxxxxxxxxxxxxxxxxxxx
   ```
6. **Ir a Cloudflare** → [dash.cloudflare.com](https://dash.cloudflare.com)
   - Seleccionar el dominio `bienenhaus.com.ar`
   - Ir a **DNS** → **Records**
   - Clic en **Add Record**
   - Type: `TXT`
   - Name: `@` (o dejarlo vacío)
   - Content: el valor que te dio Google (pegar completo)
   - Clic **Save**
7. **Volver a Search Console** y hacer clic en **"Verificar"**
   - Si no verifica inmediatamente, esperar 5 minutos y reintentar (la propagación DNS puede tardar)
8. **Una vez verificado:**
   - Ir a **"Sitemaps"** en el menú izquierdo
   - En "Añadir un nuevo sitemap" escribir: `sitemap.xml`
   - Hacer clic en **"Enviar"**
9. **Pedir indexación de la página principal:**
   - Ir a la barra superior (URL Inspection / Inspección de URL)
   - Pegar `https://bienenhaus.com.ar/`
   - Hacer clic en **"Solicitar indexación"**
   - Repetir para `https://bienenhaus.com.ar/politica-de-privacidad.html`
   - También pedir indexación de 2-3 fichas principales:
     - `https://bienenhaus.com.ar/fichas/DA-P0001.html`
     - `https://bienenhaus.com.ar/fichas/HS-P0006.html`

### ✅ Checklist de Search Console
- [ ] Propiedad de dominio añadida
- [ ] Registro TXT en Cloudflare DNS
- [ ] Dominio verificado
- [ ] `sitemap.xml` enviado
- [ ] Indexación de la home solicitada
- [ ] Indexación de 3 fichas principales solicitada

### Qué esperar
- **Indexación inicial:** 2-7 días (Google no es inmediato)
- **Aparecer en búsquedas:** 1-4 semanas
- **Ver resultados en Search Console:** datos a partir de la semana 2

---

## PARTE 2: Perfil de Empresa en Google (10 minutos)

### Qué hace
Te da el panel lateral en búsquedas ("Business Profile"), te ubica en Google Maps, permite reseñas, y es **la fuente #1 de visitas para una inmobiliaria local**.

### Paso a paso

1. **Ir a** [business.google.com](https://business.google.com)
2. **Iniciar sesión** con tu Gmail
3. **Hacer clic en "Añadir negocio"** o el botón "+"
4. **Nombre del negocio:** `Bienenhaus Propiedades`
5. **Categoría:** escribir "inmobiliaria" y seleccionar **"Agente inmobiliario"** (o "Servicios inmobiliarios")
6. **Ubicación:**
   - Elegir **"Sí"** cuando pregunte si atendés clientes en tu dirección
   - Escribir la dirección de la oficina (cuando la tengas definida)
   - Si aún no tienen oficina pública: elegir **"No, solo atiendo a domicilio del cliente"** (se puede cambiar después)
7. **Área de servicio:** escribir las zonas que cubren:
   - Córdoba Capital
   - Valle de Calamuchita
   - (agregar las que correspondan)
8. **Información de contacto:**
   - Teléfono: el número real (uno de los dos que rotan)
   - Sitio web: `https://bienenhaus.com.ar`
9. **Horarios:** los reales (si aún no los definiste, poner "Lun-Vie 9:00-18:00" como placeholder)
10. **Fotos:**
    - Logo (el que ya tienen: pwa-512x512.png)
    - Foto de portada (una imagen atractiva de una propiedad o el hero del sitio)
    - Agregar 3-5 fotos de propiedades destacadas
11. **Descripción (importante para SEO local):**
    ```
    Inmobiliaria en Córdoba especializada en venta y alquiler de propiedades premium. 
    Departamentos, casas y terrenos en las mejores zonas de Córdoba Capital y el Valle de Calamuchita. 
    Asesoramiento integral, tasaciones profesionales y marketing digital para tu propiedad.
    CPI 1834.
    ```
12. **Verificar el perfil:**
    - Google te va a pedir verificación (por lo general envía un código postal o llama por teléfono)
    - Elegir el método que prefieras y completar cuando llegue

### ✅ Checklist del Perfil de Empresa
- [ ] Negocio creado con nombre correcto
- [ ] Categoría "Agente inmobiliario"
- [ ] Ubicación o área de servicio definida
- [ ] Teléfono real
- [ ] Sitio web: bienenhaus.com.ar
- [ ] Horarios cargados
- [ ] Logo y fotos subidas
- [ ] Descripción con keywords de Córdoba
- [ ] Verificación en proceso

### Qué esperar
- **Aprobación:** 1-3 días
- **Aparecer en Maps:** inmediato después de aprobado
- **Primeras llamadas desde Maps:** desde el día 1

---

## PARTE 3: Palabras clave que Google va a empezar a asociar

Tu sitio ya está optimizado para estas búsquedas:

| Palabra clave | Dónde está optimizada |
|---|---|
| "inmobiliaria en Córdoba" | Título de la página + meta description + H2 del catálogo |
| "inmobiliaria premium Córdoba" | Hero + sección Servicios |
| "propiedades en Córdoba" | H2 del catálogo + JSON-LD |
| "tasaciones Córdoba" | Sección Servicios + página de tasación |
| "casas en venta Córdoba" | Fichas de propiedades (cada una con su título) |
| "terrenos Calamuchita" | Fichas de terrenos (DA-P0001, etc.) |
| "departamentos alquiler Córdoba" | Ficha HS-P0006 (Alquiler Centro Departamento) |

### Qué NO hacer (Google penaliza)
- ❌ Comprar reseñas falsas
- ❌ Duplicar contenido entre páginas
- ❌ Escribir "inmobiliaria Córdoba" 50 veces en la misma página
- ❌ Crear múltiples perfiles de Google Business para la misma empresa

---

## PARTE 4: Qué revisar en Search Console (primera semana)

| Métrica | Dónde | Qué significa |
|---|---|---|
| **Páginas indexadas** | Índice → Páginas | Cuántas de tus URLs están en Google |
| **Sitemap procesado** | Sitemaps | Si Google leyó tu sitemap.xml |
| **Posición media** | Rendimiento | En qué puesto apareces para cada búsqueda |
| **Clics** | Rendimiento | Cuánta gente hizo clic desde Google |
| **Impresiones** | Rendimiento | Cuántas veces te vieron en resultados |
| **Errores de rastreo** | Índice → Páginas | Si Google no puede leer alguna página |

---

## Cronograma esperado

| Semana | Qué pasa |
|---|---|
| 1 | Google rastrea e indexa las primeras páginas |
| 2-3 | Aparecen en búsquedas de "bienenhaus" (nombre directo) |
| 4-6 | Empiezan a aparecer para "inmobiliaria córdoba" (competitivo) |
| 6-12 | Las fichas de propiedades generan visitas por búsquedas específicas |
| 3+ meses | El perfil de Maps genera llamadas y consultas recurrentes |

---

**Creada el 2026-09-19.** Esta guía no requiere intervención del desarrollador — el dueño del negocio puede completarla solo.
