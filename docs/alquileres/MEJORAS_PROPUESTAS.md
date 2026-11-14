# Administración de Alquileres — Revisión y mejoras propuestas (14/11/2026)

> Documento para presentar al empleador. Primero el resultado de la revisión
> técnica completa, después las mejoras propuestas ordenadas por valor.

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

### A. Liquidaciones al Portal del Propietario ⭐ (la de más valor)
Hoy la rendición mensual llega al propietario por WhatsApp con PDF adjunto
manual. El portal del propietario ya existe (encuestas, documentos): agregar la
sección **"Liquidaciones"** — cada cierre de mes publica la rendición del
propietario en su portal y (opcional) le avisa por email.
- **Valor:** el propietario consulta su rendición cuando quiere, queda
  historial, se reduce el ida y vuelta por WhatsApp.
- **Esfuerzo:** medio (conectar el cierre de mes con el portal existente).

### B. Historial de respaldos al cerrar mes
Al cerrar un mes, guardar una copia inmutable del estado (tabla de snapshots).
El sistema ya tiene backup diario completo de la base; esto agrega la versión
**por cierre de mes**, para recuperar "la administración como estaba cuando
cerramos Octubre" aunque el mes haya seguido siendo editado.
- **Valor:** red de seguridad para datos financieros.
- **Esfuerzo:** chico.

### C. Recordatorio de cierre de mes
Cron mensual (día 2-3): si el mes anterior no fue cerrado, genera una tarea
para Danilo (o aviso en el digest semanal que ya llega por email).
- **Valor:** evita que la administración se atrase sin que nadie se dé cuenta.
- **Esfuerzo:** chico (patrón de crons ya existente).

### D. Vencimientos de contrato visibles en el CRM
El módulo ya calcula "próximo vencimiento de contrato". Llevar esos vencimientos
al CRM: alerta en el Dashboard y/o tarea automática al agente a 90/60/30 días
de vencer un contrato (renovación o aviso de desalojo).
- **Valor:** nada de contratos que se vencen sin aviso (hoy solo se ve dentro
  del módulo).
- **Esfuerzo:** medio.

### E. KPIs de alquileres en el Dashboard del panel
Card en el Dashboard con: cobrado / pendiente / honorarios / neto a
propietarios del mes en curso (leído del estado, sin doble carga de datos).
- **Valor:** el empleador ve la salud de la administración sin entrar al
  módulo.
- **Esfuerzo:** chico-medio.

### F. Badge real en el menú lateral
El ítem "Alquileres" del menú muestra un "0" hardcodeado. Convertirlo en el
contador de **contratos por vencer (60 días)**, leído del estado.
- **Valor:** consistencia visual con el resto del menú (los otros badges son
  reales).
- **Esfuerzo:** chico.

### G. Comprobantes en la nube (Supabase Storage)
Los contratos/facturas adjuntos hoy viven en el navegador (IndexedDB): si se
limpia el navegador o se cambia de máquina, se pierden y hay que re-importar
el archivo original. Moverlos a Storage privado (carpeta por usuario, RLS).
- **Valor:** los comprobantes sobreviven al navegador y se ven desde
  cualquier dispositivo.
- **Esfuerzo:** medio-alto (es el cambio más profundo de la lista; el módulo
  ya funciona sin él, solo hay que tenerlo presente si un día se pierden).

### H. Uso desde dos dispositivos a la vez (aviso de conflicto)
Si la administración se abre en dos máquinas, la última que guarda pisa a la
otra en silencio. Agregar detección: si el estado en la nube es más nuevo que
el que tengo en pantalla, avisar antes de pisar.
- **Valor:** protege el único flujo que hoy puede perder datos sin aviso.
- **Esfuerzo:** chico.

---

## 4. Recomendación de orden

1. **Decidir lo de la sección 2** (personal vs compartido) — condiciona todo.
2. **H** (aviso de conflicto) + **B** (snapshot al cerrar mes): protección de
   datos, esfuerzo chico.
3. **A** (liquidaciones al portal): la de más valor de negocio.
4. **C, D, E, F**: visibilidad y recordatorios (cualquier orden).
5. **G** (adjuntos a la nube): cuando se quiera usar el módulo desde más de un
   dispositivo.
