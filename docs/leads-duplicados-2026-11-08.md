# Leads duplicados históricos — informe read-only (2026-11-08)

**Origen del problema:** la consolidación de leads de ML estuvo rota del 13/10 al 8/11/2026 — la exclusión de etapas usaba nombres de etapa que no existen en el enum `lead_stage`, el filtro explotaba con error 22P02 en runtime y la respuesta llegaba vacía sin que nadie lo viera. Resultado: cada contacto de la misma persona creó un lead nuevo en vez de unirse al existente.

El bug está **corregido** (commit `757f64f`) y tiene guard de tests (`tests/stage-enum-contract.spec.js`). Este informe es **solo lectura**: los duplicados quedaron en la base y la fusión es decisión del dueño.

**Cómo se identificaron:** misma persona = mismo email (normalizado) O mismos últimos 10 dígitos de teléfono. Un mismo lead puede aparecer en 2 grupos (por teléfono y por email) — así es como la consolidación los pegaría.

**Totales:** 32 filas de leads no únicas · 25 grupos · **6 grupos con lead todavía activo (stage `contactado`)** — esos son los que conviene mirar primero en el CRM.

---

## Email: `lic_waltercaiola@yahoo.com.ar` — 3 leads ⚠️ **ACTIVO**

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 26/10/26 | Walter Oscar Caiola | 7a628228… | contactado | — |
| 26/10/26 | Walter Oscar Caiola | 19c0ef86… | cerrado_perdido | sí |
| 26/10/26 | Walter Oscar Caiola | 7ad3180c… | cerrado_perdido | sí |

## Teléfono: `1132043756` — 3 leads ⚠️ **ACTIVO**

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 26/10/26 | Walter Oscar Caiola | 7a628228… | contactado | — |
| 26/10/26 | Walter Oscar Caiola | 19c0ef86… | cerrado_perdido | sí |
| 26/10/26 | Walter Oscar Caiola | 7ad3180c… | cerrado_perdido | sí |

## Teléfono: `1136581144` — 3 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 20/09/26 | A. R Chame | 95cae4bd… | cerrado_perdido | sí |
| 08/10/26 | Adolfo Rafael Chame | 87a758af… | cerrado_perdido | — |
| 08/10/26 | Adolfo Rafael Chame | 0f9e0ec2… | cerrado_perdido | — |

## Email: `carina_518@hotmail.com` — 2 leads ⚠️ **ACTIVO**

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 21/10/26 | Maria del Carmen Retamar | 078074ff… | contactado | — |
| 26/10/26 | Maria del Carmen Retamar | 97d54051… | cerrado_perdido | sí |

## Email: `horaciogermancordoba@gmail.com` — 2 leads ⚠️ **ACTIVO**

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 20/10/26 | Horacio German Cordoba | 94d0765d… | contactado | sí |
| 26/10/26 | Horacio German Cordoba | 370cac60… | cerrado_perdido | sí |

## Email: `molinapatricia382@gmail.com` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 17/09/26 | Patricia Inés | 12a8add0… | cerrado_perdido | — |
| 08/10/26 | Patricia Ines Molina | 413dca12… | cerrado_perdido | — |

## Email: `raquel_cba25@hotmail.com` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 05/10/26 | Raquel Jorgelina Villca | 29f4eae6… | cerrado_perdido | — |
| 08/10/26 | Raquel Jorgelina Villca | 568b4a02… | cerrado_perdido | sí |

## Email: `rchame@yahoo.com` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 08/10/26 | Adolfo Rafael Chame | 87a758af… | cerrado_perdido | — |
| 08/10/26 | Adolfo Rafael Chame | 0f9e0ec2… | cerrado_perdido | — |

## Email: `segunqn@gmail.com` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 17/09/26 | Sergio Calvo | 719f70b8… | cerrado_perdido | — |
| 08/10/26 | Sergio Omar Calvo | 9deccb43… | cerrado_perdido | — |

## Email: `stefania.vilella25@gmail.com` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 20/09/26 | Stefania Soledad Vilella | 5e72c996… | cerrado_perdido | — |
| 08/10/26 | Stefania Soledad Vilella | cd6fddf4… | cerrado_perdido | — |

## Email: `yani_al2@hotmail.com` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 17/09/26 | Yanina Rosana Voto | b98ff29d… | cerrado_perdido | — |
| 08/10/26 | Yanina Rosana Voto | cb70367d… | cerrado_perdido | — |

## Email: `zaratekaren93@gmail.com` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 17/09/26 | Karen Zarate | aedcf78f… | cerrado_perdido | — |
| 08/10/26 | Karen Amira Aguirre Zarate | 6d343a0e… | cerrado_perdido | — |

## Teléfono: `1176292409` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 14/09/26 | Mayra Burgos | 94ec4ee2… | cerrado_perdido | — |
| 08/10/26 | Mayra Romina Burgos | d1ef6a14… | cerrado_perdido | — |

## Teléfono: `2477597999` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 17/09/26 | Yanina Rosana Voto | b98ff29d… | cerrado_perdido | — |
| 08/10/26 | Yanina Rosana Voto | cb70367d… | cerrado_perdido | — |

## Teléfono: `2665274067` — 2 leads ⚠️ **ACTIVO**

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 20/10/26 | Horacio German Cordoba | 94d0765d… | contactado | sí |
| 26/10/26 | Horacio German Cordoba | 370cac60… | cerrado_perdido | sí |

## Teléfono: `2995289099` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 17/09/26 | Sergio Calvo | 719f70b8… | cerrado_perdido | — |
| 08/10/26 | Sergio Omar Calvo | 9deccb43… | cerrado_perdido | — |

## Teléfono: `3434574056` — 2 leads ⚠️ **ACTIVO**

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 21/10/26 | Maria del Carmen Retamar | 078074ff… | contactado | — |
| 26/10/26 | Maria del Carmen Retamar | 97d54051… | cerrado_perdido | sí |

## Teléfono: `3465652493` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 29/09/26 | Roberto Martin Raviola | d9a0cf9c… | cerrado_perdido | — |
| 08/10/26 | Roberto Martin Raviola | c76dc64b… | cerrado_perdido | — |

## Teléfono: `3513098802` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 05/10/26 | Raquel Jorgelina Villca | 29f4eae6… | cerrado_perdido | — |
| 08/10/26 | Raquel Jorgelina Villca | 568b4a02… | cerrado_perdido | sí |

## Teléfono: `3516644125` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 20/09/26 | Stefania Soledad Vilella | 5e72c996… | cerrado_perdido | — |
| 08/10/26 | Stefania Soledad Vilella | cd6fddf4… | cerrado_perdido | — |

## Teléfono: `3516955441` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 25/09/26 | Tomi | 524519ad… | cerrado_perdido | — |
| 08/10/26 | Tomas Agustin Peralta | 157710cd… | cerrado_perdido | — |

## Teléfono: `3517683857` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 17/09/26 | Patricia Inés | 12a8add0… | cerrado_perdido | — |
| 08/10/26 | Patricia Ines Molina | 413dca12… | cerrado_perdido | — |

## Teléfono: `3541210309` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 17/09/26 | Karen Zarate | aedcf78f… | cerrado_perdido | — |
| 08/10/26 | Karen Amira Aguirre Zarate | 6d343a0e… | cerrado_perdido | — |

## Teléfono: `3541553655` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 29/09/26 | Jorge Mario Altamirano | 7b35fabd… | cerrado_perdido | — |
| 08/10/26 | Jorge Mario Altamirano | 57c0192f… | cerrado_perdido | — |

## Teléfono: `3541683369` — 2 leads

| Fecha | Nombre | Lead (id) | Stage | ¿Con propiedad? |
|---|---|---|---|---|
| 10/09/26 | Karen Alejandra Peral | 58f923aa… | cerrado_perdido | — |
| 08/10/26 | Karen Alejandra Peral | 5a75224f… | cerrado_perdido | — |

---

## Qué hacer con esto (decisión del dueño)

- **Los 6 grupos con lead ACTIVO** (⚠️): tener la persona dos veces en el CRM confunde el embudo (2 leads contactados = 2 seguimientos paralelos). Sugerencia: en el CRM, revisar notas y propiedades de ambas filas, decidir cuál es la "buena" y archivar la otra con motivo. No hay fusión automática — es ficha por ficha.
- **Los otros 19 grupos** son leads ya terminados (`cerrado_perdido`): el impacto es solo de datos/KPIs (la persona cuenta dos veces). Baja prioridad.
- El código nuevo fusiona solo leads con identidad de ML/RELA — los duplicados que entren de AHORA en adelante quedarán en UNA fila sola.

_2026-11-08 — generado automáticamente en la auditoría de rela-callbacks._
