# Plan — Compatibilidad de JMSFusion con Jellyfin 12.1.0

**Fecha:** 2026-09-20
**Estado:** **Fases 1–3 ejecutadas y verificadas** (2026-09-20). Fase 4 (instalar + reiniciar)
sigue pendiente de CONFIRM explícito — ver §6.
**Servidor medido:** `http://192.168.8.207:30013` — Jellyfin **12.1.0**, nombre `Neexy` (la
dirección salió de los docs de muelle; muelle se usó como puntero al servidor, no como arnés
de pruebas).
**Plugin actual:** JMSFusion 3.7.1.25, `targetAbi 10.11.0.0`, `net9.0`, paquetes Jellyfin 10.11.0.

> Todo lo que sigue está medido contra el servidor real o contra el compilador. Cada hallazgo
> lleva el comando que lo produjo. Nada está supuesto.

---

## 0. Resumen ejecutivo

Jellyfin pasó de `10.11` a `12.x` (no es "10.12": los paquetes en NuGet son `12.0.0` y `12.1.0`).
Eso rompe el plugin en **tres** sitios, y sólo tres:

| # | Rompe | Gravedad | Tamaño real |
|---|-------|----------|-------------|
| 1 | **ABI / empaquetado** — el servidor no cargará un plugin con `targetAbi 10.11.0.0` | Bloqueante | meta.json + manifest.json |
| 2 | **Compilación** — TFM `net9.0` → `net10.0`, paquetes → `12.1.0`, y 1 llamada de API | Bloqueante | **1 línea de C#** |
| 3 | **Auth heredada** — `X-Emby-Token` y `?api_key=` ya no autentican | Alto, acotado | 2 sitios C# + 18 sitios JS (cifra final, §6) |

La buena noticia, medida y no supuesta: **la superficie REST no cambió**, `window.ApiClient`
sigue existiendo, y el contrato de `localStorage` del que depende el plugin sigue idéntico.
No hay que reescribir la capa de front-end.

---

## 1. Hallazgos medidos

### 1.1 El servidor es 12.1.0 y los paquetes existen

```
curl -s http://192.168.8.207:30013/System/Info/Public
→ {"ServerName":"Neexy","Version":"12.1.0","ProductName":"Jellyfin Server", ...}

curl -s https://api.nuget.org/v3-flatcontainer/jellyfin.controller/index.json
→ últimas: 12.0.0-rc7, 12.0.0, 12.1.0
```

Los plugins core del servidor reportan versión `12.1.0.0` (AudioDB, MusicBrainz, OMDb, TMDb,
Studio Images). **JMSFusion no aparece en `/Plugins`** — no está instalado en ese servidor.

### 1.2 El paquete 12.1.0 es `net10.0`

```
unzip -l jellyfin.controller.12.1.0.nupkg → lib/net10.0/MediaBrowser.Controller.dll
nuspec deps (TFM net10.0): Jellyfin.Common 12.1.0, Jellyfin.Model 12.1.0,
                           Microsoft.Extensions.Configuration.Binder 10.0.11
```

SDK local: `dotnet --list-sdks` → `10.0.302`; runtime `Microsoft.AspNetCore.App 10.0.10`.
**El toolchain ya está listo**, no hace falta instalar nada.

### 1.3 La compilación contra 12.1.0 arroja UN solo error

Copia del repo en scratchpad, `TargetFramework net9.0→net10.0`, los 4 paquetes Jellyfin
`10.11.0→12.1.0`, `Logging.Abstractions 9.0.10→10.0.11`,
`FileProviders.Embedded 8.0.0→10.0.11`, y `dotnet build -c Release`:

```
Controllers/WatchlistController.cs(804,47): error CS1061:
  'IUserManager' does not contain a definition for 'Users'
```

`IUserManager` en 12.1 (extraído de `MediaBrowser.Controller.xml`) ya no expone la propiedad
`Users`; expone `GetUsers()` / `GetUsersIds()`. Aplicado el cambio:

```
_users.Users  →  _users.GetUsers()
dotnet build -c Release → Build succeeded. 0 Error(s)
```

**Baseline de control:** el repo tal cual (net9.0 + 10.11.0) también compila limpio, así que
el error es atribuible al salto de versión y no a deuda previa.

Aviso menor del build: `NU1510 — Microsoft.Extensions.Logging.Abstractions no se podará`,
es decir que la referencia ya es redundante. **Se eliminó del csproj** (§6), no se subió de
versión: el framework ya la aporta, y con ella fuera el build queda sin warnings.

### 1.4 La superficie REST **no** cambió (esto era el riesgo grande, y está descartado)

Sondeo con IDs reales del servidor (usuario `abraham`, una película real):

| Ruta | 12.1 |
|------|------|
| `/Users/{u}/Items` (39 usos en el JS) | **200** |
| `/Users/{u}/Items/Latest`, `/Users/{u}/Items/{i}`, `/Users/{u}/Views` | 200 |
| `/Items?userId=`, `/Items/Latest?userId=`, `/UserViews?userId=` | 200 |
| `/Items/Filters`, `/Shows/NextUp`, `/Sessions`, `/Studios`, `/Genres` | 200 |
| `/Items/{i}/Images/{Primary,Backdrop/0,Logo}` | 200 |
| `/Users/Public` | 200 |
| `/Users/Me` | 400 — *inconcluso*: con API key no hay usuario asociado; hay que reverificar con token de sesión |

Las rutas `/Users/{userId}/Items`, que llevan años marcadas como deprecadas, **siguen vivas**.
No hace falta migrarlas para que 12.1 funcione (sí sería higiene, pero no es este trabajo).

### 1.5 La auth heredada murió — pero *ignora*, no *rechaza*

Matriz sobre `/System/Info` y `/Users/{u}/Items`:

| Mecanismo | 12.1 |
|-----------|------|
| `X-Emby-Token: <token>` solo | **401** |
| `?api_key=<token>` solo | **401** |
| `X-Emby-Authorization: MediaBrowser Token=...` | **401** |
| `Authorization: MediaBrowser Token="..."` (con o sin Client/Device, con o sin comillas) | **200** |

Y el matiz que cambia por completo el tamaño del trabajo:

| Combinación | 12.1 |
|-------------|------|
| `Authorization` + `X-Emby-Token` | **200** |
| `Authorization` + `?api_key=` | **200** |
| `Authorization` + `X-Emby-Token: basura` | **200** |
| `Authorization` + `?api_key=basura` | **200** |
| Imagen `/Items/{i}/Images/Primary` **sin auth ninguna** | **200** |

Es decir: 12.1 **no lee** las credenciales heredadas, pero tampoco se ofende por ellas. Sólo
fallan las llamadas donde lo heredado es la **única** credencial. Y los endpoints de imagen son
anónimos, así que todo `<img src=...&api_key=>` sigue pintando.

**Corroboración independiente:** el propio `jellyfin-web` 12.1 contiene **cero** ocurrencias de
`X-Emby-Token` y `api_key` en sus 30 bundles; manda `Authorization` y nada más. El cliente dejó
de mandarlos porque el servidor dejó de leerlos.

### 1.6 Los contratos de front-end que el plugin usa siguen intactos

Descargados y analizados los 30 bundles de `/web/` del servidor 12.1:

| Contrato del que depende el plugin | 12.1 |
|---|---|
| `window.ApiClient` (134 usos en el JS de moui) | **existe** (4 asignaciones; `getCurrentUserId`, `serverAddress`, `getUrl`) |
| `appRouter`, `Dashboard`, `Emby.Page` | existen |
| `localStorage["jellyfin_credentials"]` | **existe**, en `node_modules.jellyfin-apiclient.bundle.js` |
| Forma `{Servers:[{AccessToken, UserId, Id}]}` | idéntica |
| `index.html` con `</head>` / `</body>` / `</html>` | 1 de cada — los anclajes de `IndexPatcher` siguen sirviendo |
| `index.html` servido sin `Content-Encoding` | sin comprimir (8.042 bytes) |

`RuntimeModules/api.js:1286 getAuthHeader()` ya emite exactamente el formato que 12.1 acepta
(`MediaBrowser Client="..", Device="..", DeviceId="..", Version="..", Token=".."`), y lo
alimenta desde `jellyfin_credentials`. **Ese camino funciona en 12.1 sin tocarlo.**

### 1.7 Dónde está realmente la auth rota

**C# — 2 sitios reales** (el resto de `api_key` en C# son de terceros: TMDB, Jellyseerr/\*arr, y
no les afecta):

- `Core/TrailerAutomationService.cs:1216` — `CreateJellyfinRequest()` pone **sólo**
  `X-Emby-Token: JfApiKey`. Llamada servidor→Jellyfin ⇒ **401 en 12.1**.
- `Controllers/LyricsController.cs:311` — arma `{jfBase}/Users/{userId}/Items?...&api_key=`
  como **única** credencial ⇒ **401 en 12.1**.
- *(No rompen — verificado, ver §1.7b)* `LyricsController.cs:142` y `TrailersController.cs:182`
  leen el `X-Emby-Token` entrante como auth **propia del plugin**, no de Jellyfin. Siguen
  funcionando en 12.1. Conviene igualmente que acepten `Authorization` además de la cabecera
  heredada.

### 1.7b Los controladores del plugin siguen siendo alcanzables en 12.1

Ningún controlador de JMSFusion declara `[Authorize]` ni `[AllowAnonymous]` (grep sobre
`Controllers/`: **cero** ocurrencias de ambos). Eso plantea la pregunta de si 12.1 aplica una
*fallback authorization policy* que filtraría esos endpoints antes de que el plugin lea nada —
lo que convertiría toda la API propia del plugin (`/Plugins/JMSFusion/ping`, `/studio-hubs/*`,
`/gmmp/*`, `/ScopedCache`, `/cast/access`) en 401.

Medido contra el servidor real usando los controladores de **otros** plugins ya instalados, con
controles a ambos lados:

| Ruta | sin auth | con auth |
|------|----------|----------|
| `/PluginPages/inject.js` (sin política declarada) | **200** | 200 |
| `/JavaScriptInjector/public.js` (sin política) | **200** | 200 |
| `/Moonfin/Web/loader.js`, `/Moonfin/Web/config.json` (sin política) | **200** | 200 |
| `/PluginPages/User` (sin política) | **200** | 200 |
| `/Intros/ScanStatus` (declara `RequiresElevation`) — *control* | **401** | 200 |
| `/Items` (core, `DefaultAuthorization`) — *control* | **401** | 200 |

Los dos controles prueban que el sondeo distingue de verdad: donde hay política declarada, se
aplica. Donde no la hay, el endpoint responde sin credenciales. **12.1 no impone una fallback
policy restrictiva sobre los controladores de plugin.**

El `openapi.json` del servidor lo corrobora: de 465 rutas, 55 operaciones no llevan bloque
`security` — y entre ellas están precisamente las de PluginPages, JavaScriptInjector y Moonfin.

*Residuo honesto:* no se puede descartar al 100% que esos plugins declaren `[AllowAnonymous]`
explícitamente, lo que también esquivaría un fallback. La prueba definitiva es instalar
JMSFusion y pedir `/Plugins/JMSFusion/ping` (Fase 4, paso 17b). La evidencia disponible apunta
con fuerza a que no hay problema.

**JS — triaje estático aproximado, no conteo exacto.** Buscando `X-Emby-Token`/`api_key` y
mirando si aparece `Authorization`/`getAuthHeader` en una ventana de ±14 líneas: 30 archivos,
~55 sitios "sólo heredado" y 13 "ya emparejados". Desglose por tipo: 23 cabecera de petición,
10 decoración de URL con `api_key` (inofensivas en imagen/stream, que son anónimos), 2 cadenas
i18n (no-op), 20 sin clasificar.

> ⚠️ Estas cifras son la opinión de una heurística de texto, no una medición. Una ventana de
> ±14 líneas marca como "sólo heredado" un `fetch` cuyo objeto de cabeceras se construye 30
> líneas más arriba, y como "emparejado" uno donde aparece un `Authorization` ajeno a 12 líneas.
> **La cifra real se establece en la Fase 2 paso 11**, con la auditoría de red en el navegador.
> Sirven para dimensionar dónde mirar, no para estimar el trabajo.

Concentración útil para atacar muchos de golpe: `modules/player/core/auth.js`,
`modules/player/core/{playlist,jellyfinPlaylists}.js`, `modules/pauseModul.js`.

### 1.8 Empaquetado

- `meta.json`: `targetAbi 10.11.0.0` → debe ser `12.1.0.0`.
- `manifest.json`: **46 entradas, todas `10.11.0.0`**.
- `update_meta.sh` **no gestiona `targetAbi`** (sólo versión, timestamp e imagePath).

---

## 2. Riesgos y lo que todavía NO está medido

Honestidad sobre los límites de lo comprobado:

1. **No se ha instalado el plugin en 12.1.** Todo lo de servidor está verificado por compilación
   y por sondeo HTTP, no por carga real. Lo que sólo se ve al instalar: que
   `IStartupFilter` + `InMemoryRewriterFileProvider` sigan enganchando el `WebRootFileProvider`,
   que las rutas `/slider/*` y `/Plugins/JMSFusion/*` no choquen, y que no haya
   `TypeLoadException` por cambios de interfaz que el compilador no ve.
2. **Las pruebas de auth se hicieron con API key, no con token de usuario.** La evidencia de que
   el rechazo es *por nombre de cabecera* y no por tipo de token es que
   `X-Emby-Authorization` —misma carga útil que la que sí funciona— también da 401. Aun así,
   los caminos `accessToken` del JS hay que reverificarlos en el navegador.
3. **`/Users/Me` da 400** — inconcluso por lo anterior.
4. **El servidor tiene `HasPendingRestart: true`** y TMDb Box Sets está en estado `Restart`
   (14.0.0.0 `Superseded` → 15.0.0.0). **Reiniciar ese servidor para probar JMSFusion aplicará
   también esa actualización de TMDb Box Sets**, que es un cambio pendiente de otra persona en
   un servidor que el usuario mira. Ningún paso de instalación/reinicio se ejecuta sin
   confirmación explícita.
5. El servidor ya corre **File Transformation 3.0.1.0**, **Plugin Pages 3.0.1.0** y
   **JavaScript Injector 4.0.0.0** — el ecosistema 12.x tiene una vía de inyección sancionada.
   Ver decisión abierta (§4).

---

## 3. Plan de trabajo

### Fase 1 — Compilar contra 12.1 (bloqueante, ~30 min)

1. `JMSFusion.csproj`: `net9.0` → `net10.0`.
2. `JMSFusion.csproj`: `Jellyfin.{Controller,Model,Common,Data}` `10.11.0` → `12.1.0`.
3. `JMSFusion.csproj`: `Logging.Abstractions` → `10.0.11` (o eliminar, cf. NU1510);
   `FileProviders.Embedded` `8.0.0` → `10.0.11`.
4. `Controllers/WatchlistController.cs:804`: `_users.Users` → `_users.GetUsers()`.
5. **Verificación:** `dotnet build -c Release` ⇒ 0 errores. *(Ya reproducido en scratchpad.)*

### Fase 2 — Auth (alto, acotado)

6. `Core/TrailerAutomationService.cs:1216` — `CreateJellyfinRequest()` pasa a
   `Authorization: MediaBrowser Token="{JfApiKey}", Client="JMSFusion", Device="server",
   DeviceId="jmsfusion", Version="{plugin}"`.
7. `Controllers/LyricsController.cs:311` — quitar `&api_key=` de la URL y mandar la cabecera
   `Authorization`.
8. `LyricsController.cs:142` / `TrailersController.cs:182` — aceptar `Authorization` además de
   `X-Emby-Token` (compatibilidad hacia atrás, no sustitución).
9. **JS:** centralizar en vez de parchear 55 sitios. `buildSafeFetchHeaders()` (main.js:4233) y
   `modules/player/core/auth.js` deben garantizar `Authorization: getAuthHeader()` **siempre**;
   lo heredado puede quedarse (12.1 lo ignora, medido) para no romper 10.11.
10. *(Opcional / higiene)* Triar a mano el resto de sitios heredados. **Sólo es necesario para
    los que el paso 11 demuestre que dan 401** — tras el paso 9, la mayoría dejará de importar.
    No auditar los 55 a ciegas.
11. **Verificación (esto es lo que fija el alcance real del paso 10):** auditoría de red en el
    navegador sobre 12.1 — recorrer home, reproductor, letras, trailers y studio hubs, y listar
    toda respuesta 401. Esa lista *es* el trabajo pendiente.

### Fase 3 — Empaquetado

12. `meta.json`: `targetAbi` → `12.1.0.0`.
13. `manifest.json`: **bifurcar**. Las 46 entradas existentes se quedan en `10.11.0.0` (para
    quien siga en 10.11); la entrada nueva se publica con `12.1.0.0`. El servidor filtra por
    ABI, así que un único manifest sirve a ambas ramas.
14. *(Opcional / higiene — no hace falta para 12.1)* `update_meta.sh`: que gestione `targetAbi`
    en vez de dejarlo hardcodeado. Poner `12.1.0.0` es necesario; refactorizar el script que lo
    escribe, no.
15. Recordatorio del histórico: el primer `dotnet build` tras subir versión copia el `meta.json`
    **viejo** — construir dos veces, y tomar `icon.png` de `img/`.

### Fase 4 — Verificación en vivo (requiere CONFIRM explícito)

16. Instalar el `.zip` en el 12.1 y reiniciar. **Antes de esto, avisar de que el reinicio
    aplicará también TMDb Box Sets 15.0.0.0.** Alternativa preferible: probar primero en un
    Jellyfin 12.1 desechable en local, donde no hay cambios ajenos pendientes.
17. Comprobar en log: `[JMSFusion]` carga sin `TypeLoadException`, y el parcheo de índice.
17b. `GET /Plugins/JMSFusion/ping` sin credenciales — cierra el residuo de §1.7b. 200 confirma
    que la API propia del plugin es alcanzable; 401 significaría que sí hay fallback policy y
    que todos los controladores necesitan `[AllowAnonymous]` o una política explícita.
18. Comprobar en navegador: `/slider/main.js` 200, home renderiza, reproductor, letras,
    trailers, studio hubs, y **cero 401** en la pestaña de red.

---

## 4. Decisión abierta (necesita criterio del usuario, no más medición)

**¿Mantener el reescritor en memoria propio, o migrar a File Transformation 3.0.1.0?**

La evidencia recogida **favorece mantenerlo**: los anclajes `</head>`/`</body>` siguen ahí,
`index.html` se sirve sin comprimir, y el plugin compila limpio contra 12.1. No hay nada roto
que obligue a migrar.

El argumento en contra es estratégico, no técnico: el servidor ya tiene instalados File
Transformation y Plugin Pages, y el ecosistema 12.x los trata como la vía oficial. Migrar
reduce mantenimiento futuro a cambio de un trabajo grande hoy.

**Recomendación: no migrar ahora.** Hacer 12.1 funcionar con la arquitectura actual (Fases 1–4),
y tratar la migración como un proyecto aparte con su propio plan.

---

## 5. Esfuerzo

| Fase | Esfuerzo | Riesgo |
|------|----------|--------|
| 1 — compilar | ~30 min | Bajo (ya reproducido) |
| 2 — auth (necesario: pasos 6–9) | ~1–2 h | Medio |
| 2 — auth (opcional: paso 10, según lo que dé el 11) | 0–3 h | Bajo |
| 3 — empaquetado | ~1 h | Bajo |
| 4 — verificación en vivo | 1–2 h | Medio (depende de servidor de pruebas) |

El salto 10.11 → 12.1 resultó mucho menos traumático de lo que sugiere el número de versión:
el rediseño está en la autenticación, no en la API ni en el front-end.


---

## 6. Registro de ejecución (2026-09-20)

Ejecutadas las Fases 1–3. 15 archivos modificados, 2 nuevos (`Core/JellyfinAuth.cs`,
`tests/jellyfinAuthHeaders.test.mjs`): +95 / −58.

### Fase 1 — compilar ✅
- `net9.0` → `net10.0`; los 4 paquetes Jellyfin → `12.1.0`; `FileProviders.Embedded` → `10.0.11`.
- `Microsoft.Extensions.Logging.Abstractions` **eliminado** (NU1510: lo aporta el framework).
- `WatchlistController.cs:804`: `_users.Users` → `_users.GetUsers()`.
- **Verificado:** `dotnet build -c Release` → 0 errores, **0 warnings**.

### Fase 2 — auth ✅
- Nuevo `Core/JellyfinAuth.cs`: `BuildHeaderValue()` para llamadas salientes y
  `ReadIncomingToken()` que acepta `Authorization` **y** `X-Emby-Token` en las entrantes.
- `TrailerAutomationService.cs` y `LyricsController.cs` (se le quitó el `&api_key=` de la URL)
  pasan a `Authorization`.
- `LyricsController` y `TrailersController` leen ahora la credencial entrante por ambas vías.
- `main.js`: `Authorization` se adjunta en **toda** petición al mismo origen, no sólo en las que
  reconocía `requiresAuthRequest()` — esa lista se dejaba fuera `/Items`, `/Shows/NextUp`,
  `/Studios`. Guardado contra orígenes externos para no filtrar el token.
- Nuevo `authHeaders()` en `player/core/auth.js`; **15 de los 18 sitios** migrados a él.

**Corrección al triaje de §1.7:** al emparejar cada `X-Emby-Token` con su objeto de cabeceras
por balanceo de llaves (en vez de ventana de ±14 líneas), los sitios reales sin `Authorization`
resultaron **18, no ~55**. Además, tres candidatos eran falsos positivos:

| Sitio | Veredicto real |
|---|---|
| `player/core/auth.js` (4 sitios) | sólo **lee** `api_key` de la URL para descubrir el token; no lo envía |
| `recentRows.js:2282` | va a **TMDB**, tercero |
| `profileChooser.js:800` | URL de **imagen**, anónima en 12.1 (medido) |

Los 3 sitios restantes (`config.js:1658`, `settings/musicPage.js:98`,
`settings/applySettings.js:198`) apuntan a endpoints **propios del plugin**
(`/Plugins/JMSFusion/*`, `/JMSFusion/lyrics/*`), que §1.7b demuestra alcanzables y cuyos
controladores ahora aceptan ambas cabeceras. **No rompen**; se dejan como están.

### Fase 3 — empaquetado ✅
- `meta.json`: `targetAbi` → `12.1.0.0`. Verificado que `update_meta.sh` no lo pisa y que el
  `meta.json` copiado a `bin/Release/net10.0/` lleva el valor nuevo.
- Nada en `.github/`, `tools/` ni los scripts fija `net9.0` ni `10.11` — no hay CI de build que
  actualizar.
- **`manifest.json` sin tocar a propósito:** sus 46 entradas siguen en `10.11.0.0`, que es lo
  correcto para quien siga en 10.11. La entrada con `12.1.0.0` se añade al **cortar la release**
  (bump de versión + zip + md5), que es un paso de publicación aparte.

### Verificación ejecutada

| Comprobación | Resultado |
|---|---|
| `dotnet build -c Release` (×2, por el meta.json rancio) | 0 errores, 0 warnings |
| `node tools/check-imports.mjs` | 141 módulos, todos los imports resuelven |
| Suite `tests/*.test.mjs` | **10/10 PASS** (9 previas + 1 nueva) |
| Formato del header C# contra el 12.1 real | 200 en `/System/Info` y `/Users/{u}/Items` |
| Formato del header JS contra el 12.1 real | 200 en `/Users/{u}/Items`, `/Items`, `/Sessions` |
| URL de lyrics ya sin `api_key` | 200 |
| Prueba de mutación del test nuevo | quitar la línea `Authorization` → FAIL, exit 1 |

### Correcciones salidas de la revisión

Tres cosas que la primera pasada hizo mal y se arreglaron antes de cerrar:

1. **Fuga de credencial en `main.js` (regresión propia, la más grave).** La primera versión
   adjuntaba `Authorization` a *toda* petición al mismo origen. Pero `normalizeWithServer()`
   mapea `/slider/*` → `/web/slider/*`, y `safeFetch` también sirve los assets del propio
   plugin: el token de sesión del usuario acababa viajando en peticiones que no lo necesitan.
   El bug original —que `requiresAuthRequest()` se dejaba fuera `/Items`, `/Shows/NextUp`,
   `/Studios`— se arregla **ensanchando** el predicado a la lista de raíces de la API de
   Jellyfin, no quitándolo. Las rutas de imagen quedan fuera a propósito (son anónimas en 12.1
   y se piden antes del login). Ambos lados —cabecera y comprobación de token— usan ahora el
   mismo predicado.
   Cubierto por `tests/safeFetchAuthScope.test.mjs`; con la fuga reintroducida, falla con
   *"must NOT carry Authorization — that leaks the session token"*.

   **Y un segundo matiz:** el predicado ensanchado también gobernaba el `throw` de `safeFetch`
   ("Auth not ready"), así que rutas recién incluidas habrían **bloqueado 5 s y reventado** en
   arranque en frío — un síntoma de "el reproductor se cuelga", que la auditoría de 401 de la
   Fase 4 no vería. Medido en el 12.1 real: `/Videos/{id}/stream` responde **200 sin auth**,
   mientras `/Items/{id}/PlaybackInfo` da **401**. Así que ahora hay **dos** predicados:
   `requiresAuthRequest` (ancho: *puede* llevar credencial) y `requiresTokenBeforeRequest`
   (estrecho, el original literal: *debe* tenerla antes de disparar).

   Validado además pasando las 30 formas de ruta reales extraídas del JS por el predicado: las
   7 variantes de imagen y las 5 rutas propias del plugin salen sin credencial; el resto la
   lleva. Ningún falso positivo ni negativo.

2. **Precedencia invertida en `ReadIncomingToken`.** Leía `X-Emby-Token` primero y
   `Authorization` como respaldo, al revés del contrato documentado. Invertido: `Authorization`
   manda, y la heredada queda de respaldo para clientes de 10.11.

3. **Los dos harnesses C# existentes estaban rotos por el cambio de TFM.** `UrlVersioning` y
   `LocalTmdbBatch` cargaban el DLL desde `bin/Release/net9.0/`, ruta que ya no existe.
   Corregidos a `net10.0`, más el sondeo de NuGet de `UrlVersioning` (que sólo aceptaba
   `/net9.0/` y `/net8.0/`) y los comentarios de ambos `.csproj`. Los tres pasan.

### Pruebas añadidas

| Archivo | Cubre |
|---|---|
| `tests/jellyfinAuthHeaders.test.mjs` | 8 aserciones sobre `authHeaders()` del reproductor |
| `tests/safeFetchAuthScope.test.mjs` | 23 aserciones sobre **qué URLs** pueden llevar el token y cuáles bloquean esperándolo |
| `tests/JellyfinAuth/` (harness C#) | 8 aserciones sobre `BuildHeaderValue` y `ReadIncomingToken`, incluida la regex contra la cabecera exacta que emite el navegador |

Las tres pasaron la prueba de mutación: al revertir el cambio que protegen, fallan con exit 1.

**Estado final:** `dotnet build` 0 errores / 0 warnings · **11/11** suites JS · **3/3**
harnesses C# · 141 módulos con imports resueltos.

### Lo que queda (Fase 4, requiere CONFIRM)
Instalar el `.zip` en un servidor 12.1 y validar en vivo: carga sin `TypeLoadException`,
`GET /Plugins/JMSFusion/ping` sin credenciales (cierra el residuo de §1.7b), y auditoría de red
con **cero 401**. Recordatorio: reiniciar `Neexy` aplicaría también TMDb Box Sets 15.0.0.0.
