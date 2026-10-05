// Full-screen view of an empty library's image on the no-content home. No imports on purpose,
// so the decisions can be unit-tested on their own (tests/noContentCardZoom.test.mjs).
//
// An expired Neexy membership leaves one empty library whose image carries the renewal QR.
// jellyfin-web shows it as a My Media card: ~300 px wide on a desktop, with a ~70 px QR that a
// phone camera cannot read, and clicking it opens a library with nothing in it. While the home is
// in no-content mode (userContentGate.js), selecting such a card opens its own image full screen
// at the screen's resolution instead. Click, Enter and a TV remote's OK all arrive as "click".

const VIEWER_ID = "jms-nocontent-viewer";
const MIN_VIEWER_IMAGE_WIDTH = 800;
const MAX_VIEWER_IMAGE_WIDTH = 3840;
const RESIZE_PARAMS = new Set(["fillwidth", "fillheight", "width", "height", "maxwidth", "maxheight", "quality"]);
const URL_IN_CSS = /url\((['"]?)(.*?)\1\)/i;
// Library views whose own page is still useful; only empty content libraries are enlarged.
const NON_ZOOM_COLLECTION_TYPES = new Set(["playlists", "livetv", "boxsets", "channels"]);
// moui's own rows never hold a native library card, but must never be hijacked either.
const MANAGED_SECTION_SELECTOR = [
  "#monwui-slides-container",
  "#studio-hubs",
  "#personal-recommendations",
  "#genre-hubs",
  '[id^="genre-hubs--"]',
  '[id^="because-you-watched--"]',
  '[id^="director-rows--"]',
  '[id^="recent-rows--"]',
  '[id^="continue-rows--"]',
  '[id^="nextup-rows--"]',
  '[id^="library-hubs--"]',
  '[id^="top10-series-rows--"]',
  '[id^="top10-movie-rows--"]',
  '[id^="tmdb-top-movie-rows--"]',
  '[id^="tmdb-trailer-rows--"]',
].join(", ");
// The card's "..." menu and multi-select keep working.
const CARD_CONTROL_SELECTOR = '[data-action="menu"], .cardOverlayButton, .btnCardOptions, .chkItemSelect, .itemSelectionPanel';
const BACK_KEYS = new Set(["Escape", "Esc", "Backspace", "GoBack", "BrowserBack"]);

let activeViewer = null;
let zoomInstalled = false;

/**
 * The card's image URL with every size parameter replaced by `maxWidth` (the screen width in
 * device pixels, clamped) and full quality. Same image, same cache tag; anything that is not a
 * Jellyfin image URL is returned untouched.
 */
export function buildFullResolutionImageUrl(url, targetWidth) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw, "http://jms.invalid");
  } catch {
    return raw;
  }
  if (!/\/Images\//i.test(parsed.pathname)) return raw;

  const sizeKeys = [...parsed.searchParams.keys()].filter((key) => RESIZE_PARAMS.has(key.toLowerCase()));
  sizeKeys.forEach((key) => parsed.searchParams.delete(key));
  const width = Math.min(
    MAX_VIEWER_IMAGE_WIDTH,
    Math.max(MIN_VIEWER_IMAGE_WIDTH, Math.round(Number(targetWidth) || MIN_VIEWER_IMAGE_WIDTH))
  );
  parsed.searchParams.set("maxWidth", String(width));
  parsed.searchParams.set("quality", "100");

  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//");
  return isAbsolute ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** The URL of the image the card shows, whether jellyfin-web has lazy-loaded it yet or not. */
export function readCardImageUrl(card, { getComputedStyle: computeStyle } = {}) {
  if (!card) return "";
  const box = card.querySelector?.(".cardImageContainer, .cardImage") || null;
  if (box) {
    if (box.tagName === "IMG") {
      const src = box.currentSrc || box.src || box.getAttribute?.("data-src") || "";
      if (src) return src;
    }
    const inline = String(box.style?.backgroundImage || "").match(URL_IN_CSS)?.[2] || "";
    if (inline) return inline;
    const lazy = box.getAttribute?.("data-src") || "";
    if (lazy) return lazy;
    if (typeof computeStyle === "function") {
      const computed = String(computeStyle(box)?.backgroundImage || "").match(URL_IN_CSS)?.[2] || "";
      if (computed) return computed;
    }
  }
  const img = card.querySelector?.("img") || null;
  if (img) return img.currentSrc || img.src || img.getAttribute?.("data-src") || "";
  return "";
}

/** A native library card (jellyfin-web `data-type="CollectionFolder"`) worth enlarging. */
export function isZoomableLibraryCard(card) {
  if (!card) return false;
  const id = String(card.dataset?.id || card.getAttribute?.("data-id") || "").trim();
  if (!id) return false;
  const type = String(card.dataset?.type || "").trim().toLowerCase();
  if (type !== "collectionfolder") return false;
  const collectionType = String(card.dataset?.collectiontype || "").trim().toLowerCase();
  if (NON_ZOOM_COLLECTION_TYPES.has(collectionType)) return false;
  if (card.closest?.(MANAGED_SECTION_SELECTOR)) return false;
  return true;
}

function readCardTitle(card) {
  const text = card?.querySelector?.(".cardText-first, .cardText")?.textContent || "";
  return text.replace(/\s+/g, " ").trim();
}

export function closeNoContentImageViewer() {
  const viewer = activeViewer;
  activeViewer = null;
  viewer?.close?.();
}

/**
 * Shows `previewSrc` (what the card already loaded) at once and swaps in `src` (full
 * resolution) as soon as it has loaded, so the QR is on screen immediately and turns sharp.
 * Any click, Escape or a remote's Back closes it, and so does leaving the page.
 */
export function openNoContentImageViewer({
  src = "",
  previewSrc = "",
  title = "",
  closeLabel = "Close",
  returnFocus = null,
} = {}) {
  closeNoContentImageViewer();
  const doc = document;

  const overlay = doc.createElement("div");
  overlay.id = VIEWER_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  if (title) overlay.setAttribute("aria-label", title);
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    // Above jellyfin-web 12.1's MUI header (z-index 1100) and its dialogs.
    zIndex: "100000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    padding: "clamp(12px, 3vmin, 40px)",
    background: "rgba(0, 0, 0, 0.94)",
    cursor: "zoom-out",
  });

  const img = doc.createElement("img");
  img.alt = title;
  img.decoding = "async";
  img.draggable = false;
  Object.assign(img.style, {
    display: "block",
    maxWidth: "100%",
    maxHeight: "100%",
    width: "auto",
    height: "auto",
    objectFit: "contain",
    borderRadius: "14px",
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.6)",
    userSelect: "none",
  });
  img.src = previewSrc || src;
  if (src && previewSrc && src !== previewSrc) {
    const full = new Image();
    full.decoding = "async";
    full.onload = () => {
      if (img.isConnected) img.src = src;
    };
    full.src = src;
  }

  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "✕";
  closeButton.title = closeLabel;
  closeButton.setAttribute("aria-label", closeLabel);
  Object.assign(closeButton.style, {
    position: "absolute",
    top: "max(12px, env(safe-area-inset-top))",
    right: "max(12px, env(safe-area-inset-right))",
    width: "48px",
    height: "48px",
    border: "0",
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.16)",
    color: "#fff",
    font: "600 22px/48px system-ui, sans-serif",
    cursor: "pointer",
  });

  overlay.append(img, closeButton);

  const root = doc.documentElement;
  const previousOverflow = root.style.overflow;
  root.style.overflow = "hidden";

  const onKeyDown = (event) => {
    if (!BACK_KEYS.has(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    closeNoContentImageViewer();
  };
  const onRouteChange = () => closeNoContentImageViewer();

  const close = () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("hashchange", onRouteChange);
    window.removeEventListener("popstate", onRouteChange);
    overlay.remove();
    root.style.overflow = previousOverflow;
    try { returnFocus?.focus?.({ preventScroll: true }); } catch {}
  };

  overlay.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeNoContentImageViewer();
  });
  doc.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("hashchange", onRouteChange);
  window.addEventListener("popstate", onRouteChange);

  doc.body.appendChild(overlay);
  activeViewer = { close };
  try { closeButton.focus({ preventScroll: true }); } catch {}

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (!reduceMotion && typeof overlay.animate === "function") {
    overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }
}

/**
 * One capture-phase listener for the whole page; it acts only while `isActive()` says the home
 * is in no-content mode, so installing it early or twice is harmless.
 */
export function installNoContentCardZoom({ isActive, getCloseLabel } = {}) {
  if (zoomInstalled || typeof document === "undefined") return;
  zoomInstalled = true;

  document.addEventListener("click", (event) => {
    if (typeof isActive !== "function" || !isActive()) return;
    const target = event.target;
    const card = target?.closest?.(".card");
    if (!card || target.closest?.(CARD_CONTROL_SELECTOR)) return;
    if (!card.closest?.("#indexPage:not(.hide), #homePage:not(.hide)")) return;
    if (!isZoomableLibraryCard(card)) return;

    const previewSrc = readCardImageUrl(card, {
      getComputedStyle: (node) => window.getComputedStyle(node),
    });
    // No image means no QR to show: let the card do what it always did.
    if (!previewSrc) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const screenWidth = Math.round((window.innerWidth || 1280) * (window.devicePixelRatio || 1));
    openNoContentImageViewer({
      src: buildFullResolutionImageUrl(previewSrc, screenWidth),
      previewSrc,
      title: readCardTitle(card),
      closeLabel: (typeof getCloseLabel === "function" && getCloseLabel()) || "Close",
      returnFocus: card.querySelector?.("a, button, [tabindex]") || card,
    });
  }, true);
}
