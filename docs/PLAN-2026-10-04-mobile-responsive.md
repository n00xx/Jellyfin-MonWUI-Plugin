# Plan — Auditoría responsiva de moui (celulares y tablets, iOS/Android)

**Fecha:** 2026-10-04
**Estado:** **Fases 0, 1, 2, 4 (slider por defecto), 5 y 6 (parcial) ejecutadas y verificadas** contra el
servidor real (2026-10-05). Fase 3 no se hizo (§6). El release v3.7.1.36 está pendiente de CONFIRM: ver §6.
**Servidor medido:** `http://192.168.8.207:30013` — Jellyfin **12.1.0** (`Neexy`), plugin 3.7.1.35.
**Alcance:** `Resources/slider/` — 24 hojas CSS (~800 KB, sin contar FontAwesome), ~130 módulos JS (~5 MB)
y el CSS que esos módulos inyectan en tiempo de ejecución (21 módulos).

> Cada cifra sale de un barrido mecánico (scripts en el scratchpad de la sesión: `audit.py`,
> `cssparse.py`, `q2.py`, `q3.py`, `compat.py`). Distingo **CONFIRMADO** (leí el código y la
> falla se sigue de él) de **CANDIDATO** (el patrón está, pero sólo un render dirá si rompe).
> Contar `vh` o `:hover` no prueba nada por sí solo; por eso la Fase 0 es una línea base renderizada.

---

## 0. Resumen ejecutivo

moui **no está roto en móvil de forma general**. Ya tiene 199 reglas `max-width:768px`, 163 a
`480px`, `clamp()` (170), `aspect-ratio` (107), `scroll-snap`, `overscroll-behavior` y las
cabeceras de tráiler ya filtran los dispositivos táctiles. Los problemas son **puntuales y de cuatro clases**:

| # | Problema | Estado | Gravedad | Afecta |
|---|----------|--------|----------|--------|
| 1 | **El botón Atrás de Android no cierra ningún overlay**, salvo Watchlist (8+ overlays) | CONFIRMADO | **Alta** (el usuario queda atrapado) | App Android, Chrome Android |
| 2 | `pauseModul.js:3809` llama `requestIdleCallback` sin guarda → `ReferenceError` en WebKit | CONFIRMADO | **Alta** en iOS | iOS (todas las apps) |
| 3 | Lookbehind regex en `artistModal.js:1576` → **todo el reproductor de música** no parsea | CONFIRMADO | Media (sólo iOS < 16.4) | iOS 16.0–16.3 |
| 4 | **Hueco de breakpoints**: celular horizontal (844×390) y tablets (810–1366) caen en el layout de escritorio | CANDIDATO fuerte | Alta | Teléfono girado, iPad, tablets Android |
| 5 | **8 detectores de "móvil" distintos**, varios congelados al cargar (no reaccionan al girar) | CONFIRMADO | Media | Rotación, iPad, laptops táctiles |
| 6 | **Safe-area**: hasta ~110 reglas `position:fixed` pegadas a un borde sin `env(safe-area-inset-*)` | CANDIDATO | Media | iPhone con notch/Dynamic Island |
| 7 | **`vh` en alturas de overlays** (~75 reglas) → el pie queda bajo la barra del navegador | CANDIDATO | Media-baja | Safari/Chrome móvil (no las apps) |
| 8 | `backdrop-filter` sin prefijo `-webkit-` (77 vs 17) → paneles "glass" sin desenfoque | CONFIRMADO | Baja | iOS < 18 |
| 9 | Controles que sólo aparecen con `:hover` (handle de progreso 12 px, `opacity:0`) | CONFIRMADO | Baja | Táctil |

**Restricción que multiplica el trabajo:** hay **11 variantes de tema** (3 sliders, 4 reproductores,
4 notificaciones). Un arreglo de CSS hecho en una hoja no llega a las otras diez. La Fase 4 propone
una hoja `src/mobile.css` común en lugar de editar las 11.

---

## 1. Hallazgos medidos

### 1.1 El viewport del servidor (fija qué importa y qué no)

```
GET /web/index.html
<meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,
      maximum-scale=1,user-scalable=no,viewport-fit=cover">
```

- `viewport-fit=cover` → en iPhone con notch los `env(safe-area-inset-*)` **valen de verdad**
  (≈47–59 px arriba y 34 px abajo en vertical; ≈47–59 px a los lados en horizontal). Todo lo fijo
  a un borde sin `env()` puede quedar bajo la isla o la barra de inicio. → §1.6
- `maximum-scale=1` → iOS **no** hace auto-zoom al enfocar un `<input>` de menos de 16 px.
  **No hace falta tocar tamaños de fuente de inputs.**

### 1.2 Atrás de Android — ningún overlay salvo Watchlist entra en el historial  — CONFIRMADO

```
grep history.(pushState|replaceState|back)( → sólo modules/watchlist.js:7466-7506
```

| Overlay | `pushState` | `popstate` | `Escape` |
|---------|:-:|:-:|:-:|
| watchlist | ✅ | ✅ | ✅ |
| genreExplorer / sectionExplorer (y los 5 "Ver todo") | — | — | ✅ |
| detailsModal | — | — | ✅ |
| settingsPage | — | — | ✅ |
| studioHubs | — | — | **—** |
| notifications | — | — | **—** |
| castModule, buscarPage, seerr, modales del reproductor | — | — | parcial |

Además, por debajo de 760 px estos overlays ocupan `100%×100%` con el fondo a `padding:0`,
así que **no queda fondo donde tocar para cerrar** (memoria `jellyfin-plugin-overlay-dismissal`).
En un teléfono la única salida es la ✕. Si además queda bajo la isla (§1.6) o bajo el AppBar de
12.1 (z 1100, memoria `jellyfin-12-1-mui-header`), el usuario queda atrapado.

**Lo que NO está medido:** que el Atrás de la app Jellyfin Android haga `history.back()` en el
WebView. El arreglo de Watchlist (v3.7.1.22) **nunca se probó en un dispositivo real**.

### 1.3 `requestIdleCallback` sin guarda en la pantalla de pausa  — CONFIRMADO

```js
// modules/pauseModul.js:3809 — dentro de setupPauseScreen()
requestIdleCallback?.(() => { … }, { timeout: 3000 });
```

`?.` **no protege un identificador global no declarado**: lanza `ReferenceError`. WebKit no expone
`requestIdleCallback` (al menos hasta Safari 18; la Fase 0 lo mide en el simulador actual). La
excepción sale **antes** de `window.__jmsPauseOverlay.destroy = destroy` y del `return` de limpieza.
`main.js:3518` la atrapa, deja `pauseBooted = false` y `cleanupPauseOverlay = null`, pero los listeners
(`keydown`, `popstate`, `hashchange`, `visibilitychange`, el `MutationObserver` y el loop) **ya
quedaron enganchados** y nadie los aborta. Cada reintento puede apilar otro juego.

Es el **único** caso sin guarda. Los otros 5 usos sin `window.` sí la tienen (`typeof … === "function"`):
`collectionCacheDb.js:33`, `directorRows.js:1509/2154`, `qualityBadges.js:19` y `player/main.js:1409`
(`"requestIdleCallback" in window`). Lo mismo vale para los 17 usos de `window.requestIdleCallback` y
`window.cancelIdleCallback`: los revisé uno por uno y todos tienen `typeof`, `||` con respaldo `setTimeout`
o `typeof ric === "function"`.

### 1.4 Lookbehind regex → el reproductor de música entero no carga en iOS < 16.4  — CONFIRMADO

```
modules/player/ui/artistModal.js:1576   /(?<!\b(?:Mr|Mrs|…))\.(\s+)(?=\p{Lu})/gu
```

Una regex literal se valida al **parsear** el módulo; WebKit < 16.4 no soporta lookbehind → SyntaxError
del módulo. `player/main.js:12`, `playerUI.js:13` y `jellyfinPlaylists.js:7` lo importan **estáticamente**,
así que cae el reproductor completo.

**Barrido de sintaxis completo:** compilé cada módulo dos veces con esbuild, una con `--target=esnext` y otra
con `--target=safari15`, y comparé las salidas. Si difieren, el archivo tiene sintaxis que Safari 15 no
soporta. Sólo difieren 2 archivos: `artistModal.js` (el positivo conocido, lo que valida el método) y
`libraryHubsShared.js` (`/\p{Diacritic}/gu`). Este segundo es esbuild siendo conservador:
`\p{Diacritic}` es una propiedad binaria de ES2018 que Safari soporta desde 11.1, aunque lo confirmo en el simulador.
**No hay más sintaxis incompatible.**

### 1.5 Ocho detectores de "móvil", ninguno igual  — CONFIRMADO

| Sitio | Criterio | Problema |
|-------|----------|----------|
| `genreExplorer.js:9`, `personalRecommendations.js:43`, `directorRows.js:52`, `recentRows.js:49` | `maxTouchPoints>0 \|\| innerWidth<=820` | Se calcula **una vez al cargar**: girar el teléfono no lo cambia. Una laptop táctil = "móvil". |
| `positionOverrides.js:125` | `max-width:768px` **y** táctil | Un iPad (≥810 px) o un teléfono horizontal (≥844 px) **nunca** es "móvil". |
| `utils.js:230` `isMobileLikeDevice` | `hover:none + coarse` \|\| UA \|\| iPadOS | Razonable |
| `utils.js:502` | UA \|\| táctil con pantalla < 1024 | Usa `screen`, no el viewport |
| `hoverTrailerModal.js:123`, `navigation.js:16`, `buttons.js:168` | `ontouchstart` \|\| `maxTouchPoints` | Laptop táctil = táctil |
| `slideCreator.js:19` `LOW_POWER_PEAK` | coarse + UA/lado ≤1280 | Congelado al cargar |
| `studioHubsUtils.js:106`, `studioTrailerPopover.js:66` | `hover:none and pointer:coarse` | Correcto |
| `utils.js:634`, `notifications.js:120` | `hover:hover and pointer:fine` | Correcto |

Por eso, en el mismo dispositivo, un módulo actúa como "móvil" y otro como "escritorio".

### 1.6 Breakpoints: el celular horizontal y las tablets quedan fuera  — CANDIDATO fuerte

Hay **24 anchos distintos** de `max-width` (400, 460, 480, 520, 560, 600, 640, 680, 700, 720, 728, 750,
760, 767, 768, 780, 820, 920, 960, 980, 1024, 1080, 1200, 1260). Lo que falta:

- **Celular horizontal** (iPhone 844×390, Pixel 915×412): el ancho supera 768, así que se aplica
  el layout de escritorio, pero con ~390 px de alto. Sólo **3 de 24 hojas** tienen reglas de altura
  u orientación (`pauseModul`, `pauseModul2`, `subtitleCustomizer`). Los 3 sliders, los 4 reproductores,
  detailsModal, castmodal, settings, notificaciones y explorers **no tienen ninguna**.
- **Tablets** (iPad 810/820/834 vertical, 1024–1366 horizontal; Android 800–1280): sólo 17 reglas en
  `max-width:1024px`. Casi todo lo que está entre 821 y 1366 recibe el layout de escritorio, aunque
  el usuario esté tocando la pantalla.

### 1.7 Safe-area  — CANDIDATO

`env(safe-area-inset-*)` aparece **15 veces** en todo el front-end. Hay **hasta ~110 reglas** `position:fixed`
pegadas a un borde que no lo usan. La cifra está inflada: el barrido también cuenta los modales centrados
con `top:50%`. Las de más riesgo son las que tienen controles en el borde:

- `#modern-music-player` (`bottom:5px` / `bottom:-100px`, 4 temas): la barra queda bajo el indicador de inicio
- `.jf-toast-container`, `#jfToastContainer`, `.notifications-container` (`bottom:18–20px`)
- `.playback-notification` (3 sliders, `bottom:10px`)
- Cabeceras con ✕ de los overlays `inset:0`: `.genre-explorer-overlay`, `#jms-details-modal-root`,
  `.jms-cast-modal`, `.jf-profile-overlay`, `.jf-notif-modal`, `#jms-pause-overlay`, watchlist, buscarPage, seerr
- En horizontal, todo lo que tiene `left:0`/`left:24px` (insignias de pausa `.rating-genre-overlay`)

### 1.8 `vh` en alturas de overlays  — CANDIDATO

Hay 123 usos en CSS y 30 en JS, contra **18** `dvh`/`svh`. Sólo importan los que fijan una
altura de overlay (unos 75; lista completa en `q3.txt` §C). Por ejemplo:
`.jms-cast-modal__shell calc(100vh - 34px)`, `#artist-modal height:100vh` (×4 temas),
`.jf-notif-modal height:94vh`, `#settings-modal … min(94vh,980px)`, `.monwui-castmodal-container 80vh`,
`.jf-profile-shell min(92vh,900px)`.
En Safari/Chrome móvil `100vh` = el viewport **sin** barras, así que el pie del modal (botones Guardar/Cerrar)
queda bajo la barra del navegador. **Dentro de las apps Jellyfin el efecto es mucho menor** (no hay barra de URL).
Ya existe el patrón correcto en el repo: `@supports not (height:100dvh)` en `pauseModul.css`.

### 1.9 Cosmético  — CONFIRMADO

- `backdrop-filter` sin `-webkit-`: 77 vs 17 → en iOS < 18 los paneles translúcidos pierden el
  desenfoque y el texto puede perder contraste (peakslider 19, pauseModul 10, normalslider/slider 8 c/u).
- `.player-progress-handle{opacity:0;width:12px;height:12px}` (4 temas) sólo aparece con `:hover`:
  en táctil el punto de arrastre es invisible y mide 12 px (mínimo recomendado: 44 pt iOS / 48 dp Android).
- `.jmsdm-minicard-overlay`, `.*-see-all-tip`, `.favorite-heart:after`: sólo con hover, sin alternativa táctil.

### 1.10 Lo que ya está bien (no tocar)

- Inputs < 16 px: no hay zoom, por `maximum-scale=1` (§1.1).
- Pantalla completa: `cinemaPreRoll.js` ya usa `webkitRequestFullscreen`/`webkitEnterFullscreen`. La
  tecla F de `pauseModul` sólo sirve con teclado.
- `playsinline`: los 5 módulos que crean `<video>` (`detailsModal`, `hoverTrailerModal`, `studioHubs`,
  `studioTrailerPopover`, `utils`) lo ponen, así que en iPhone el autoplay no salta a pantalla completa nativa.
- El modal de tráiler en hover ya se filtra en táctil. Error 153 de YouTube en iOS ya resuelto con `yt-embed.html`.
- `fontawesome/all.min.css` fuera de alcance.

### 1.11 Hallazgo colateral (no es móvil)

`main.js:2944` mapea la variante `auroraslider` a `/slider/src/auroraSlider.css`, **que no existe** en el repo.

---

## 2. Riesgos y lo que todavía NO está medido

- **Nada de §1.6–1.9 se ha visto renderizado.** La Fase 0 decide cuáles son reales y lo demás se descarta.
- **Atrás de Android en la app real**: sin emulador Android en esta Mac. Hace falta el dispositivo del usuario.
- **WKWebView de la app Jellyfin iOS** ≠ Safari: los safe-area y las barras se comportan distinto. El
  simulador iOS (hay iPhone 18 Pro / iPad Pro 13 instalados) da WebKit y safe-area reales, pero **no la app**.
- **Hojas CSS minificadas**: editar una arriesga el truncado silencioso (memoria `jellyfin-plugin-css-silent-truncation`:
  un `(` sin cerrar se comió 14 KB). Cada edición pasa el barrido de paréntesis y un conteo de `cssRules`.
- **Orden de carga** de una hoja `mobile.css` común: los CSS de variante se cargan de forma asíncrona
  (`syncCSS`, `main.js:2941-3020`) y el reproductor carga los suyos más tarde. Hay que garantizar que la
  hoja común quede **al final** o subir la especificidad. Se mide antes de decidir.
- **Regresión en escritorio**: todo cambio va detrás de media queries de ancho/alto/puntero. El escritorio
  con ratón (`hover:hover and pointer:fine`) no debe cambiar ni un píxel; la Fase 0 lo fotografía.
- **Laptops táctiles**: hoy varios módulos las tratan como "móvil". Unificar la detección cambia ese
  comportamiento. Lo dejo como decisión explícita (§4).

---

## 3. Plan de trabajo

### Fase 0 — Línea base renderizada (sin tocar código)

1. Arnés Playwright (ya está en caché: v1.60 con **WebKit** y Chromium) en `tools/mobile-audit.mjs`, contra el servidor en vivo:
   - Perfiles: iPhone SE (375×667), iPhone 15 Pro (393×852) **vertical y horizontal**, Pixel 7 (412×915)
     vertical y horizontal, iPad mini (744×1133), iPad Air (820×1180) vertical y horizontal, iPad Pro 13 horizontal
     (1366×1024), Galaxy Tab S (800×1280), y escritorio 1440 como control. WebKit para los iOS y Chromium para los Android.
   - Pantallas: home (slider + filas), detalle, cada overlay (Watchlist, Buscar, Explorers, Studio Hubs,
     Notificaciones, Ajustes, Cast, Perfiles), pantalla de pausa y reproductor de música.
   - Chequeos automáticos: desbordamiento horizontal (`scrollWidth > innerWidth`), elementos interactivos
     < 44×44, controles fuera del viewport y ✕ visible y clicable (`elementFromPoint`).
2. En el simulador iOS (Safari, iPhone 18 Pro + iPad Pro 13): capturas a mano de esas mismas pantallas, para ver el
   safe-area real. Ahí, y **no** en Playwright WebKit (que puede traer funciones experimentales activas),
   también mido `typeof requestIdleCallback` y `/\p{Diacritic}/u`.
3. Resultado: tabla hallazgo → real/descartado, con capturas en `docs/images/mobile-baseline/`.
   **Gate:** las Fases 4–6 sólo atacan lo que la Fase 0 confirme.

### Fase 1 — Salir de cualquier overlay (Alta)

1. Antes de extender nada, **probar el arreglo de Watchlist en el Android del usuario**. Si el Atrás de
   la app no hace `history.back()`, el enfoque cambia (por ejemplo, escuchar `keydown` `GoBack`/`BrowserBack`).
2. Módulo `modules/overlayHistory.js` basado en el patrón de Watchlist: `pushState` a la misma URL,
   copiando `history.state` y sin tocar `idx`; `release()` con `replaceState` para "cerrar y navegar".
   **Con pila:** Explorer → Detalle → Tráiler = 3 entradas, y Atrás cierra sólo la de arriba.
3. Migrar: genreExplorer/sectionExplorer (los 5 grids), detailsModal, settingsPage, studioHubs,
   notifications, castModule, buscarPage, seerr, profileChooser y los modales del reproductor. Watchlist pasa al helper.
4. Añadir `Escape` a studioHubs y notifications, que no lo tienen.
5. Tests `.mjs` con DOM y `history` falsos: abrir, apilar, Atrás, cerrar y navegar.

### Fase 2 — Defectos de compatibilidad iOS (Alta/Media, ~1 h)

1. `pauseModul.js:3809` → `if (typeof window.requestIdleCallback === "function") … else setTimeout(…)`.
   Test con el global borrado: `setupPauseScreen()` devuelve su limpieza y registra `destroy`.
2. `artistModal.js:1576` → reescribir sin lookbehind (capturar el token previo y comprobarlo en el callback)
   **si** la versión mínima de iOS es < 16.4 (§4). Test: mismas divisiones de frases en `eng`/`spa`/`tur`.
3. Barrido mecánico en `tests/`: ningún global de idle sin guarda y ningún lookbehind (regresión).

### Fase 3 — Una sola detección de dispositivo (Media)

1. `modules/deviceCaps.js`: `isCoarse` (`(hover:none) and (pointer:coarse)`), `isPhoneLayout`, `isTabletLayout`,
   `isLandscapePhone` (`(max-height:500px) and (orientation:landscape)`), **vivos** con listeners de `matchMedia`
   y un evento `jms:devicecaps` cuando cambian (rotación).
2. Mover ahí los 8 sitios de §1.5. Los `IS_MOBILE` congelados pasan a leerse en el momento de usarse.
3. `positionOverrides.isMobileDevice` deja de exigir ≤768 y usa `isCoarse && (isPhoneLayout || isLandscapePhone)`.
4. **Sin cambios en escritorio**: con `pointer:fine` todo da `false`, igual que hoy (test con matchMedia falso).

### Fase 4 — Celular horizontal y tablets (Alta si la Fase 0 lo confirma)

1. **Decisión de arquitectura** (§4): una hoja común `src/mobile.css` cargada al final, o editar las 11 variantes.
   Recomiendo `mobile.css`: `Resources/**` ya se embebe por glob (`.csproj:57`), es **una** línea más de
   `syncCSS` en `main.js`, y el arreglo llega a todas las variantes. Antes hay que medir el orden de carga.
2. Tres rangos canónicos, sólo para los rangos nuevos (las 24 queries existentes se quedan como están):
   - `(max-height:500px) and (orientation:landscape)`: celular horizontal (slider más bajo, overlays a pantalla completa,
     reproductor compacto)
   - `(min-width:768px) and (max-width:1366px) and (pointer:coarse)`: tablet táctil (rejillas y overlays de tablet,
     sin dependencia de hover)
   - lo de teléfono vertical ya existe
3. Componentes, en el orden que marque la Fase 0: slider (3 variantes), detailsModal, overlays explorer,
   reproductor de música, castmodal, settings, notificaciones y pantalla de pausa.

### Fase 5 — Safe-area y `dvh` (Media)

1. Sólo para los elementos fijos con controles en el borde de §1.7: padding/offset con
   `max(<valor actual>, env(safe-area-inset-*))`, para que en escritorio el valor no cambie.
2. `vh` → `dvh` **sólo** en las alturas de overlay de §1.8, con el respaldo `@supports not (height:100dvh)` que ya existe.
3. Para el CSS inyectado por JS (watchlist, buscarPage, seerr, radioModal, parentalPin), el mismo cambio en sus plantillas.

### Fase 6 — Cosmético (Baja)

1. Añadir `-webkit-backdrop-filter` junto a cada `backdrop-filter` que no lo tenga (si se soporta iOS < 18).
2. En `(hover:none)`: handle de progreso visible y con un área táctil de 44 px; `.see-all-tip` y la mini-card
   también visibles o accesibles por toque.
3. Los objetivos < 44 px que haya listado la Fase 0.

### Fase 7 — Verificación y release

1. Repetir el arnés de la Fase 0 y comparar capturas antes y después: en escritorio 1440 **cero diferencias**.
2. Barrido de paréntesis de todas las hojas `src/*.css` + conteo `cssRules` > 0 de cada selector nuevo
   (test permanente en `tests/cssParenBalance.test.mjs`).
3. `node` con todos los tests `.mjs` y `dotnet build` **dos veces** (memoria `jellyfin-plugin-build-meta-stale`),
   con `grep -a` de los assets dentro del DLL.
4. Release según `jellyfin-plugin-release-process` (rama `fix/v3.7.1.36`, zip, md5, manifest).
5. Prueba en los dispositivos del usuario: app Jellyfin iOS (iPhone + iPad) y app Android (Atrás).

---

## 4. Decisiones abiertas (criterio del usuario)

1. **Cuenta de prueba con contenido real.** La cuenta de la sesión anterior está vencida y sólo ve el inicio vacío, así que no sirve para la línea base.
2. **Prioridad:** ¿apps Jellyfin (iOS/Android) o navegadores móviles? Decide cuánto pesa la Fase 5 (`dvh`).
3. **iOS mínimo soportado.** < 16.4 obliga a la Fase 2.2; < 18 obliga a la Fase 6.1.
4. **¿Hay un Android para probar el Atrás?** Sin él, la Fase 1 sale sin verificar en la app real.
5. **Laptops táctiles:** ¿deben verse como escritorio (lo que propongo) o como móvil (lo que hacen hoy algunos módulos)?
6. **`mobile.css` común vs editar las 11 variantes** (recomiendo la hoja común).

---

## 5. Esfuerzo

| Fase | Complejidad | Estimado |
|------|-------------|----------|
| 0 — Línea base | Media | 3–4 h |
| 1 — Atrás / overlays | **Alta** (8+ módulos, pila) | 5–7 h |
| 2 — Compat iOS | Baja | 1 h |
| 3 — deviceCaps | Media | 2–3 h |
| 4 — Horizontal / tablet | Alta (depende de la Fase 0) | 4–8 h |
| 5 — Safe-area / dvh | Media | 2–3 h |
| 6 — Cosmético | Baja | 1–2 h |
| 7 — Verificación + release | Media | 2–3 h |
| **Total** | **Alta** | **~20–30 h** |

La Fase 2 es independiente y barata; se puede adelantar sola en un release corto si se quiere el arreglo de iOS ya.

---

## 6. Registro de ejecución (2026-10-05)

Rama `fix/v3.7.1.36`. La verificación usa `tools/mobile-audit.mjs` con 13 perfiles (WebKit
para iOS, Chromium para Android, y Chromium con el notch real inyectado por CDP) contra
`192.168.8.207:30013`. Con `--local` sirve este checkout por encima del servidor, así que cada
arreglo se midió con datos reales **antes** de instalar nada.

### Lo que la línea base confirmó y lo que descartó

| Hallazgo del plan | Resultado medido |
|---|---|
| §1.2 Atrás de Android | **Confirmado** en los 13 perfiles: sólo Watchlist cerraba |
| §1.3 `requestIdleCallback` | **Confirmado**: iOS 27 Safari (simulador) no lo tiene |
| §1.6 Celular horizontal | **Confirmado**: capas del slider encimadas (sinopsis, ratings, título, botones) |
| §1.7 Safe-area | **Confirmado** en las ✕ de explorers, detalle, Watchlist, perfiles y notificaciones |
| Desbordamiento horizontal | **Descartado**: ningún perfil móvil ni tablet desborda |
| §1.6 Tablets | **Descartado**: iPad y Galaxy Tab sin capas encimadas |
| §1.8 `vh` → `dvh` | No se tocó: ningún overlay medido corta contenido |
| No previsto | **401 en `/Items/{id}/LocalTrailers`** y en la sincronización de música (§6.2) |
| No previsto | El botón de perfil se caía a una 2.ª línea y el header crecía de 48 a 90 px (iPhone SE) |

### 6.1 Commits

| Commit | Qué |
|---|---|
| `96bdbb7` / `9f7a3b2` | Fase 2: `requestIdleCallback` con guarda en pauseModul; la lookbehind de artistModal fuera (prueba de 3000 casos idénticos, lineal) |
| `ed9d787` | 12.1: `fetchLocalTrailers` y la sincronización de música mandaban sólo `X-Emby-Token` (401 → 200) |
| `019f462` / `cf3080f` | Fase 1: `overlayHistory.js` con pila, integrado en 9 overlays; Watchlist migrado |
| `5836db5` (+ siguiente) | Fases 4–6: `src/mobile.css` (notch, slider horizontal, botón de perfil, ✕ de 40 px en táctil) y el arnés |

### 6.2 Medido después del arreglo (`--local`)

- **Atrás:** `closes` en todos los overlays y perfiles (antes sólo Watchlist).
- **Notch (iPhone 15 Pro vertical, insets reales):** ninguna ✕ bajo la isla; ✕ de notificaciones
  25 → 40 px, de explorers 30 → 40 px.
- **Slider horizontal:** 0 capas encimadas en iPhone 15 Pro y Pixel 7 (antes 4 y 3); botones 20 → 40 px.
- **Botón de perfil:** header de 90 → 48 px en iPhone SE; avatar dentro de la barra.
- **401:** los 38 de `LocalTrailers` por pasada → 0. Los errores restantes son de otros plugins
  (`jf-avatars` 404, `JellyfinHelper` 403).
- Vertical y escritorio: sin cambios en las capas del slider; las reglas nuevas se reducen a las
  originales cuando `env()` vale 0 (lo exige `tests/mobileCss.test.mjs`).

### 6.3 Lo que NO se hizo, y por qué

- **Fase 3 (detección de dispositivo única):** la línea base no mostró ningún defecto atribuible a
  los 8 detectores distintos, y unificarlos toca 8 módulos con riesgo real de regresión. Queda
  como deuda técnica documentada, no como bug.
- **Variantes `slider` y `peakslider` en horizontal:** sin medir. La variante se guarda en el
  servidor por usuario y `storagePreload` pisa cualquier override local; medirlas exige cambiar
  la configuración de la cuenta de prueba.
- **Header de Jellyfin bajo el notch:** el `MuiAppBar` de 12.1 no aplica `safe-area-inset-top`.
  Es de Jellyfin, sólo se nota en modo PWA/app (en Safari el inset superior es 0) y parchearlo
  desde moui desplazaría todo el layout de Jellyfin.
- **`-webkit-backdrop-filter`:** iOS 27 soporta el nombre sin prefijo; sólo afecta a iOS < 18.
- **Overlays sin Atrás todavía:** settingsPage, castModule, paneles de seerr, modales del reproductor.

### 6.4 Pendiente de CONFIRM

1. **Release v3.7.1.36** (version bump, build ×2, zip, md5, manifest a `main`, `gh release`). Llega
   a todos los servidores que tienen el plugin.
2. **Prueba en dispositivo real:** Atrás en la app Android, y la app iOS (WKWebView).
