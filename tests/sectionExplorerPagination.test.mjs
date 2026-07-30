// Regression test for a "See All" pagination stall: IntersectionObserver only fires on a
// *change* of intersection state, so if a rendered page already fits inside the sentinel's
// rootMargin the moment it lands, the sentinel never crosses again and loadMore() never gets
// a second chance to run — every explorer grid (genre/director/personal/studio/section) then
// silently freezes at one page (PAGE_SIZE items), no matter how large the real library is.
//
// The fix adds a synchronous geometry recheck after each non-exhausted page render: if the
// sentinel is still within the observer's margin, call loadMore() again directly instead of
// waiting for a crossing event that may never come. Both tests below exercise the real
// modules with an IntersectionObserver stub whose .observe() never invokes its callback —
// i.e. the exact "never crosses" scenario — so they only pass if the geometry recheck (not
// the observer) is what drives pagination to completion.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const modulesDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider/modules");
const genreExplorerSrc = readFileSync(path.join(modulesDir, "genreExplorer.js"), "utf8");
const sectionExplorerSrc = readFileSync(path.join(modulesDir, "sectionExplorer.js"), "utf8");

const toDataUrl = (src) => "data:text/javascript;charset=utf-8," + encodeURIComponent(src);

// --- Minimal fake DOM: just enough surface for querySelector/appendChild/classList/
// getBoundingClientRect/addEventListener to behave like the real thing for these two flows. ---
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
    this._text = "";
    this._rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    this.hidden = false;
    this.value = "";
  }
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v || "").split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (...names) => names.forEach((n) => self._classes.add(n)),
      remove: (...names) => names.forEach((n) => self._classes.delete(n)),
      contains: (n) => self._classes.has(n),
    };
  }
  // The test never inspects markup, only the fixed named nodes every explorer template
  // creates, so building that fixed skeleton is enough — no need to actually parse HTML.
  set innerHTML(_html) {
    this.children = [];
    const grid = new FakeElement("div"); grid.className = "ge-grid";
    const empty = new FakeElement("div"); empty.className = "ge-empty";
    const sentinel = new FakeElement("div"); sentinel.className = "ge-sentinel";
    const content = new FakeElement("div"); content.className = "ge-content";
    content.appendChild(grid); content.appendChild(empty); content.appendChild(sentinel);
    const closeBtn = new FakeElement("button"); closeBtn.className = "ge-close";
    const actions = new FakeElement("div"); actions.className = "ge-actions";
    actions.appendChild(closeBtn);
    const header = new FakeElement("div"); header.className = "ge-header";
    header.appendChild(actions);
    const dialog = new FakeElement("div"); dialog.className = "genre-explorer";
    dialog.appendChild(header); dialog.appendChild(content);
    this.appendChild(dialog);
  }
  get innerHTML() { return ""; }
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
  replaceChildren(...nodes) { this.children = []; nodes.forEach((n) => this.appendChild(n)); }
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
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const arr = this._listeners[type];
    const i = arr ? arr.indexOf(fn) : -1;
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(evt) { (this._listeners[evt?.type] || []).forEach((fn) => { try { fn(evt); } catch {} }); return true; }
  getBoundingClientRect() { return this._rect; }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  focus() {}
}

function createFragment() {
  const frag = new FakeElement("#fragment");
  frag.__isFragment = true;
  return frag;
}

function installDomEnv() {
  const bodyEl = new FakeElement("body");
  globalThis.document = {
    body: bodyEl,
    head: new FakeElement("head"),
    createElement: (tag) => new FakeElement(tag),
    createDocumentFragment: () => createFragment(),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {
    innerWidth: 1024,
    location: { hash: "" },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { maxTouchPoints: 0, userAgent: "node-test-agent" },
    configurable: true,
  });
  // The exact scenario under test: an observer that is wired up but never once reports a
  // crossing, matching a sentinel that fits inside rootMargin from the very first render.
  globalThis.IntersectionObserver = class {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; }
    observe() {}
    disconnect() {}
    unobserve() {}
  };
}

// ---- Test 1: isSentinelStillInRange(), directly from the real genreExplorer.js ----
console.log("isSentinelStillInRange() — geometry recheck used to keep paging past one screen");
{
  installDomEnv();

  const noopStub = (exports) => toDataUrl(exports.map((n) => `export function ${n}(){}`).join("\n"));
  const doctored = genreExplorerSrc
    .replace(
      `import { makeApiRequest, getSessionInfo, getCachedUserTopGenres } from "../../Plugins/JMSFusion/runtime/api.js";`,
      `import { makeApiRequest, getSessionInfo, getCachedUserTopGenres } from "${noopStub(["makeApiRequest", "getSessionInfo", "getCachedUserTopGenres"])}";`
    )
    .replace(
      `import { getConfig } from "./config.js";`,
      `import { getConfig } from "${toDataUrl("export function getConfig(){ return { languageLabels: {} }; }")}";`
    )
    .replace(`import { withServer } from "./jfUrl.js";`, `import { withServer } from "${noopStub(["withServer"])}";`)
    .replace(`import { openDetailsModal } from "./detailsModalLoader.js";`, `import { openDetailsModal } from "${noopStub(["openDetailsModal"])}";`)
    .replace(`import { faIconHtml } from "./faIcons.js";`, `import { faIconHtml } from "${toDataUrl('export function faIconHtml(){ return ""; }')}";`)
    .replace(`import { resolveSliderAssetHref } from "./assetLinks.js";`, `import { resolveSliderAssetHref } from "${noopStub(["resolveSliderAssetHref"])}";`)
    .replace(`import { formatOfficialRatingLabel } from "./utils.js";`, `import { formatOfficialRatingLabel } from "${noopStub(["formatOfficialRatingLabel"])}";`)
    + `\n// instance:${Math.random()}\n`;

  const mod = await import(toDataUrl(doctored));
  if (typeof mod.isSentinelStillInRange !== "function") {
    fail("isSentinelStillInRange is not exported from genreExplorer.js");
  } else {
    const rect = (props) => ({ getBoundingClientRect: () => props });

    const withinMargin = mod.isSentinelStillInRange(rect({ bottom: 1000 }), rect({ top: 1500 }), 800);
    if (withinMargin !== true) fail(`expected in-range (300px below viewport, 800px margin) to be true, got ${withinMargin}`);
    else ok("sentinel just past the visible area but inside rootMargin still counts as in-range");

    const outOfMargin = mod.isSentinelStillInRange(rect({ bottom: 1000 }), rect({ top: 5000 }), 800);
    if (outOfMargin !== false) fail(`expected far-below sentinel to be out of range, got ${outOfMargin}`);
    else ok("sentinel genuinely far below the margin is correctly out-of-range");

    const missing = mod.isSentinelStillInRange(null, null, 800);
    if (missing !== false) fail(`expected missing scroller/sentinel to be false, got ${missing}`);
    else ok("missing scroller/sentinel is handled without throwing");
  }
}

// ---- Test 2: openSectionExplorer() must page past PAGE_SIZE even though the observer
// never fires a single crossing notification. ----
console.log("\nsectionExplorer's loadMore() must not stall at one page when the IO never crosses");
{
  installDomEnv();

  const PAGE_SIZE = 40;
  const fakeItem = (id) => ({ Id: `item-${id}`, Name: `Item ${id}` });
  const pages = [
    Array.from({ length: PAGE_SIZE }, (_, i) => fakeItem(i)),      // page 1: full page
    Array.from({ length: 15 }, (_, i) => fakeItem(PAGE_SIZE + i)), // page 2: short page -> exhausted
  ];
  let callCount = 0;
  globalThis.__TEST_API_HANDLER__ = async () => {
    const page = pages[callCount] || [];
    callCount++;
    return { Items: page };
  };

  const apiStubUrl = toDataUrl(`
    export function getSessionInfo(){ return { userId: "u1", serverId: "s1" }; }
    export async function makeApiRequest(url, opts){ return globalThis.__TEST_API_HANDLER__(url, opts); }
  `);
  const configStubUrl = toDataUrl(`export function getConfig(){ return { languageLabels: {} }; }`);
  const faIconsStubUrl = toDataUrl(`export function faIconHtml(){ return ""; }`);
  // Mirrors the real isSentinelStillInRange verified directly against genreExplorer.js in
  // Test 1 above; inlined here only because this test replaces genreExplorer.js wholesale to
  // isolate sectionExplorer.js's own retry logic.
  const genreExplorerStubUrl = toDataUrl(`
    export function createCardFor(){ return document.createElement("div"); }
    export function bindExplorerGridDetails(){}
    export function injectGEPerfStyles(){}
    export function registerExplorerCloser(){}
    export function getExplorerPointerOrigin(){ return null; }
    export function isSentinelStillInRange(scroller, sentinel, marginPx = 800) {
      if (!scroller || !sentinel) return false;
      const rootRect = scroller.getBoundingClientRect();
      const rect = sentinel.getBoundingClientRect();
      return rect.top <= rootRect.bottom + marginPx;
    }
  `);

  const doctored = sectionExplorerSrc
    .replace(
      `import { makeApiRequest, getSessionInfo } from "../../Plugins/JMSFusion/runtime/api.js";`,
      `import { makeApiRequest, getSessionInfo } from "${apiStubUrl}";`
    )
    .replace(`import { getConfig } from "./config.js";`, `import { getConfig } from "${configStubUrl}";`)
    .replace(`import { faIconHtml } from "./faIcons.js";`, `import { faIconHtml } from "${faIconsStubUrl}";`)
    .replace(
      `import {
  createCardFor,
  bindExplorerGridDetails,
  injectGEPerfStyles,
  registerExplorerCloser,
  getExplorerPointerOrigin,
  isSentinelStillInRange,
} from "./genreExplorer.js";`,
      `import {
  createCardFor,
  bindExplorerGridDetails,
  injectGEPerfStyles,
  registerExplorerCloser,
  getExplorerPointerOrigin,
  isSentinelStillInRange,
} from "${genreExplorerStubUrl}";`
    )
    + `\n// instance:${Math.random()}\n`;

  const mod = await import(toDataUrl(doctored));
  mod.openSectionExplorer({ title: "Test Section", query: { IncludeItemTypes: "Movie" } });

  // loadMore() recurses through real (instant, in-test) awaits; a few event-loop turns is
  // plenty since nothing here has real network latency.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));

  const totalExpected = pages[0].length + pages[1].length;
  if (callCount !== 2) {
    fail(`expected exactly 2 page requests (one full + one short to exhaust), got ${callCount}`);
  } else {
    ok("stopped after the short page — no runaway fetching past exhaustion");
  }

  // Reach into the fake DOM the same way a real browser test would: query the grid that
  // openSectionExplorer built and count its rendered cards.
  const overlay = globalThis.document.body.children.find((n) => n._classes.has("section-explorer-overlay"));
  const grid = overlay?.querySelector(".ge-grid");
  const rendered = grid ? grid.children.length : 0;
  if (rendered !== totalExpected) {
    fail(`expected all ${totalExpected} items rendered (not stuck at PAGE_SIZE=${PAGE_SIZE}), got ${rendered}`);
  } else {
    ok(`all ${totalExpected} items rendered despite the IntersectionObserver never reporting a crossing`);
  }

  try { mod.closeSectionExplorer(true); } catch {}
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
