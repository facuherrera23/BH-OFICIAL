# RELA — corte a producción (playbook, NO ejecutado)

Preparado el 2026-11-24. **No ejecutar** hasta tener: (1) credenciales de
producción, (2) confirmación de pack/créditos, (3) OK explícito del dueño.

## Lo que falta

- `client_id` / `client_secret` de producción (los de sandbox dan `401 invalid_client`).
- Código de inmobiliaria en producción (en sandbox es `30662083`).
- Base URL definitiva (presunción: `https://api-zp-open.navent.com`).
- Confirmación de que hay créditos disponibles (sin ellos el `PUT` responde `ERR-0501`).

## Verificación previa (solo lectura)

```sql
select * from public.rela_portal_status();
select base_url, environment, role, codigo_inmobiliaria, dry_run, callbacks_enabled
  from public.rela_config where id = true;
select status, count(*) from public.rela_listings group by status;
```

Estado al preparar este playbook: sandbox, `dry_run=false`, 11 avisos aceptados,
0 créditos SIMPLE disponibles, 22 propiedades listas sin publicar.

La cola ya está reconciliada (`pending:22 / published:11 / not_publishable:13 /
blocked:0`) y el panel se actualiza solo ante cambios de `rela_listings` (migración
`20261124000001` + `tests/rela-realtime.spec.js`). No hace falta recargar la
pestaña para ver los botones ni los contadores.

## Paso 1 — secrets de la Edge Function

Reemplazar los placeholders por los valores que envíe QuintoAndar. **Nunca commitearlos.**

```bash
supabase secrets set \
  RELA_CLIENT_ID=<id_produccion> \
  RELA_CLIENT_SECRET=<secret_produccion> \
  RELA_BASE_URL=https://api-zp-open.navent.com \
  RELA_ROLE=zp \
  --project-ref rnldqiwwzhjnurkguihu
```

## Paso 2 — probar el login antes de tocar la configuración

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://api-zp-open.navent.com/v1/application/login?grant_type=client_credentials&client_id=<id>&client_secret=<secret>"
```

Debe dar **200**. Si da 401, las credenciales no son de producción: parar acá.

## Paso 3 — apuntar la config (ESCRITURA, requiere OK del dueño)

```sql
update public.rela_config
   set base_url = 'https://api-zp-open.navent.com',
       environment = 'production'
 where id = true;
```

El token cacheado en `rela_tokens` es de sandbox. El cliente lo re-hace solo cuando
la API responde `invalid_token`; **no borrar la fila a mano**.

## Paso 4 — verificar Stock

```sql
select * from public.rela_portal_status();
```

Además, en el panel: Portales → RELA → botón **Stock**. Debe mostrar los créditos
de producción, no los 13 del sandbox.

## Paso 5 — un aviso de prueba

Publicar **una sola** propiedad desde el panel (botón Publicar en RELA) y verificar:

1. `PUT` → 200, `errors: []`, `estado: ONLINE`, `idAviso` devuelto.
2. `GET /avisos/{codigo}` → 200 con título/precio/fotos/contacto correctos.
3. El aviso se ve en **zonaprop.com.ar** (esto es lo que decide, no el estado interno).
4. `audit_log` con `action='rela_publish'`, `status='success'`.

Si `GET` devuelve `PROCESADO` pero el aviso no se ve en el sitio, preguntar a
QuintoAndar antes de seguir (ver el mail enviado al hilo SP-61526).

## Paso 6 — publicar el resto

Solo después del paso 5. En lotes de 5, chequeando créditos entre lote y lote.
Cada publicación deja su fila en `rela_listings` y su traza en `audit_log`.
**No se borra nada**: las filas de sandbox se reemplazan por las de producción
en la misma fila (UNIQUE por `property_id`).

## Rollback

Si hay que volver atrás:

```sql
update public.rela_config
   set base_url = 'https://api-zp-sandbox-open.navent.com',
       environment = 'sandbox'
 where id = true;
```

Y restaurar los secrets anteriores. Los avisos ya creados en producción **no se
borran**: se dan de baja con el botón **Despublicar de RELA** del panel, que llama
al `DELETE` de la API y deja la fila como `UNPUBLISHED`.

## Hallazgo abierto (para el mail)

`GET /v1/inmobiliarias/30662083/avisos/online/resumen` responde **200** con
`total: 0` en sandbox, aunque los 11 `PUT` fueron aceptados y consumieron créditos.
La documentación local lo marcaba como endpoint no confirmado; existe y responde.
Conviene preguntar a QuintoAndar qué significa ese `total: 0` y si `PROCESADO`
equivale a "publicado y visible".
