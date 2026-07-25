# Plan: Studio Collections — brand matching rewrite

Target release: **v3.7.0.7**

## 1. Problem as reported

The "Marvel Studios" card under Studio Collections opens a page listing only
3 entries (Deadpool, Spider-Man: Un nuevo universo, Deadpool - Colección). One
of those was added manually by the user. *Capitán América: Civil War* is present
in the library, its `Studio` field reads **Marvel Studios**, and it is still
missing from the hub.

## 2. Diagnosis

### 2.1 The hub is bound to the wrong studio entity

`Resources/slider/modules/studioHubs.js:1047`

```js
let studio = manualId
  ? { Id: manualId, Name: desired }
  : (nameMap[desired] || studios.find(s => matches(desired, s.Name)) || await searchStudiosByAliases(...));
```

`Array.prototype.find` returns the **first** candidate over the threshold, and
`fetchStudios` requests `SortBy=SortName&SortOrder=Ascending`. So the winner is
whichever qualifying studio sorts first alphabetically, not the best match.

Working the scoring by hand (`studioHubs.js:1296-1305`):

- `JUNK_WORDS` includes `studios`, so `toks("Marvel Studios")` → `{marvel}`
- `toks("Marvel Entertainment")` → `{marvel, entertainment}`
- `inter = 1`, `min(1, 2) = 1`, core token `marvel` present
- score = `1.0 + 1/1` = **2.0**

`toks("Marvel Studios")` against itself also scores **2.0**. It is an exact tie,
and `Marvel Entertainment` sorts before `Marvel Studios`, so it wins. The page
header in the reported screenshot reads *"Marvel Entertainment"*, which confirms
this is what happened.

### 2.2 No single studio entity is the right answer

This is the part that rules out simply fixing the ranking:

| Title | Studio entity |
|---|---|
| Deadpool | Marvel Entertainment |
| Spider-Man: Un nuevo universo | Marvel Entertainment |
| Capitán América: Civil War | **Marvel Studios** |

Jellyfin creates one `Studio` entity per distinct studio string coming from
metadata. "Marvel" as a brand spans several of them (Marvel Studios, Marvel
Entertainment, Marvel Animation, Marvel Television, ...). Picking the *correct*
single entity would show Civil War and drop Deadpool and Spider-Verse. Only a
**union across every entity belonging to the brand** produces the complete row.

### 2.3 Supporting defects

| # | Location | Defect |
|---|---|---|
| D1 | `studioHubs.js:1047` | first-match-wins instead of best-match-wins |
| D2 | `studioHubs.js:767-785` | one `StudioIds` value per hub; no union |
| D3 | `studioHubsShared.js:430-434` | `#/list?studioId=` carries a single id |
| D4 | `studioHubs.js:753-765` | `/Studios?Limit=300`, no paging, no `userId` scope |
| D5 | `studioHubs.js:68` | `studioHub_nameIdMap_v5` caches the bad mapping for 30 days |
| D6 | `studioHubs.js:1083-1092` | `MIN_RATING=6.5` on the *existence* query deletes the card |
| D7 | `settings/studioHubsPage.js:46-180` | `ALIASES`/`CORE_TOKENS`/`nbase`/`strip`/`toks` duplicated verbatim |
| D8 | `studioHubs.js:37-61` | `ALIASES` has no `Netflix` key; `CORE_TOKENS` has no `Universal`; hand-maintained tables drift |
| D9 | `studioHubs.js:72` | `nbase` does not strip diacritics, does not fold `&`→`and` or `+`→`plus` |

D6 is worth calling out: `needsStudioItems = isDefaultHub && !logoUrl`, and an
empty result calls `card.remove()`. A brand with no bundled logo whose titles all
sit under 6.5 disappears from the row with no error. The same filter empties the
hover preview through `selectTopNWithMinRating`.

## 3. Design

### 3.1 One brand registry, one location

Replace `ALIASES` + `CORE_TOKENS` + the scattered slug sets with a single
declarative table, placed in **`studioHubsShared.js`** (both `studioHubs.js` and
`settings/studioHubsPage.js` already import that module, so no new file needs to
be registered in `AssetVersioning.cs`).

```js
export const STUDIO_BRANDS = [
  {
    canonical: "Marvel Studios",
    slug: "marvel-studios",
    include: [/\bmarvel\b/],
    exclude: [/\bmarvel\s+music\b/],
  },
  {
    canonical: "Disney+",
    slug: "disney",
    includeAll: [/\bdisney\b/, /(\bplus\b|\+)/],
  },
  // ...
];
```

`include` / `includeAll` / `exclude` are explicit, so adding a brand or excluding
a false positive is a one-line data edit rather than a scoring-threshold guess.

### 3.2 Deterministic normalization

`normalizeStudioName`: lowercase → NFD + strip combining marks → `&`→`and`,
`+`→`plus` → punctuation to space → collapse whitespace.

Junk-word stripping is **removed from the matching key** — collapsing "Marvel
Studios" to "marvel" is what created the tie in the first place. It is kept only
as a low-weight secondary signal for ranking which entity is the canonical one.

### 3.3 Multi-entity resolution

`resolveStudioBrands(allStudios)` returns, per brand:

```js
{ canonical, studioIds: [...], studioNames: [...], primaryId }
```

`studioIds` is every entity satisfying the rules; `primaryId` is the exact
canonical-name match when one exists (used for logo lookup and as the
single-id fallback). Ranking is best-score-wins with an exact-canonical
tie-break — D1 fixed as a side effect.

### 3.4 Complete, user-scoped studio enumeration

Replace `Limit=300` with a `StartIndex` loop guarded by `TotalRecordCount`, and
pass `userId` so entities from libraries the user cannot see are not resolved
into an empty row.

### 3.5 Union queries

`fetchStudioItemsViaUsers` takes `studioIds[]` and sends
`StudioIds=id1,id2,id3` (Jellyfin binds this comma-delimited and ORs the
condition). The `Studios=<name>` fallback URL is dropped — it silently narrows
back to one name once we are unioning.

### 3.6 Destination link

Decided by Phase 0 (see below).

## 4. Phases

### Phase 0 — Empirical verification `DONE`

Run read-only against `tv.neexy.net` (test server) on 2026-07-24, using the
browser's existing authenticated session.

**Diagnosis confirmed exactly:**

| Entity | Id | Items |
|---|---|---|
| Marvel Entertainment | `d89d0ae4…` | **2** |
| Marvel Studios | `92e08726…` | **10** |
| union (`StudioIds=a,b`) | — | **12** |

The hub is bound to `Marvel Entertainment` → 2 items. The union returns 12,
including *Capitán América: Civil War*, *Avengers: Infinity War*, *Deadpool &
Wolverine*, *Guardianes de la galaxia* — all previously invisible.

**API findings:**

- `StudioIds=id1,id2` (comma) unions correctly → 12.
- `StudioIds=id1|id2` (pipe) returns **203** items — it does not OR, it produces
  garbage. **Use comma only, never pipe.**

**D4 is not theoretical — it is firing today.** The library has **338 studios**;
`Limit=300` returns 300, and these fall off the end:

```
310  LOST  Universal Pictures
315  LOST  Walt Disney Animation Studios
316  LOST  Walt Disney Feature Animation
317  LOST  Walt Disney Pictures      <-- a default hub
318  LOST  Walt Disney Productions
319+ LOST  Warner Bros. …            <-- a default hub
```

**Brand fan-out is much wider than the `ALIASES` table knows:**

| Brand | Entities present |
|---|---|
| DC | DC, DC Films, DC Studios, DC Vertigo |
| Walt Disney | Pictures, Animation Studios, Feature Animation, Productions |
| Paramount | Pictures, Paramount+, Paramount Network |
| DreamWorks | Animation, Pictures, Oriental DreamWorks |
| Marvel | Studios, Entertainment |

Every default brand is affected, not just Marvel.

**Substring matching is proven dangerous:** a naive `name.includes("dc")` match
picks up *Ehime Broadcasting*, *Hokkaido Cultural Broadcasting*, *Kochi Sun Sun
Broadcasting*, *Okinawa Television Broadcasting*, *Tokai Television
Broadcasting* — because "Broa**dc**asting" contains `dc`. The registry must use
word-boundary regexes (`/\bdc\b/`), never substrings.

**Destination link — the native list page CANNOT take multiple ids:**

| URL | Tab title | Cards |
|---|---|---|
| `#/list?studioId=<one>` (control) | "Marvel Studios" | renders |
| `#/list?studioId=<a>,<b>` | "Neexy" | **0** |

The comma value does not merely break the header — the whole route fails to
render. `jellyfin-web` resolves the page via `getItem(studioId)`, which 404s on
a comma value and aborts the view.

**→ Decision: build the Studio Explorer overlay**, cloning the proven
`openDirectorExplorer` pattern (`genreExplorer.js:492`), which already does
grid + infinite scroll + a params-based query. Phase 4 grows from ~1 h to ~4 h
and overall complexity moves to **HIGH**.

### Phase 1 — Brand registry `DONE`
Add `STUDIO_BRANDS`, `normalizeStudioName`, `resolveStudioBrands` to
`studioHubsShared.js`. Delete both copies of `ALIASES`, `CORE_TOKENS`, `nbase`,
`strip`, `toks`, `scoreMatch`/`scoreStudioHubMatch`.

### Phase 2 — Studio enumeration `DONE`
Rewrite `fetchStudios` with paging + `userId`.

### Phase 3 — Multi-entity resolution and union queries `DONE`
Rewrite the resolution block at `studioHubs.js:1042-1050`, thread `studioIds[]`
through `fetchStudioItemsViaUsers`, `chooseBackdropForStudio`,
`createPreviewButton`, and `setupHoverVideo`.

### Phase 4 — Studio Explorer overlay `DONE`
Forced by the Phase 0 result. Clone `openDirectorExplorer`
(`genreExplorer.js:492`): same overlay shell, same grid, same
`IntersectionObserver` infinite scroll, same open/close animation — only the
query differs (`StudioIds=<comma list>` instead of `PersonIds`). Hub cards call
it instead of setting an `href`. Keep a single-id `#/list` href as the
right-click / middle-click fallback so "open in new tab" still does something
sensible.

### Phase 5 — Rating filter `DONE`
Drop `MinCommunityRating` from existence/count queries; apply it only when
picking artwork, and fall back to the unfiltered pool when the filtered pool is
empty so a card can never vanish silently.

### Phase 6 — Cache invalidation `DONE`
Bump `studioHub_cache_v5` → `_v6`, `studioHub_nameIdMap_v5` → `_v6`,
`studioHub_backdropMap_v1` → `_v2`. The `nameIdMap` payload shape changes from a
single studio object to an id list, and it has a 30-day TTL — without the bump
the deploy looks like it did nothing.

### Phase 7 — Diagnostics panel `DONE`
Read-only section in `settings/studioHubsPage.js`: per brand, the matched studio
entity names and the resulting item count, plus a list of studio entities that
matched no brand. This is the part that answers "so it does not happen again" —
it turns a silent mis-resolution into something visible.

### Phase 8 — Release v3.7.0.7 `DONE`
Per `jellyfin-plugin-release-process`, in this exact order:

1. bump `<Version>` in `JMSFusion.csproj`
2. `./update_meta.sh 3.7.0.7`
3. `dotnet publish -c Release -o <dir>`
4. zip the 3 flat files (`Jellyfin.Plugin.JMSFusion.dll`, `meta.json`, `icon.png`)
5. `md5 -q <zip>`
6. **then** prepend the `manifest.json` entry with that checksum
7. merge to `main`, push, `gh release create v3.7.0.7`

Note this is a full DLL rebuild even though the change is JS-only —
`/Resources/slider` is embedded in the assembly.

## 5. Risks

| Level | Risk | Mitigation |
|---|---|---|
| ~~HIGH~~ | ~~native `#/list` multi-id~~ | **resolved by Phase 0: it does not work.** Explorer overlay it is |
| MEDIUM | brand rules over-match ("Broa**dc**asting" under DC) | word-boundary regexes + explicit `exclude` + the Phase 7 panel makes it visible |
| MEDIUM | brand-scope judgment calls (see §6) | defaults proposed, tunable via the registry |
| MEDIUM | stale localStorage hides the fix | Phase 6 cache bumps |
| MEDIUM | union changes row composition for every brand, not just Marvel | verify each of the 11 default brands in the diagnostics panel before release |
| LOW | manual entries stay single-id | **deliberate** — see below |

## 6. Brand-scope judgment calls

Phase 0 surfaced entities the current table never anticipated. Proposed
defaults, all one-line edits in the registry:

| Question | Proposed default | Why |
|---|---|---|
| Does **Paramount Pictures** absorb *Paramount+* / *Paramount Network*? | **No** — studio brand only | `Disney+` is already its own hub, separate from `Walt Disney Pictures`; streaming-label ≠ film studio |
| Does **DC** absorb *DC Films*, *DC Studios*, *DC Vertigo*? | **Yes**, all four | same brand, and none is a separate hub |
| Does **Walt Disney Pictures** absorb *Animation Studios*, *Feature Animation*, *Productions*? | **Yes** | same brand; `Disney+` stays separate |
| Does **DreamWorks Animation** absorb *DreamWorks Pictures* / *Oriental DreamWorks*? | **Yes** | same brand |
| Does **Marvel Studios** absorb *Marvel Entertainment*? | **Yes** — this is the reported bug | |

## 7. Explicit scope boundary

`StudioHubManualEntry.StudioId` stays **single-valued**. Making manual entries
multi-id pulls in the C# controller, a config migration, and the sanitize paths
for no benefit here — a manual entry is the user pointing at one specific
entity. Only the default brand hubs become multi-entity. The asymmetry is a
decision, not an oversight.

## 8. Complexity

| Area | Estimate |
|---|---|
| Phases 1-3 (core) | 4-5 h |
| Phase 4 (Studio Explorer overlay) | 4 h |
| Phases 5-6 | 1 h |
| Phase 7 (diagnostics) | 2 h |
| Phase 8 (release) | 1 h |

**HIGH** — Phase 0 forced the explorer route.

## 9. Outcome

All eight phases landed in v3.7.0.7.

The pure matching logic moved to `Resources/slider/modules/studioBrands.js`
(no imports, unit-testable) rather than staying in `studioHubsShared.js` — the
project embeds resources with a `Resources/**/*` wildcard and keeps no asset
index, so a new module needs no registration. `tests/studioBrands.test.mjs`
imports it directly and covers resolution, exclusions, primary ranking and
normalization.

One correction made during review: brand resolution was initially still read
through the 30-day `MAP_KEY` cache, which would have frozen the mapping for a
month and re-created the original bug one level up — a new studio, a metadata
refresh or a registry edit would not have taken effect. Resolution is pure and
runs over an already-fetched array, so it now runs on every render; `MAP_KEY`
survives only as an offline fallback for when the studio fetch fails.

Measured on the live 338-studio library:

| Collection | Entities | Titles |
|---|---|---|
| Marvel Studios | 2 | 2 → **12** |
| Walt Disney Pictures | 4 | 10 |
| DC | 4 | 6 |
| Warner Bros. Pictures | 2 | 22 |
| DreamWorks Animation | 3 | — |

Seven studios remain unassigned to any brand (five Japanese broadcasters,
Paramount+ and Paramount Network) — all of them correctly so.
