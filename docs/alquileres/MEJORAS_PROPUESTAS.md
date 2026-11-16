# Administración de Alquileres — Revisión y mejoras propuestas (14/11/2026)

> Documento para presentar al empleador. Primero el resultado de la revisión
> técnica completa, después las mejoras propuestas ordenadas por valor.
>
> **Estado de implementación:** Bloques 1 (H + B + F), 2 (C + E + D),
> 3 (A — liquidaciones al portal) y 4 (G — comprobantes a Storage)
> ✅ IMPLEMENTADOS y verificados en producción el 15/11/2026. El mapeo
> propietario→CRM quedó hecho (habilita las tareas automáticas de
> vencimientos como próxima etapa). No queda nada del plan original
> en el módulo — próximas etapas posibles: tareas 90/60/30 de vencimientos
> y la decisión pendiente del set compartido (sección 4).

---

## 1. Revisión técnica — resultado

El módulo funciona correctamente end-to-end. Verificado en producción con los
datos reales de la administración (10 propiedades, Octubre 2026):

| Área | Estado |
|---|---|
| Carga inicial del estado (RLS `user_id = auth.uid()`) | ✅ |
| Auto-guardado en la nube (debounce 1.2s, cola, skip si nada cambió) | ✅ |
| Reintentos ante falla de red (backoff + reintento permanente) | ✅ |
| Embebido en el panel (iframe, sidebar visible, altura automática) | ✅ |
| Navegación de meses (retroceso restaura desde historial) | ✅ |
| PDFs (órdenes/liquidaciones/rendiciones), Excel, respaldo JSON | ✅ |
| WhatsApp (PDF + mensaje pre-armado), OCR de contratos/facturas | ✅ |
| Identidad visual del panel (dark, teal, fuentes) | ✅ |
| Suite de tests: 34 guards del módulo + 587 del proyecto | ✅ |

**Corregido durante la revisión (crítico, ya en producción):** si la carga
inicial fallaba (corte de internet, sesión vencida), el módulo arrancaba vacío
y el auto-guardado **pisaba la única copia de los datos con un estado vacío**.
Hoy: pantalla de reintento + guardado bloqueado hasta cargar bien. La pérdida
de datos ya no es posible en ese escenario.

---

## 2. Decisión previa que necesita el empleador

**¿El módulo es personal o de la inmobiliaria?** Hoy cada usuario del panel
tiene su PROPIA administración (una fila por usuario, aislada por RLS): Danilo
ve las 10 propiedades; otro usuario vería el módulo vacío.

- Si **solo Danilo** administra alquileres → dejar como está.
- Si **más de una persona** debe ver/cargar la misma administración → hay que
  convertirlo en un set de datos compartido (una fila de la inmobiliaria con
  permisos por rol). **Todas las propuestas de abajo asumen que esto ya se
  decidió**; conviene resolverlo antes de implementar A, B o D.

---

## 3. Mejoras propuestas (ordenadas por valor)

### A. Liquidaciones al Portal del Propietario ⭐ ✅ IMPLEMENTADO (15/11/2026)
Hoy la rendición mensual llega al propietario por WhatsApp con PDF adjunto
manual. Ahora: el operador vincula cada propietario de la administración con
su ficha del CRM (una vez, botón "Propietarios") y al cerrar cada mes la
liquidación se publica automáticamente en el portal de ese propietario, con
email de aviso e historial por mes (re-publicar un mes reemplaza la versión
anterior).
- **Valor:** el propietario consulta su rendición cuando quiere, queda
  historial, se reduce el ida y vuelta por WhatsApp.
- **Estado:** en producción. Pendiente del día a día: hacer el mapeo inicial
  de propietarios (una vez) y publicar el primer mes real.

### B. Historial de respaldos al cerrar mes
Al cerrar un mes, guardar una copia inmutable del estado (tabla de snapshots).
El sistema ya tiene backup diario completo de la base; esto agrega la versión
**por cierre de mes**, para recuperar "la administración como estaba cuando
cerramos Octubre" aunque el mes haya seguido siendo editado.
- **Valor:** red de seguridad para datos financieros.
- **Esfuerzo:** chico.

### C. Recordatorio de cierre de mes ✅ IMPLEMENTADO (15/11/2026)
Cron mensual (días 2 y 3, 12:00 ART): si el mes anterior no fue cerrado en el
módulo, envía un email al usuario del módulo (Brevo). Un solo email por mes
(aunque el cron corra dos días).
- **Valor:** evita que la administración se atrase sin que nadie se dé cuenta.
- **Estado:** en producción — verificado con el envío real de Octubre 2026.

### D. Vencimientos de contrato visibles en el CRM ✅ IMPLEMENTADO (15/11/2026)
El módulo ya calcula "próximo vencimiento de contrato". Los vencimientos
(vencidos + próximos 3 meses) se listan ahora en la tarjeta del Dashboard y el
badge del menú los cuenta. Las tareas automáticas a 90/60/30 días quedan para
la próxima etapa: requieren vincular cada propiedad del módulo al propietario
del CRM (hoy son nombres en texto libre).
- **Valor:** nada de contratos que se vencen sin aviso.
- **Estado:** en producción (tarjeta + badge). Tareas automáticas: pendiente
  del mapeo de propietarios.

### E. KPIs de alquileres en el Dashboard del panel ✅ IMPLEMENTADO (15/11/2026)
Card en el Dashboard con: órdenes del mes, honorarios, neto a propietarios,
cobradas/liquidadas y el período — calculados por el módulo con su propia
lógica de negocio y leídos por una RPC segura.
- **Valor:** el empleador ve la salud de la administración sin entrar al
  módulo.
- **Estado:** en producción. Los KPIs aparecen después de la primera
  sincronización del módulo.

### F. Badge real en el menú lateral
El ítem "Alquileres" del menú muestra un "0" hardcodeado. Convertirlo en el
contador de **contratos por vencer (60 días)**, leído del estado.
- **Valor:** consistencia visual con el resto del menú (los otros badges son
  reales).
- **Esfuerzo:** chico.

### G. Comprobantes en la nube (Supabase Storage) ✅ IMPLEMENTADO (15/11/2026)
Los contratos/facturas adjuntos hoy viven en el navegador (IndexedDB): si se
limpia el navegador o se cambia de máquina, se pierden y hay que re-importar
el archivo original. Ahora: IndexedDB queda como caché local y hay una copia
durable en Storage privado (carpeta por usuario, RLS). Al abrir el módulo se
convergen ambas copias automáticamente — los 33 archivos históricos se suben
solo en la primera apertura, y de ahí en adelante cada comprobante que se
agrega o se quita se refleja en la nube.
- **Valor:** los comprobantes sobreviven al navegador y se ven desde
  cualquier dispositivo.
- **Estado:** en producción. Nota para el dueño: la primera vez que Danilo
  (u otro operador) abra el módulo después de este deploy, la convergencia
  subirá todos los archivos que tenía en ese navegador — puede tardar unos
  segundos en la primera apertura.

### H. Uso desde dos dispositivos a la vez (aviso de conflicto)
Si la administración se abre en dos máquinas, la última que guarda pisa a la
otra en silencio. Agregar detección: si el estado en la nube es más nuevo que
el que tengo en pantalla, avisar antes de pisar.
- **Valor:** protege el único flujo que hoy puede perder datos sin aviso.
- **Esfuerzo:** chico.

---

## 4. Recomendación de orden

1. ~~**Decidir lo de la sección 2** (personal vs compartido)~~ — **URGENTE**:
   el recordatorio de Octubre detectó que hoy EXISTEN dos filas activas
   (hfacundo45 + danilo.arbo, ambas con las 10 propiedades). Son dos copias
   que pueden divergir: definir quién es el operador único o pasar a datos
   compartidos antes de implementar A.
2. ~~H (aviso de conflicto) + B (snapshot al cerrar mes)~~ ✅ + ~~F (badge)~~ ✅
3. ~~A (liquidaciones al portal)~~ — pendiente de luz verde.
4. ~~C, D, E, F~~ ✅
5. **G** (adjuntos a la nube): cuando se quiera usar el módulo desde más de un
   dispositivo.
