// Regression tests for three ways Jellyfin 12.1's fixed MUI AppBar (48px, z-index 1100) ended
// up on top of moui content:
//
//   1. Every explorer overlay (.genre-explorer-overlay, z-index 999) had its header row under
//      the AppBar, so the Buscar input and the close buttons took no clicks.
//   2. syncSliderHeaderOffset() measured only .skinHeader, which 12.1 renders as an empty 0x0
//      div. The offset stayed 0 and the slider started under the header, its top-left badge
//      beneath the Jellyfin logo.
//   3. forceHomeSectionsTop() pulled the home sections up by -10vh even with no slider on the
//      page, putting the first row's title under the header where no scroll could reach it.
//
// (1) is checked against the shipped CSS; (2) and (3) run the real modules against a minimal
// fake DOM, importing them through data: URLs with their ./config.js imports stubbed out.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const sliderDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider");
const read = (rel) => readFileSync(path.join(sliderDir, rel), "utf8");
// encodeURIComponent leaves ' alone, so these URLs must only ever sit inside double quotes.
const toDataUrl = (src) => "data:text/javascript;charset=utf-8," + encodeURIComponent(src);
const configStubUrl = toDataUrl(`export function getConfig(){ return globalThis.__TEST_CONFIG__ || {}; }`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Fake DOM: elements with id/classes/parent, a style map, and a fixed bounding rect. ---
function createStyle() {
  const props = new Map();
  return {
    getPropertyValue: (name) => props.get(name)?.value ?? "",
    getPropertyPriority: (name) => props.get(name)?.priority ?? "",
    setProperty: (name, value, priority = "") => props.set(name, { value: String(value), priority }),
    removeProperty: (name) => { props.delete(name); },
    get top() { return props.get("top")?.value ?? ""; },
  };
}

const registry = [];
function el({ id = "", classes = [], parent = null, rect = { top: 0, bottom: 0, width: 0, height: 0 } } = {}) {
  const node = {
    id, classes: new Set(classes), parentElement: parent, rect, style: createStyle(),
    dataset: {}, isConnected: true,
    getBoundingClientRect: () => ({ left: 0, right: rect.width, ...rect }),
    matches: (sel) => matchesSelector(node, sel),
    querySelector: (sel) => queryAll(sel, node)[0] || null,
    querySelectorAll: (sel) => queryAll(sel, node),
  };
  registry.push(node);
  return node;
}

// Compound: tag-less "#id", ".a.b", ":not(.x)" pieces; descendant combinator by whitespace.
function matchesCompound(node, compound) {
  const nots = [];
  const base = compound.replace(/:not\(([^)]*)\)/g, (_, inner) => { nots.push(inner); return ""; });
  for (const token of base.match(/[#.][\w-]+/g) || []) {
    if (token[0] === "#" && node.id !== token.slice(1)) return false;
    if (token[0] === "." && !node.classes.has(token.slice(1))) return false;
  }
  return nots.every((inner) => !matchesCompound(node, inner));
}
function matchesSelector(node, selector) {
  return selector.split(",").some((part) => {
    const chain = part.trim().split(/\s+/);
    if (!matchesCompound(node, chain.at(-1))) return false;
    let cursor = node.parentElement;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (cursor && !matchesCompound(cursor, chain[i])) cursor = cursor.parentElement;
      if (!cursor) return false;
      cursor = cursor.parentElement;
    }
    return true;
  });
}
function isInside(node, root) {
  for (let cur = node.parentElement; cur; cur = cur.parentElement) if (cur === root) return true;
  return false;
}
function queryAll(selector, root = null) {
  return registry.filter((n) => n.isConnected && (!root || isInside(n, root)) && matchesSelector(n, selector));
}

function installGlobals() {
  const noop = () => {};
  const docEl = { style: createStyle(), dataset: {} };
  globalThis.document = {
    readyState: "complete", visibilityState: "visible",
    documentElement: docEl, body: {}, scrollingElement: { scrollTop: 0 },
    addEventListener: noop,
    querySelector: (sel) => queryAll(sel)[0] || null,
    querySelectorAll: (sel) => queryAll(sel),
  };
  const computed = (node) => ({
    display: "block", visibility: "visible", top: node?.style?.top || "",
    getPropertyValue: (name) => node?.style?.getPropertyValue?.(name) || "",
  });
  globalThis.window = {
    scrollY: 0, pageYOffset: 0, location: { hash: "#/home", pathname: "/web/", search: "" },
    addEventListener: noop, matchMedia: () => ({ matches: false }), getComputedStyle: computed,
  };
  globalThis.getComputedStyle = computed;
  globalThis.localStorage = { getItem: () => null };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
}

installGlobals();
globalThis.__TEST_CONFIG__ = { cssVariant: "normalslider", slideTop: 0, enableSlider: true };

const overridesSrc = read("modules/positionOverrides.js").replace(`from './config.js'`, `from "${configStubUrl}"`);
const overridesUrl = toDataUrl(overridesSrc);
const utilsSrc = read("modules/positionUtils.js")
  .replace(`from "./config.js"`, `from "${configStubUrl}"`)
  .replace(`from './positionOverrides.js'`, `from "${overridesUrl}"`);
const { forceHomeSectionsTop } = await import(overridesUrl);
const { syncSliderHeaderOffset } = await import(toDataUrl(utilsSrc));

// ---------------------------------------------------------------------------------------------
console.log("1. explorer overlays are not covered by the MUI AppBar");
{
  const overlayZ = Number(/\.genre-explorer-overlay\{[^}]*z-index:(\d+)/.exec(read("src/personalRecommendations.css"))?.[1]);
  const headerCss = read("src/headerNav.css");
  const rule = /([^{}]*:has\(\.genre-explorer-overlay\)[^{}]*\.MuiAppBar-root[^{}]*)\{([^}]*)\}/.exec(headerCss);
  const loweredZ = Number(/z-index:\s*(\d+)/.exec(rule?.[2] || "")?.[1]);

  if (!Number.isFinite(overlayZ)) fail("could not read .genre-explorer-overlay z-index");
  else if (!rule) fail("headerNav.css has no rule lowering .MuiAppBar-root while an explorer overlay is open");
  else if (!(loweredZ < overlayZ)) fail(`AppBar lowered to ${loweredZ}, not below the overlay's ${overlayZ}`);
  else ok(`AppBar drops to ${loweredZ} under the overlay's ${overlayZ} while one is open`);

  const opens = (headerCss.match(/\(/g) || []).length;
  const closes = (headerCss.match(/\)/g) || []).length;
  if (opens !== closes) fail(`headerNav.css parens unbalanced (${opens} open, ${closes} close)`);
  else ok("headerNav.css parens balanced");
}

// ---------------------------------------------------------------------------------------------
console.log("2. the slider header offset measures 12.1's MUI AppBar");
{
  const indexPage = el({ id: "indexPage", classes: ["page"] });
  el({ classes: ["skinHeader"], rect: { top: 0, bottom: 0, width: 0, height: 0 } });
  el({ classes: ["MuiAppBar-root"], rect: { top: 0, bottom: 48, width: 1920, height: 48 } });
  const slider = el({ id: "monwui-slides-container", parent: indexPage, rect: { top: 14, bottom: 658, width: 1920, height: 644 } });

  syncSliderHeaderOffset(slider);
  const offset = slider.style.getPropertyValue("--jms-slider-header-offset-px");
  if (offset !== "34px") fail(`expected the slider pushed 34px below the 48px AppBar, got "${offset}"`);
  else ok("slider offset is 34px: its top clears the AppBar");

  registry.length = 0;
}

// ---------------------------------------------------------------------------------------------
console.log("3. home sections are only pulled up when a slider is on the page");
{
  const indexPage = el({ id: "indexPage", classes: ["page"] });
  const sections = el({ classes: ["homeSectionsContainer"], parent: indexPage });

  forceHomeSectionsTop();
  await sleep(500);
  if (sections.style.top) fail(`no slider, yet sections got top "${sections.style.top}"`);
  else ok("no slider: sections keep their natural position");

  el({ id: "monwui-slides-container", parent: indexPage, rect: { top: 48, bottom: 692, width: 1920, height: 644 } });
  forceHomeSectionsTop();
  await sleep(500);
  if (!sections.style.top.includes("-10vh")) fail(`slider mounted, expected the -10vh pull, got "${sections.style.top}"`);
  else ok("slider mounted: the -10vh pull comes back");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
