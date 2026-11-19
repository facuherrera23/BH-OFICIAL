# Verificar el sitio en Google Search Console (GSC)

> Estado: **pendiente del dueño** (19/11/2026). Es el paso que falta para
> saber qué se busca en el sitio: sin GSC, cualquier decisión de SEO es a ciegas.

## Por qué importa

Hoy el sitio tiene **0 páginas indexadas** en la búsqueda de Google
(`site:bienenhaus.com.ar` → 0 resultados) y **no hay ninguna forma de saber
qué consultas traen tráfico**. Lo que sí se hizo (19/11/2026):

| Pieza | Qué resuelve |
|---|---|
| `/propiedades.html` (hub estático) | La home **no tenía ni un link** a las 27 fichas en el HTML inicial (el catálogo se arma por JS). El crawler ahora puede recorrer el hub sin ejecutar JS. |
| `tel:` visible en fichas y home | Google puede mostrar el botón "Llamar" en el rich result. Antes había 0 links de teléfono. |
| `lastmod` real por ficha en el sitemap | Antes todas las URLs tenían la fecha de generación → Google lo ignoraba. |
| Sitemap en `robots.txt` | Ya estaba: `Sitemap: https://bienenhaus.com.ar/sitemap.xml`. |

Sin GSC, no sabemos si conviene una landing por zona, por tipo de propiedad o
por barrio: **eso se decide con las queries reales**, no con una intuición.

## Paso a paso (lo hace el dueño, ~5 minutos)

1. Entrar en **https://search.google.com/search-console** con una cuenta de
   Google (la del negocio, idealmente) y toca **"Agregar propiedad"**.
2. Elegir el tipo **"Dominio"** → escribir `bienenhaus.com.ar`
   (sin `https://`, sin `/`).
3. Google muestra un **registro DNS tipo TXT** con un token, parecido a:
   ```
   google-site-verification=ABCdef1234567890abcdef1234567890abcdef1234567890
   ```
4. En **Cloudflare → DNS → Records → Add record**:
   - **Type**: `TXT`
   - **Name**: `@`
   - **Content**: el token completo (pegarlo tal cual, con el prefijo
     `google-site-verification=`)
   - **TTL**: `Auto`
5. Guardar y esperar la propagación (puede tardar de minutos a 48 h, según
   el TTL de Cloudflare).
6. Volver a GSC → **Verify**. Cuando pase a "Ownership verified", la propiedad
   queda verificada.

> Alternativa si el dominio está en otro registrador de DNS: el mismo paso 3
> pero en el panel del registrador (GoDaddy / Hosting / Register / etc.).

## Después de verificar

1. En GSC → **Sitemaps** → escribí `sitemap.xml` → **Submit**.
   (También se autodetecta por `robots.txt`, pero mandarlo a mano es gratis.)
2. En GSC → **Inspección de URLs** → pegá `https://bienenhaus.com.ar/propiedades.html`
   → **Request indexing** (indexa esa, y encola el resto).
3. ** waited 1–2 semanas** y volvé a **Performance → Queries**: ahí están las
   búsquedas reales que traen visitas.

## Qué mirar en Performance (y qué decidimos con eso)

| Métrica | Para qué sirve |
|---|---|
| **Queries** (búsquedas) | Qué escribe la gente: "terrenos en venta El Cedrón", "casas en Córdoba", "departamentos en alquiler Centro"… |
| **Pages** (páginas) | Qué ficha se mira más → para decidir cuáles merecen una landing propia |
| **CTR** | Si Google muestra el resultado pero nadie clica → el título/description de esa ficha están mal |
| **Clicks / Impressions** | La línea de base real. Hoy es 0: **el primer objetivo es que deje de ser 0**. |

Con esos datos se define la **Fase 3.2** (landings por zona o por tipo), en
vez de adivinar.

## Pendientes del dueño (no se pueden hacer desde el repo)

- [ ] Verificar el dominio en GSC (este documento).
- [ ] Enviar el sitemap.
- [ ] Activar **Cloudflare Web Analytics** (la CSP de todas las páginas ya lo
      permite: `static.cloudflareinsights.com`; falta el beacon con el token).
- [ ] Opcional: **Bing Webmaster Tools** (importa el sitio a Bing y de ahí a
      los buscadores de IA).
- [ ] Decidir si se habilita `Google-Extended` en Cloudflare (hoy está en
      `Disallow`): bloquea AI Overviews y Gemini, pero no la búsqueda web.

## Nota técnica

`robots.txt` (producción) tiene:

```
User-agent: *
Allow: /
Content-Signal: search=yes,ai-train=no,use=reference
Sitemap: https://bienenhaus.com.ar/sitemap.xml
```

→ **Googlebot no está bloqueado** ✓. Los `Disallow` son de AI crawlers
(`Google-Extended`, `GPTBot`, `ClaudeBot`, …), que no afectan la búsqueda
web. Si en algún momento se quiere aparecer en AI Overviews, hay que quitar
`Google-Extended` de esa lista (o usar la opción de opt-out de Cloudflare).
