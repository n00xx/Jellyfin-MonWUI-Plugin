// The studio "See all" grid is grouped by type: every film first, then every series. A single
// Movie,Series query cannot express that — it interleaves the two by rating — so the grid runs
// two paginators back to back.
//
// The failure this guards against is specific and silent. The old loader treated a short page as
// "the grid is exhausted" and disconnected the IntersectionObserver right there. Under a type
// split, the first short page is the end of the *films*, not of the grid: disconnecting there
// strands every series behind an event that can no longer fire, and the overlay just ends after
// the last film with no indication anything is missing. Test 1 below fails outright if that
// happens, because the observer stub here never reports a crossing — exactly as it behaves when
// a rendered page already sits inside the sentinel's rootMargin.
//
// Test 2 covers the other half: a studio with no films at all must not render an orphan "Films"
// heading over zero cards, and must still reach its series.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);
const eq = (actual, expected, msg) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  a === b ? ok(msg) : fail(`${msg} — expected ${b}, got ${a}`);
};

const modulesDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider/modules");
const genreExplorerSrc = readFileSync(path.join(modulesDir, "genreExplorer.js"), "utf8");
const toDataUrl = (src) => "data:text/javascript;charset=utf-8," + encodeURIComponent(src);

// --- Minimal fake DOM. Unlike the harness in sectionExplorerPagination.test.mjs, innerHTML
// keeps the assigned string (the headings are asserted through it) and only materialises the
// explorer skeleton for the one template that declares it, so cards built through innerHTML do
// not each sprout a phantom grid. ---
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this._attrs = {};
    this._listeners = {};
    this._html = "";
    this._rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v || "").split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (...n) => n.forEach((x) => self._classes.add(x)),
      remove: (...n) => n.forEach((x) => self._classes.delete(x)),
      contains: (x) => self._classes.has(x),
    };
  }
  set innerHTML(html) {
    this._html = String(html ?? "");
    this.children = [];
    if (!this._html.includes("ge-grid")) return;
    const mk = (cls, tag) => { const el = new FakeElement(tag || "div"); el.className = cls; return el; };
    const grid = mk("ge-grid"), empty = mk("ge-empty"), sentinel = mk("ge-sentinel");
    const content = mk("ge-content");
    content.appendChild(grid); content.appendChild(empty); content.appendChild(sentinel);
    const actions = mk("ge-actions");
    actions.appendChild(mk("ge-close", "button"));
    const header = mk("ge-header");
    header.appendChild(actions);
    const dialog = mk("genre-explorer");
    dialog.appendChild(header); dialog.appendChild(content);
    this.appendChild(dialog);
  }
  get innerHTML() { return this._html; }
  get firstElementChild() { return this.children[0] || null; }
  appendChild(node) {
    if (node?.__isFragment) {
      for (const child of node.children) { child.parentNode = this; this.children.push(child); }
      node.children = [];
      return node;
    }
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  querySelector(sel) {
    const cls = sel.replace(/^\./, "");
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (node._classes?.has(cls)) return node;
      stack.push(...node.children);
    }
    return null;
  }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, "");
    const out = [], stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (node._classes?.has(cls)) out.push(node);
      stack.push(...node.children);
    }
    return out;
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  getBoundingClientRect() { return this._rect; }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  focus() {}
}

function installDomEnv() {
  const body = new FakeElement("body");
  globalThis.document = {
    body,
    head: new FakeElement("head"),
    createElement: (tag) => new FakeElement(tag),
    createDocumentFragment: () => { const f = new FakeElement("#fragment"); f.__isFragment = true; return f; },
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {
    innerWidth: 1024, innerHeight: 768,
    location: { hash: "" },
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  Object.defineProperty(globalThis, "navigator", {
    value: { maxTouchPoints: 0, userAgent: "node-test-agent" }, configurable: true,
  });
  // Wired up but never reports a crossing — the case where a page lands already inside
  // rootMargin. Everything below therefore has to be driven by the loader itself.
  globalThis.__observers = [];
  globalThis.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.disconnected = false; globalThis.__observers.push(this); }
    observe() {} unobserve() {}
    disconnect() { this.disconnected = true; }
  };
  return body;
}

// Simulates the sentinel crossing into view. A disconnected observer stops calling back, so
// this refuses to fire one — otherwise a test could "pass" by driving a listener the browser
// would already have torn down.
function fireCrossing() {
  const io = globalThis.__observers[globalThis.__observers.length - 1];
  if (!io || io.disconnected) return false;
  io.cb([{ isIntersecting: true }]);
  return true;
}

const noopStub = (names) => toDataUrl(names.map((n) => `export function ${n}(){}`).join("\n"));

/**
 * Loads the real genreExplorer.js with its imports stubbed. `library` maps an item type to the
 * full list of items that type would return; the request stub pages through it the way Jellyfin
 * does, reporting the group's real size in TotalRecordCount.
 */
async function loadExplorer(library) {
  const requests = [];
  const apiStub = toDataUrl(`
    export function getSessionInfo(){ return { userId: "u1", serverId: "srv" }; }
    export function getCachedUserTopGenres(){ return []; }
    export async function makeApiRequest(url){
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      globalThis.__studioRequests.push({
        types: q.get("IncludeItemTypes"),
        startIndex: Number(q.get("StartIndex")),
        limit: Number(q.get("Limit")),
        studioIds: q.get("StudioIds"),
        tags: q.get("Tags"),
      });
      const all = globalThis.__studioLibrary[q.get("IncludeItemTypes")] || [];
      const start = Number(q.get("StartIndex"));
      return { Items: all.slice(start, start + Number(q.get("Limit"))), TotalRecordCount: all.length };
    }
  `);

  globalThis.__studioRequests = requests;
  globalThis.__studioLibrary = library;

  const doctored = genreExplorerSrc
    .replace(
      `import { makeApiRequest, getSessionInfo, getCachedUserTopGenres } from "../../Plugins/JMSFusion/runtime/api.js";`,
      `import { makeApiRequest, getSessionInfo, getCachedUserTopGenres } from "${apiStub}";`)
    .replace(
      `import { getConfig } from "./config.js";`,
      `import { getConfig } from "${toDataUrl('export function getConfig(){ return { languageLabels: { sectionMovies: "Movies", sectionSeries: "Series" } }; }')}";`)
    .replace(`import { withServer } from "./jfUrl.js";`, `import { withServer } from "${toDataUrl('export function withServer(u){ return u; }')}";`)
    .replace(`import { openDetailsModal } from "./detailsModalLoader.js";`, `import { openDetailsModal } from "${noopStub(["openDetailsModal"])}";`)
    .replace(`import { faIconHtml } from "./faIcons.js";`, `import { faIconHtml } from "${toDataUrl('export function faIconHtml(){ return ""; }')}";`)
    .replace(`import { resolveSliderAssetHref } from "./assetLinks.js";`, `import { resolveSliderAssetHref } from "${noopStub(["resolveSliderAssetHref"])}";`)
    .replace(`import { formatOfficialRatingLabel } from "./utils.js";`, `import { formatOfficialRatingLabel } from "${toDataUrl('export function formatOfficialRatingLabel(){ return ""; }')}";`)
    + `\n// instance:${Math.random()}\n`;

  return { mod: await import(toDataUrl(doctored)), requests };
}

const item = (type, i) => ({ Id: `${type}-${i}`, Name: `${type} ${i}`, Type: type, ImageTags: {} });

// Pagination continues across ticks, so settle rather than guess at a fixed delay.
async function settle(grid) {
  let last = -1;
  for (let i = 0; i < 60 && grid.children.length !== last; i++) {
    last = grid.children.length;
    await new Promise((r) => setTimeout(r, 5));
  }
}

const shape = (grid) => grid.children.map((c) => (c._classes.has("ge-section-head") ? "H" : "card"));
const headings = (grid) => grid.querySelectorAll(".ge-section-head").map((h) => h.innerHTML.replace(/\s+/g, " ").trim());

// --------------------------------------------------------------------------------------
console.log("Studio explorer: films are paged to exhaustion, then series follow");
{
  installDomEnv();
  // 45 films spans two pages, the second short — the exact boundary the old loader mistook for
  // the end of the grid.
  const { mod, requests } = await loadExplorer({
    Movie: Array.from({ length: 45 }, (_, i) => item("Movie", i)),
    Series: Array.from({ length: 3 }, (_, i) => item("Series", i)),
  });

  mod.openStudioExplorer({ name: "Disney+", studioIds: ["s1", "s2"] });
  const grid = document.body.querySelector(".ge-grid");
  await settle(grid);

  const layout = shape(grid);
  eq(layout.length, 50, "every film and every series is rendered, plus one heading each");
  eq(layout[0], "H", "the grid opens with a heading, not a card");
  eq(layout.indexOf("H", 1), 46, "the second heading falls after all 45 films");
  eq(layout.filter((x) => x === "H").length, 2, "exactly one heading per type");

  const heads = headings(grid);
  eq(heads[0].includes("Movies"), true, "the first group is labelled Movies");
  eq(heads[0].includes(">45<"), true, "and counts the whole group, not just its first page");
  eq(heads[1].includes("Series"), true, "the second group is labelled Series");
  eq(heads[1].includes(">3<"), true, "with its own count");

  // Which heading opens the grid is marked explicitly rather than by position: pruning drops
  // firstElementChild in a loop, so a positional rule would migrate onto a card.
  const headEls = grid.querySelectorAll(".ge-section-head");
  eq(headEls[0]._classes.has("ge-section-head--first"), true, "the opening heading carries no top rule");
  eq(headEls[1]._classes.has("ge-section-head--first"), false, "the one after it is ruled off from the group above");

  eq(requests.map((r) => r.types), ["Movie", "Movie", "Series"],
    "each request asks for one type — a combined Movie,Series query would interleave them");
  eq(requests.map((r) => r.startIndex), [0, 40, 0],
    "StartIndex pages within a type and resets at the boundary");
  eq(requests[2].studioIds, "s1,s2",
    "the studio union stays comma-joined (a pipe silently returns unrelated items)");
}

// --------------------------------------------------------------------------------------
console.log("\nStudio explorer: a studio with no films renders no 'Movies' heading");
{
  installDomEnv();
  const { mod, requests } = await loadExplorer({
    Movie: [],
    Series: Array.from({ length: 4 }, (_, i) => item("Series", i)),
  });

  mod.openStudioExplorer({ name: "Series Only", studioIds: ["s9"] });
  const grid = document.body.querySelector(".ge-grid");
  await settle(grid);

  eq(shape(grid), ["H", "card", "card", "card", "card"],
    "the series arrive under a single heading, with no empty group above them");
  const heads = headings(grid);
  eq(heads.length, 1, "only the non-empty type gets a heading");
  eq(heads[0].includes("Series"), true, "and it is the series one");
  eq(grid.querySelectorAll(".ge-section-head")[0]._classes.has("ge-section-head--first"), true,
    "and because it opens the grid it carries no top rule, despite being the second phase");
  eq(requests.map((r) => r.types), ["Movie", "Series"],
    "the empty film phase still runs, then hands off instead of ending the grid");
}

// --------------------------------------------------------------------------------------
console.log("\nStudio explorer: the observer survives the type boundary");
{
  const body = installDomEnv();
  const { mod } = await loadExplorer({
    Movie: Array.from({ length: 45 }, (_, i) => item("Movie", i)),
    Series: Array.from({ length: 50 }, (_, i) => item("Series", i)),
  });

  mod.openStudioExplorer({ name: "Both", studioIds: ["s1"] });

  // Push the sentinel out of the observer's margin the moment anything is on screen. The
  // geometry recheck now declines to page further, so from here only a real crossing can move
  // the grid — which is what makes a premature disconnect observable instead of masked.
  const grid = body.querySelector(".ge-grid");
  const sentinel = body.querySelector(".ge-sentinel");
  sentinel.getBoundingClientRect = () => ({ top: grid.children.length ? 99999 : 0 });

  await settle(grid);
  eq(shape(grid).length, 41, "the first film page lands and then waits for a crossing");

  eq(fireCrossing(), true, "the observer is still live after the first page");
  await settle(grid);
  eq(shape(grid).filter((x) => x === "H").length, 2,
    "draining the films hands off to the series rather than ending the grid");

  // The regression: disconnecting when the *films* ran out leaves the series stuck at one page.
  eq(fireCrossing(), true, "the observer is still live after the type boundary");
  await settle(grid);
  eq(shape(grid).length, 97, "the last series page arrives, so all 45 films and 50 series render");

  eq(globalThis.__observers[globalThis.__observers.length - 1].disconnected, true,
    "and only once both types are drained is the observer torn down");
}

// --------------------------------------------------------------------------------------
// The mirror of the no-films case, and the one the empty-state check does not cover for free:
// here the grid already holds cards when the second type comes back empty, so nothing but the
// heading's own guard stops it being appended over zero cards.
console.log("\nStudio explorer: a studio with no series renders no trailing 'Series' heading");
{
  const body = installDomEnv();
  const { mod } = await loadExplorer({
    Movie: Array.from({ length: 5 }, (_, i) => item("Movie", i)),
    Series: [],
  });

  mod.openStudioExplorer({ name: "Films Only", studioIds: ["s7"] });
  const grid = body.querySelector(".ge-grid");
  await settle(grid);

  eq(shape(grid), ["H", "card", "card", "card", "card", "card"],
    "the grid ends on its last film, with no heading dangling after it");
  const heads = headings(grid);
  eq(heads.length, 1, "only the non-empty type gets a heading");
  eq(heads[0].includes("Movies"), true, "and it is the films one");
}

// --------------------------------------------------------------------------------------
console.log("\nStudio explorer: an empty studio still shows the empty state");
{
  installDomEnv();
  const { mod } = await loadExplorer({ Movie: [], Series: [] });

  mod.openStudioExplorer({ name: "Nothing", studioIds: ["s0"] });
  const grid = document.body.querySelector(".ge-grid");
  await settle(grid);

  eq(grid.children.length, 0, "no headings are left stranded over an empty grid");
  eq(document.body.querySelector(".ge-empty").style.display, "", "the empty state is visible");
}

// --------------------------------------------------------------------------------------
// A film brand reaches its series through the library's franchise keyword, not its studios:
// TMDB writes the broadcasting network onto a series, so StudioIds for "Marvel Studios"
// returns 55 films and 0 shows. The two filters are alternatives — ANDing them would return
// nothing, since a brand only carries tags because its series are absent from the studio axis.
console.log("\nStudio explorer: a tagged brand switches axis for the series phase only");
{
  installDomEnv();
  const { mod, requests } = await loadExplorer({
    Movie: Array.from({ length: 4 }, (_, i) => item("Movie", i)),
    Series: Array.from({ length: 3 }, (_, i) => item("Series", i)),
  });

  mod.openStudioExplorer({
    name: "Marvel Studios",
    studioIds: ["s1", "s2"],
    seriesTags: ["marvel cinematic universe (mcu)"],
  });
  const grid = document.body.querySelector(".ge-grid");
  await settle(grid);

  const films = requests.filter((r) => r.types === "Movie");
  const shows = requests.filter((r) => r.types === "Series");
  eq(films.length > 0, true, "the films phase ran");
  eq(shows.length > 0, true, "the series phase ran");

  eq(films[0].studioIds, "s1,s2", "films still filter on the studio axis");
  eq(films[0].tags, null, "films must not be narrowed by a franchise keyword");

  eq(shows[0].tags, "marvel cinematic universe (mcu)", "series filter on the tag axis");
  eq(shows[0].studioIds, null, "the studio filter is replaced, not combined");

  eq(headings(grid).length, 2, "both type headings still render");
  eq(shape(grid).length, 9, "four films, three series, one heading each");
}

// --------------------------------------------------------------------------------------
console.log("\nStudio explorer: an untagged brand keeps both phases on the studio axis");
{
  installDomEnv();
  const { mod, requests } = await loadExplorer({
    Movie: [item("Movie", 0)],
    Series: [item("Series", 0)],
  });

  // Netflix and Disney+ *are* networks, so their series resolve through StudioIds already.
  mod.openStudioExplorer({ name: "Netflix", studioIds: ["s5"] });
  await settle(document.body.querySelector(".ge-grid"));

  eq(requests.every((r) => r.studioIds === "s5"), true, "every phase kept the studio filter");
  eq(requests.every((r) => r.tags === null), true, "no phase invented a tag filter");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll studio explorer type-split tests passed.");
if (failures) process.exit(1);
