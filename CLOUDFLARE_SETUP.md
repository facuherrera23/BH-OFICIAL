# 🔧 Guía de Configuración Cloudflare Pages + API Token

## 📋 Resumen del Problema

**Error actual:** `401 Authentication error` en `Deploy to Cloudflare Pages`

**Causa raíz:** El token de API se creó en una cuenta de Cloudflare distinta a la que contiene el Pages project `bienenhaus` y el dominio `bienenhaus.com.ar`.

---

## 🎯 Objetivo

Crear un **API Token en la cuenta correcta** (la que contiene el Pages project `bienenhaus` y el dominio `bienenhaus.com.ar`) y configurar los secrets en GitHub.

---

## 🔍 PASO 1: Identificar la Cuenta Correcta

### 1.1 Acceder a Cloudflare Dashboard
```
https://dash.cloudflare.com/
```

### 1.2 Identificar la cuenta correcta
1. En el selector de cuentas (esquina superior izquierda), revisa todas tus cuentas
2. Busca la cuenta que contiene:
   - **Pages project:** `bienenhaus`
   - **Dominio:** `bienenhaus.com.ar` (en DNS/Zonas)

### 1.3 Obtener el Account ID
1. Selecciona la cuenta correcta en el selector (esquina superior izquierda)
2. El **Account ID** aparece en la barra lateral derecha (32 caracteres hex)
3. **Copiar y guardar** → será `CLOUDFLARE_ACCOUNT_ID` en GitHub

---

## 🔑 PASO 2: Crear API Token en la Cuenta Correcta

### 2.1 Cambiar a la cuenta correcta
1. En el selector de cuentas (esquina superior izquierda) → elige la cuenta que tiene `bienenhaus` Pages project
2. Verifica que ves el Pages project `bienenhaus` en **Workers & Pages** → **Pages**

### 2.2 Crear API Token
1. Ve a: **https://dash.cloudflare.com/profile/api-tokens**
2. Click **"Create Token"**
3. **Template:** "Edit Cloudflare Workers" (o "Custom token")
4. **Permisos requeridos:**
   ```
   Account → Cloudflare Pages → Edit
   Account → Account Settings → Read
   ```
5. **Recursos de cuenta (CRÍTICO):**
   - Incluir → **Todas las cuentas** (o selecciona específicamente la cuenta actual)
   - ⚠️ NO dejes "Select..." sin seleccionar
5. **Recursos de zona:** Dejar como está (o seleccionar zona `bienenhaus.com.ar`)
6. **TTL:** 1 año (o sin expiración)
6. **Crear token** → **Copiar inmediatamente**

---

## 🔐 PASO 3: Actualizar Secrets en GitHub

### 3.1 Ir a GitHub Secrets
```
https://github.com/facuherrera23/BH-OFICIAL/settings/secrets/actions
```

### 3.2 Actualizar/Crear estos 2 secrets:

| Secret | Valor |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | `el_token_que_acabas_de_copiar` |
| `CLOUDFLARE_ACCOUNT_ID` | `el_account_id_de_la_cuenta_correcta` (32 chars hex, NO URL) |

---

## 🔄 DESPUÉS DE ACTUALIZAR SECRETS

### 1. Re-run del workflow
1. Ve a: **Actions** → último run fallido
2. Click **"Re-run all jobs"**

### 2. Monitorear jobs críticos
| Job | Qué verificar |
|-----|---------------|
| **Deploy Supabase Edge Functions** | ✅ `manage-users`, `cloudinary-sign`, +12 más |
| **Deploy to Cloudflare Pages** | ✅ success (sin 401) |

---

## 🔍 VERIFICACIÓN RÁPIDA PRE-DEPLOY

Antes de hacer re-run, verifica en GitHub Secrets:

| Secret | Valor esperado |
|--------|----------------|
| `CLOUDFLARE_API_TOKEN` | Token que empieza con letra/número, longitud ~40+ chars |
| `CLOUDFLARE_ACCOUNT_ID` | 32 caracteres hexadecimales (ej: `a1b2c3d4e5f6...`) |
| `SUPABASE_ACCESS_TOKEN` | `sbp_xxx...` |
| `SUPABASE_PROJECT_REF` | `rnldqiwwzhjnurkguihu` |

---

## 🔍 CÓMO VERIFICAR QUE EL TOKEN ES CORRECTO

### Test rápido via API (opcional)
```bash
curl -X GET "https://api.cloudflare.com/client/v4/accounts" \
  -H "Authorization: Bearer TU_NUEVO_TOKEN" \
  -H "Content-Type: application/json"
```
Debe retornar `success: true` y listar la cuenta correcta.

### Verificar Pages project accesible
```bash
curl -X GET "https://api.cloudflare.com/client/v4/accounts/TU_ACCOUNT_ID/pages/projects" \
  -H "Authorization: Bearer TU_NUEVO_TOKEN"
```
Debe listar el proyecto `bienenhaus`.

---

## 🚀 CHECKLIST FINAL ANTES DE RE-RUN

- [ ] Token creado en **la misma cuenta** que tiene el Pages project `bienenhaus`
- [ ] Token tiene permiso **Account → Cloudflare Pages: Edit**
- [ ] Token tiene permiso **Account → Account Settings: Read**
- [ ] **Recursos de cuenta** → "Todas las cuentas" O la cuenta específica seleccionada
- [ ] `CLOUDFLARE_API_TOKEN` actualizado en GitHub Secrets
- [ ] `CLOUDFLARE_ACCOUNT_ID` = Account ID de la cuenta correcta (32 hex chars)
- [ ] `CLOUDFLARE_ACCOUNT_ID` NO es una URL

---

## 🚀 DESPUÉS DE CONFIGURAR

1. Ve a: **Actions** → último run fallido → **"Re-run all jobs"**
2. Monitorea:
   - ✅ **Deploy Supabase Edge Functions** (debe pasar)
   - ✅ **Deploy to Cloudflare Pages** (debe pasar)
   - ✅ Workflow completo verde 🟢

---

## 🔗 ENLACES ÚTILES

| Acción | Enlace |
|--------|--------|
| Cloudflare Dashboard | https://dash.cloudflare.com/ |
| Crear API Token | https://dash.cloudflare.com/profile/api-tokens |
| GitHub Secrets | https://github.com/facuherrera23/BH-OFICIAL/settings/secrets/actions |
| GitHub Actions | https://github.com/facuherrera23/BH-OFICIAL/actions |
| Supabase Dashboard | https://supabase.com/dashboard/project/rnldqiwwzhjnurkguihu |

---

## 📞 SI SIGUE FALLANDO

Si después de actualizar los secrets sigue fallando:

1. **Verifica logs** del job "Deploy to Cloudflare Pages"
2. Error **401** = token inválido/cuenta incorrecta
3. Error **403** = token sin permisos Pages:Edit
4. Error **404** = Account ID incorrecto

**Contacta:** Revisa que el token se creó en la MISMA cuenta que tiene el Pages project `bienenhaus` y el dominio `bienenhaus.com.ar`.

---

> **Nota:** El deploy de Supabase Edge Functions funciona independientemente y ya está arreglado. Solo Cloudflare Pages necesita este fix.