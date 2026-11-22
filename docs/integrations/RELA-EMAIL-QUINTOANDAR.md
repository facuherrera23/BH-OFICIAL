# Email de seguimiento a QuintoAndar — RELA (ZonaProp)

> **Hilo:** responder/reenviar en `SP-61526` a `jira@navent.atlassian.net`
> **Copia:** `integracion@ar.quintoandar.com`
> **Asunto (exacto, para no romper el hilo):** `SP-61526 Fwd: Solicitud de información para integración con Zonaprop`
>
> Motivo: el correo técnico del 9/11 lleva **13 días sin respuesta**. El 13/11
> el dueño también consultó por otra vía (Atención Inmobiliarias de ZonaProp,
> hilo `GDrTQktEG1-2BXaUo9-RvRI`) y tampoco obtuvo respuesta: Carla es Customer
> Service y derivó el tema a ejecutiva de cuentas, no a integraciones.
>
> **Firma: Facundo Herrera Orquera** (responsable de la integración), no el titular.
> Copiar desde "---" hasta el final.

---

Hola Bryan / equipo de integraciones de QuintoAndar:

Les escribo como continuación del ticket **SP-61526** (correo enviado el 9/11 a
esta dirección, con copia a integracion@ar.quintoandar.com). Llevamos 13 días
sin respuesta y necesitamos destrabar la integración de nuestro CRM propio con
ZonaProp. Somos **Bienenhaus Propiedades**, inmobiliaria de Córdoba, Argentina.

**Datos de la integración:**

| Dato | Valor |
|---|---|
| Inmobiliaria | Bienenhaus Propiedades |
| `codigoInmobiliaria` | `30662083` |
| Integración RELA | `20354` |
| `role` | `zp` |
| Ambiente actual | Sandbox (`https://api-zp-sandbox-open.navent.com`) |

## Lo que ya está resuelto (no hace falta que lo revisen)

- **Vinculación:** `GET /v1/inmobiliarias` → 200, `total: 1`, inmobiliaria
  `30662083`, `bloqueada: false`. `GET /v1/inmobiliarias/30662083/disponibilidad`
  → 200 con `SIMPLE: 11`, `DESTACADO: 2`, `HOME: 0` (13 créditos en sandbox).
- **Catálogo/zonas:** las 3 zonas que no figuraban (Loma del Tigre, La Alfonsina
  y San Javier del Lago) se mapearon a Villa Carlos Paz con el barrio real en la
  descripción. Ya no necesitamos los `idUbicacion`.
- **Captación de consultas:** como no pudimos registrar callbacks, pasamos a
  `GET /v1/inmobiliarias/30662083/mensajes` (polling cada 10 min). Ya trajo
  contactos reales al CRM. El teléfono de contacto del aviso es
  `+5493516379651`.

## Lo que necesitamos (4 puntos)

**1. La API de sandbox está caída (HTTP 521).**

`https://api-zp-sandbox-open.navent.com` responde **521 "Web server is down"**
incluso en la raíz. Ya pasó del 7 al 9/11 y volvió el 21/11; hoy sigue caída
(verificado el 22/11). ¿Hay una fecha estimada de restablecimiento o un host
alternativo de sandbox? Sin esto no podemos correr el alta de los avisos ni
confirmar el aviso de prueba que tenemos autorizado.

**2. Permiso para configurar callbacks.**

`PUT /v1/configuracion/callbacks` responde
`500 {"code":"error_inesperado","message":"Access is denied"}`.

¿Pueden habilitar el permiso de administración de callbacks para la integración
`20354`? La URL a registrar es:

```
https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/rela-callbacks
```

Si el polling es la vía que recomiendan, también nos sirve que lo confirmen por
escrito para dejar de pedirlo.

**3. Credenciales del ambiente de producción.**

Necesitamos `client_id` y `client_secret` de producción. Los de sandbox darían
`invalid_token` en `https://api-zp-open.navent.com` (host que sí responde).
¿Es ese el endpoint correcto y el `role` sigue siendo `zp`?

**4. Pack/créditos de producción.**

En el mensaje del 10/9 nos indicaron que la cuenta no tenía créditos en
producción y que Sandbox era espejo de producción. Hoy sandbox muestra 13
créditos, pero para publicar en el sitio real necesitamos saber si el pack ya
está activo y cuántos avisos permite.

En cuanto tengamos API + credenciales, publicamos **un solo aviso de prueba** y
les confirmamos el resultado antes de seguir con el resto del inventario.

Quedamos atentos a su respuesta. Si necesitan algún dato adicional, decinoslo.

¡Muchas gracias!

**Facundo Herrera Orquera**
Bienenhaus Propiedades — Córdoba, Argentina
