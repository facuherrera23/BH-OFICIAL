# Google Business Profile — Post de tasación (listo para pegar)

> **Por qué es manual:** Google Business Profile **no ofrece API para publicar**
> (limitación para todos los proveedores, igual que pasó con el botón de
> comunidad de YouTube). El post se pega una vez desde el panel del perfil.
> La URL lleva UTMs: cada lead que entra desde acá queda atribuido en el CRM.

## Dónde pegarlo (2 minutos)

1. Entrar a **google.com/business** con la cuenta dueña del perfil.
2. **Publicaciones → Novedad** (o "What's new" / "Create post").
3. Pegar el texto de abajo, poner la **URL del botón** y subir una foto
   (una fachada o foto de propiedad sirve; screenshot del formulario también).
4. Publicar. Google elige cuánto tiempo lo mantiene arriba (típicamente lo
   re-publica el mismo texto cada 4-6 semanas para que no caduque).

## Texto principal (picar y pegar)

---

**¿Cuánto vale tu propiedad? Descubrilo con una tasación profesional sin cargo.**

Si estás pensando en vender o alquilar en Córdoba, la primera decisión es saber
el precio correcto. En Bienenhaus hacemos la tasación **GRATIS y sin compromiso**:
analizamos zona, comparables y estado del inmueble, y te decimos el valor real
de mercado — no el que conviene al que te visita.

Pedila online en 1 minuto: te contacts y coordinamos la visita.

📌 Pedí tu tasación acá: https://bienenhaus.com.ar/tasacion.html

---

## URL para el botón del post

```
https://bienenhaus.com.ar/tasacion.html?utm_source=google_business&utm_medium=post&utm_campaign=gbp-tasacion
```

- `utm_source=google_business` → en el CRM el lead llega marcado con este canal
  (el formulario de tasación persiste las UTMs de la URL).
- `utm_campaign=gbp-tasacion` → identifica este post en particular; si se hacen
  posts nuevos, variar el valor (ej: `gbp-tasacion-2026-12`) para medirlos por separado.

## Versión corta (para "Descripción" del perfil o biografías)

> Tasación profesional sin cargo para propiedades en Córdoba.
> Pedila online en bienenhaus.com.ar/tasacion.html

## Notas

- Los leads de esta vía son idénticos a los del landing: entra por donde
  entre, el lead nace con la tarea "Primer contacto" de 2 h y queda medido
  en el digest semanal por canal (el SLA de primer contacto no distingue origen).
- La sección "Dónde pegarlo" queda documentada para re-publicar el post
  periódicamente (los posts de GBP caducan a ~4-6 meses si son de novedad;
  las "ofertas" permiten fecha).
- Sin API de publicación: si algún día Google la entrega, integrar con el
  patrón del módulo Contenido (`social_posts`), pero HOY es pegado manual.
