# Email para QuintoAndar — integración RELA (ZonaProp)

> **Para:** integracion@ar.quintoandar.com
> **Asunto:** Bienenhaus Propiedades — re-vinculación de la inmobiliaria 30662083 y solicitud de credenciales de producción
>
> Copiar desde "---" hasta el final. Los datos técnicos van en código para que
> los puedan copiar sin errores.

---

Hola, equipo de integraciones de QuintoAndar:

Somos **Bienenhaus Propiedades**, una inmobiliaria de Córdoba (Argentina). Estamos
integrados con la API de **Open RELA** desde agosto de 2026 y necesitamos ayuda
para destrabar la publicación de nuestros avisos.

**Nuestros datos:**

| Dato | Valor |
|---|---|
| Inmobiliaria | Bienenhaus Propiedades |
| `codigoInmobiliaria` | `30662083` (ambiente sandbox) |
| Integración RELA | `20354` |
| Plan contratado | `SIMPLE` |
| Ambiente | Sandbox (pruebas) → necesitamos pasar a producción |

## Lo que ya tenemos listo

- Los 27 avisos están completos y validados (precio, fotos, descripción, tipo
  de inmueble, superficie y zona con su código RELA).
- La integración técnica está funcionando: los catálogos de RELA se leen bien
  con nuestro token y los avisos se arman con el formato que pide la API.
- El paso de avisos está medido y funciona (creamos un aviso de prueba el
  31/08 y la API lo procesó correctamente).
- Tenemos listo el endpoint que recibe las consultas de los interestedos para
  que entren directamente a nuestro CRM.

## Lo que necesitamos (4 puntos concretos)

**1. Re-vincular la inmobiliaria `30662083` a nuestra integración `20354`.**

Hoy, al consultar el estado de la inmobiliaria, la API responde:

```
GET /v1/inmobiliarias/30662083/disponibilidad
→ 409 "La inmobiliaria [30662083] no pertenece a la integracion [20354]"

GET /v1/inmobiliarias
→ {"total":0}
```

El 31/08 esto funcionaba (la API rechazaba los avisos por falta de créditos del
plan, no por vínculo). Por lo que entendimos, la vinculación se perdió o nunca
se completó para el ambiente sandbox. ¿Nos pueden re-vincular la inmobiliaria
`30662083` a la integración `20354`? Nos sirve en cualquiera de los dos
ambientes, en el que esté disponible antes.

**2. Permiso para administrar las notificaciones (callbacks).**

Necesitamos registrar a dónde la API nos avisa de las consultas de los
interesados. Al intentar ver la configuración actual, la API responde:

```
GET /v1/configuracion/callbacks
→ 500 "Access is denied"
```

¿Nos pueden habilitar ese permiso para la integración `20354`? La URL que
queremos registrar es:

```
https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/rela-callbacks
```

**3. Credenciales del ambiente de producción.**

Para publicar de verdad necesitamos el `client_id` y el `client_secret` de
producción (los de sandbox no sirven en el endpoint de producción: responden
`invalid_token`). ¿Nos los pueden enviar?

El host que estamos usando como referencia para el endpoint de producción es
`https://api-zp-open.navent.com` (responde `invalid_token` sin credenciales, o
sea que existe). Por favor confirmen si es el correcto y si el parámetro
`role` sigue siendo `zp`.

**4. Tres zonas que no encontramos en el catálogo de ubicaciones.**

Para 5 de nuestros avisos (Loma Del Tigre, La Alfonsina y San Javier del
Lago, todos en Córdoba) no encontramos el código de ubicación en el catálogo.
Son barrios/parajes que la API no nos devuelve al sincronizar. ¿Nos pueden
pasar el `idUbicacion` de estas tres zonas, o confirmar si tienen un
equivalente dentro de la localidad?

| Zona | Avisos |
|---|---|
| Loma Del Tigre | DA-P0001, DA-P0013 |
| La Alfonsina | DA-P0015, DA-P0016 |
| San Javier del Lago | DA-P0026 |

## Una consulta aparte

Desde el **7 de noviembre** la API de sandbox
(`https://api-zp-sandbox-open.navent.com`) responde **HTTP 521** en todas las
rutas, incluso en la raíz. Entendemos que puede ser una caída programada, pero
queríamos confirmar si hay una fecha estimada de vuelta, porque sin el catálogo
de ubicaciones no podemos completar el alta de los 5 avisos que faltan.

Quedamos a la espera de su confirmación. Si necesitan que probemos algo en
particular, o que completemos algún dato de la solicitud de integración,
decinoslo y lo hacemos.

¡Muchas gracias por la ayuda!

**Bienenhaus Propiedades**
Córdoba, Argentina
