import { getSessionInfo, makeApiRequest } from "../../Plugins/JMSFusion/runtime/api.js";
import { getConfig } from "./config.js";
import { faIconHtml } from "./faIcons.js";
import { createRecommendationCard } from "./recentRows.js";
import { registerExplorerCloser } from "./genreExplorer.js";
import { getSerrAccess, searchSerr, searchJellyfinByTmdbId, createSerrRequest, listSerrRequests } from "./seerr/api.js";
import { ensureSerrStyles } from "./seerr/styles.js";
import {
  mergeSearchResults,
  resultMediaType,
  resultTitle,
  posterUrl as serrPosterUrl,
  resultYear,
  notify,
  requestErrorMessage,
  requestMatchesPayload,
} from "./seerr/ui.js";

/**
 * Buscar: a full-screen search page reached from the nav icon next to Watchlist (see
 * watchlist.js's openBuscarSearchPage). It searches Seerr/Arr's TMDb-backed catalog (so it
 * reaches everything the user could ever request, not just what is already scanned into
 * Jellyfin) and cross-references each result against the local library by TMDb id, so a title
 * already available renders exactly like a home-page card (reusing createRecommendationCard
 * verbatim) with a green badge, while anything missing renders a purple "Solicitar" card that
 * opens a minimal, 4K-free confirmation before submitting the request.
 */

const SEARCH_DEBOUNCE_MS = 320;
// Caps how many results get a per-title searchJellyfinByTmdbId lookup — those calls are not
// batched server-side, so this bounds the fan-out to what the grid can actually show at once.
const RESULT_LIMIT = 24;
const STYLE_ID = "monwui-buscar-style";

let __overlay = null;
let __serverId = "";
let __searchTimer = null;
let __queryToken = 0;
let __isClosing = false;
let __access = null;

function labels() {
  return getConfig()?.languageLabels || {};
}

function L(key, fallback) {
  const value = labels()[key];
  return (typeof value === "string" && value.trim()) ? value : fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[m]));
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function ensureBuscarStyles() {
  ensureSerrStyles();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .buscar-request-card { cursor: pointer; }
    .buscar-request-poster { position: relative; }
    .buscar-badge {
      position: absolute; top: 8px; left: 8px; z-index: 2;
      padding: 5px 10px; border-radius: 999px;
      font-size: 11px; font-weight: 800; letter-spacing: .02em;
      box-shadow: 0 6px 16px rgba(0,0,0,.35);
    }
    .buscar-badge--available { background: linear-gradient(135deg,#3ddc84,#1fae64); color: #06210f; }
    .buscar-badge--missing { background: linear-gradient(135deg,#b98bff,#7c3aed); color: #fff; }
    .buscar-request-card--sent { cursor: default; }
    .buscar-request-card--sent .buscar-request-poster { opacity: .55; }
    .buscar-request-card--sent .buscar-badge--missing { background: rgba(255,255,255,.14); box-shadow: none; }
    .buscar-request-title {
      padding: 8px 2px 2px; font-size: 13px; font-weight: 700; color: rgba(255,255,255,.92);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .buscar-request-year { color: rgba(255,255,255,.55); font-weight: 600; }
    .buscar-empty, .buscar-status {
      color: rgba(227,243,248,.82); font-size: 14px; padding: 48px 16px; text-align: center;
    }
    #monwuiBuscarConfirmModal {
      align-items: center; backdrop-filter: blur(14px);
      background:
        radial-gradient(circle at top left, rgba(124,58,237,.18), transparent 28%),
        linear-gradient(180deg, rgba(8,10,16,.72), rgba(7,9,15,.92));
      display: none; inset: 0; justify-content: center; padding: 18px;
      position: fixed; z-index: 1000002;
    }
    #monwuiBuscarConfirmModal.open { display: flex; }
    .buscar-solicitar-btn {
      background: linear-gradient(135deg,#b98bff,#7c3aed) !important;
      border-color: rgba(124,58,237,.5) !important;
      color: #fff !important;
    }
    .buscar-solicitar-btn:hover { background: linear-gradient(135deg,#c9a6ff,#8b4fef) !important; }
  `;
  document.head.appendChild(style);
}

function buildRequestPayload(result) {
  const mediaType = resultMediaType(result);
  return {
    mediaType,
    mediaId: Number(result?.id),
    tvdbId: Number(result?.tvdbId || result?.tvdb_id || 0) || undefined,
    title: resultTitle(result),
    posterUrl: serrPosterUrl(result),
    requestAllSeasons: mediaType === "tv",
    seasons: [],
    source: "buscar",
    is4K: false,
  };
}

function closeBuscarConfirmModal(value = false) {
  const modal = document.getElementById("monwuiBuscarConfirmModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("hidden", "hidden");
  const resolve = modal.__buscarResolve;
  modal.__buscarResolve = null;
  if (typeof resolve === "function") resolve(value);
}

function ensureBuscarConfirmModal() {
  ensureBuscarStyles();
  let modal = document.getElementById("monwuiBuscarConfirmModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "monwuiBuscarConfirmModal";
  modal.setAttribute("hidden", "hidden");
  modal.innerHTML = `
    <div class="monwui-serr-card monwui-serr-confirm-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(L("buscarRequestConfirmTitle", "Confirmar solicitud"))}">
      <div class="monwui-serr-head">
        <h2 class="monwui-serr-title">${escapeHtml(L("buscarRequestConfirmTitle", "Confirmar solicitud"))}</h2>
        <button type="button" class="monwui-serr-close" data-buscar-confirm-cancel aria-label="${escapeHtml(L("close", "Cerrar"))}">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
      <div class="monwui-serr-confirm-body">
        <div class="monwui-serr-confirm-layout has-poster">
          <div class="monwui-serr-confirm-poster" data-buscar-confirm-poster-wrap>
            <img data-buscar-confirm-poster alt="">
            <i class="fas fa-clapperboard" aria-hidden="true"></i>
          </div>
          <div class="monwui-serr-confirm-summary">
            <div class="monwui-serr-confirm-eyebrow">${escapeHtml(L("buscarRequestConfirmEyebrow", "Solicitud"))}</div>
            <div class="monwui-serr-confirm-name" data-buscar-confirm-name></div>
            <div class="monwui-serr-confirm-meta" data-buscar-confirm-meta></div>
          </div>
        </div>
      </div>
      <div class="monwui-serr-footer">
        <button type="button" class="monwui-serr-mini-btn" data-buscar-confirm-cancel>${escapeHtml(L("cancel", "Cancelar"))}</button>
        <button type="button" class="monwui-serr-btn buscar-solicitar-btn" data-buscar-confirm-submit>
          <i class="fas fa-paper-plane" aria-hidden="true"></i><span>${escapeHtml(L("buscarRequestButton", "Solicitar"))}</span>
        </button>
      </div>
    </div>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target?.closest?.("[data-buscar-confirm-cancel]")) {
      closeBuscarConfirmModal(false);
      return;
    }
    if (event.target?.closest?.("[data-buscar-confirm-submit]")) {
      closeBuscarConfirmModal(true);
    }
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeBuscarConfirmModal(false);
  });

  document.body.appendChild(modal);
  return modal;
}

async function confirmBuscarRequest(result) {
  const modal = ensureBuscarConfirmModal();
  const title = resultTitle(result);
  const mediaType = resultMediaType(result);
  const year = resultYear(result);
  const typeLabel = mediaType === "tv" ? L("serrTv", "Serie") : L("serrMovie", "Película");
  const poster = serrPosterUrl(result);

  modal.querySelector("[data-buscar-confirm-name]").textContent = title;
  modal.querySelector("[data-buscar-confirm-meta]").textContent = [typeLabel, year].filter(Boolean).join(" • ");
  const posterNode = modal.querySelector("[data-buscar-confirm-poster]");
  const posterWrapNode = modal.querySelector("[data-buscar-confirm-poster-wrap]");
  if (poster) {
    posterNode.onerror = () => posterWrapNode.setAttribute("hidden", "hidden");
    posterNode.src = poster;
    posterNode.alt = title;
    posterWrapNode.removeAttribute("hidden");
  } else {
    posterNode.removeAttribute("src");
    posterWrapNode.setAttribute("hidden", "hidden");
  }

  if (typeof modal.__buscarResolve === "function") modal.__buscarResolve(false);

  return await new Promise((resolve) => {
    modal.__buscarResolve = resolve;
    modal.classList.add("open");
    modal.removeAttribute("hidden");
    setTimeout(() => modal.querySelector("[data-buscar-confirm-submit]")?.focus?.(), 0);
  });
}

async function handleRequestClick(result, card) {
  if (card.dataset.serrRequested === "1") return;

  const confirmed = await confirmBuscarRequest(result);
  if (!confirmed) return;

  const badge = card.querySelector(".buscar-badge--missing");
  const originalBadgeText = badge?.textContent || "";
  try {
    if (badge) badge.textContent = L("serrRequestSending", "Enviando...");
    const payload = buildRequestPayload(result);
    const response = await createSerrRequest(payload);
    if (response?.ok === false) {
      throw new Error(response?.error || L("serrRequestFailed", "No se pudo crear la solicitud."));
    }
    notify(
      L(
        "buscarRequestSuccessToast",
        "¡Listo! Tu solicitud se envió correctamente. Haremos nuestro mejor esfuerzo por tenerla disponible lo antes posible."
      ),
      "success"
    );
    markCardAsRequested(card, badge);
  } catch (error) {
    notify(requestErrorMessage(error, L("buscarRequestFailedToast", "No se pudo enviar tu solicitud. Intenta de nuevo.")), "error");
    if (badge) badge.textContent = originalBadgeText;
  }
}

function markCardAsRequested(card, badge = card.querySelector(".buscar-badge--missing")) {
  if (badge) badge.textContent = L("buscarRequestedBadge", "Solicitado");
  card.classList.add("buscar-request-card--sent");
  card.dataset.serrRequested = "1";
}

function createRequestCard(result, activeRequests = []) {
  const card = document.createElement("div");
  card.className = "card personal-recs-card buscar-request-card";
  const poster = serrPosterUrl(result);
  const title = resultTitle(result);
  const year = resultYear(result);

  card.innerHTML = `
    <div class="cardBox">
      <div class="cardScalable">
        <div class="cardImageContainer buscar-request-poster">
          ${poster
            ? `<img class="cardImage" src="${escapeHtml(poster)}" alt="" loading="lazy">`
            : `<div class="prc-noimg-label">${escapeHtml(L("noImage", "Sin imagen"))}</div>`}
          <div class="buscar-badge buscar-badge--missing">${escapeHtml(L("buscarRequestBadge", "Solicitar"))}</div>
        </div>
      </div>
      <div class="buscar-request-title">
        ${escapeHtml(title)}${year ? ` <span class="buscar-request-year">(${escapeHtml(year)})</span>` : ""}
      </div>
    </div>
  `;

  card.addEventListener("click", () => {
    handleRequestClick(result, card).catch(() => {});
  });

  // Layer 1 of the duplicate-request guard: pre-mark results that already have an active
  // request before the user ever clicks. Layer 2 is the server's own FindBlockingDuplicate
  // check on submit, kept as a safety net in case this list is stale.
  const payload = buildRequestPayload(result);
  if (activeRequests.some((req) => requestMatchesPayload(req, payload))) {
    markCardAsRequested(card);
  }

  return card;
}

function decorateAvailableCard(card) {
  const host = card.querySelector(".cardImageContainer") || card;
  try { host.style.position = host.style.position || "relative"; } catch {}
  const badge = document.createElement("div");
  badge.className = "buscar-badge buscar-badge--available";
  badge.textContent = L("buscarAvailableBadge", "Ya disponible");
  host.appendChild(badge);
  return card;
}

// searchJellyfinByTmdbId's controller returns a trimmed DTO (Id/Name/Type/rating/overview) built
// for searchBridge.js's "does this exist" check — it has no ImageTags, so handing it straight to
// createRecommendationCard renders every match as a gray "no image" box. This re-fetches the full
// item shape the card factory needs, matching the field list recentRows.js/genreExplorer.js use.
const BUSCAR_ITEM_FIELDS = [
  "PrimaryImageAspectRatio",
  "ImageTags",
  "CommunityRating",
  "Genres",
  "OfficialRating",
  "ProductionYear",
  "CumulativeRunTimeTicks",
  "RunTimeTicks",
].join(",");

async function fetchFullItemsByIds(ids) {
  const clean = Array.from(new Set(ids.filter(Boolean)));
  if (!clean.length) return new Map();
  try {
    const { userId } = getSessionInfo() || {};
    if (!userId) return new Map();
    const url =
      `/Users/${userId}/Items?Ids=${encodeURIComponent(clean.join(","))}&` +
      `Fields=${encodeURIComponent(BUSCAR_ITEM_FIELDS)}&EnableUserData=true`;
    const data = await makeApiRequest(url);
    const items = Array.isArray(data?.Items) ? data.Items : [];
    return new Map(items.map((it) => [String(it.Id), it]));
  } catch {
    return new Map();
  }
}

/**
 * searchJellyfinByTmdbId has no batch form, so this fans out one lookup per visible result
 * (capped by RESULT_LIMIT) rather than per keystroke — the caller only invokes this once per
 * submitted/debounced query, after the Seerr search itself has already resolved. The follow-up
 * full-item fetch IS batched into a single request for every match found on the page.
 */
async function annotateWithLibraryMatches(results) {
  const capped = results.slice(0, RESULT_LIMIT);
  const matchedIds = await Promise.all(capped.map(async (result) => {
    const type = resultMediaType(result);
    if (type !== "movie" && type !== "tv") return null;
    try {
      const res = await searchJellyfinByTmdbId(Number(result?.id));
      const thin = Array.isArray(res?.items) ? res.items[0] : null;
      return thin?.Id ? String(thin.Id) : null;
    } catch {
      return null;
    }
  }));

  const fullItemsById = await fetchFullItemsByIds(matchedIds.filter(Boolean));

  return capped.map((result, index) => {
    const id = matchedIds[index];
    return { result, localItem: id ? (fullItemsById.get(id) || null) : null };
  });
}

function releaseCards(grid) {
  grid.querySelectorAll(".personal-recs-card").forEach((el) => {
    try { el.dispatchEvent(new CustomEvent("jms:cleanup")); } catch {}
  });
}

async function fetchActiveSerrRequests() {
  const data = await listSerrRequests({ includeDownloads: false }).catch(() => null);
  return Array.isArray(data?.requests) ? data.requests : [];
}

async function renderEntries(grid, entries, token) {
  releaseCards(grid);
  grid.innerHTML = "";
  if (!entries.length) {
    grid.parentElement?.querySelector?.(".buscar-empty")?.remove();
    const empty = document.createElement("div");
    empty.className = "buscar-empty";
    empty.textContent = L("buscarNoResults", "No encontramos nada con ese nombre.");
    grid.appendChild(empty);
    return;
  }

  const needsRequestCheck = entries.some((entry) => !entry.localItem);
  const activeRequests = needsRequestCheck ? await fetchActiveSerrRequests() : [];
  if (token !== __queryToken) return;

  const frag = document.createDocumentFragment();
  entries.forEach(({ result, localItem }) => {
    if (localItem) {
      const card = createRecommendationCard(localItem, __serverId, { showRating: false });
      frag.appendChild(decorateAvailableCard(card));
    } else {
      frag.appendChild(createRequestCard(result, activeRequests));
    }
  });
  grid.appendChild(frag);
}

function setStatus(grid, message) {
  releaseCards(grid);
  grid.innerHTML = `<div class="buscar-status">${escapeHtml(message)}</div>`;
}

async function runSearch(grid, query) {
  const token = ++__queryToken;
  const clean = String(query || "").trim();
  if (!clean) {
    releaseCards(grid);
    grid.innerHTML = "";
    return;
  }

  setStatus(grid, L("loadingText", "Cargando..."));

  if (!__access) {
    __access = await getSerrAccess().catch(() => null);
  }
  if (__access?.enabled !== true) {
    if (token !== __queryToken) return;
    setStatus(grid, L("buscarNotConfigured", "La búsqueda de Seerr/Arr no está configurada en este servidor."));
    return;
  }

  try {
    const [page1, page2] = await Promise.all([
      searchSerr(clean, { page: 1 }),
      searchSerr(clean, { page: 2 }).catch(() => null),
    ]);
    if (token !== __queryToken) return;

    const merged = mergeSearchResults(
      Array.isArray(page1?.results) ? page1.results : [],
      Array.isArray(page2?.results) ? page2.results : []
    ).filter((result) => {
      const type = resultMediaType(result);
      return type === "movie" || type === "tv";
    });

    if (!merged.length) {
      if (token !== __queryToken) return;
      renderEntries(grid, [], token);
      return;
    }

    const entries = await annotateWithLibraryMatches(merged);
    if (token !== __queryToken) return;
    renderEntries(grid, entries, token);
  } catch (error) {
    if (token !== __queryToken) return;
    setStatus(grid, error?.message || L("serrSearchFailed", "La búsqueda falló. Intenta de nuevo."));
  }
}

function bindSearch(overlayEl) {
  const input = overlayEl.querySelector(".sx-search-input");
  const clear = overlayEl.querySelector(".sx-search-clear");
  const grid = overlayEl.querySelector(".ge-grid");
  if (!input || !grid) return;

  const schedule = () => {
    if (__searchTimer) clearTimeout(__searchTimer);
    __searchTimer = setTimeout(() => {
      __searchTimer = null;
      runSearch(grid, input.value);
    }, SEARCH_DEBOUNCE_MS);
  };

  input.addEventListener("input", () => {
    if (clear) clear.hidden = !input.value;
    schedule();
  }, { passive: true });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (__searchTimer) { clearTimeout(__searchTimer); __searchTimer = null; }
      runSearch(grid, input.value);
      return;
    }
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      e.preventDefault();
      input.value = "";
      if (clear) clear.hidden = true;
      if (__searchTimer) { clearTimeout(__searchTimer); __searchTimer = null; }
      releaseCards(grid);
      grid.innerHTML = "";
    }
  });

  if (clear) {
    clear.addEventListener("click", () => {
      input.value = "";
      clear.hidden = true;
      if (__searchTimer) { clearTimeout(__searchTimer); __searchTimer = null; }
      releaseCards(grid);
      grid.innerHTML = "";
      try { input.focus(); } catch {}
    }, { passive: true });
  }

  setTimeout(() => { try { input.focus(); } catch {} }, 60);
}

function playOpenAnimation(overlayEl) {
  const dialog = overlayEl.querySelector(".genre-explorer");
  if (!dialog || prefersReducedMotion()) return;
  overlayEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out", fill: "both" });
  dialog.animate(
    [{ transform: "scale(0.96)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
    { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" }
  );
}

function teardown() {
  if (__searchTimer) { clearTimeout(__searchTimer); __searchTimer = null; }
  document.removeEventListener("keydown", escCloser, false);
  window.removeEventListener("hashchange", hashCloser, false);
  const grid = __overlay?.querySelector(".ge-grid");
  if (grid) releaseCards(grid);
  __overlay?.remove();
  __overlay = null;
  __isClosing = false;
}

export function closeBuscarPage(skipAnimation = false) {
  if (!__overlay || __isClosing) return;
  if (skipAnimation || prefersReducedMotion()) {
    teardown();
    return;
  }
  __isClosing = true;
  const sheet = __overlay;
  const dialog = __overlay.querySelector(".genre-explorer");
  const fade = sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" });
  const shrink = dialog?.animate(
    [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0.96)", opacity: 0 }],
    { duration: 200, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" }
  );
  let finished = 0;
  let settled = false;
  const expected = shrink ? 2 : 1;
  const mark = () => {
    if (++finished < expected || settled) return;
    settled = true;
    teardown();
  };
  fade.addEventListener("finish", mark, { once: true });
  shrink?.addEventListener("finish", mark, { once: true });
  setTimeout(() => { finished = expected - 1; mark(); }, 240);
}

function escCloser(e) {
  if (e.key === "Escape") closeBuscarPage();
}

function hashCloser() {
  closeBuscarPage(true);
}

export async function openBuscarPage() {
  if (__overlay) return;
  ensureBuscarStyles();
  __serverId = getSessionInfo()?.serverId || "";
  __access = null;
  __queryToken += 1;

  const title = L("buscarOpen", "Buscar");
  const placeholder = L("buscarSearchPlaceholder", "Buscar películas, series...");

  __overlay = document.createElement("div");
  __overlay.className = "genre-explorer-overlay buscar-overlay";
  __overlay.innerHTML = `
    <div class="genre-explorer" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="ge-header sx-header">
        <div class="ge-title">${escapeHtml(title)}</div>
        <div class="sx-search" role="search">
          <span class="sx-search-icon" aria-hidden="true">${faIconHtml("search")}</span>
          <input class="sx-search-input" type="search" autocomplete="off" spellcheck="false"
                 placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}">
          <button type="button" class="sx-search-clear" hidden aria-label="${escapeHtml(L("sectionSearchClear", "Limpiar búsqueda"))}">✕</button>
        </div>
        <div class="ge-actions">
          <button type="button" class="ge-close" aria-label="${escapeHtml(L("close", "Cerrar"))}">✕</button>
        </div>
      </div>
      <div class="ge-content">
        <div class="ge-grid" role="list"></div>
      </div>
    </div>
  `;

  document.body.appendChild(__overlay);
  try { playOpenAnimation(__overlay); } catch {}

  bindSearch(__overlay);
  __overlay.querySelector(".ge-close")?.addEventListener("click", () => closeBuscarPage(), { passive: true });
  __overlay.addEventListener("click", (e) => {
    if (e.target === __overlay) closeBuscarPage();
  }, { passive: true });
  document.addEventListener("keydown", escCloser, { passive: false });
  window.addEventListener("hashchange", hashCloser, { passive: true });
}

registerExplorerCloser(() => closeBuscarPage(true));
