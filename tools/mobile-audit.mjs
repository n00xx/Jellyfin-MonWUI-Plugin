#!/usr/bin/env node
// Renders moui on phone, tablet and desktop profiles against a live Jellyfin server and reports
// what breaks mechanically: horizontal overflow, tap targets too small for a finger, UI spilling
// out of the header, controls under an iPhone's notch or home bar, overlays that the Back button
// does not close, close buttons that cannot be tapped, and page errors.
//
// WebKit stands in for iOS layout, Chromium for Android. Neither is the Jellyfin app's WebView.
// Playwright reports env(safe-area-inset-*) as 0, so the "· notch" profiles run the iPhone
// viewport in Chromium with real insets injected over CDP (Emulation.setSafeAreaInsetsOverride):
// that is the only way to see whether moui's CSS actually respects the notch.
//
// Usage:
//   JF_BASE=http://host:8096 JF_USER=… JF_PASS=… PW_MODULE=/abs/path/to/playwright-core \
//     node tools/mobile-audit.mjs [--out DIR] [--only "iPhone 15 Pro,Pixel 7"] [--screens home,explorer]
//
// Credentials are read from the environment only; nothing is written to disk but the report.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.JF_BASE || "").replace(/\/+$/, "");
const USER = process.env.JF_USER || "";
const PASS = process.env.JF_PASS || "";
if (!BASE || !USER || !process.env.PW_MODULE) {
  console.error("JF_BASE, JF_USER, JF_PASS and PW_MODULE are required");
  process.exit(2);
}
// WebKit's document.fonts.ready never settles on this page, and Playwright waits for it before
// every screenshot. The fonts themselves render; only the readiness promise hangs.
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ??= "1";
const { webkit, chromium, devices } = await import(process.env.PW_MODULE);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT = path.resolve(arg("--out", "mobile-audit-out"));
const ONLY = arg("--only", "").split(",").map((s) => s.trim()).filter(Boolean);
const ALL_SCREENS = ["home", "detail", "notifications", "search", "explorer", "studio", "card", "profile", "watchlist"];
const SCREENS = arg("--screens", ALL_SCREENS.join(",")).split(",").map((s) => s.trim());
// --local serves the plugin's front end from this checkout instead of the server, so a change
// can be measured against real data before anything is installed.
const LOCAL = process.argv.includes("--local");
mkdirSync(OUT, { recursive: true });

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_TYPES = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html" };

// The server serves /slider~v-<version>/… straight from Resources/slider, and rewrites the
// runtime modules' "../../../slider/" imports to that versioned segment; doing the same here
// keeps one module instance per file, as on the server.
async function routeToLocalCheckout(context) {
  const index = await (await fetch(`${BASE}/web/index.html`)).text();
  const segment = (index.match(/slider~v-[^/"']+/) || [])[0];
  if (!segment) throw new Error("--local: no versioned slider segment in index.html");
  // Modules load from the versioned segment; stylesheets from /slider/src/…?v=… (or under /web/).
  await context.route(/\/(slider(~v-[^/]+)?|Plugins\/JMSFusion\/runtime)\/[^?#]+/, async (route) => {
    const { pathname } = new URL(route.request().url());
    const slider = pathname.match(/\/slider(?:~v-[^/]+)?\/(.+)$/);
    const runtime = pathname.match(/\/Plugins\/JMSFusion\/runtime\/(.+)$/);
    const file = slider ? path.join(REPO, "Resources/slider", slider[1]) : path.join(REPO, "RuntimeModules", runtime[1]);
    const type = LOCAL_TYPES[path.extname(file)];
    if (!type || !file.startsWith(REPO) || !existsSync(file)) return route.continue();
    let body = readFileSync(file, "utf8");
    if (runtime) body = body.replace(/(["'])((?:\.\.\/)+)slider\//g, `$1$2${segment}/`);
    return route.fulfill({ status: 200, contentType: type, body });
  });
}

// Insets of a notched iPhone in CSS px.
const NOTCH_PORTRAIT = { top: 59, bottom: 34, left: 0, right: 0 };
const NOTCH_LANDSCAPE = { top: 0, bottom: 21, left: 59, right: 59 };

const MATRIX = [
  { name: "iPhone SE", device: "iPhone SE", engine: "webkit" },
  { name: "iPhone 15 Pro", device: "iPhone 15 Pro", engine: "webkit" },
  { name: "iPhone 15 Pro landscape", device: "iPhone 15 Pro landscape", engine: "webkit" },
  { name: "iPhone 15 Pro · notch", device: "iPhone 15 Pro", engine: "chromium", safeArea: NOTCH_PORTRAIT },
  { name: "iPhone 15 Pro landscape · notch", device: "iPhone 15 Pro landscape", engine: "chromium", safeArea: NOTCH_LANDSCAPE },
  { name: "Pixel 7", device: "Pixel 7", engine: "chromium" },
  { name: "Pixel 7 landscape", device: "Pixel 7 landscape", engine: "chromium" },
  { name: "iPad Mini", device: "iPad Mini", engine: "webkit" },
  { name: "iPad (gen 11)", device: "iPad (gen 11)", engine: "webkit" },
  { name: "iPad Pro 11 landscape", device: "iPad Pro 11 landscape", engine: "webkit" },
  { name: "Galaxy Tab S9", device: "Galaxy Tab S9", engine: "chromium" },
  { name: "Galaxy Tab S9 landscape", device: "Galaxy Tab S9 landscape", engine: "chromium" },
  { name: "Desktop 1440", profile: { viewport: { width: 1440, height: 900 } }, engine: "chromium" },
].filter((d) => !ONLY.length || ONLY.includes(d.name));

// What opens each overlay, tried in order; the first visible match is clicked.
const OPENERS = {
  notifications: ["#jfNotifBtn"],
  search: [".MuiAppBar-root a[aria-label=Search]", ".MuiAppBar-root [aria-label=Search]", "a[href*='search']"],
  explorer: [".dir-row-see-all", "[class*=see-all]"],
  studio: ["a.hub-card"],
  card: ["[id^=recent-rows--] a[href*='details']", "[id^=recent-rows--] [data-id]", "[id^=recent-rows--] .card"],
  profile: ["#jfProfileChooserBtn"],
  // On a phone the Watchlist link lives in the navigation drawer.
  watchlist: [".monwui-watchlist-nav-button", async (page) => {
    const menu = page.locator(".MuiAppBar-root [aria-label='Open Menu']").first();
    if (!(await menu.isVisible().catch(() => false))) return null;
    await menu.click();
    await page.waitForTimeout(800);
    const link = page.locator(".MuiDrawer-root a, .MuiDrawer-root [role=button]").filter({ hasText: /watchlist|izleme|ver más tarde/i }).first();
    return (await link.isVisible().catch(() => false)) ? link : null;
  }],
};

const SETTLE_MS = 1500;
const SETTLE_CAP_MS = 25000;
const OVERLAY_SETTLE_CAP_MS = 8000;
const MIN_TARGET = 44;
const BACK_WAIT_MS = 1500;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The server shows its own "you are using the web browser" notice (not moui). Accepting it is
// remembered, so it is done once at login and again only if it comes back.
async function dismissServerNotices(page) {
  const accept = page.getByRole("button", { name: /^\s*Aceptar\s*$/ });
  if (await accept.first().isVisible().catch(() => false)) {
    await accept.first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

// Waits until the DOM stops growing, so lazily mounted moui rows are measured too.
async function settle(page, cap = SETTLE_CAP_MS) {
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - started < cap) {
    const count = await page.evaluate(() => document.getElementsByTagName("*").length).catch(() => -1);
    if (count !== last) { last = count; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= SETTLE_MS) return;
    await page.waitForTimeout(250);
  }
}

async function login(browserType) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...devices["iPhone 15 Pro"] });
  const page = await context.newPage();
  await page.goto(`${BASE}/web/#/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#txtManualName", USER);
  await page.fill("#txtManualPassword", PASS);
  await page.click("form .button-submit[type=submit]:visible");
  await page.waitForFunction(() => !/#\/login/.test(location.hash) && !!window.ApiClient?.getCurrentUserId?.(), null, { timeout: 30000 });
  await settle(page);
  await dismissServerNotices(page);
  const state = await context.storageState();
  await browser.close();
  return state;
}

// Runs in the page: tags the topmost element covering most of the viewport. Elements already
// tagged "before" are the page itself, so a new one after a click is the overlay.
function tagCoveringLayers(attr) {
  const vw = innerWidth, vh = innerHeight;
  const found = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (w * h >= 0.5 * vw * vh) { el.setAttribute(attr, "1"); found.push(el); }
  }
  return found.length;
}

// Runs in the page. Measures, never changes layout (it only reads and sets data-audit-* tags).
function measure({ insets, minTarget, rootSelector }) {
  const vw = innerWidth;
  const vh = innerHeight;
  const root = (rootSelector && document.querySelector(rootSelector)) || document.body;
  const MOUI = /monwui|jms|^jf-|jfNotif|jfProfile|slide|recent-rows|continue-rows|top10|dir-row|genre-hub|studio-hub|library-hub|personal-rec|watchlist|hub-|prc-|gh-|sx-|seerr|serr|genre-explorer|notif|pause|cast/i;

  const describe = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).map((c) => `.${c}`).join("") : "";
    const label = el.getAttribute("aria-label") || "";
    return `${el.tagName.toLowerCase()}${id}${cls}${label ? ` [${label.slice(0, 30)}]` : ""}`;
  };
  const owner = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const tokens = [n.id, ...(typeof n.className === "string" ? n.className.split(/\s+/) : [])].filter(Boolean);
      const hit = tokens.find((t) => MOUI.test(t));
      if (hit) return hit;
    }
    return null;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  // An element hanging past the viewport is fine inside a horizontal scroller or a clipping box.
  const clippedX = (el) => {
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).overflowX !== "visible") return true;
    }
    return false;
  };
  const isFixed = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).position === "fixed") return true;
    }
    return false;
  };
  // Content in a scroller can be scrolled out from under the home bar; fixed chrome cannot.
  const inScroller = (el) => {
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return true;
      if (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
      if (cs.position === "fixed") return false;
    }
    return false;
  };
  const rectOf = (r) => [r.left, r.top, r.width, r.height].map(Math.round);
  // Is the element the thing a finger at its centre would actually hit?
  const hittable = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return !!top && (top === el || el.contains(top));
  };

  const all = [...root.querySelectorAll("*")];
  const overflow = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 2 || r.left < -2) && r.width > 0 && visible(el) && !clippedX(el)) {
      overflow.push({ el: describe(el), owner: owner(el), left: Math.round(r.left), right: Math.round(r.right) });
    }
  }

  const interactive = all.filter((el) => el.matches("button, a[href], [role=button], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])"));
  const small = [];
  const underInsets = [];
  const offscreenFixed = [];
  for (const el of interactive) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    if (!onScreen) {
      if (isFixed(el)) offscreenFixed.push({ el: describe(el), owner: owner(el), rect: rectOf(r) });
      continue;
    }
    if (Math.min(r.width, r.height) < minTarget) small.push({ el: describe(el), owner: owner(el), w: Math.round(r.width), h: Math.round(r.height) });
    if (insets && isFixed(el) && !inScroller(el)) {
      const edges = [];
      if (insets.top && r.top < insets.top) edges.push("top");
      if (insets.bottom && r.bottom > vh - insets.bottom) edges.push("bottom");
      if (insets.left && r.left < insets.left) edges.push("left");
      if (insets.right && r.right > vw - insets.right) edges.push("right");
      if (edges.length) underInsets.push({ el: describe(el), owner: owner(el), edges, rect: rectOf(r) });
    }
  }

  // moui puts buttons into Jellyfin's header; on a narrow header they can fall out of it.
  const bar = document.querySelector(".MuiAppBar-root") || document.querySelector(".skinHeader");
  const headerSpill = [];
  if (bar && !rootSelector) {
    const b = bar.getBoundingClientRect();
    for (const el of [...bar.querySelectorAll("button, a[href]"), ...document.querySelectorAll("#jfProfileChooserBtn, #jfNotifBtn")]) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > b.bottom + 2 || r.top < b.top - 2 || r.right > vw + 1) headerSpill.push({ el: describe(el), owner: owner(el), rect: rectOf(r), header: rectOf(b) });
    }
  }

  // The way out of an overlay: a visible close control a finger can actually hit.
  let close = null;
  if (rootSelector && root !== document.body) {
    const candidates = all.filter((el) => visible(el) && (
      /close|cerrar|kapat|dismiss|back/i.test(`${el.getAttribute("aria-label") || ""} ${el.title || ""} ${typeof el.className === "string" ? el.className : ""}`)
      || /^\s*[✕×✖]\s*$/.test(el.textContent || "")));
    const best = candidates.find((el) => el.matches("button, a, [role=button]")) || candidates[0];
    if (best) {
      const r = best.getBoundingClientRect();
      const edges = [];
      if (insets?.top && r.top < insets.top) edges.push("top");
      if (insets?.left && r.left < insets.left) edges.push("left");
      if (insets?.right && r.right > vw - insets.right) edges.push("right");
      close = { el: describe(best), rect: rectOf(r), hittable: hittable(best), underInsets: edges, size: Math.round(Math.min(r.width, r.height)) };
    } else {
      close = { el: null };
    }
  }

  // The overlay's main panel, to compare geometry between runs (a desktop fix must not move it).
  const panelEl = rootSelector ? root.querySelector(".genre-explorer, .jmsdm-card, .monwuiwl-card, .jf-profile-shell, .jf-notif-panel") : null;

  return {
    viewport: [vw, vh],
    panel: panelEl ? { el: describe(panelEl), rect: rectOf(panelEl.getBoundingClientRect()) } : null,
    scrollWidth: document.documentElement.scrollWidth,
    pageOverflowX: !rootSelector && document.documentElement.scrollWidth > vw + 1,
    overflow: overflow.slice(0, 40),
    overflowCount: overflow.length,
    smallTargets: small,
    underInsets,
    offscreenFixed,
    headerSpill,
    close,
    ric: typeof window.requestIdleCallback,
  };
}

async function firstMovieId(page) {
  return page.evaluate(async () => {
    const api = window.ApiClient;
    const res = await api.getItems(api.getCurrentUserId(), {
      IncludeItemTypes: "Movie", Recursive: true, Limit: 1, SortBy: "SortName", ImageTypes: "Backdrop",
    });
    return res?.Items?.[0]?.Id || null;
  });
}

async function openOverlay(page, screen) {
  for (const opener of OPENERS[screen]) {
    const sel = typeof opener === "string" ? opener : `${screen} (via drawer)`;
    const target = typeof opener === "string" ? page.locator(opener).first() : await opener(page);
    if (target && await target.isVisible().catch(() => false)) {
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await page.evaluate(tagCoveringLayers, "data-audit-before");
      const hashBefore = await page.evaluate(() => location.hash);
      await target.click({ timeout: 5000 }).catch(() => target.dispatchEvent("click"));
      // With a mouse, the pointer left over a card opens its hover preview on top of the overlay
      // (and over the bell it re-opens the notifications panel). Park it in a corner.
      await page.mouse.move(1, (page.viewportSize()?.height || 600) - 1).catch(() => {});
      await page.waitForTimeout(1200);
      await settle(page, OVERLAY_SETTLE_CAP_MS);
      // An opening scale animation moves the close button under elementFromPoint, which would
      // report it as covered. Measure once the overlay has come to rest.
      await page.waitForFunction(
        () => !document.getAnimations?.().some((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming?.().endTime)),
        null,
        { timeout: 3000 }
      ).catch(() => {});
      await page.evaluate(tagCoveringLayers, "data-audit-before-skip");
      // Layers that are new since the click: tagged by the second pass only.
      const overlay = await page.evaluate(() => {
        const fresh = [...document.querySelectorAll("[data-audit-before-skip]")].filter((el) => !el.hasAttribute("data-audit-before"));
        const top = fresh.sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0))[0];
        if (top) top.setAttribute("data-audit-root", "1");
        return top ? (top.id ? `#${top.id}` : `${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/)[0]}`) : null;
      });
      const hashAfter = await page.evaluate(() => location.hash);
      return { opener: sel, overlay, from: hashBefore, navigated: hashAfter !== hashBefore ? hashAfter.slice(0, 60) : null };
    }
  }
  return null;
}

// Android's Back button is history.back() inside the page. The overlay is opened on a home page
// the SPA reached from a details page, so the history entry under it is a real route. Only
// "closes" is right: the overlay goes away and the user stays on home. Anything else is the bug
// a phone user hits -- the overlay stays up, or Back also throws them off the page.
// A screen that opened as its own route (Jellyfin's search page) is right to go back to the
// page it was opened from.
async function backTest(page, opened) {
  const hashBefore = await page.evaluate(() => location.hash);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(BACK_WAIT_MS);
  return page.evaluate(({ before, from, isRoute }) => {
    const root = document.querySelector("[data-audit-root]");
    const cs = root && getComputedStyle(root);
    const open = !!root && root.isConnected && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 && root.getBoundingClientRect().width > 0;
    if (isRoute) return !open && location.hash === from ? "closes (route)" : `ROUTE BACK WENT TO ${location.hash.slice(0, 40)}`;
    const moved = location.hash !== before;
    return open ? (moved ? "STAYS OPEN, page navigated underneath" : "STAYS OPEN") : (moved ? "CLOSES BUT LEAVES THE PAGE" : "closes");
  }, { before: hashBefore, from: opened.from, isRoute: !!opened.navigated });
}

async function loadForScreen(page, screen, routes) {
  if (OPENERS[screen] && routes.detail) {
    await page.goto(`${BASE}/web/${routes.detail}`, { waitUntil: "domcontentloaded" });
    await settle(page, OVERLAY_SETTLE_CAP_MS);
    await page.evaluate(() => { location.hash = "#/home"; });
  } else {
    await page.goto(`${BASE}/web/${screen === "detail" ? routes.detail : "#/home"}`, { waitUntil: "domcontentloaded" });
  }
  await settle(page);
  await dismissServerNotices(page);
}

async function auditScreen(page, device, screen, routes, dir) {
  if (screen === "detail" && !routes.detail) return { skipped: "no movie found" };
  // A hash-only goto keeps the document, and with it whatever overlay the last screen left open.
  // Done before listening, so the previous page's aborted requests are not counted here.
  await page.goto("about:blank");
  const insets = device.safeArea || null;
  const failures = [];
  const onError = (e) => failures.push(String(e?.message || e).slice(0, 300));
  const onConsole = (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) failures.push(`console: ${m.text().slice(0, 300)}`); };
  // Failed responses with their URL (the console line has none). Query strings can carry tokens.
  const onResponse = (r) => { if (r.status() >= 400) failures.push(`http ${r.status()} ${r.request().method()} ${r.url().replace(BASE, "").split("?")[0]}`); };
  page.on("pageerror", onError);
  page.on("console", onConsole);
  page.on("response", onResponse);
  try {
    await loadForScreen(page, screen, routes);

    let opened = null;
    if (OPENERS[screen]) {
      opened = await openOverlay(page, screen);
      if (!opened) return { skipped: "opener not visible" };
    }
    const rootSelector = opened?.overlay ? "[data-audit-root]" : null;
    const m = await page.evaluate(measure, { insets, minTarget: MIN_TARGET, rootSelector });
    const shot = await page.screenshot({ path: path.join(dir, `${screen}.png`), timeout: 15000 })
      .then(() => null, (e) => String(e?.message || e).split("\n")[0]);
    const back = opened?.overlay ? await backTest(page, opened) : null;
    return { ...m, ...(opened ? { opened } : {}), ...(back ? { back } : {}), errors: failures, ...(shot ? { screenshotError: shot } : {}) };
  } finally {
    page.off("pageerror", onError);
    page.off("console", onConsole);
    page.off("response", onResponse);
  }
}

async function auditDevice(device, state, browsers) {
  const profile = device.profile || devices[device.device];
  const context = await browsers[device.engine].newContext({ ...profile, storageState: state });
  if (LOCAL) await routeToLocalCheckout(context);
  const page = await context.newPage();
  if (device.safeArea) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: device.safeArea });
  }
  const dir = path.join(OUT, slug(device.name));
  mkdirSync(dir, { recursive: true });
  const routes = {};
  if (SCREENS.includes("detail")) {
    await page.goto(`${BASE}/web/#/home`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.ApiClient?.getCurrentUserId?.(), null, { timeout: 20000 }).catch(() => {});
    const id = await firstMovieId(page).catch(() => null);
    if (id) routes.detail = `#/details?id=${id}`;
  }
  const results = {};
  for (const screen of SCREENS) {
    try {
      results[screen] = await auditScreen(page, device, screen, routes, dir);
    } catch (e) {
      results[screen] = { failed: String(e?.message || e).split("\n")[0].slice(0, 300) };
    }
  }
  await context.close();
  return results;
}

function summarize(x) {
  if (!x) return "FAILED";
  if (x.failed) return `FAILED(${x.failed.slice(0, 40)})`;
  if (x.skipped) return "skip";
  const bits = [];
  if (x.pageOverflowX) bits.push(`overflowX=${x.scrollWidth}`);
  if (x.overflowCount) bits.push(`hang=${x.overflowCount}`);
  bits.push(`small=${x.smallTargets.length}`);
  if (x.underInsets.length) bits.push(`notch=${x.underInsets.length}`);
  if (x.headerSpill?.length) bits.push(`spill=${x.headerSpill.length}`);
  if (x.close) bits.push(x.close.el ? `close=${x.close.size}px${x.close.hittable ? "" : ",BLOCKED"}${x.close.underInsets?.length ? ",NOTCH" : ""}` : "close=NONE");
  if (x.back) bits.push(`back=${x.back}`);
  if (x.errors.length) bits.push(`err=${x.errors.length}`);
  return bits.join(" ");
}

const browsers = {};
const needed = new Set(MATRIX.map((d) => d.engine));
if (needed.has("webkit")) browsers.webkit = await webkit.launch();
if (needed.has("chromium")) browsers.chromium = await chromium.launch();
const state = await login(needed.has("webkit") ? webkit : chromium);

const report = { base: BASE, source: LOCAL ? "local checkout" : "server", at: new Date().toISOString(), screens: SCREENS, devices: {} };
for (const device of MATRIX) {
  try {
    report.devices[device.name] = await auditDevice(device, state, browsers);
  } catch (e) {
    report.devices[device.name] = { failed: String(e?.message || e).slice(0, 400) };
  }
  const r = report.devices[device.name];
  console.log(`\n${device.name}${r.failed ? `  FAILED ${r.failed}` : ""}`);
  if (!r.failed) for (const s of SCREENS) console.log(`  ${s.padEnd(14)} ${summarize(r[s])}`);
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
}
for (const b of Object.values(browsers)) await b.close();
console.log(`\nreport: ${path.join(OUT, "report.json")}`);
