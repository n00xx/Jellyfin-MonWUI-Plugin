# Plan: Library Collections v2 — defaults, orden, héroe rotatorio y fix de flechas

Base: `main` @ `281c2d3` (v3.7.0.4) · Rama propuesta: `feat/library-hubs-v2` · Release objetivo: **v3.7.0.5**

## Interpretación de la petición

> **Supuesto de lectura:** entiendo «un bug de diseño … en las **fechas** tanto izquierda como derecha»
> como «**flechas**» (los botones de scroll `‹` `›` de la fila). Las imágenes 17/18 muestran la flecha
> izquierda recortada contra el borde en las filas nuevas frente al botón circular completo en
> «Recently Added Series», y el análisis de CSS predice exactamente ese defecto. Si te referías a
> otra cosa, corrígeme y ajusto solo la Fase 4.

Cuatro cambios sobre la feature `libraryHubs` ya entregada en v3.7.0.4:

1. Activada por defecto, todas las categorías marcadas, orden propio (no alfabético), y
   `libraryHubs` en 2ª posición del Home Section Order.
2. La tarjeta grande (hero) de cada categoría cambia aleatoriamente **cada 5 minutos**.
3. Desactivar el tráiler en hover **solo** en la categoría Collections.
4. Arreglar el recorte de las flechas de scroll, que ocurre solo en estas filas.

## Causa raíz del bug 4 (verificada, no supuesta)

Las secciones de esta feature reciben id `library-hubs--0`, `library-hubs--1`, … (`makeManagedRecentRowsSectionId`,
`recentRows.js:354`). En `Resources/slider/src/personalRecommendations.css` hay **40 reglas** que enumeran
los prefijos hermanos (`[id^=recent-rows--]`, `[id^=continue-rows--]`, `[id^=genre-hubs--]`, …) y
**ninguna incluye `library-hubs--`** (`grep -c 'library-hubs'` → **0**).

Lo que las filas nuevas están perdiendo:

| Regla | Declaración que falta | Síntoma |
|---|---|---|
| Contenedor de sección | `padding-inline:3.2%;position:relative;display:flex` | `.hub-scroll-left{left:-1.4rem}` queda **fuera** del área → flecha recortada (imagen 17) |
| Estilo del botón | gradiente radial + borde + `box-shadow` + `:before` + `:hover` + `:active` | flecha plana sin el botón circular con relieve (imagen 18) |
| Custom properties | `--jms-card-width*`, `--jms-card-radius*` | ancho/radio de tarjeta ligeramente distintos al resto del home |
| `.rr-progress-wrap` | posicionamiento de la barra de progreso | divergencia latente |

Solo `personalRecommendations.css` contiene estas listas (`grep -rl 'recent-rows--' Resources/` →
los otros 3 hits son `.js`). **Sin cambios en C#.**

## Fases

### Fase 1 — Defaults y orden

**1a. Activado por defecto** (`config.js:1106-1107`) — pasar del patrón «solo si está guardado como
`'true'`» al patrón «true salvo que esté guardado como `'false'`», que es el que ya usa el resto del
repo (`raw !== 'false'`, `config.js:652`):

```js
enableLibraryHubs: localStorage.getItem('enableLibraryHubs') !== 'false',
showLibraryHubsHeroCards: localStorage.getItem('showLibraryHubsHeroCards') !== 'false',
```

**No** se toca `buildManagedHomeSectionEnabledMap` (`config.js:254`): el resolver de `:1106` ya
devuelve un booleano, así que `=== true` funciona en cuanto se invierte el default, mientras que
`!== false` convertiría además `undefined` en «activado» para cualquier llamador que pase una
config parcial.

Verificado que el patrón `!== 'false'` respeta un «off» deliberado: el sweep `applyRawConfig`
(`applySettings.js:1238-1256`) escribe los no-objetos con `localStorage.setItem(key, String(value))`,
así que un `false` se persiste como la cadena `'false'` y no se pierde.

⚠️ `showLibraryHubsHeroCards` es sub-opción del toggle maestro: es exactamente la clase de control
que provocó el bug arreglado en `7a30eac` (FormData omite inputs deshabilitados). Se revisa que
`applySettings.js:727` siga leyendo por `boolFromFd` con fallback a config, y se ajusta el fallback
al nuevo default.

**1b. Todas marcadas** — ya es el comportamiento actual: `libraryHubsHidden` default `[]`.
**Sin cambios.**

**1c. `libraryHubs` en 2ª posición** — `DEFAULT_MANAGED_HOME_SECTION_ORDER` ya la tiene 2ª
(`config.js:10-24`), pero un usuario con orden guardado de antes de v3.7.0.4 la recibe **al final**:
las entradas guardadas se insertan primero y los defaults se anexan después (`config.js:152-176`).

Se usa la maquinaria que ya existe para este caso, añadiendo una 4ª llamada junto a las tres de
`config.js:178-180`:

```js
ensureImplicitManagedFollowerOrder(out, explicit, "studioHubs", "libraryHubs");
```

Verificado en el cuerpo del helper (`config.js:233-248`): sale temprano si la clave está en
`explicit`, y las claves anexadas desde los defaults entran con `fromExplicit=false`. Resultado:
se reubica tras `studioHubs` cuando el usuario no la ordenó a mano, y se respeta su elección
cuando sí lo hizo.

**1d. Orden de categorías** — hoy el orden lo dicta `/Users/{id}/Views`, que devuelve las
bibliotecas alfabéticamente; de ahí el orden de la imagen 13. Hay **dos consumidores** que deben
coincidir o divergirán:

- el panel de ajustes → `studioHubsPage.js` `createLibraryHubsSection()`
- las filas del home → `recentRows.js:1682` `resolveLibraryHubsSelection()`

Se añade **un solo** helper `sortLibraryHubCategories()` en `libraryHubsShared.js` (el módulo
compartido) y lo consumen ambos. Orden explícito **confirmado** por el usuario (Collections siempre al final):

```
Películas · Series · Doramas · Anime · Donghuas · Shows · Documentales · Collections
```

Implementado como función de rango, no como lista literal, para que sobreviva a bibliotecas nuevas:

| Categoría | Rango |
|---|---|
| Nombre en la lista explícita | su índice (0-6) |
| Collections (`boxsets` o nombre «collections») | **siempre último** |
| Cualquier otra | después de las explícitas, antes de Collections, en su orden original |

Comparación normalizada sin acentos ni mayúsculas (`Películas` ≡ `Peliculas`) para que no dependa
de cómo esté escrito el nombre del dataset. Todas quedan marcadas.

**Nota:** `recentRows.js:1659-1675` tiene copias duplicadas de `getLibraryHubsExcludedNames` /
`getLibraryHubsHiddenIds` en vez de importar de `libraryHubsShared.js`. No las toco (fuera de
alcance), pero el helper de orden **sí** vive solo en el módulo compartido para no repetir el error.

### Fase 2 — Hero aleatorio con rotación cada 5 min

Dos cambios en el plan de la sección (`recentRows.js:5243-5264`):

1. Pasar `randomHero: true` — hoy no se pasa y el default es `false` (`recentRows.js:3975`), así que
   el hero es siempre el primer item. Sin esto, el intervalo no cambiaría nada.
2. Pasar `heroRotateMs: 5 * 60 * 1000` (constante nombrada `LIBRARY_HUBS_HERO_ROTATE_MS`).

En `fillSectionWithItems` se acepta `heroRotateMs = 0`. Cuando es `> 0` y el hero está activo, se
arma un intervalo que **solo sustituye el `heroHost`** (limpia + `createRowHeroCard(nuevoBest)`),
sin volver a renderizar la fila:

- **Por qué solo el hero:** volver a llamar a `renderResolvedItems(pool)` re-renderiza la fila,
  resetea el scroll y reentra en el renderizador progresivo y en la lógica de `__renderPass`.
  El intercambio del hero deja la fila intacta. Coste: el nuevo hero puede aparecer también como
  tarjeta en la fila (hoy se excluye vía `remaining`), lo cual es normal en este tipo de UI.
- **Sin red:** re-elige sobre el `pool` ya obtenido (`cardCount + 1` items).
- **Limpieza del hero saliente (crítico):** `createRowHeroCard` registra un listener `jms:cleanup`
  (`recentRows.js:3362-3368`) que libera la imagen gestionada y los handlers de preview, y el hero
  monta además un `createTrailerIframe` (`:3346`). Hoy ese listener se dispara una sola vez, en el
  teardown de la sección. Si el tick hiciera `heroHost.innerHTML = ""` (lo que hace
  `renderResolvedItems` en `:4074`), la limpieza del hero saliente **nunca correría**: serían un
  iframe de tráiler y una imagen gestionada filtrados 12 veces/hora × 7 filas. Por tanto el tick
  **despacha `jms:cleanup` sobre el `.dir-row-hero` saliente antes de sustituirlo**.
- **Guardas del tick:** no rota si `!section.isConnected`, si `document.hidden`, si no estamos en la
  ruta home, si el usuario tiene el puntero sobre la sección, o si el tráiler del hero está
  reproduciéndose — `createTrailerIframe` puede arrancar sin hover, así que la guarda de puntero no
  basta. En esos casos espera al siguiente tick.
- **Escalonado:** desfase por índice de sección para que las 7 filas no cambien todas a la vez.
- **Teardown:** `clearInterval` en un listener `jms:cleanup` de la sección, y además
  `cleanupManagedRecentRowsSections` (`recentRows.js:369`) pasa a despachar `jms:cleanup` también
  sobre la `<section>` (hoy solo lo hace sobre `.personal-recs-card`, `.dir-row-hero` y
  `.personal-recs-row`). La guarda `isConnected` del tick actúa como red de seguridad para
  cualquier otra vía de desmontaje. Sin esto son 7-8 intervalos filtrados por cada
  home → detalle → home.

### Fase 3 — Sin tráiler en Collections

Se identifica la categoría por **`CollectionType === "boxsets"`**, no por el nombre «Collections»,
siguiendo la convención del repo de keyear por id/tipo para sobrevivir a renombrados
(`getLibraryHubItemTypes` ya hace switch sobre `boxsets`).

En esa categoría hay **dos** superficies que reproducen tráiler, y se desactivan ambas:

| Superficie | Sitio | Acción |
|---|---|---|
| Hover en tarjeta | `recentRows.js:3027` `attachPreviewByMode` (tras `setTimeout` de 500 ms) | nueva opción `disableHoverPreview` en `createRecommendationCard`, propagada desde `fillSectionWithItems` → `appendCard` (`:4113`) |
| Tráiler del hero | `recentRows.js:3346` `createTrailerIframe` | nueva opción `disableHeroTrailer` en `createRowHeroCard` |

Cubro las dos porque la imagen 16 señala el **hero** de Collections mientras el texto dice «on
hover», y en un BoxSet ninguna de las dos puede funcionar: no tiene medio propio ni
`RemoteTrailers`, que es la razón por la que falla.

**Sin UI nueva ni claves de ajustes:** es un comportamiento fijo pedido, no un toggle. Añadir
controles arrastraría los 9 ficheros `language/*.js` y la trampa de persistencia de
`applySettings.js`.

### Fase 4 — Fix de las flechas (CSS)

En `Resources/slider/src/personalRecommendations.css`, añadir `[id^=library-hubs--]` a **las 40
reglas** que enumeran prefijos hermanos — no solo a las de `hub-scroll-btn`.

Es el mismo coste de edición y estrictamente menos riesgo: si solo arreglo las flechas, el
contenedor sigue sin `padding-inline`, y las custom properties de tarjeta y `.rr-progress-wrap`
siguen divergiendo, lo que reaparecería como «otro bug solo en estas categorías».

El fichero está minificado (3 líneas, 42 KB) y no hay fuente sin minificar, así que la edición es
por reemplazo textual de cada lista de selectores. Criterio de aceptación: **toda regla que enumere
prefijos hermanos `--` debe enumerar también `library-hubs--`**, verificado regla por regla con el
mismo divisor por `}` que se usó para localizar el bug — no por un total, porque una regla puede
repetir el prefijo (`X .foo, X .bar`). Conteo de apoyo (el fichero tiene 3 líneas, así que
`grep -c` no sirve):

```bash
grep -o 'library-hubs' Resources/slider/src/personalRecommendations.css | wc -l   # 0 → >0
```

### Fase 5 — Release v3.7.0.5

Orden obligatorio (el `checksum` del manifest es el **md5 del zip**, así que el manifest va
**después** de comprimir):

1. `<Version>` → `3.7.0.5` en `JMSFusion.csproj`
2. `./update_meta.sh 3.7.0.5`
3. `dotnet publish -c Release -o <dir>`
4. Zip con 3 ficheros planos: `Jellyfin.Plugin.JMSFusion.dll`, `meta.json`, `icon.png`
5. `md5 -q <zip>`
6. **Entonces** anteponer la entrada en `manifest.json`
7. Merge a **`main`** y push, luego `gh release create v3.7.0.5` con el zip

`manifest.json` se sirve desde `main`; una release en rama es invisible para Jellyfin.
`.gitignore` ya cubre `*.zip` (el zip de 3.7.0.4 en la raíz está sin trackear).

## Ficheros a tocar

| Fichero | Fase | Cambio |
|---|---|---|
| `Resources/slider/modules/config.js` | 1a, 1c | defaults `!== 'false'`, enabled map, 4ª llamada al follower order |
| `Resources/slider/modules/libraryHubsShared.js` | 1d | `sortLibraryHubCategories()` (nuevo, compartido) |
| `Resources/slider/modules/settings/studioHubsPage.js` | 1d | consumir el orden en la lista de checkboxes |
| `Resources/slider/modules/settings/applySettings.js` | 1a | fallbacks alineados al nuevo default |
| `Resources/slider/modules/recentRows.js` | 1d, 2, 3 | orden, `randomHero`+rotación, opciones de tráiler, dispatch de cleanup |
| `Resources/slider/src/personalRecommendations.css` | 4 | `[id^=library-hubs--]` en 40 reglas |
| `JMSFusion.csproj`, `meta.json`, `manifest.json` | 5 | release |

**6 ficheros de código + 3 de release.** Sin C#, sin ficheros `language/*.js`, sin UI nueva —
bastante más pequeño que los 17 ficheros de v3.7.0.4.

**Precondición verificada:** el hero de estas filas depende también del gate global
`showHeroCards` = `cfg.showRecentRowsHeroCards !== false` (`recentRows.js:131`, `:3994`), cuyo
default ya es activado (`config.js:1003`). La rotación de la Fase 2 no es código muerto.

## Riesgos

| Riesgo | Sev. | Mitigación |
|---|---|---|
| 7-8 intervalos de 5 min filtrados al remontar el home | **ALTO** | `clearInterval` en `jms:cleanup` + guarda `isConnected` en el tick |
| Iframe de tráiler + imagen gestionada filtrados en cada rotación del hero | **ALTO** | despachar `jms:cleanup` sobre el `.dir-row-hero` saliente antes de sustituirlo |
| Cambiar el default a activado sobrescribe un «off» deliberado del usuario | MEDIO | **verificado**: `applyRawConfig` (`applySettings.js:1249-1251`) persiste `false` como la cadena `'false'`, así que `!== 'false'` respeta el off |
| `showLibraryHubsHeroCards` no persiste al guardar con la sección colapsada | MEDIO | misma clase de bug que `7a30eac`; leer por `boolFromFd` con fallback a config |
| Editar CSS minificado rompe una regla | MEDIO | reemplazo textual acotado + conteo de selectores antes/después + `dotnet build` |
| El orden del panel y el del home divergen | MEDIO | un único helper en `libraryHubsShared.js` consumido por ambos |
| Rotación del hero duplica un item en la fila | BAJO | aceptado; alternativa (re-render completo) resetea el scroll |
| `ensureImplicitManagedFollowerOrder` no reubica si `studioHubs` está deshabilitado | BAJO | «2ª posición» es relativa a Studio Collections, que es lo que muestra la imagen 14 |
| Sin Jellyfin local para prueba funcional | MEDIO | verificación estática (`node --check`, `dotnet build`, conteos de CSS); prueba en vivo la haces tú |

## Complejidad estimada

**MEDIA** — la Fase 2 (ciclo de vida del intervalo) es la de más riesgo; la Fase 4 es mecánica pero
amplia. Sin cambios en C#.

---

## Resultado

Implementado en **v3.7.0.5**. Orden confirmado por el usuario con Collections al final.

### Desviaciones respecto al plan

- **El orden se aplica en un único punto, no en dos.** El plan preveía tocar
  `studioHubsPage.js` para ordenar la lista de checkboxes. Al aplicar
  `sortLibraryHubCategories()` dentro de `fetchLibraryHubCategories()`, el panel de ajustes
  hereda el orden sin cambios, porque ya itera el resultado de esa función. Un fichero menos.
- **`applySettings.js` no necesitó cambios.** `boolFromFd` (`:390-396`) lee el checkbox
  directamente del DOM (`control.checked`), que es el arreglo de `7a30eac`; el fallback a
  config solo entra si el control no está en el formulario, y con el nuevo default resuelve
  a `true` correctamente.
- **Fuga adicional encontrada y arreglada:** `renderResolvedItems` hacía
  `heroHost.innerHTML = ""` sin despachar el `jms:cleanup` del hero saliente, así que ya
  perdía el iframe de tráiler y la imagen gestionada en cada re-render. Ahora ambos caminos
  (re-render y rotación) pasan por `releaseHeroHost()`.
- **El bug del CSS afectaba a 31 reglas, no 40.** El «40» venía de contar con un `split("}")`
  ingenuo, que parte los bloques `@media`. Con un recorrido por profundidad de llaves son
  31 reglas y 58 selectores añadidos.

### Ficheros

| Fichero | Cambio |
|---|---|
| `Resources/slider/modules/config.js` | defaults `!== 'false'`, follower order tras `studioHubs` |
| `Resources/slider/modules/libraryHubsShared.js` | `sortLibraryHubCategories`, `isLibraryHubCollections` |
| `Resources/slider/modules/recentRows.js` | orden, rotación del hero, gating de tráiler, dispatch de cleanup |
| `Resources/slider/src/personalRecommendations.css` | 58 selectores `library-hubs` en 31 reglas |
| `JMSFusion.csproj`, `meta.json`, `manifest.json` | release 3.7.0.5 |

**4 ficheros de código.** Sin C#, sin `language/*.js`, sin UI nueva.

### Verificado

- **Orden**, con test unitario sobre el código real (región pura evaluada, sin stubs):
  el orden alfabético que devuelve Jellyfin sale como
  `Películas > Series > Doramas > Anime > Donghuas > Shows > Documentales > Collections`;
  una biblioteca nueva entra antes de Collections; `Peliculas` sin acento sigue rankeando 1ª;
  el array de entrada no se muta.
- **CSS:** las 31 reglas con `recent-rows` tienen su gemela `library-hubs`, 0 huecos a nivel
  de selector, balance de llaves intacto, transformación idempotente, y quitando las gemelas
  se recupera el fichero original **byte a byte** (prueba de que solo se añadieron selectores).
  Confirmado que la regla con `padding-inline:3.2%;position:relative` — la que causaba la
  flecha recortada — ya cubre `[id^=library-hubs--]`.
- **Sintaxis ESM** de los 6 ficheros JS tocados o dependientes (`node --check` sobre copias
  `.mjs`, porque con extensión `.js` Node los parsea como CommonJS y el chequeo no es válido).
- `dotnet build -c Release` → 0 errores, 0 avisos.
- **El DLL publicado embebe los cambios** (no solo el repo): verificado el flip del default,
  la llamada al follower order, `sortLibraryHubCategories`, `documentales`,
  `LIBRARY_HUBS_HERO_ROTATE_MS`, `disableHeroTrailer` y el selector
  `[id^=library-hubs--] .personal-recs-scroll-wrap .hub-scroll-btn`.
- Zip con exactamente 3 ficheros planos; `checksum` del manifest == md5 del zip;
  versión coherente en csproj / meta.json / manifest.json.

### Pendiente de prueba funcional

No hay Jellyfin local en este entorno. La rotación cada 5 minutos y el render de las flechas
solo están verificados de forma estática y por inspección del CSS resultante; la prueba en
vivo la hace el usuario.

### Seguimiento en v3.7.0.6 — reserva para el hero

El pool era `cardCount + 1` (13) y la fila muestra 12, así que al rotar el hero caía casi
siempre en un título **ya visible en la fila**: el mismo título dos veces en pantalla. Estaba
documentado arriba como coste aceptado, pero se corrigió a petición del usuario:

- `LIBRARY_HUBS_HERO_RESERVE = 8` → se descargan `cardCount + 1 + 8` (21) items. La fila
  sigue mostrando 12; los ~9 restantes son reserva para el hero.
- `rotateHeroCard` prefiere candidatos **que no estén renderizados en la fila**, leyendo los
  `data-item-id` del DOM, y cae al pool completo si la fila resulta contener todo (biblioteca
  con menos títulos que la fila).

Resultado: cada rotación muestra un título nuevo, sin duplicar tarjeta, y sin tocar la fila
ni el scroll. El límite se subió en los dos sitios (fetch de red y `cachedItems`) para que el
camino cacheado no devuelva solo 13.

### Nota sobre el default

El patrón `!== 'false'` activa la feature en instalaciones nuevas y para quien nunca guardó
ajustes, pero **respeta un «off» explícito**: quien guardó ajustes con la sección desactivada
tiene `'false'` en `localStorage` y la seguirá viendo desactivada. Es el mismo criterio que
usa `enableStudioHubs`.
