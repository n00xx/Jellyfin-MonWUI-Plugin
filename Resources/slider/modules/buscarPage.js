import { getSessionInfo, makeApiRequest } from "../../Plugins/JMSFusion/runtime/api.js";
import { getConfig } from "./config.js";
import { faIconHtml } from "./faIcons.js";
import { createRecommendationCard } from "./recentRows.js";
import { registerExplorerCloser } from "./genreExplorer.js";
import { getSerrAccess, searchSerr, searchJellyfinByTmdbIds, createSerrRequest, listSerrRequests } from "./seerr/api.js";
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
// This no longer bounds network fan-out — the library cross-reference is one batched request
// regardless of size (see searchJellyfinByTmdbIds). What it still bounds is card construction.
// The render cost was the open question that kept this at 24: every result builds a real card
// with its own poster and listeners. It is answered by what the rest of the UI already does —
// the home page builds several rows of ten from this same createRecommendationCard on every
// load, and the explorer grids append pages of forty. Forty is inside that envelope, and two
// Seerr pages are already fetched and then two thirds of them thrown away, so covering the
// whole result set costs nothing extra on the wire.
const RESULT_LIMIT = 40;
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
    /* Both are single children of a 170px-track grid, so without the span they render inside
       one narrow column with 48px of padding around a wrapped word. */
    .buscar-overlay .buscar-empty, .buscar-overlay .buscar-status {
      grid-column: 1 / -1;
    }
    .buscar-empty, .buscar-status {
      color: rgba(227,243,248,.82); font-size: 14px; padding: 48px 16px; text-align: center;
    }
    /* Section headings span the whole row so the grid's auto-fill tracks resume beneath them.
       Everything here is scoped to .buscar-overlay because .ge-grid is shared with the five
       "See all" explorer grids. */
    .buscar-overlay .buscar-section-head {
      grid-column: 1 / -1;
      display: flex; align-items: baseline; gap: 10px;
      margin: 4px 2px 0;
    }
    .buscar-overlay .buscar-section-head--discover {
      margin-top: 22px; padding-top: 18px;
      border-top: 1px solid rgba(166,206,220,.16);
    }
    .buscar-overlay .buscar-section-title {
      margin: 0;
      font-size: clamp(1.02rem, 1.6vw, 1.26rem);
      font-weight: 800; letter-spacing: -.01em; line-height: 1.2;
      color: #eef8fb;
    }
    .buscar-overlay .buscar-section-count {
      font-size: 11px; font-weight: 800; line-height: 1;
      padding: 4px 8px; border-radius: 999px;
      color: rgba(227,243,248,.72);
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(166,206,220,.18);
    }
    .buscar-overlay .buscar-section-head--available .buscar-section-count {
      color: #06210f; background: linear-gradient(135deg,#3ddc84,#1fae64); border-color: transparent;
    }
    .buscar-overlay .buscar-section-head--discover .buscar-section-count {
      color: #fff; background: linear-gradient(135deg,#b98bff,#7c3aed); border-color: transparent;
    }
    /* Type headings sit one level under the availability headings, so they read as a
       subdivision of the group above rather than as a peer of it: smaller, uppercase, indented,
       and with no rule above them.

       What they must not do is collide with it. At 4px under "En biblioteca", "PELÍCULAS" read
       as a second line of that title rather than as the label of its own group, and .62 alpha
       left it too faint to argue otherwise. Separation and a leading accent rule carry the
       distinction instead of weight — matching the parent's weight would flatten the two levels
       back into the one they were before they were split. */
    .buscar-overlay .buscar-subsection-head {
      grid-column: 1 / -1;
      display: flex; align-items: center; gap: 8px;
      margin: 24px 2px 2px;
      padding: 1px 0 1px 10px;
      border-left: 3px solid var(--buscar-type-accent, rgba(166,206,220,.5));
    }
    .buscar-overlay .buscar-subsection-head--first { margin-top: 14px; }
    .buscar-overlay .buscar-subsection-title {
      margin: 0;
      font-size: clamp(.86rem, 1vw, .97rem);
      font-weight: 700; letter-spacing: .09em; line-height: 1.25;
      text-transform: uppercase;
      color: rgba(227,243,248,.88);
    }
    .buscar-overlay .buscar-subsection-count {
      font-size: 10px; font-weight: 700; line-height: 1;
      padding: 3px 7px; border-radius: 999px;
      color: rgba(227,243,248,.82);
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(166,206,220,.22);
    }
    @media (max-width: 640px) {
      .buscar-overlay .buscar-section-head--discover { margin-top: 16px; padding-top: 14px; }
      .buscar-overlay .buscar-subsection-head { margin-top: 18px; padding-left: 8px; }
      .buscar-overlay .buscar-subsection-head--first { margin-top: 10px; }
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
 * Cross-references every result against the local library in exactly two requests: one batched
 * TMDb-id lookup, then one batched fetch of the full item shape for whatever matched.
 *
 * This used to fan out one searchJellyfinByTmdbId call per title. Browsers cap concurrent
 * connections per origin, so those lookups left in serialized waves and dominated the time to
 * first card — the whole reason the result set was capped at 24. With the batch endpoint the
 * network cost is constant, so the cap no longer buys anything and covering the full page is
 * cheaper than covering a third of it used to be.
 */
async function annotateWithLibraryMatches(results) {
  const capped = results.slice(0, RESULT_LIMIT);

  // TMDb ids are only unique *within* a media type, so a person and a movie can share one.
  // Resolving the id per row without re-checking the type would let a movie match leak onto a
  // same-numbered non-movie row. Callers currently pre-filter to movie/tv, but the guard stays
  // local so this function is correct on its own.
  const lookupId = (result) => {
    const type = resultMediaType(result);
    if (type !== "movie" && type !== "tv") return null;
    const id = Math.floor(Number(result?.id));
    return Number.isFinite(id) && id > 0 ? id : null;
  };

  const tmdbIds = capped.map(lookupId).filter((id) => id !== null);
  const matchesByTmdbId = await searchJellyfinByTmdbIds(tmdbIds).catch(() => new Map());
  const fullItemsById = await fetchFullItemsByIds(Array.from(matchesByTmdbId.values()));

  return capped.map((result) => {
    const tmdbId = lookupId(result);
    const itemId = tmdbId === null ? null : matchesByTmdbId.get(tmdbId);
    return { result, localItem: itemId ? (fullItemsById.get(itemId) || null) : null };
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

/**
 * "movie" or "tv" for one entry. The local item wins when there is one — its Type is what the
 * rendered card actually opens — and the Seerr media type covers everything else. runSearch has
 * already dropped every result that is neither, so this partition is exhaustive and no entry can
 * fall out of the grid between the two groups.
 */
function entryMediaType(entry) {
  const localType = String(entry?.localItem?.Type || "");
  if (localType === "Movie") return "movie";
  if (localType === "Series") return "tv";
  return resultMediaType(entry?.result);
}

/**
 * Emits an availability heading spanning the full grid row, then one type heading per non-empty
 * group beneath it, each followed by its cards. Renders nothing at all when every group is empty
 * — a heading over zero results is exactly the noise these sections exist to remove, and that
 * applies to the type headings as much as to the availability heading above them.
 *
 * The count on each heading is derived from the cards actually appended rather than passed in,
 * so a badge can never disagree with what is under it.
 */
function appendSection(frag, { title, variant, groups }) {
  const filled = groups.filter((group) => group.cards.length);
  if (!filled.length) return;

  const total = filled.reduce((sum, group) => sum + group.cards.length, 0);

  const head = document.createElement("div");
  head.className = `buscar-section-head buscar-section-head--${variant}`;
  head.setAttribute("role", "presentation");
  head.innerHTML = `
    <h3 class="buscar-section-title">${escapeHtml(title)}</h3>
    <span class="buscar-section-count">${total}</span>
  `;
  frag.appendChild(head);

  filled.forEach((group, index) => {
    const sub = document.createElement("div");
    sub.className = `buscar-subsection-head${index === 0 ? " buscar-subsection-head--first" : ""}`;
    sub.setAttribute("role", "presentation");
    sub.innerHTML = `
      <h4 class="buscar-subsection-title">${escapeHtml(group.title)}</h4>
      <span class="buscar-subsection-count">${group.cards.length}</span>
    `;
    frag.appendChild(sub);
    group.cards.forEach((card) => frag.appendChild(card));
  });
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

  // Split, preserving Seerr's relevance order inside each bucket.
  const available = entries.filter((entry) => entry.localItem);
  const missing = entries.filter((entry) => !entry.localItem);

  const activeRequests = missing.length ? await fetchActiveSerrRequests() : [];
  if (token !== __queryToken) return;

  const frag = document.createDocumentFragment();

  // Type is the second axis, nested under availability rather than replacing it: which of these
  // you already have and which you would have to request is the distinction the sections exist
  // for, and grouping by type instead of under it would throw that away.
  const ofType = (bucket, type) => bucket.filter((entry) => entryMediaType(entry) === type);
  const moviesLabel = L("sectionMovies", "Películas");
  const seriesLabel = L("sectionSeries", "Series");

  appendSection(frag, {
    title: L("buscarSectionAvailable", "En biblioteca"),
    variant: "available",
    groups: [
      {
        title: moviesLabel,
        cards: ofType(available, "movie").map(({ localItem }) =>
          decorateAvailableCard(createRecommendationCard(localItem, __serverId, { showRating: false }))),
      },
      {
        title: seriesLabel,
        cards: ofType(available, "tv").map(({ localItem }) =>
          decorateAvailableCard(createRecommendationCard(localItem, __serverId, { showRating: false }))),
      },
    ],
  });

  appendSection(frag, {
    title: L("buscarSectionDiscover", "Descubre"),
    variant: "discover",
    groups: [
      {
        title: moviesLabel,
        cards: ofType(missing, "movie").map(({ result }) => createRequestCard(result, activeRequests)),
      },
      {
        title: seriesLabel,
        cards: ofType(missing, "tv").map(({ result }) => createRequestCard(result, activeRequests)),
      },
    ],
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
          <button type="button" class="sx-search-clear" hidden aria-label="${escapeHtml(L("sectionSearchClear", "Limpiar búsqueda"))}">×</button>
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
