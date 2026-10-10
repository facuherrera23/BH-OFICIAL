# Guía Completa: Conectar Chat Redes Sociales (Zernio) - Paso a Paso

> **Objetivo:** Tener un inbox unificado en el panel administrativo para leer y responder mensajes directos de Instagram y Facebook Messenger desde un solo lugar.
> **Costo:** $0/mes (plan free de Zernio incluye 2 cuentas: Instagram + Facebook Messenger)

---

## 📋 Tabla de Contenidos

1. [Requisitos Previos](#requisitos-previos)
2. [Crear Cuenta en Zernio](#crear-cuenta-en-zernio)
3. [Conectar Instagram y Facebook Messenger](#conectar-instagram-y-facebook-messenger)
4. [Configurar Webhook en Zernio](#configurar-webhook-en-zernio)
5. [Obtener API Key de Zernio](#obtener-api-key-de-zernio)
6. [Configurar API Key en Panel Administrativo](#configurar-api-key-en-panel-administrativo)
7. [Probar Conexión](#probar-conexión)
8. [Verificar Funcionamiento](#verificar-funcionamiento)
9. [Troubleshooting](#troubleshooting)

---

## 1. Requisitos Previos

### ✅ Lo que YA está listo en el proyecto
- [x] Base de datos: tablas `zernio_accounts`, `zernio_conversations`, `zernio_messages`, `zernio_webhook_events`, `zernio_config` creadas con RLS y Realtime
- [x] Migración `20260827_zernio_chat_completo` aplicada en producción (columna `platform`, UNIQUE no parcial en `zernio_messages`, FKs, RLS, `api_key` restringida a `super_admin`)
- [x] Edge Function `zernio-webhook` deployada y verificada E2E (firma HMAC 401/200, dedup, persistencia de `platform`, update de conversación, auditoría)
- [x] Edge Function `zernio-proxy` deployada (proxy autenticado para enviar respuestas; verify JWT = ON)
- [x] Panel administrativo: pestaña "Chat Redes" en categoría "Red & Difusión"
- [x] Configuración: campo "Zernio API Key" + botón "Probar Conexión" en pestaña Configuración
- [x] Webhook secret ya configurado en DB (`zernio_config` → key `webhook_secret`)

### 🔑 Lo que NECESITAS tú
- [ ] Acceso a Instagram Business (cuenta profesional)
- [ ] Acceso a Facebook Page (página de la inmobiliaria)
- [ ] Acceso a Facebook Business Manager (opcional pero recomendado)
- [ ] Acceso a Supabase Dashboard (para verificar webhook)

---

## 2. Crear Cuenta en Zernio

### Paso 2.1: Registrarse
1. Ir a **[zernio.com/signup](https://zernio.com/signup)**
2. Registrarse con email corporativo (ej: `admin@bienenhaus.com.ar`)
3. **No requiere tarjeta de crédito** (plan free incluye 2 cuentas)
4. Confirmar email

### Paso 2.2: Verificar plan
- En Dashboard Zernio → Settings → Billing
- Verificar: **Free Plan** (2 cuentas gratis: Instagram + Facebook)
- WhatsApp sería la 3ra cuenta → $6/mes (opcional, NO necesario para $0/mes)

---

## 3. Conectar Instagram y Facebook Messenger

### ⚠️ IMPORTANTE: Requisitos previos
- Instagram: **Cuenta Profesional/Business** (no personal)
- Facebook: Página de la inmobiliaria (no perfil personal)
- Ambas vinculadas al mismo Facebook Business Manager (recomendado)

### Paso 3.1: Conectar Instagram
1. En Zernio Dashboard → **Connections** → **Add Connection**
2. Seleccionar **Instagram**
3. Click **"Connect Instagram"**
4. Se abre popup de Facebook/Instagram:
   - Iniciar sesión con usuario que administra la cuenta Business
   - Seleccionar la **Instagram Business Account** correcta
   - Permitir permisos: `instagram_basic`, `instagram_manage_messages`, `pages_messaging`
4. Confirmar → Debe aparecer "Connected" en verde

### Paso 3.2: Conectar Facebook Messenger
1. En Zernio Dashboard → **Connections** → **Add Connection**
2. Seleccionar **Facebook Messenger**
3. Click **"Connect Facebook"**
4. Se abre popup de Facebook:
   - Iniciar sesión con usuario admin de la Page
   - Seleccionar la **Facebook Page** de la inmobiliaria
   - Permitir permisos: `pages_messaging`, `pages_read_engagement`, `pages_show_list`
5. Confirmar → Debe aparecer "Connected" en verde

### ✅ Verificación
En Zernio Dashboard → **Connections** debe mostrar:
| Platform | Status | Username/Page |
|----------|--------|---------------|
| Instagram | 🟢 Connected | @bienenhauspropiedades |
| Facebook | 🟢 Connected | Bienenhaus Propiedades |

---

## 4. Configurar Webhook en Zernio

### Paso 4.1: Crear Webhook
1. En Zernio Dashboard → **Settings** → **Webhooks**
2. Click **"Create Webhook"** o **"Add Webhook"**
3. Completar formulario:

| Campo | Valor |
|-------|-------|
| **Webhook URL** | `https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/zernio-webhook` |
| **Secret** | `73106e2e51b7e3a3be1d3b1aa9c1fad7c71dacd76403673ffa58414995382fde` |
| **Events to subscribe** | Seleccionar TODOS estos: |

### Eventos a suscribir (checkboxes):
| Categoría | Eventos |
|-----------|---------|
| **Conversations** | `conversation.started` |
| **Messages** | `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed` |
| **Accounts** | `account.connected`, `account.disconnected` |
| **Testing** | `webhook.test` (opcional) |

> ⚠️ **NO suscribir** `comment.received`, `reaction.received` (fase 2)

### Paso 4.2: Probar Webhook desde Zernio
1. En la lista de webhooks → Click en el webhook creado
2. Click **"Test Webhook"** o **"Send Test Event"**
2. Debe responder **200 OK** con `{ "ok": true }`

### Paso 4.3: Verificar en Supabase
1. En Supabase Dashboard → **Edge Functions** → `zernio-webhook` → **Logs**
2. Debe aparecer log: `"event":"webhook.test","detail":"ping de prueba de Zernio"`

---

## 5. Obtener API Key de Zernio

### Paso 5.1: Generar API Key
1. En Zernio Dashboard → **Settings** → **API Keys**
2. Click **"Create API Key"** o **"Generate New Key"**
3. Nombre: `Bienenhaus Admin Panel`
3. Permisos: **Full Access** (Read + Write)
4. Click **"Generate"**
5. **¡COPIAR LA KEY INMEDIATAMENTE!** (solo se muestra una vez)
   - Formato típico: `sk_live_abc123...` o `zk_live_xyz789...`

> ⚠️ **IMPORTANTE:** Guárdala en un lugar seguro (password manager). No se puede recuperar después.

---

## 6. Configurar API Key en Panel Administrativo

### Paso 6.1: Acceder al Panel
1. Ir a: `https://bienenhaus.com.ar/admin` (o `http://localhost:8788/admin` en local)
2. Login con usuario **super_admin**

### Paso 6.2: Ir a Configuración
1. En sidebar izquierdo → Click **"Configuración"** (ícono ⚙️)
2. Scroll hasta sección **"Sistema e Integraciones"**

### Paso 6.3: Ingresar API Key
1. Buscar campo: **"Zernio API Key (Chat Redes Sociales)"**
2. Click en el campo (tipo password) → **Pegar la API Key** copiada de Zernio
3. (Opcional) Click ícono 👁️ para mostrar/ocultar
4. Click **"Guardar Cambios"** (botón verde con ícono 💾)

### ✅ Verificación
- Debe aparecer toast: **"Configuración guardada correctamente"**
- El campo se mantiene oculto (tipo password) por seguridad

---

## 7. Probar Conexión

### Paso 7.1: Botón "Probar Conexión"
1. En la misma sección "Sistema e Integraciones"
2. Click botón **"Probar Conexión Zernio"** (ícono 🔌)
2. Esperar 2-3 segundos...

### ✅ Resultado esperado
| Resultado | Qué significa |
|-----------|---------------|
| `✓ Conectado · 2 cuenta(s) sincronizada(s)` | **ÉXITO** - API Key válida, cuentas detectadas |
| `✗ Error en respuesta` | API Key inválida o expirada |
| `✗ Error de red` | Problema de conectividad / CORS |

### Si falla:
1. Verificar que la API Key sea correcta (copiar/pegar sin espacios extra)
2. Verificar que las cuentas en Zernio estén "Connected" (verdes)
3. Verificar que el webhook en Zernio apunte a la URL correcta

---

## 8. Verificar Funcionamiento

### Paso 8.1: Acceder al Chat
1. En sidebar → Categoría **"Red & Difusión"** → Click **"Chat Redes"** (ícono 💬)
2. Debe cargar la vista de inbox con:
   - **Sidebar izquierdo**: Lista de conversaciones (filtros: Todas/IG/FB, búsqueda)
   - **Panel derecho**: Área de mensajes + composer

### Paso 8.2: Probar mensaje entrante
1. Desde tu celular → Enviar DM a la cuenta de Instagram/Facebook de la inmobiliaria
2. En el panel → Debe aparecer **en < 5 segundos**:
   - Nueva conversación en sidebar (badge rojo con "1")
   - Mensaje en el hilo de chat
   - Badge rojo en nav item "Chat Redes"

### Paso 8.3: Probar respuesta saliente
1. Click en la conversación → Se abre hilo de chat
2. Escribir respuesta en composer (abajo)
3. **Enter** para enviar (Shift+Enter = salto de línea)
3. Debe aparecer:
   - Tu mensaje en burbuja azul (derecha) con tick ✓
   - Tick doble ✓✓ cuando se entrega/lee
   - Badge "no leídos" decrementa

### Paso 8.4: Verificar ticks de estado
| Tick | Significado |
|------|-------------|
| ✓ | Enviado (aceptado por Zernio) |
| ✓✓ | Entregado / Leído (confirmado por Zernio) |
| ⚠️ | Falló (ver error en burbuja) |

---

## 9. Troubleshooting

### 🔴 "Probar Conexión" falla
| Error | Causa | Solución |
|-------|-------|----------|
| `✗ Error en respuesta` | API Key inválida | Regenerar API Key en Zernio → pegar de nuevo |
| `✗ Error de red / CORS` | Webhook no deployado | Verificar deploy en Supabase Dashboard |
| `✗ 0 cuenta(s) sincronizada(s)` | Cuentas no conectadas en Zernio | Reconectar IG/FB en Zernio Dashboard |

### 🔴 Mensajes no llegan al panel
| Causa | Verificación |
|-------|--------------|
| Webhook no recibe | Zernio Dashboard → Webhook → Logs → ver si llegan requests |
| Webhook URL incorrecta | Zernio → Webhooks → URL debe ser `https://rnldqiwwzhjnurkguihu.supabase.co/functions/v1/zernio-webhook` |
| Secret mismatch | Zernio webhook secret = `73106e2e51b7e3a3be1d3b1aa9c1fad7c71dacd76403673ffa58414995382fde` |
| Verify JWT ON | Supabase Dashboard → Edge Functions → zernio-webhook → Settings → Verify JWT = **OFF** |

### 🔴 No puedo responder (botón enviar no funciona)
| Causa | Verificación |
|-------|--------------|
| API Key no guardada | Configuración → Zernio API Key → debe tener valor |
| API Key inválida | "Probar Conexión" → debe dar ✓ |
| Usuario no es super_admin | Solo super_admin puede usar el chat |
| Proxy caído | `zernio-proxy` en Supabase Edge Functions → Logs |

### 🔴 Webhook 503 / BOOT_ERROR
| Causa | Solución |
|-------|----------|
| Supabase Edge Functions caído | Verificar [status.supabase.com](https://status.supabase.com/) |
| Código con error de sintaxis | Dashboard → Edge Functions → zernio-webhook → Logs → ver error |
| Variable PLATFORMS duplicada | Código debe tener UNA sola declaración `const PLATFORMS = new Set([...])` |

---

## 📋 Checklist Final de Verificación

Antes de dar por terminado, verifica **TODOS** los checkboxes:

### Infraestructura
- [ ] Migración DB aplicada (`20260827_zernio_chat_completo`)
- [ ] `zernio-webhook` deployado en Supabase (Verify JWT = OFF)
- [ ] `zernio-proxy` deployado via CLI
- [ ] `zernio_config` tiene `webhook_secret` y `api_key`

### Zernio
- [ ] Cuenta creada en zernio.com
- [ ] Instagram Business conectado (verde)
- [ ] Facebook Messenger conectado (verde)
- [ ] Webhook creado con URL correcta + secret correcto
- [ ] Eventos suscritos: conversation.started, message.received, message.sent, message.delivered, message.read, message.failed, account.connected, account.disconnected
- [ ] Test webhook desde Zernio → 200 OK
- [ ] API Key generada y copiada

### Panel Admin
- [ ] API Key pegada en Configuración → "Guardar Cambios"
- [ ] "Probar Conexión" → ✓ Conectado · 2 cuenta(s)
- [ ] Pestaña "Chat Redes" visible en "Red & Difusión"
- [ ] Mensaje de prueba recibido en < 5 seg
- [ ] Respuesta enviada → ticks ✓ → ✓✓

---

## 📞 Contacto y Soporte

Si algo no funciona tras seguir todos los pasos:

1. **Revisar logs:** Supabase Dashboard → Edge Functions → `zernio-webhook` → Logs
2. **Verificar status Supabase:** https://status.supabase.com/
3. **Verificar status Zernio:** https://status.zernio.com/ (si existe)
4. **Logs del proxy:** Supabase → Edge Functions → `zernio-proxy` → Logs

---

## 📝 Notas Técnicas (para desarrolladores)

### Arquitectura
```
[Instagram/Facebook] → [Zernio] → (webhook HMAC) → [Supabase Edge Function: zernio-webhook]
                                                           ↓
                                              [Supabase DB: zernio_* tables] → (Realtime) → [Panel Admin]
                                                           ↑
                    [Panel Admin: respuesta] → [zernio-proxy] → [Zernio API] → [Instagram/Facebook]
```

### Secretos
| Secreto | Dónde está | Para qué |
|---------|------------|----------|
| `ZERNIO_WEBHOOK_SECRET` | Supabase Secrets + `zernio_config` (fallback) | Verificar firma HMAC webhook |
| `ZERNIO_API_KEY` | `zernio_config` (key=`api_key`) | Autenticar requests a Zernio API |

### Tablas principales
| Tabla | Propósito |
|-------|-----------|
| `zernio_accounts` | Espejo de cuentas conectadas en Zernio |
| `zernio_conversations` | Hilos de chat (inbox) |
| `zernio_messages` | Mensajes individuales (in/out) |
| `zernio_webhook_events` | Dedup de eventos (PK = eventId) |
| `zernio_config` | Secrets: `webhook_secret`, `api_key` |

---

## 🎉 ¡Listo!

Si completaste **TODOS** los pasos de esta guía, el **Chat Redes Sociales está 100% operativo**.

> **Costo mensual: $0** (Instagram + Facebook Messenger en plan free de Zernio)
> **Tiempo de activación:** ~20 minutos
> **Mantenimiento:** Cero (webhooks automáticos, Realtime nativo)

---

*Documento generado automáticamente - Última actualización: 2026-08-27*
*Proyecto: BH-OFICIAL | Bienenhaus Propiedades*