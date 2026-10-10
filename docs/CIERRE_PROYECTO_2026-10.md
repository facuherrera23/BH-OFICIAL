# Cierre de proyecto — Octubre 2026

> Informe final para el dueño de BIENENHAUS: qué se entregó, cómo se usa cada cosa, y la lista corta de pendientes que **solo vos** podés resolver.

---

## 1. Qué se entregó en este ciclo

### 1.1 Encuesta de Visita — la "HOJA DE VISITA" digital 📝

Tu hoja de visita en papel ahora es un link que el asesor le manda al visitante por WhatsApp desde el panel. El visitante responde desde el celular; las opiniones quedan en la propiedad; y vos las ves en tu portal sin saber quién visitó.

- **Autoguardado real**: si el visitante cierra el chat a mitad de la encuesta, nada se pierde.
- **Una encuesta por lead y propiedad**: el link queda registrado y se reusa; podés reiniciarla para una segunda visita.
- **Resultados anónimos en el portal del propietario**: puntuaciones, "¿compraría?" y comentarios — sin datos del visitante, con teléfonos enmascarados.
- **Oferta automática**: al completar una visita (en el CRM o al registrar la salida en la Agenda), el sistema ofrece mandar la encuesta en el momento.
- Guía completa del equipo: [`docs/GUIA_ENCUESTA_VISITA.md`](GUIA_ENCUESTA_VISITA.md)

### 1.2 Chat Redes (Instagram) — funcionando en automático 💬

Diagnóstico: la recepción dependía de un webhook que nunca llegó a configurarse en el dashboard de Zernio, y los mensajes solo entraban con sincronización manual. Se encontraron mensajes reales sin leer con semanas de antigüedad.

Solución implementada (sin necesitar tu intervención):
- **Sincronizador automático cada 2 minutos**: cada mensaje nuevo de Instagram aparece en el panel solo, con su badge de no leído.
- **Respuestas desde el panel**: el equipo responde directo desde Chat Redes (el envío ya funciona con la API key guardada).
- El push instantáneo vía webhook queda como mejora opcional (ver pendientes).

### 1.3 Portal del Propietario — ajustes de pedido tuyo ✨

- Nueva sección **"Opiniones de visitas"** (anónima, ver §1.1).
- Se quitó el botón "Coordiná una por WhatsApp" del estado sin visitas (los dueños no agendan visitas, el asesor sí) y el beneficio "Comisión preferencial" de Exclusividad.

### 1.4 Robustez y calidad

- Suite de pruebas automatizadas: **62+ tests verdes** (incluye las páginas nuevas).
- 2 auditorías de seguridad completas durante el ciclo; todos los hallazgos medios+ resueltos.
- README del repositorio actualizado como documento vivo (arquitectura, flujos, ADRs y changelog al día).

---

## 2. Cómo probás vos lo entregado (5 minutos)

1. **Encuesta**: abrí el panel → Leads → tu lead de prueba con tu propio WhatsApp y una propiedad vinculada → botón **Encuesta** → te llega el link por WhatsApp → respondé algo, cerrá el chat, reabrí: sigue todo ahí → apretá *Enviar* → volvé al lead y mirá el historial + solapa Propiedades → abrí tu portal y mirá la sección *Opiniones de visitas*.
2. **Chat**: dale un DM desde una cuenta personal a **@bienenhaus.prop** → en menos de 2 minutos aparece solo en Chat Redes → respondelo desde ahí.

---

## 3. Pendientes que SOLO vos podés resolver

| # | Pendiente | Por qué importa | Esfuerzo |
|---|---|---|---|
| 1 | **Borrar del dashboard de Supabase las funciones de debug `tmp-gen-jwt` y `cta-test`** | ⚠️ **Prioridad seguridad**: `tmp-gen-jwt` genera magic-links sin autenticación. Son leftovers de pruebas viejas | 5 min en supabase.com/dashboard → Edge Functions → borrar |
| 2 | **Activar Leaked Password Protection** (Supabase → Auth) | Impide contraseñas filtradas en cuentas de tu equipo | 1 toggle en el dashboard |
| 3 | **Chat: registrar el webhook en Zernio** (opcional — todo funciona igual sin esto) | Baja la latencia de 2 min a instantáneo. Pasos: `docs/integrations/CONECTAR_ZERNIO_CHAT.md` §4. Si lo hacés, avisar para rotar el secret que quedó en esa guía | ~5 min |
| 4 | **Mercado Libre**: cerrar las publicaciones huérfanas DA-P0019/21/22/03 en el panel de ML antes de republicar | Evita duplicados en el portal | Desde el panel de ML |
| 5 | **Usd rate**: decidir si mostrar precios ARS en el catálogo del landing | La funcionalidad está construida, falta decisión de negocio | — |

---

## 4. Decisiones de diseño registradas (para el futuro)

- **ADR-016**: acceso público por token URL (portal, confirmar visita, encuesta).
- **ADR-017**: encuesta por (lead + propiedad) con autoguardado continuo y archivado para re-encuesta — 1 link registrado, cero pérdida de datos, historial preservado.
- El chat opera con pull incremental cada 2 min; el webhook push queda construido y defendido para cuando se registre en el dashboard.

Documentación técnica completa: [`README.md`](../README.md) del repositorio.
