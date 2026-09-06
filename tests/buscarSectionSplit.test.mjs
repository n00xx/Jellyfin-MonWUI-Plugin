// Regression tests for the Buscar search overlay's two-section layout and its library
// cross-reference cost.
//
// Buscar searches Seerr's TMDb-backed catalog, then has to ask the local server "is this
// already in the library?" for every result just to decide which section a card belongs to.
// That lookup used to be one HTTP request per title (searchJellyfinByTmdbId). Browsers cap
// concurrent connections per origin, so ~24 lookups left in ~4 serialized waves and dominated
// the time to first card — which is why the result set was capped at 24 in the first place.
//
// Test 1 is the guard that matters for latency: it drives annotateWithLibraryMatches with a
// large result set and asserts the network cost stays CONSTANT (one batched id lookup + one
// batched item hydration), never scaling with the number of results. If someone reintroduces a
// per-title lookup, the call counter catches it regardless of how fast it happens to run here.
//
// Tests 2-4 cover the split itself: available titles under one heading, requestable ones under
// another, relevance order preserved inside each bucket, and no heading emitted for an empty
// bucket (a heading over zero results is the exact noise these sections exist to remove).

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);
const eq = (actual, expected, msg) =>
  (JSON.stringify(actual) === JSON.stringify(expected))
    ? ok(msg)
    : fail(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const modulesDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider/modules");
const toDataUrl = (src) => "data:text/javascript;charset=utf-8," + encodeURIComponent(src);
const noopStub = (names) => toDataUrl(names.map((n) => `export function ${n}(){}`).join("\n"));

// --- Minimal fake DOM: enough for createElement/appendChild/innerHTML/classList/querySelector
// to behave like the real thing for the render path under test. No geometry needed. ---
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this._html = "";
    this.textContent = "";
    this.className = "";
    this._attrs = {};
    this.classList = {
      add: (...c) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...c])].join(" "); },
      remove: (...c) => { this.className = this.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(" "); },
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }
  get parentElement() { return this.parentNode; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  removeAttribute(k) { delete this._attrs[k]; }
  appendChild(node) {
    if (node && node.__isFragment) { node.children.forEach((c) => this.appendChild(c)); node.children = []; return node; }
    node.parentNode = this; this.children.push(node); return node;
  }
  remove() {
    const i = this.parentNode?.children.indexOf(this) ?? -1;
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  _all() { return this.children.flatMap((c) => [c, ...c._all()]); }
  _matches(sel) {
    return sel.split(",").map((s) => s.trim()).filter(Boolean).every === undefined
      ? false
      : sel.split(",").map((s) => s.trim()).filter(Boolean)
          .some((s) => s.startsWith(".") && this.className.split(/\s+/).includes(s.slice(1)));
  }
  querySelector(sel) { return this._all().find((n) => n._matches(sel)) || null; }
  querySelectorAll(sel) { return this._all().filter((n) => n._matches(sel)); }
  addEventListener() {}
  dispatchEvent() { return true; }
}

function installDomEnv() {
  const doc = {
    createElement: (t) => new FakeElement(t),
    createDocumentFragment: () => {
      const f = new FakeElement("#fragment");
      f.__isFragment = true;
      return f;
    },
    head: new FakeElement("head"),
    body: new FakeElement("body"),
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.document = doc;
  globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.CustomEvent = class { constructor(t) { this.type = t; } };
  return doc;
}

// Counts every call so the assertions can prove cost is constant, not just "fast enough".
const calls = { batchLookups: 0, batchLookupSizes: [], apiRequests: [], serrRequestLists: 0 };

async function loadBuscar({ matches = new Map(), items = [] } = {}) {
  // Mirrors the real endpoint: only ids actually asked about can come back matched.
  globalThis.__TEST_BATCH__ = (ids) => {
    calls.batchLookups++;
    calls.batchLookupSizes.push(ids.length);
    return new Map(ids.filter((id) => matches.has(id)).map((id) => [id, matches.get(id)]));
  };
  globalThis.__TEST_API__ = (url) => {
    calls.apiRequests.push(url);
    return { Items: items };
  };
  globalThis.__TEST_REQLIST__ = () => { calls.serrRequestLists++; return { requests: [] }; };

  const src = readFileSync(path.join(modulesDir, "buscarPage.js"), "utf8");
  const doctored = src
    .replace(
      `import { getSessionInfo, makeApiRequest } from "../../Plugins/JMSFusion/runtime/api.js";`,
      `import { getSessionInfo, makeApiRequest } from "${toDataUrl(`
        export function getSessionInfo(){ return { userId: "u1", serverId: "s1" }; }
        export async function makeApiRequest(url){ return globalThis.__TEST_API__(url); }
      `)}";`)
    .replace(`import { getConfig } from "./config.js";`,
      `import { getConfig } from "${toDataUrl(`export function getConfig(){ return { languageLabels: {} }; }`)}";`)
    .replace(`import { faIconHtml } from "./faIcons.js";`,
      `import { faIconHtml } from "${toDataUrl('export function faIconHtml(){ return ""; }')}";`)
    .replace(`import { createRecommendationCard } from "./recentRows.js";`,
      `import { createRecommendationCard } from "${toDataUrl(`
        export function createRecommendationCard(item){
          const el = document.createElement("div");
          el.className = "card personal-recs-card";
          el.dataset.testName = String(item?.Name || "");
          return el;
        }
      `)}";`)
    .replace(`import { registerExplorerCloser } from "./genreExplorer.js";`,
      `import { registerExplorerCloser } from "${noopStub(["registerExplorerCloser"])}";`)
    .replace(
      `import { getSerrAccess, searchSerr, searchJellyfinByTmdbIds, createSerrRequest, listSerrRequests } from "./seerr/api.js";`,
      `import { getSerrAccess, searchSerr, searchJellyfinByTmdbIds, createSerrRequest, listSerrRequests } from "${toDataUrl(`
        export async function getSerrAccess(){ return { enabled: true }; }
        export async function searchSerr(){ return { results: [] }; }
        export async function searchJellyfinByTmdbIds(ids){ return globalThis.__TEST_BATCH__(ids); }
        export async function createSerrRequest(){ return { ok: true }; }
        export async function listSerrRequests(){ return globalThis.__TEST_REQLIST__(); }
      `)}";`)
    .replace(`import { ensureSerrStyles } from "./seerr/styles.js";`,
      `import { ensureSerrStyles } from "${noopStub(["ensureSerrStyles"])}";`)
    .replace(
      /import \{\s*mergeSearchResults,[\s\S]*?\} from "\.\/seerr\/ui\.js";/,
      `import { mergeSearchResults, resultMediaType, resultTitle, posterUrl as serrPosterUrl, resultYear, notify, requestErrorMessage, requestMatchesPayload } from "${toDataUrl(`
        export function mergeSearchResults(...lists){ return lists.flat(); }
        export function resultMediaType(r){ return r?.mediaType || "movie"; }
        export function resultTitle(r){ return r?.title || ""; }
        export function posterUrl(){ return ""; }
        export function resultYear(r){ return r?.year || ""; }
        export function notify(){}
        export function requestErrorMessage(e, f){ return f; }
        export function requestMatchesPayload(){ return false; }
      `)}";`)
    // Widen visibility of the internals under test. The code itself is untouched.
    + "\nexport { renderEntries as __renderEntries, annotateWithLibraryMatches as __annotate };\n";

  return await import(toDataUrl(doctored));
}

const seerrResult = (id, title) => ({ id, title, mediaType: "movie", year: "2024" });
const tvResult = (id, title) => ({ id, title, mediaType: "tv", year: "2024" });

// Names a rendered grid child. Type headings carry their own class, so they are distinguishable
// from the availability headings above them and from the cards below.
const label = (c) =>
  c.className.includes("buscar-subsection-head")
    ? "T:" + (c.innerHTML.includes("Series") ? "Series" : "Películas")
  : c.className.includes("buscar-section-head--available") ? "H:available"
  : c.className.includes("buscar-section-head--discover") ? "H:discover"
  : c.className.includes("buscar-request-card") ? "card:request"
  : "card:available";

// --------------------------------------------------------------------------------------
console.log("\nBuscar: library cross-reference cost stays constant");
{
  installDomEnv();
  calls.batchLookups = 0; calls.batchLookupSizes = []; calls.apiRequests = [];

  // RESULT_LIMIT caps how many cards get built (40). The input deliberately overshoots it, so
  // the cap is exercised rather than merely fitted. The point of these assertions is that the
  // *network* cost is one lookup no matter how many results arrive — so a reintroduced
  // per-title lookup fails here regardless of how fast it happens to run on this machine.
  const results = Array.from({ length: 60 }, (_, i) => seerrResult(1000 + i, `Title ${i}`));
  const matches = new Map(results.filter((_, i) => i % 2 === 0).map((r) => [r.id, `item${r.id}`]));
  const items = Array.from(matches.values()).map((id) => ({ Id: id, Name: `Local ${id}` }));

  const mod = await loadBuscar({ matches, items });
  const entries = await mod.__annotate(results);

  eq(calls.batchLookups, 1, "60 results cost exactly ONE batched TMDb lookup (not 60)");
  eq(calls.apiRequests.length, 1, "hydrating the matches costs exactly ONE item request");
  eq(entries.length, 40, "the result set is capped at RESULT_LIMIT cards");
  eq(calls.batchLookupSizes, [40], "only the ids that will actually render are looked up");
  eq(entries.filter((e) => e.localItem).length, 20, "library matches inside the cap are annotated");
  eq(entries.filter((e) => !e.localItem).length, 20, "the rest stay requestable");

  // Cost must not grow with the size of the incoming result set.
  calls.batchLookups = 0; calls.apiRequests = [];
  const many = Array.from({ length: 200 }, (_, i) => seerrResult(5000 + i, `Big ${i}`));
  await mod.__annotate(many);
  eq(calls.batchLookups, 1, "200 incoming results still cost exactly ONE batched lookup");
  eq(calls.apiRequests.length, 0, "no item request when nothing matched (no wasted round trip)");
}

// --------------------------------------------------------------------------------------
console.log("\nBuscar: a non-movie row never inherits a same-numbered movie's match");
{
  installDomEnv();
  calls.batchLookups = 0; calls.batchLookupSizes = [];

  // TMDb ids are only unique within a media type, so a person and a movie can share id 603.
  const results = [
    { id: 603, title: "The Matrix", mediaType: "movie" },
    { id: 603, title: "Some Person", mediaType: "person" },
  ];
  const mod = await loadBuscar({
    matches: new Map([[603, "itemMatrix"]]),
    items: [{ Id: "itemMatrix", Name: "The Matrix" }],
  });
  const entries = await mod.__annotate(results);

  eq(calls.batchLookupSizes, [[603].length], "only the movie's id is looked up");
  eq(Boolean(entries[0].localItem), true, "the movie row resolves to its library match");
  eq(entries[1].localItem, null, "the person row stays unmatched despite sharing id 603");
}

// --------------------------------------------------------------------------------------
console.log("\nBuscar: results split into two labelled sections");
{
  const doc = installDomEnv();
  calls.serrRequestLists = 0;
  const results = [seerrResult(1, "Alpha"), seerrResult(2, "Beta"), seerrResult(3, "Gamma")];
  const matches = new Map([[2, "itemB"]]);
  const mod = await loadBuscar({ matches, items: [{ Id: "itemB", Name: "Beta Local" }] });

  const grid = doc.createElement("div");
  doc.body.appendChild(grid);
  const entries = await mod.__annotate(results);
  await mod.__renderEntries(grid, entries, 0);

  const heads = grid.querySelectorAll(".buscar-section-head");
  eq(heads.length, 2, "both sections render when each bucket has results");
  eq(heads[0].className.includes("buscar-section-head--available"), true, "available section comes first");
  eq(heads[1].className.includes("buscar-section-head--discover"), true, "discover section comes second");
  eq(heads[0].innerHTML.includes("En biblioteca"), true, "first heading reads 'En biblioteca'");
  eq(heads[1].innerHTML.includes("Descubre"), true, "second heading reads 'Descubre'");
  eq(heads[0].innerHTML.includes(">1<"), true, "available count reflects the single match");
  eq(heads[1].innerHTML.includes(">2<"), true, "discover count reflects the two misses");

  // Ordering: availability heading, then a type heading, then that type's cards, then the next
  // availability heading. Every result here is a movie, so each bucket opens exactly one group.
  const order = grid.children.map(label);
  eq(order, ["H:available", "T:Películas", "card:available",
             "H:discover", "T:Películas", "card:request", "card:request"],
    "cards sit under their own type heading, inside their own bucket");
}

// --------------------------------------------------------------------------------------
console.log("\nBuscar: each bucket is subdivided into films and series");
{
  const doc = installDomEnv();
  calls.serrRequestLists = 0;

  // Two of each type in each bucket, interleaved on the way in, so a passing result means the
  // grouping actually regrouped them rather than the input happening to arrive pre-sorted.
  const results = [
    tvResult(11, "Series A"),        // available
    seerrResult(12, "Film A"),       // available
    tvResult(13, "Series B"),        // discover
    seerrResult(14, "Film B"),       // discover
    seerrResult(15, "Film C"),       // available
    tvResult(16, "Series C"),        // discover
  ];
  const matches = new Map([[11, "i11"], [12, "i12"], [15, "i15"]]);
  const mod = await loadBuscar({
    matches,
    items: [
      { Id: "i11", Name: "Series A", Type: "Series" },
      { Id: "i12", Name: "Film A", Type: "Movie" },
      { Id: "i15", Name: "Film C", Type: "Movie" },
    ],
  });

  const grid = doc.createElement("div");
  doc.body.appendChild(grid);
  await mod.__renderEntries(grid, await mod.__annotate(results), 0);

  eq(grid.children.map(label), [
    "H:available", "T:Películas", "card:available", "card:available",
                   "T:Series",    "card:available",
    "H:discover",  "T:Películas", "card:request",
                   "T:Series",    "card:request", "card:request",
  ], "films group before series inside each bucket, and every card lands under its own type");

  const subs = grid.querySelectorAll(".buscar-subsection-head");
  eq(subs.length, 4, "one type heading per non-empty group, in both buckets");
  eq(subs[0].innerHTML.includes(">2<"), true, "the available-films badge counts its own cards");
  eq(subs[1].innerHTML.includes(">1<"), true, "the available-series badge counts its own cards");

  // The availability badge must equal what is actually under it, not what was passed in.
  const heads = grid.querySelectorAll(".buscar-section-head");
  eq(heads[0].innerHTML.includes(">3<"), true, "'En biblioteca' counts both of its groups");
  eq(heads[1].innerHTML.includes(">3<"), true, "'Descubre' counts both of its groups");
}

// --------------------------------------------------------------------------------------
console.log("\nBuscar: the library item's own type decides which group its card joins");
{
  const doc = installDomEnv();
  // Seerr calls this a film; the library match is a series. The card is built from the library
  // item and opens a series, so filing it under "Películas" on Seerr's word would put the user
  // one click away from something the heading said was not there.
  const mod = await loadBuscar({
    matches: new Map([[31, "i31"]]),
    items: [{ Id: "i31", Name: "Actually A Series", Type: "Series" }],
  });

  const grid = doc.createElement("div");
  doc.body.appendChild(grid);
  await mod.__renderEntries(grid, await mod.__annotate([seerrResult(31, "Mislabelled")]), 0);

  eq(grid.children.map(label), ["H:available", "T:Series", "card:available"],
    "the local item's Type wins over the Seerr media type");
}

// --------------------------------------------------------------------------------------
console.log("\nBuscar: a type with no results gets no type heading");
{
  const doc = installDomEnv();
  const results = [tvResult(21, "Only A"), tvResult(22, "Only B")];
  const mod = await loadBuscar({ matches: new Map(), items: [] });

  const grid = doc.createElement("div");
  doc.body.appendChild(grid);
  await mod.__renderEntries(grid, await mod.__annotate(results), 0);

  const subs = grid.querySelectorAll(".buscar-subsection-head");
  eq(subs.length, 1, "an all-series result set renders exactly one type heading");
  eq(subs[0].innerHTML.includes("Series"), true, "and it is the series one");
  eq(grid.children.map(label), ["H:discover", "T:Series", "card:request", "card:request"],
    "no empty 'Películas' heading over zero cards");
}

// --------------------------------------------------------------------------------------
console.log("\nBuscar: an empty bucket emits no heading");
{
  const doc = installDomEnv();
  const mod = await loadBuscar({ matches: new Map(), items: [] });

  // All requestable — nothing in the library.
  const grid = doc.createElement("div");
  doc.body.appendChild(grid);
  const entries = await mod.__annotate([seerrResult(7, "Solo"), seerrResult(8, "Duo")]);
  await mod.__renderEntries(grid, entries, 0);

  const heads = grid.querySelectorAll(".buscar-section-head");
  eq(heads.length, 1, "only the non-empty section renders a heading");
  eq(heads[0].className.includes("buscar-section-head--discover"), true, "and it is the discover one");
  eq(grid.querySelectorAll(".buscar-section-head--available").length, 0,
    "no empty 'En biblioteca' heading over zero cards");
}

{
  const doc = installDomEnv();
  const mod = await loadBuscar({ matches: new Map([[9, "itemZ"]]), items: [{ Id: "itemZ", Name: "Zeta" }] });

  const grid = doc.createElement("div");
  doc.body.appendChild(grid);
  calls.serrRequestLists = 0;
  const entries = await mod.__annotate([seerrResult(9, "Zeta")]);
  await mod.__renderEntries(grid, entries, 0);

  eq(grid.querySelectorAll(".buscar-section-head").length, 1, "all-available search renders one heading");
  eq(grid.querySelectorAll(".buscar-section-head--available").length, 1, "and it is 'En biblioteca'");
  eq(calls.serrRequestLists, 0,
    "no active-requests fetch when nothing is requestable (skips a needless round trip)");
}

// --------------------------------------------------------------------------------------
console.log("\nBuscar: empty result set still shows the empty state");
{
  const doc = installDomEnv();
  const mod = await loadBuscar();
  const grid = doc.createElement("div");
  doc.body.appendChild(grid);
  await mod.__renderEntries(grid, [], 0);
  eq(grid.querySelectorAll(".buscar-empty").length, 1, "empty state renders");
  eq(grid.querySelectorAll(".buscar-section-head").length, 0, "and no section headings");
}

console.log(failures === 0 ? "\nAll buscar section tests passed.\n" : `\n${failures} test(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
