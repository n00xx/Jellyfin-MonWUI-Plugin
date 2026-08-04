/**
 * Section explorer — the MonWUI surface behind every home-row "See All".
 *
 * Those chevrons used to hand the user off to Jellyfin's native `#/movies`, `#/tv` and
 * `#/list.html` pages, which drops them out of the MonWUI look and loses the details modal.
 * Now they open this overlay instead, and the native hash survives on the descriptor as a
 * `fallbackHash` used only when the explorer genuinely cannot render.
 *
 * The overlay chrome deliberately reuses the `.genre-explorer` / `.ge-*` classes and the card
 * factory from genreExplorer.js so the four existing explorers and this one stay visually
 * identical and share one stylesheet.
 */

import { makeApiRequest, getSessionInfo } from "../../Plugins/JMSFusion/runtime/api.js";
import { getConfig } from "./config.js";
import { faIconHtml } from "./faIcons.js";
import {
  createCardFor,
  bindExplorerGridDetails,
  injectGEPerfStyles,
  registerExplorerCloser,
  getExplorerPointerOrigin,
  isSentinelStillInRange,
} from "./genreExplorer.js";

const PAGE_SIZE = 40;
const MAX_CARDS = 600;
const SEARCH_DEBOUNCE_MS = 280;

const COMMON_FIELDS = [
  "PrimaryImageAspectRatio",
  "ImageTags",
  "CommunityRating",
  "Genres",
  "OfficialRating",
  "ProductionYear",
  "CumulativeRunTimeTicks",
  "RunTimeTicks",
].join(",");

/** `/Shows/NextUp` is a different endpoint with its own shape, so descriptors name it. */
export const SECTION_ENDPOINT_NEXT_UP = "nextUp";

let __overlay = null;
let __abort = null;
let __io = null;
let __descriptor = null;
let __serverId = "";
let __startIndex = 0;
let __exhausted = false;
let __isClosing = false;
let __searchTerm = "";
let __searchTimer = null;
let __seenIds = new Set();
let __renderedAnything = false;
let __scrollFallbackHandler = null;
let __stallWarned = false;

/**
 * Incremented on every reset (a new search term). Every in-flight request carries the token it
 * started under, so a response that arrives after the user typed again is dropped instead of
 * being appended to the wrong result set.
 */
let __queryToken = 0;
/** Holds the token of the request currently in flight; never a plain boolean, so an aborted
 *  request that settles late cannot clear the busy flag of the request that replaced it. */
let __busyToken = -1;

function labels() {
  return getConfig()?.languageLabels || {};
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isNextUp(descriptor) {
  return descriptor?.endpoint === SECTION_ENDPOINT_NEXT_UP;
}

function isSearchable(descriptor) {
  // Next Up has no SearchTerm equivalent, so it renders without the box rather than
  // shipping an input that silently ignores what the user types.
  return descriptor?.searchable !== false && !isNextUp(descriptor);
}

function buildRequestUrl({ startIndex, searchTerm }) {
  const { userId } = getSessionInfo();
  const params = new URLSearchParams();

  params.set("Fields", COMMON_FIELDS);
  params.set("EnableUserData", "true");
  params.set("ImageTypeLimit", "1");
  params.set("EnableImageTypes", "Primary,Backdrop,Logo");

  for (const [key, value] of Object.entries(__descriptor?.query || {})) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }

  if (searchTerm) {
    // The scope params above are set first and stay set — a SearchTerm without them would
    // search the whole server, which is exactly what "search only inside this section" rules out.
    params.set("SearchTerm", searchTerm);
    // Falling back to SortName here silently re-sorted the results alphabetically, so searching
    // inside a "Recently Added" grid stopped showing newest-first — the one ordering that row is
    // about. Inherit the descriptor's own sort so the search keeps the order the grid opened with;
    // SortName stays the last resort for descriptors that declare no sort at all.
    params.set(
      "SortBy",
      __descriptor?.searchSortBy || __descriptor?.query?.SortBy || "SortName"
    );
    params.set(
      "SortOrder",
      __descriptor?.searchSortOrder || __descriptor?.query?.SortOrder || "Ascending"
    );
  }

  params.set("Limit", String(PAGE_SIZE));
  params.set("StartIndex", String(startIndex));

  if (isNextUp(__descriptor)) {
    params.set("UserId", String(userId || ""));
    return `/Shows/NextUp?${params.toString()}`;
  }
  return `/Users/${encodeURIComponent(userId || "")}/Items?${params.toString()}`;
}

function pruneGridIfNeeded() {
  const grid = __overlay?.querySelector(".ge-grid");
  if (!grid) return;
  const extra = grid.children.length - MAX_CARDS;
  for (let i = 0; i < extra; i++) {
    const el = grid.firstElementChild;
    if (!el) break;
    try { el.dispatchEvent(new Event("jms:cleanup")); } catch {}
    el.remove();
  }
}

function clearGrid() {
  const grid = __overlay?.querySelector(".ge-grid");
  if (!grid) return;
  for (const el of Array.from(grid.children)) {
    try { el.dispatchEvent(new Event("jms:cleanup")); } catch {}
  }
  grid.replaceChildren();
}

function setStatus(message) {
  const empty = __overlay?.querySelector(".ge-empty");
  if (!empty) return;
  if (!message) {
    empty.style.display = "none";
    empty.textContent = "";
    return;
  }
  empty.textContent = message;
  empty.style.display = "";
}

function emptyMessage() {
  const l = labels();
  if (__searchTerm) return l.sectionSearchEmpty || "Bu bölümde sonuç yok";
  return l.noResults || "İçerik bulunamadı";
}

function renderIntoGrid(items) {
  const grid = __overlay?.querySelector(".ge-grid");
  if (!grid) return;

  if (items.length) {
    const frag = document.createDocumentFragment();
    for (const item of items) frag.appendChild(createCardFor(item, __serverId));
    grid.appendChild(frag);
    pruneGridIfNeeded();
    __renderedAnything = true;
  }

  setStatus(grid.children.length ? "" : emptyMessage());
}

/**
 * A failed *first* load with no search active means the explorer never got off the ground, so
 * hand the user to the native Jellyfin page rather than showing an empty overlay. Anything
 * later — a failed page 3, a failed search — reports inline; bouncing to Jellyfin mid-browse
 * would throw away the scroll position and read as a crash. An empty result set is not a
 * failure and never reaches here.
 */
function handleLoadFailure(error) {
  console.warn("sectionExplorer: fetch error:", error);
  if (!__renderedAnything && !__searchTerm) {
    // Both have to be captured before closing — closeSectionExplorer nulls __descriptor, and
    // losing onFallback would drop back to a raw hash write with no serverId in it.
    const fallbackHash = __descriptor?.fallbackHash;
    const onFallback = __descriptor?.onFallback;
    closeSectionExplorer(true);
    navigateToFallback(fallbackHash, onFallback);
    return;
  }
  setStatus(labels().sectionSearchError || labels().errorLoading || "İçerik yüklenemedi");
}

function navigateToFallback(fallbackHash, onFallback) {
  if (!fallbackHash) return;
  if (typeof onFallback === "function") {
    try { onFallback(fallbackHash); return; } catch (err) {
      console.warn("sectionExplorer: fallback handler failed:", err);
    }
  }
  try { window.location.hash = fallbackHash; } catch {}
}

async function loadMore() {
  if (!__overlay || __exhausted) return;
  if (__busyToken === __queryToken) return;

  const token = __queryToken;
  __busyToken = token;

  if (__abort) { try { __abort.abort(); } catch {} }
  const controller = new AbortController();
  __abort = controller;

  try {
    const url = buildRequestUrl({ startIndex: __startIndex, searchTerm: __searchTerm });
    const data = await makeApiRequest(url, { signal: controller.signal });
    if (token !== __queryToken || !__overlay) return;

    const items = (Array.isArray(data?.Items) ? data.Items : []).filter((it) => it?.Id);
    __startIndex += items.length;

    const fresh = items.filter((it) => !__seenIds.has(String(it.Id)));
    for (const it of fresh) __seenIds.add(String(it.Id));
    renderIntoGrid(fresh);

    if (items.length < PAGE_SIZE) {
      __exhausted = true;
      try { __io?.disconnect(); } catch {}
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (token === __queryToken) handleLoadFailure(error);
  } finally {
    // Only the request that still owns the current token may clear the flag. A superseded
    // request leaves the stale token behind, which no longer matches and so blocks nothing.
    if (token === __queryToken) __busyToken = -1;
  }

  if (!__exhausted && __overlay && token === __queryToken) {
    const scroller = __overlay.querySelector(".ge-content");
    const sentinel = __overlay.querySelector(".ge-sentinel");
    if (isSentinelStillInRange(scroller, sentinel)) loadMore();
  }
}

function observeSentinel() {
  if (!__overlay) return;
  try { __io?.disconnect(); } catch {}
  const scroller = __overlay.querySelector(".ge-content");
  const sentinel = __overlay.querySelector(".ge-sentinel");
  if (!scroller || !sentinel) return;
  __io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) loadMore();
    }
  }, { root: scroller, rootMargin: "800px 0px" });
  __io.observe(sentinel);

  // Belt-and-suspenders: loadMore()'s own geometry recheck should already keep paging
  // until the sentinel truly leaves the 800px margin, so this should never fire. It exists
  // to turn a future regression (or an explorer variant this pattern hasn't reached yet)
  // into a loud console signal instead of a silently truncated grid.
  if (__scrollFallbackHandler) {
    try { scroller.removeEventListener("scroll", __scrollFallbackHandler); } catch {}
  }
  __scrollFallbackHandler = () => {
    if (__exhausted || __busyToken === __queryToken) return;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    if (!atBottom) return;
    if (!__stallWarned) {
      __stallWarned = true;
      console.warn("[MonWUI] See All pagination stalled: reached the bottom without exhausting results — recovering via scroll fallback.");
    }
    loadMore();
  };
  scroller.addEventListener("scroll", __scrollFallbackHandler, { passive: true });
}

function resetResults() {
  if (!__overlay) return;
  __queryToken += 1;
  __startIndex = 0;
  __exhausted = false;
  __stallWarned = false;
  __seenIds = new Set();
  if (__abort) { try { __abort.abort(); } catch {} }
  __abort = null;
  clearGrid();
  setStatus("");
  try { __overlay.querySelector(".ge-content").scrollTop = 0; } catch {}
  observeSentinel();
  loadMore();
}

function applySearchTerm(raw) {
  const next = String(raw || "").trim();
  if (next === __searchTerm) return;
  __searchTerm = next;
  resetResults();
}

function bindSearch() {
  const input = __overlay?.querySelector(".sx-search-input");
  const clear = __overlay?.querySelector(".sx-search-clear");
  if (!input) return;

  const schedule = () => {
    if (__searchTimer) clearTimeout(__searchTimer);
    __searchTimer = setTimeout(() => {
      __searchTimer = null;
      applySearchTerm(input.value);
    }, SEARCH_DEBOUNCE_MS);
  };

  input.addEventListener("input", () => {
    if (clear) clear.hidden = !input.value;
    schedule();
  }, { passive: true });

  // Enter should not wait out the debounce, and Escape clears the box instead of closing the
  // overlay — losing a whole grid to a stray keypress while typing is worse than a second tap.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (__searchTimer) { clearTimeout(__searchTimer); __searchTimer = null; }
      applySearchTerm(input.value);
      return;
    }
    if (e.key === "Escape") {
      // With text in the box Escape clears it and stops here, so the keypress cannot also
      // close the overlay. With the box empty there is nothing to clear, so it propagates
      // to the document handler and closes as Escape normally would.
      if (!input.value) return;
      e.stopPropagation();
      e.preventDefault();
      input.value = "";
      if (clear) clear.hidden = true;
      if (__searchTimer) { clearTimeout(__searchTimer); __searchTimer = null; }
      applySearchTerm("");
    }
  });

  if (clear) {
    clear.addEventListener("click", () => {
      input.value = "";
      clear.hidden = true;
      if (__searchTimer) { clearTimeout(__searchTimer); __searchTimer = null; }
      applySearchTerm("");
      try { input.focus(); } catch {}
    }, { passive: true });
  }
}

function prefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

function playOpenAnimation(overlayEl) {
  const dialog = overlayEl.querySelector(".genre-explorer");
  if (!dialog || prefersReducedMotion()) return;
  const origin = getExplorerPointerOrigin() || {
    x: (window.innerWidth / 2) | 0,
    y: (window.innerHeight / 2) | 0,
  };
  dialog.style.transformOrigin = `${origin.x}px ${origin.y}px`;
  overlayEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out", fill: "both" });
  dialog.animate(
    [{ transform: "scale(0.84)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
    { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" }
  );
}

function animatedCloseThen(cb) {
  if (!__overlay || __isClosing) { cb?.(); return; }
  if (prefersReducedMotion()) {
    cb?.();
    closeSectionExplorer(true);
    return;
  }
  __isClosing = true;
  const sheet = __overlay;
  const dialog = __overlay.querySelector(".genre-explorer");
  const origin = getExplorerPointerOrigin() || {
    x: (window.innerWidth / 2) | 0,
    y: (window.innerHeight / 2) | 0,
  };
  if (dialog) dialog.style.transformOrigin = `${origin.x}px ${origin.y}px`;

  const fade = sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "forwards" });
  const shrink = dialog?.animate(
    [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0.84)", opacity: 0 }],
    { duration: 220, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" }
  );

  // Both animations plus a safety timeout can all fire, so `settled` makes the teardown
  // run exactly once rather than however many of the three arrive.
  let finished = 0;
  let settled = false;
  const expected = shrink ? 2 : 1;
  const mark = () => {
    if (++finished < expected || settled) return;
    settled = true;
    cb?.();
    try { closeSectionExplorer(true); } catch {}
  };
  const force = () => { finished = expected - 1; mark(); };

  fade.addEventListener("finish", mark, { once: true });
  shrink?.addEventListener("finish", mark, { once: true });
  // Force rather than count toward the quorum: a timeout that only counted as one vote would
  // leave the overlay stuck on screen whenever neither animation reported finishing.
  setTimeout(force, 260);
}

function escCloser(e) {
  if (e.key === "Escape") animatedCloseThen();
}

// The overlay never touches the hash itself, so a hashchange can only mean the user navigated
// away — at which point the grid must not stay parked over the new page.
function hashCloser() {
  animatedCloseThen();
}

export function closeSectionExplorer(skipAnimation = false) {
  if (!__overlay) return;
  if (!skipAnimation) { animatedCloseThen(); return; }

  if (__searchTimer) { clearTimeout(__searchTimer); __searchTimer = null; }
  if (__abort) { try { __abort.abort(); } catch {} }
  try { __io?.disconnect(); } catch {}
  document.removeEventListener("keydown", escCloser);
  window.removeEventListener("hashchange", hashCloser);
  clearGrid();
  try { __overlay.remove(); } catch {}

  __overlay = null;
  __abort = null;
  __io = null;
  __descriptor = null;
  __serverId = "";
  __startIndex = 0;
  __exhausted = false;
  __stallWarned = false;
  __scrollFallbackHandler = null;
  __isClosing = false;
  __searchTerm = "";
  __seenIds = new Set();
  __renderedAnything = false;
  __busyToken = -1;
}

/**
 * Opens the explorer for one home row.
 *
 * @param {object} descriptor
 * @param {string} descriptor.title        Row title, shown in the header.
 * @param {object} descriptor.query        Jellyfin query params defining the section's scope.
 *                                         Search reuses these verbatim, so whatever narrows the
 *                                         row (ParentId, IncludeItemTypes, Filters) also narrows
 *                                         the search.
 * @param {string} [descriptor.endpoint]   SECTION_ENDPOINT_NEXT_UP for `/Shows/NextUp`.
 * @param {boolean} [descriptor.searchable] Set false to hide the search box.
 * @param {string} [descriptor.fallbackHash] Native Jellyfin hash, used only when the explorer
 *                                         cannot open or its first load fails.
 * @param {Function} [descriptor.onFallback] Performs the fallback navigation. recentRows passes
 *                                         its own `gotoHash`, which injects the serverId.
 */
export function openSectionExplorer(descriptor) {
  const fallbackHash = descriptor?.fallbackHash;
  const onFallback = descriptor?.onFallback;

  if (!descriptor?.query || typeof descriptor.query !== "object") {
    console.warn("sectionExplorer: descriptor has no query, falling back to Jellyfin");
    navigateToFallback(fallbackHash, onFallback);
    return;
  }

  try {
    if (__overlay) closeSectionExplorer(true);

    __descriptor = descriptor;
    __serverId = getSessionInfo()?.serverId || "";
    __startIndex = 0;
    __exhausted = false;
    __stallWarned = false;
    __searchTerm = "";
    __seenIds = new Set();
    __renderedAnything = false;
    __busyToken = -1;
    __queryToken += 1;

    const l = labels();
    const title = String(descriptor.title || l.all || "Tümü");
    const searchable = isSearchable(descriptor);
    const searchPlaceholder = (l.sectionSearchPlaceholder || "Bu bölümde ara")
      .replace("{section}", title);

    __overlay = document.createElement("div");
    __overlay.className = "genre-explorer-overlay section-explorer-overlay";
    __overlay.innerHTML = `
      <div class="genre-explorer" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="ge-header sx-header">
          <div class="ge-title">${escapeHtml(title)}</div>
          ${searchable ? `
            <div class="sx-search" role="search">
              <span class="sx-search-icon" aria-hidden="true">${faIconHtml("search")}</span>
              <input class="sx-search-input" type="search" autocomplete="off" spellcheck="false"
                     placeholder="${escapeHtml(searchPlaceholder)}"
                     aria-label="${escapeHtml(searchPlaceholder)}">
              <button type="button" class="sx-search-clear" hidden
                      aria-label="${escapeHtml(l.sectionSearchClear || "Aramayı temizle")}">✕</button>
            </div>
          ` : ""}
          <div class="ge-actions">
            <button type="button" class="ge-close" aria-label="${escapeHtml(l.close || "Kapat")}">✕</button>
          </div>
        </div>
        <div class="ge-content">
          <div class="ge-grid" role="list"></div>
          <div class="ge-empty" style="display:none"></div>
          <div class="ge-sentinel"></div>
        </div>
      </div>
    `;

    document.body.appendChild(__overlay);
    injectGEPerfStyles();
    try { playOpenAnimation(__overlay); } catch {}

    bindExplorerGridDetails(__overlay.querySelector(".ge-grid"));
    bindSearch();

    __overlay.querySelector(".ge-close")
      ?.addEventListener("click", () => animatedCloseThen(), { passive: true });
    __overlay.addEventListener("click", (e) => {
      if (e.target === __overlay) animatedCloseThen();
    }, { passive: true });
    document.addEventListener("keydown", escCloser, { passive: false });
    window.addEventListener("hashchange", hashCloser, { passive: true });

    observeSentinel();
    loadMore();
  } catch (error) {
    console.warn("sectionExplorer: open failed, falling back to Jellyfin:", error);
    try { closeSectionExplorer(true); } catch {}
    navigateToFallback(fallbackHash, onFallback);
  }
}

// Pressing play from the details modal fires jms:details-modal-play, which genreExplorer turns
// into closeActiveExplorers(). Registering here keeps this overlay from sitting over the player.
registerExplorerCloser(() => closeSectionExplorer(true));
