# Plan: Library Hubs (filas por categoría/dataset) en Studio Collection Settings

Rama: `feat/library-hubs`
Base: `main` @ `adf6a6e`

## Objetivo

Añadir una sección nueva dentro de **Studio Collection Settings** que renderice, en la pantalla
de inicio, **una fila por cada categoría** procedente de los datasets de TrueNAS Scale expuestos
como bibliotecas de Jellyfin.

Cada fila:

- Título de la categoría (p. ej. `Doramas`).
- N tarjetas de contenido (por defecto **12**, configurable).
- Enlace **"Ver todo"** con el chevron `›` — mismo componente que ya usa la app.
- Checkbox **enable/disable** individual por categoría, con el estilo existente.

La carpeta **`Downloads` queda excluida**.

## Hallazgos del análisis del repo

| Área | Ubicación | Nota |
|---|---|---|
| Panel de ajustes | `Resources/slider/modules/settings/studioHubsPage.js:1027` `createStudioHubsPanel()` | Punto de inserción |
| Helpers de UI | `Resources/slider/modules/settings/shared.js` | `createSection`, `createCheckbox`, `createNumberInput`, `bindCheckboxKontrol` |
| Persistencia | `Resources/slider/modules/settings/applySettings.js:~692` → sweep en `:1209-1211` | Cada clave debe mapearse desde `formData` a `updatedConfig`; el sweep la vuelca a `localStorage` |
| Lectura de config | `Resources/slider/modules/config.js:1103-1130` | Defaults desde `localStorage` |
| Registro de fila home | `config.js:10` `DEFAULT_MANAGED_HOME_SECTION_ORDER` + `config.js:252` `enabledMap` | Una sección gestionada nueva debe registrarse aquí |
| Constructor de fila + "Ver todo" | `Resources/slider/modules/recentRows.js:3668` `buildSectionSkeleton({ titleText, badgeType, onSeeAll })` | Componente reutilizable ya existente |
| Enumerar bibliotecas | `recentRows.js:1516` `/Users/{userId}/Views` | Patrón ya usado |
| Href "Ver todo" | `recentRows.js:4777 / 4829` | `#/movies?topParentId=…&collectionType=…` |
| Empaquetado | `JMSFusion.csproj` embebe `Resources/**/*` por glob | Un `.js` nuevo se embebe automáticamente |
| Carga del módulo | `Resources/slider/main.js:1774-1778` | Import dinámico perezoso; hay que añadir el nuevo módulo |

**Importante:** `createCheckbox()` en `shared.js` solo *lee* `localStorage`; no escribe.
La escritura ocurre en `applySettings.js`. Todo checkbox nuevo debe registrarse allí o
se renderizará correctamente y **no guardará**.

## Fases

### Fase 1 — Descubrimiento de categorías (`libraryHubsShared.js`)

- Enumerar categorías en runtime (no hardcodear los 7 nombres) para que sobreviva a
  renombrados o datasets nuevos.
- Filtro de exclusión configurable, con `Downloads` por defecto.
- Cachear el resultado con el patrón de caché existente del módulo.

### Fase 2 — Renderizado de filas (`libraryHubs.js`)

- Una fila por categoría habilitada, respetando el orden configurado.
- Reutilizar `buildSectionSkeleton()` para título + "Ver todo" `›`.
- Reutilizar el creador de tarjetas existente para consistencia visual (hover, badges).
- Registrar como sección gestionada en `DEFAULT_MANAGED_HOME_SECTION_ORDER` y `enabledMap`.

### Fase 3 — UI de ajustes (`studioHubsPage.js`)

- Sub-sección nueva dentro del panel de Studio Collections.
- Checkbox maestro `enableLibraryHubs` + `bindCheckboxKontrol` para atenuar los hijos.
- `createNumberInput('libraryHubsCardCount', …)` con default 12.
- Un `createCheckbox` por categoría descubierta.

### Fase 4 — Persistencia

- Mapear cada clave nueva en `applySettings.js`.
- Añadir defaults en `config.js`.
- Las categorías son dinámicas → persistir el estado por categoría como un único JSON
  (`libraryHubsHidden`) en vez de N claves sueltas, siguiendo el patrón de `studioHubsHidden`.

### Fase 5 — i18n

- Añadir etiquetas a los 9 ficheros de `Resources/slider/language/` (`eng`, `spa`, `tur`,
  `deu`, `fre`, `ita`, `jpn`, `por`, `rus`).

### Fase 6 — Empaquetado y release

Orden correcto (el checksum depende del zip):

1. Bump de versión en `JMSFusion.csproj` → `3.7.0.4`
2. `./update_meta.sh 3.7.0.4` (actualiza `meta.json`)
3. `dotnet publish -c Release`
4. Comprimir el zip de release
5. Calcular `md5` del zip
6. **Entonces** añadir la entrada nueva en `manifest.json`
   (`version`, `changelog`, `targetAbi`, `sourceUrl`, `checksum`, `timestamp`)

## Riesgos

| Riesgo | Sev. | Mitigación |
|---|---|---|
| Checkboxes que no persisten por no registrarlos en `applySettings.js` | ALTO | Verificado el path; se registra explícitamente |
| Estructura real de los datasets en Jellyfin (bibliotecas vs subcarpetas) | ALTO | **Pendiente de confirmar con el usuario** — cambia el endpoint y el href de "Ver todo" |
| N filas nuevas en el home degradan el rendimiento | MEDIO | Render perezoso vía `homeSectionChain` + `IntersectionObserver`, como el resto |
| `checksum` de `manifest.json` calculado antes de generar el zip | MEDIO | Orden de pasos fijado en la Fase 6 |
| Deriva de traducciones en 9 idiomas | BAJO | Fallback al literal en inglés |

## Complejidad estimada

**MEDIA** — ~6 ficheros JS tocados, 1-2 ficheros nuevos, sin cambios en C#
(salvo que se opte por persistencia servidor vía `StudioHubsController`).
