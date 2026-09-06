import { getSessionInfo, getEmbyHeaders, makeApiRequest, updateFavoriteStatus } from "../../Plugins/JMSFusion/runtime/api.js";
import { getConfig, getDeviceProfileAuto, getHomeSectionsRuntimeConfig } from './config.js';
import { getLanguageLabels } from "../language/index.js";
import { attachMiniPosterHover } from "./studioHubsUtils.js";
import { openDetailsModal } from "./detailsModalLoader.js";
import { openStudioExplorer } from "./genreExplorer.js";
import {
  keepManagedSectionsBelowNative,
  bindManagedSectionsBelowNative,
  waitForNativeHomeSectionStability,
  waitForVisibleHomeSections
} from "./homeSectionNative.js";
import {
  enqueueManagedSectionRender,
  registerManagedHomeRowAnchor,
  waitForManagedHomeRowRelease,
  waitForManagedSectionDependencyCompletion,
  waitForManagedSectionGate
} from "./homeSectionChain.js";
import { resolveSliderAssetHref } from "./assetLinks.js";
import { withServer } from "./jfUrl.js";
import { getCachedWatchlistMembership, getWatchlistButtonText } from "./watchlistShared.js";
import { ensureWatchlistLoaded } from "./watchlist.js";
import {
  buildStudioHubLogoUrl,
  buildStudioHubVideoUrl,
  fetchStudioHubVisibility,
  fetchStudioHubManualEntries,
  fetchStudioHubVideoEntries,
  findStudioHubVideoEntry,
  sanitizeStudioHubHiddenNames,
  sanitizeStudioHubOrderNames,
  getCanonicalStudioHubName,
  resolveStudioBrandEntities,
  resolveStudioBrandSeriesTags
} from "./studioHubsShared.js";

const config = getConfig();
const PLACEHOLDER_URL = resolveSliderAssetHref(
  config.placeholderImage || "/slider/src/images/placeholder.png"
);
// Brand rules, aliases and canonical names now live in studioHubsShared.js so
// this module and the settings page cannot drift apart. See STUDIO_BRANDS there.

const LOGO_H = 160;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAP_TTL   = 30 * 24 * 60 * 60 * 1000;
const IMG_TTL   = 7  * 24 * 60 * 60 * 1000;
// _v6 / _v2: the cached shape changed from one studio object per hub to a list
// of studio ids. Without the bump the 30-day nameIdMap would keep serving the
// old single-entity mapping and the fix would look like it did nothing.
const LS_KEY    = "studioHub_cache_v6";
const MAP_KEY   = "studioHub_nameIdMap_v6";
const IMG_KEY   = "studioHub_backdropMap_v2";
const TAGS_KEY  = "studioHub_seriesTags_v1";
const STUDIO_ITEMS_LIMIT = 24;
const STUDIO_RENDER_CONCURRENCY = 4;
const STUDIO_PAGE_SIZE = 1000;
const DEFAULT_ORDER = [
  "Marvel Studios","Pixar","Walt Disney Pictures","Disney+","DC",
  "Warner Bros. Pictures","Lucasfilm Ltd.","Columbia Pictures","Paramount Pictures",
  "Netflix","DreamWorks Animation"
];
const DEFAULT_NAME_KEYS = new Set(DEFAULT_ORDER.map(name => String(name || "").trim().toLowerCase()));

let __studioHubBusy = false;
let __fetchAbort = null;
let __studioHubsMounting = false;
let __studioHubsMountedOnce = false;
let __studioHubsRetryTo = null;

function setStudioHubsReady(done) {
  const next = done === true;
  let prev = false;
  try { prev = window.__jmsStudioHubsReady === true; } catch {}
  try { window.__jmsStudioHubsReady = next; } catch {}
  if (next && !prev) {
    try { document.dispatchEvent(new Event("jms:studio-hubs-ready")); } catch {}
  }
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }

  const h = Math.abs(hash % 360);
  const isCool = (h >= 200 && h <= 280);
  const isWarm = (h < 45 || h > 300);
  const s = isCool ? 55 : isWarm ? 65 : 50;

  return {
    bg: `linear-gradient(145deg,
          hsla(${h}, ${s}%, 14%, 0.97),
          hsla(${h}, ${s - 10}%, 9%, 0.98),
          hsla(${(h + 25) % 360}, ${s - 15}%, 6%, 1))`,
    shadow: `hsla(${h}, ${s + 10}%, 35%, 0.40)`
  };
}

function getActiveHomePage() {
  return document.querySelector("#indexPage:not(.hide)") || document.querySelector("#homePage:not(.hide)");
}

function hasMountedStudioHubsSection() {
  const page = getActiveHomePage();
  const section = page?.querySelector?.("#studio-hubs");
  const row = section?.querySelector?.(".hub-row");
  return !!section && !!row;
}

function upsertImg(card, className) {
  let img = card.querySelector('img.hub-img');
  if (!img) {
    img = document.createElement('img');
    img.className = className;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.style.opacity = '0';
    img.addEventListener('load', () => {
      card.classList.remove('skeleton');
      img.style.opacity = '1';
    }, { once: true });
    card.appendChild(img);
  } else {
    img.className = className;
  }
  return img;
}

function toCanonicalStudioName(name) {
  if (!name) return null;
  const canonical = getCanonicalStudioHubName(name);
  return DEFAULT_NAME_KEYS.has(nameKey(canonical)) ? canonical : null;
}

/**
 * Left-click opens the multi-studio explorer; modified and middle clicks fall
 * through to the href so "open in new tab" still works on the primary entity.
 */
function bindStudioExplorerCard(card, { name, studioIds, seriesTags }) {
  if (!card || !studioIds?.length) return;
  card.__jmsStudioIds = studioIds;
  // Read off the card at click time, like studioIds: a later render pass refreshes both,
  // and a listener bound once must not close over the first pass's values.
  card.__jmsSeriesTags = Array.isArray(seriesTags) ? seriesTags : [];
  if (card.__jmsStudioExplorerBound) return;
  card.__jmsStudioExplorerBound = true;

  card.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.target?.closest?.(".hub-preview-btn")) return;
    e.preventDefault();
    openStudioExplorer({
      name,
      studioIds: card.__jmsStudioIds,
      seriesTags: card.__jmsSeriesTags
    });
  });
}

function ensurePreviewButton(card, studioName, studioIds, userId) {
  if (!card.querySelector('.hub-preview-btn')) {
    createPreviewButton(card, studioName, studioIds, userId);
  }
}

function mergeOrder(defaults, custom) {
  const out = [];
  const seen = new Set();
  for (const n of (custom || [])) {
    const canon = toCanonicalStudioName(n) || n;
    const k = canon.toLowerCase();
    if (!seen.has(k)) { out.push(canon); seen.add(k); }
  }
  for (const n of defaults) {
    const k = n.toLowerCase();
    if (!seen.has(k)) { out.push(n); seen.add(k); }
  }
  return out;
}

function nameKey(value) {
  return String(value || "").trim().toLowerCase();
}

function isDefaultStudioHub(name) {
  return DEFAULT_NAME_KEYS.has(nameKey(name));
}

const LOGO_BASE = "./slider/src/images/studios/";
const LOCAL_EXTS = [".webp"];
const LOGO_CACHE_KEY = "studioHub_logoUrlCache_v1";
const LOGO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const VIDEO_EXTS = [".mp4"];
const HOVER_VIDEO_TIMEOUT = 4000;
const MIN_RATING = Number.isFinite(config.studioHubsMinRating) ? config.studioHubsMinRating : 6.5;
const LOCAL_STUDIO_LOGO_SLUGS = new Set([
  "columbia-pictures",
  "dc",
  "disney",
  "dreamworks-animation",
  "lucasfilm-ltd",
  "marvel-studios",
  "netflix",
  "paramount-pictures",
  "pixar",
  "universal",
  "walt-disney-pictures",
  "warner-bros-pictures"
]);
const LOCAL_STUDIO_VIDEO_SLUGS = new Set([
  "columbia-pictures",
  "dc",
  "disney",
  "dreamworks-animation",
  "lucasfilm-ltd",
  "marvel-studios",
  "netflix",
  "paramount-pictures",
  "pixar",
  "universal",
  "walt-disney-pictures",
  "warner-bros-pictures"
]);

const getRating = (it) => Number(it?.CommunityRating ?? it?.CriticRating ?? 0);
function randomSample(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}
/**
 * Preview picks, chosen per type so a brand's series survive the rating threshold.
 *
 * The threshold used to run over the pooled list, which made the preview films-only for
 * any brand holding both: Jellyfin leaves `CommunityRating` unset on many series, `getRating`
 * scores those 0, and the unfiltered fallback only fired when *nothing* cleared the bar — so
 * one qualifying film was enough to drop every series. Filtering within each type, and falling
 * back within each type, is what keeps both represented.
 *
 * Order stays films-then-series, the grouping the explorer grid already uses.
 */
function selectTopNWithMinRating(items, min = MIN_RATING, count = 5) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= count) return list;

  const movies = [];
  const series = [];
  for (const it of list) (it?.Type === "Series" ? series : movies).push(it);

  // Fall back to the type's unfiltered pool rather than returning nothing: an empty
  // result here used to blank the preview for any brand whose titles all sat
  // below the rating threshold.
  const qualify = (group) => {
    const filtered = group.filter(it => getRating(it) >= min);
    return filtered.length ? filtered : group;
  };
  const topMovies = qualify(movies);
  const topSeries = qualify(series);

  if (!topSeries.length) return randomSample(topMovies, count);
  if (!topMovies.length) return randomSample(topSeries, count);

  // Both types exist, so neither may be squeezed out of a five-card preview. Split by how
  // much of the brand each type is, then guarantee the smaller side at least one slot.
  const share = Math.round(count * topSeries.length / (topSeries.length + topMovies.length));
  const seriesSlots = Math.min(topSeries.length, count - 1, Math.max(1, share));
  const movieSlots = Math.min(topMovies.length, count - seriesSlots);
  return [...randomSample(topMovies, movieSlots), ...randomSample(topSeries, count - movieSlots)];
}

function isLocalStudioAssetUrl(url) {
  const clean = String(url || "");
  return clean.includes("/slider/src/images/studios/") || clean.includes("./slider/src/images/studios/");
}
function getStudioAssetSlugFromUrl(url) {
  const clean = String(url || "");
  const match = clean.match(/\/([^/?#]+)\.[a-z0-9]+(?:\?|#|$)/i);
  return String(match?.[1] || "").trim().toLowerCase();
}
function hasKnownLocalStudioLogo(url) {
  const slug = getStudioAssetSlugFromUrl(url);
  return !!slug && LOCAL_STUDIO_LOGO_SLUGS.has(slug);
}
function deriveVideoCandidatesFromLogo(logoUrl) {
  if (!isLocalStudioAssetUrl(logoUrl) || !hasKnownLocalStudioLogo(logoUrl)) return [];
  const slug = getStudioAssetSlugFromUrl(logoUrl);
  if (!slug || !LOCAL_STUDIO_VIDEO_SLUGS.has(slug)) return [];
  return VIDEO_EXTS.map(ext => withVer(`${LOGO_BASE}${slug}${ext}`));
}

function markCardReady(card, { textOnly = false } = {}) {
  if (!card) return;
  card.classList.remove("skeleton");
  card.classList.toggle("hub-card-textonly", textOnly);
  setStudioHubsReady(true);
}

function clearCardImage(card) {
  const img = card?.querySelector?.("img.hub-img");
  if (!img) return;
  try { img.removeAttribute("src"); } catch {}
  try { img.remove(); } catch {}
}
let __hubPreviewPopover = null;
let __hubPreviewCloseTimer = null;
let __userInteracted = false;
window.addEventListener('pointermove', () => { __userInteracted = true; }, { once: true, passive: true });

function ensurePreviewPopover() {
  if (__hubPreviewPopover) return __hubPreviewPopover;
  const pop = document.createElement('div');
  pop.className = 'hub-preview-popover';
  pop.innerHTML = `
    <div class="hub-preview-header">
      <h3 class="hub-preview-title"></h3>
      <button class="hub-preview-close" aria-label="Close">×</button>
    </div>
    <div class="hub-preview-body"></div>
  `;
  document.body.appendChild(pop);
  pop.querySelector('.hub-preview-close').addEventListener('click', hidePreviewPopover);
  pop.addEventListener('mouseenter', () => {
    if (__hubPreviewCloseTimer) { clearTimeout(__hubPreviewCloseTimer); __hubPreviewCloseTimer = null; }
  });
  pop.addEventListener('mouseleave', () => scheduleHidePopover());
  __hubPreviewPopover = pop;
  const autoHide = () => hidePreviewPopover();
  window.addEventListener('beforeunload', autoHide);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoHide(); });
  window.addEventListener('hashchange', autoHide);
  return pop;
}

 const OPEN_INTENT_MS   = Number(config.studioHubsOpenIntentMs ?? 180);
 const CLOSE_GRACE_MS   = Number(config.studioHubsCloseGraceMs ?? 300);
 function scheduleHidePopover(delay = CLOSE_GRACE_MS) {
  if (__hubPreviewCloseTimer) clearTimeout(__hubPreviewCloseTimer);
  __hubPreviewCloseTimer = setTimeout(() => { hidePreviewPopover(); }, delay);
}

function hidePreviewPopover() {
  if (__hubPreviewCloseTimer) { clearTimeout(__hubPreviewCloseTimer); __hubPreviewCloseTimer = null; }
  if (!__hubPreviewPopover) return;
  try { __hubPreviewPopover.__cleanup?.(); __hubPreviewPopover.__cleanup = null; } catch {}
  __hubPreviewPopover.classList.remove('visible');
  setTimeout(() => {
    if (!__hubPreviewPopover.classList.contains('visible')) {
      __hubPreviewPopover.style.display = 'none';
    }
  }, 200);
}

function setPopoverContent(studioName, items) {
  const pop = ensurePreviewPopover();
  const title = pop.querySelector('.hub-preview-title');
  const body = pop.querySelector('.hub-preview-body');

  title.textContent = `${studioName} - ${(config.languageLabels.previewModalTitle || 'Top Rated Movies')}`;
  pop.querySelector('.hub-preview-close').setAttribute('aria-label', config.languageLabels.closeButton || 'Close');

  body.innerHTML = '';
  const { serverId } = getSessionInfo();

  items.slice(0, 5).forEach(item => {
    const itemEl = document.createElement('div');
    itemEl.className = 'hub-preview-item';
    const posterUrl = buildPosterUrl(item, 300, 95);
    let ratingVal = item.CommunityRating || item.CriticRating;
    let rating = (typeof ratingVal === "number") ? ratingVal.toFixed(1) : (config.languageLabels.noRating || 'N/A');
    let isFavorite = getCachedWatchlistMembership(item.Id, item.UserData?.IsFavorite);
    item.UserData = item.UserData || {};
    item.UserData.IsFavorite = isFavorite;
    const favAddText = getWatchlistButtonText(item, false);
    const favRemoveText = getWatchlistButtonText(item, true);
    itemEl.innerHTML = `
      <img class="hub-preview-poster" src="${posterUrl || PLACEHOLDER_URL}" alt="${item.Name}" loading="lazy">
      <div class="hub-preview-info">
        <div class="hub-preview-item-title">${item.Name}</div>
        <div class="hub-preview-rating">
          ⭐ ${rating}
          <button class="favorite-heart ${isFavorite ? 'favorited' : ''}"
                  data-item-id="${item.Id}"
                  aria-label="${isFavorite ? favRemoveText : favAddText}">
            ${isFavorite ? '❤️' : '🤍'}
          </button>
        </div>
      </div>
    `;
    const favoriteBtn = itemEl.querySelector('.favorite-heart');
    favoriteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (favoriteBtn.__busy) return;
      favoriteBtn.__busy = true;
      const next = !isFavorite;
      const ok = await toggleFavorite(item.Id, next, favoriteBtn, item);
      favoriteBtn.__busy = false;
      if (ok) {
        isFavorite = next;
        item.UserData = item.UserData || {};
        item.UserData.IsFavorite = isFavorite;
        favoriteBtn.classList.toggle('favorited', isFavorite);
        favoriteBtn.innerHTML = isFavorite ? '❤️' : '🤍';
        favoriteBtn.setAttribute('aria-label', isFavorite ? favRemoveText : favAddText);
      }
    });

    ensureWatchlistLoaded().then(() => {
      const synced = getCachedWatchlistMembership(item.Id, isFavorite);
      isFavorite = synced;
      item.UserData.IsFavorite = synced;
      favoriteBtn.classList.toggle('favorited', synced);
      favoriteBtn.innerHTML = synced ? '❤️' : '🤍';
      favoriteBtn.setAttribute('aria-label', synced ? favRemoveText : favAddText);
    }).catch(() => {});

    itemEl.addEventListener('click', async (e) => {
      if (!e.target.closest('.favorite-heart')) {
        e.preventDefault();
        e.stopPropagation();
        const backdropIndex = localStorage.getItem("jms_backdrop_index") || "0";
        try {
          await openDetailsModal({
            itemId: item.Id,
            serverId,
            preferBackdropIndex: backdropIndex,
            originEl: itemEl.querySelector(".hub-preview-poster") || itemEl,
          });
          hidePreviewPopover();
        } catch (err) {
          console.warn("openDetailsModal failed (studio hub preview item):", err);
        }
      }
    });

    attachMiniPosterHover(itemEl, item);
    body.appendChild(itemEl);
  });

  return pop;
}

async function toggleFavorite(itemId, isFavorite, buttonElement, item) {
  const favAddText = getWatchlistButtonText(item, false);
  const favRemoveText = getWatchlistButtonText(item, true);
  try {
    await updateFavoriteStatus(itemId, isFavorite, { item });
    if (isFavorite) {
      buttonElement.innerHTML = '❤️';
      buttonElement.classList.add('favorited');
      buttonElement.setAttribute('aria-label', favRemoveText);
    } else {
      buttonElement.innerHTML = '🤍';
      buttonElement.classList.remove('favorited');
      buttonElement.setAttribute('aria-label', favAddText);
    }
    buttonElement.style.transform = 'scale(1.2)';
    setTimeout(() => { buttonElement.style.transform = 'scale(1)'; }, 200);
    return true;
  } catch (error) {
    console.error('Favori işlemi hatası:', error);
    buttonElement.style.animation = 'shake 0.5s';
    setTimeout(() => { buttonElement.style.animation = ''; }, 500);
    return false;
  }
}

function positionPopover(anchorEl, pop) {
  const margin = 8;
  const docEl = document.documentElement;
  const vw = docEl.clientWidth;
  const vh = docEl.clientHeight;
  const r = anchorEl.getBoundingClientRect();
  const prevDisplay = pop.style.display;
  pop.style.display = 'block';
  pop.style.opacity = '0';
  pop.style.pointerEvents = 'none';

  const pw = Math.min(pop.offsetWidth || 360, vw - 2 * margin);
  const ph = Math.min(pop.offsetHeight || 300, vh - 2 * margin);

  const spaceRight  = vw - r.right  - margin;
  const spaceLeft   = r.left        - margin;
  const spaceBottom = vh - r.bottom - margin;
  const spaceTop    = r.top         - margin;

  let placement = 'right';
  if (spaceRight >= pw) placement = 'right';
  else if (spaceLeft >= pw) placement = 'left';
  else if (spaceBottom >= ph) placement = 'bottom';
  else if (spaceTop >= ph) placement = 'top';
  else {
    const candidates = [
      { side: 'right',  size: spaceRight },
      { side: 'left',   size: spaceLeft },
      { side: 'bottom', size: spaceBottom },
      { side: 'top',    size: spaceTop },
    ].sort((a,b) => b.size - a.size);
    placement = candidates[0].side;
  }

  let left, top;
  switch (placement) {
    case 'right':  left = r.right + margin;          top = r.top + (r.height - ph) / 2; break;
    case 'left':   left = r.left - margin - pw;      top = r.top + (r.height - ph) / 2; break;
    case 'bottom': left = r.left + (r.width - pw)/2; top = r.bottom + margin;           break;
    case 'top':    left = r.left + (r.width - pw)/2; top = r.top - margin - ph;         break;
  }

  left = Math.max(margin, Math.min(left, vw - margin - pw));
  top  = Math.max(margin, Math.min(top,  vh - margin - ph));
  pop.style.left = `${Math.round(left + window.scrollX)}px`;
  pop.style.top  = `${Math.round(top  + window.scrollY)}px`;
  pop.style.display = prevDisplay || 'block';
  pop.style.opacity = '';
  pop.style.pointerEvents = '';
}

function showPreviewPopover(anchorEl, studioName, items) {
  const pop = setPopoverContent(studioName, items);
  pop.style.position = 'absolute';
  pop.style.maxWidth = 'min(520px, 90vw)';
  pop.style.maxHeight = 'min(70vh, 600px)';
  pop.style.overflow = 'auto';
  pop.style.display = 'block';
  pop.classList.remove('visible');

  const reposition = () => positionPopover(anchorEl, pop);
  requestAnimationFrame(() => {
    reposition();
    requestAnimationFrame(() => { pop.classList.add('visible'); });
  });

  const onWin = () => reposition();
  window.addEventListener('resize', onWin, { passive: true });
  window.addEventListener('scroll', onWin, { passive: true });

  const row = anchorEl.closest('.hub-row');
  const onRow = () => reposition();
  if (row) row.addEventListener('scroll', onRow, { passive: true });

  const closeIfLeft = () => {
    if (!anchorEl.matches(':hover') && !pop.matches(':hover')) {
      scheduleHidePopover(CLOSE_GRACE_MS);
      const cancelOnReHover = () => {
        if (__hubPreviewCloseTimer && (anchorEl.matches(':hover') || pop.matches(':hover'))) {
          clearTimeout(__hubPreviewCloseTimer);
          __hubPreviewCloseTimer = null;
        }
      };
      pop.addEventListener('mouseenter', cancelOnReHover, { once: true });
      anchorEl.addEventListener('mouseenter', cancelOnReHover, { once: true });
    }
  };
  anchorEl.addEventListener('mouseleave', closeIfLeft, { passive: true });
  const onPopLeave = () => scheduleHidePopover(CLOSE_GRACE_MS);
  pop.addEventListener('mouseleave', onPopLeave, { passive: true });

  const cleanup = () => {
    window.removeEventListener('resize', onWin);
    window.removeEventListener('scroll', onWin);
    if (row) row.removeEventListener('scroll', onRow);
    anchorEl.removeEventListener('mouseleave', closeIfLeft);
    pop.removeEventListener('mouseleave', onPopLeave);
  };

  pop.__cleanup = cleanup;
}

function createPreviewButton(card, studioName, studioIds, userId) {
  const btn = document.createElement('button');
  btn.className = 'hub-preview-btn';
  btn.setAttribute('aria-label', `${studioName} ${(config.languageLabels.previewButtonLabel || "Önizleme")}`);
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';

  let isFetching = false;
  let studioItems = null;
  let hoverOpenTimer = null;

  async function ensureItems() {
    if (studioItems || isFetching) return;
    isFetching = true;
    btn.style.opacity = '0.5';
    try {
      const signal = __fetchAbort ? __fetchAbort.signal : null;
      // One request per type, in parallel. A single Movie,Series call sorted by rating
      // returns the top-rated titles overall, and series routinely carry no
      // CommunityRating — so that one page can come back films-only before the
      // selection below ever gets to choose.
      const [films, shows] = await Promise.all([
        fetchStudioItemsViaUsers(studioIds, studioName, userId, signal, { itemTypes: "Movie" }),
        fetchStudioItemsViaUsers(studioIds, studioName, userId, signal, {
          itemTypes: "Series",
          tags: card.__jmsSeriesTags || []
        })
      ]);
      studioItems = selectTopNWithMinRating([...films, ...shows], MIN_RATING, 5);
    } catch (err) {
      console.error('Ön izleme verileri alınamadı:', err);
      studioItems = [];
    } finally {
      isFetching = false;
      btn.style.opacity = '';
    }
  }

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await ensureItems();
    if (studioItems && studioItems.length) { showPreviewPopover(btn, studioName, studioItems); }
  });

  btn.addEventListener('mouseenter', async () => {
    if (!__userInteracted) return;
    if (hoverOpenTimer) clearTimeout(hoverOpenTimer);
    await ensureItems();
    hoverOpenTimer = setTimeout(() => {
      if (btn.matches(':hover') && studioItems && studioItems.length) {
        showPreviewPopover(btn, studioName, studioItems);
      }
    }, OPEN_INTENT_MS);
  });

  btn.addEventListener('mouseleave', () => {
    if (hoverOpenTimer) { clearTimeout(hoverOpenTimer); hoverOpenTimer = null; }
    scheduleHidePopover(160);
  });

  btn.addEventListener('focus', async () => {
    await ensureItems();
    if (studioItems && studioItems.length) { showPreviewPopover(btn, studioName, studioItems); }
  });
  btn.addEventListener('blur', () => scheduleHidePopover(160));

  card.appendChild(btn);
  return btn;
}

async function setupHoverVideo(card, options = {}) {
  if (!card) return;

  try {
    card.__hoverVideoCleanup?.();
  } catch {}
  card.__hoverVideoCleanup = null;

  const oldVideo = card.querySelector("video.hub-video");
  if (oldVideo) {
    try { oldVideo.pause(); } catch {}
    try { oldVideo.removeAttribute("src"); oldVideo.load?.(); } catch {}
    try { oldVideo.remove(); } catch {}
  }

  const logoUrl = options.logoUrl || null;
  const customVideoUrl = options.customVideoUrl || null;
  const studioName = options.studioName || "";
  const studioIds = options.studioIds || [];
  const userId = options.userId || "";

  const derivedVideoUrls = logoUrl ? deriveVideoCandidatesFromLogo(logoUrl) : [];
  const playableUrl = customVideoUrl || derivedVideoUrls[0] || null;
  if (!playableUrl) return;

  let vidEl = null;

  const ensureVideo = () => {
    if (vidEl) return vidEl;
    vidEl = document.createElement("video");
    vidEl.className = "hub-video";
    vidEl.src = playableUrl;
    vidEl.muted = true;
    vidEl.loop = true;
    vidEl.playsInline = true;
    vidEl.preload = "auto";
    vidEl.setAttribute("aria-hidden", "true");
    card.style.position = card.style.position || "relative";
    card.appendChild(vidEl);
    if (studioName && studioIds.length && userId) {
      ensurePreviewButton(card, studioName, studioIds, userId);
    }
    return vidEl;
  };

  const play = () => {
    const v = ensureVideo();
    v.currentTime = 0;
    v.style.opacity = "1";
    v.play().catch(() => {});
  };
  const stop = (remove = false) => {
    if (!vidEl) return;
    try { vidEl.pause(); } catch {}
    vidEl.style.opacity = "0";
    if (remove) {
      const v = vidEl;
      vidEl = null;
      try { v.removeAttribute('src'); v.load?.(); } catch {}
      try { v.remove(); } catch {}
    }
  };

  const onMouseEnter = () => { if (__userInteracted) play(); };
  const onMouseLeave = () => stop(false);
  const onFocus = () => play();
  const onBlur = () => stop(false);
  const stopAndRemove = () => stop(true);
  card.addEventListener("mouseenter", onMouseEnter);
  card.addEventListener("mouseleave", onMouseLeave);
  card.addEventListener("focus", onFocus);
  card.addEventListener("blur", onBlur);
  card.addEventListener("click", stopAndRemove);
  card.addEventListener("pointerdown", stopAndRemove);

  const onRouteOrHide = () => stop(true);
  const onVisibilityChange = () => {
    if (document.hidden) onRouteOrHide();
  };
  window.addEventListener("hashchange", onRouteOrHide);
  window.addEventListener("beforeunload", onRouteOrHide);
  document.addEventListener("visibilitychange", onVisibilityChange);

  card.__hoverVideoCleanup = () => {
    stop(true);
    card.removeEventListener("mouseenter", onMouseEnter);
    card.removeEventListener("mouseleave", onMouseLeave);
    card.removeEventListener("focus", onFocus);
    card.removeEventListener("blur", onBlur);
    card.removeEventListener("click", stopAndRemove);
    card.removeEventListener("pointerdown", stopAndRemove);
    window.removeEventListener("hashchange", onRouteOrHide);
    window.removeEventListener("beforeunload", onRouteOrHide);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}


function withVer(url, v = "1") { return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(v)}`; }
function loadLogoCache() {
  try { const raw = localStorage.getItem(LOGO_CACHE_KEY); if (!raw) return {}; const { ts, data } = JSON.parse(raw); if (!ts || Date.now() - ts > LOGO_CACHE_TTL) return {}; return data || {}; } catch { return {}; }
}
function saveLogoCache(map) {
  try {
    const entries = Object.entries(map);
    const MAX = 100;
    const trimmed = entries.slice(-MAX);
    const out = Object.fromEntries(trimmed);
    localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: out }));
  } catch {}
}
function slugify(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[().,™©®'’"&+]/g, " ")
    .replace(/\s+and\s+/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
async function tryLocalLogo(name) {
  const slug = slugify(name);
  if (!slug || !LOCAL_STUDIO_LOGO_SLUGS.has(slug)) return null;
  const ext = LOCAL_EXTS[0];
  if (!ext) return null;
  const base = LOGO_BASE + slug;
  return withVer(`${base}${ext}`);
}
function isCachedLocalStudioLogo(url) {
  return isLocalStudioAssetUrl(url) && hasKnownLocalStudioLogo(url);
}
function sanitizeLogoCacheEntry(cache, key) {
  if (!cache || !key || !cache[key]) return null;
  if (isCachedLocalStudioLogo(cache[key])) return cache[key];
  delete cache[key];
  saveLogoCache(cache);
  return null;
}
async function resolveLogoUrl(name) {
  const cache = loadLogoCache();
  const cachedUrl = sanitizeLogoCacheEntry(cache, name);
  if (cachedUrl) return cachedUrl;
  const localUrl = await tryLocalLogo(name);
  if (localUrl) { cache[name] = localUrl; saveLogoCache(cache); return localUrl; }
  return null;
}

/**
 * Every studio the user can see.
 *
 * Paged, because the old `Limit=300` silently truncated: a 338-studio library
 * lost Walt Disney Pictures, Warner Bros. and Universal off the end of the
 * SortName-ascending page, and those are default hubs.
 */
async function fetchStudios(signal, userId) {
  const out = [];
  let startIndex = 0;

  for (;;) {
    const params = new URLSearchParams({
      Limit: String(STUDIO_PAGE_SIZE),
      StartIndex: String(startIndex),
      SortBy: "SortName",
      SortOrder: "Ascending"
    });
    if (userId) params.set("userId", userId);

    const res = await fetch(withServer(`/Studios?${params}`), { headers: hJSON(), signal, credentials: 'same-origin' });
    if (!res.ok) {
      if (out.length) break;
      throw new Error("Studios alınamadı");
    }

    const data = await res.json();
    const items = Array.isArray(data?.Items) ? data.Items : (Array.isArray(data) ? data : []);
    out.push(...items.map(s => ({
      Id: s.Id,
      Name: s.Name,
      ImageTags: s.ImageTags || {},
      PrimaryImageTag: s.PrimaryImageTag || (s.ImageTags?.Primary) || null
    })));

    const total = Number(data?.TotalRecordCount);
    startIndex += items.length;
    if (!items.length || !Number.isFinite(total) || startIndex >= total) break;
  }

  return out;
}

/**
 * The library's series tag vocabulary, cached for a day.
 *
 * `/Items/Filters` returns every tag in one response — 1824 of them on the reference
 * library — so this runs once per render pass and is shared by every brand rather than
 * queried per hub. A failure is not fatal: brands fall back to the studio axis, which is
 * exactly how they behaved before tags existed.
 */
async function fetchSeriesTagVocabulary(userId, signal) {
  const cached = loadCache(TAGS_KEY, CACHE_TTL);
  if (Array.isArray(cached)) return cached;

  try {
    const params = new URLSearchParams({ userId, IncludeItemTypes: "Series" });
    const r = await fetch(withServer(`/Items/Filters?${params}`), { headers: hJSON(), signal, credentials: 'same-origin' });
    if (!r.ok) return [];
    const data = await r.json();
    const tags = Array.isArray(data?.Tags) ? data.Tags.filter(Boolean).map(String) : [];
    saveCache(TAGS_KEY, tags);
    return tags;
  } catch {
    return [];
  }
}

function toStudioIdList(studioIds) {
  const list = Array.isArray(studioIds) ? studioIds : [studioIds];
  return [...new Set(list.map(id => String(id || "").trim()).filter(Boolean))];
}

/**
 * Items for a brand, unioned across every studio entity it owns.
 *
 * `StudioIds` must be comma-separated — a pipe-separated value does not OR,
 * it returns unrelated results (203 items instead of 12 when measured).
 *
 * `minRating` is opt-in. It used to be baked into every call, including the one
 * that decides whether a card exists at all, so a brand whose titles all sat
 * below the threshold silently lost its card.
 *
 * `SortBy` is not optional. `SortOrder: Descending` on its own does not mean
 * "best first" — with no sort key Jellyfin falls back to SortName, so the cap of
 * `limit` items returned the brand's alphabetically *last* titles and called them
 * a sample. The card-existence check below reads the same call, so this was not
 * only a preview problem.
 *
 * `itemTypes` narrows the query to one type. Callers that need both types
 * represented must ask for each separately: a single Movie,Series call sorted by
 * rating fills its page with whatever scores highest overall, and Jellyfin leaves
 * `CommunityRating` unset on many series, so that page can come back films-only.
 */
async function fetchStudioItemsViaUsers(studioIds, studioName, userId, signal, options = {}) {
  const ids = toStudioIdList(studioIds);
  if (!ids.length) return [];

  const limit = Math.max(1, Math.min(STUDIO_ITEMS_LIMIT, Number(options.limit) || STUDIO_ITEMS_LIMIT));
  const tags = (options.tags || []).filter(Boolean);
  const params = new URLSearchParams({
    StartIndex: "0",
    Limit: String(limit),
    Fields: "PrimaryImageAspectRatio,ImageTags,BackdropImageTags,CommunityRating,CriticRating",
    Recursive: "true",
    SortBy: "CommunityRating,DateCreated",
    SortOrder: "Descending",
    IncludeItemTypes: String(options.itemTypes || "Movie,Series")
  });
  // Tags replace the studio filter rather than joining it. A brand only carries tags
  // when its series are unreachable by studio, so ANDing the two would return nothing.
  if (tags.length) params.set("Tags", tags.join("|"));
  else params.set("StudioIds", ids.join(","));
  if (Number.isFinite(options.minRating)) {
    params.set("MinCommunityRating", String(options.minRating));
  }

  try {
    const r = await fetch(withServer(`/Users/${userId}/Items?${params}`), { headers: hJSON(), signal, credentials: 'same-origin' });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data?.Items) ? data.Items : (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

function hJSON() {
  return getEmbyHeaders({ "Accept":"application/json" });
}

function buildBackdropUrl(item, index = 0) {
  const tags = item.BackdropImageTags || [];
  const tag = tags[index];
  if (!tag) return null;
  return withServer(`/Items/${item.Id}/Images/Backdrop/${index}?tag=${encodeURIComponent(tag)}&quality=72&maxWidth=960&format=webp`);
}
function buildPosterUrl(item, height = 300, quality = 95) {
  const tag = item.ImageTags?.Primary || item.PrimaryImageTag;
  if (!tag) return null;
  return withServer(`/Items/${item.Id}/Images/Primary?tag=${encodeURIComponent(tag)}&fillHeight=${height}&quality=${quality}`);
}
function pickRandom(arr) { return arr.length ? arr[Math.floor(Math.random()*arr.length)] : null; }

async function mapSettledLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(list.length || 1, Number(limit) || 1));
  let index = 0;
  const results = new Array(list.length);

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < list.length) {
      const current = index++;
      try {
        results[current] = { status: "fulfilled", value: await worker(list[current], current) };
      } catch (reason) {
        results[current] = { status: "rejected", reason };
      }
    }
  }));

  return results;
}

async function getHiddenStudioNameSet(manualEntries = []) {
  const liveConfig = getConfig();
  if (liveConfig?.forceGlobalUserSettings) {
    const globalHidden = Array.isArray(liveConfig?.studioHubsHidden) ? liveConfig.studioHubsHidden : [];
    return new Set(sanitizeStudioHubHiddenNames(globalHidden, manualEntries).map(nameKey));
  }

  try {
    const profile = getDeviceProfileAuto();
    const visibility = await fetchStudioHubVisibility({ profile });
    return new Set(sanitizeStudioHubHiddenNames(visibility?.hiddenNames || [], manualEntries).map(nameKey));
  } catch {
    return new Set();
  }
}

async function getStudioOrderList(manualEntries = []) {
  const liveConfig = getConfig();
  const globalOrder = Array.isArray(liveConfig?.studioHubsOrder) ? liveConfig.studioHubsOrder : [];

  if (liveConfig?.forceGlobalUserSettings) {
    return mergeOrder(DEFAULT_ORDER, sanitizeStudioHubOrderNames(globalOrder, manualEntries));
  }

  try {
    const profile = getDeviceProfileAuto();
    const visibility = await fetchStudioHubVisibility({ profile });
    const userOrder = Array.isArray(visibility?.orderNames) && visibility.orderNames.length
      ? visibility.orderNames
      : globalOrder;
    return mergeOrder(DEFAULT_ORDER, sanitizeStudioHubOrderNames(userOrder, manualEntries));
  } catch {
    return mergeOrder(DEFAULT_ORDER, sanitizeStudioHubOrderNames(globalOrder, manualEntries));
  }
}

async function chooseBackdropForStudio(brand, userId, signal, options = {}) {
  // Keyed by brand name, not studio id: a brand spans several entities and the
  // "primary" one can change as metadata is refreshed.
  const cacheKey = nameKey(brand?.canonical || brand?.name);
  const map = loadCache(IMG_KEY, IMG_TTL) || {};
  const cached = map[cacheKey];
  if (cached?.itemId && Number.isInteger(cached?.index)) {
    const itemId = cached.itemId;
    const idx    = cached.index;
    const tag    = cached.tag || null;
    const url = tag
      ? withServer(`/Items/${itemId}/Images/Backdrop/${idx}?tag=${encodeURIComponent(tag)}&quality=72&maxWidth=960&format=webp`)
      : withServer(`/Items/${itemId}/Images/Backdrop/${idx}?quality=72&maxWidth=960&format=webp`);
    return { itemId, index: idx, url };
  }

  const items = Array.isArray(options.items)
    ? options.items
    : await fetchStudioItemsViaUsers(brand?.studioIds, brand?.canonical, userId, signal);
  if (!items.length) return null;

  const withBd = items.filter(it => Array.isArray(it.BackdropImageTags) && it.BackdropImageTags.length);
  const candidate = pickRandom(withBd.length ? withBd : items);
  if (!candidate) return null;

  let idx = 0;
  let url = buildBackdropUrl(candidate, idx);

  if (!url) {
    const purl = buildPosterUrl(candidate);
    if (!purl) return null;
    const payload = { itemId: candidate.Id, index: -1, tag: candidate.ImageTags?.Primary || candidate.PrimaryImageTag || null };
    const newMap = { ...map, [cacheKey]: payload };
    saveCache(IMG_KEY, newMap);
    return { itemId: candidate.Id, index: -1, url: purl };
  }

  const tag = (candidate.BackdropImageTags||[])[idx] || null;
  const payload = { itemId: candidate.Id, index: idx, tag };
  const newMap = { ...map, [cacheKey]: payload };
  saveCache(IMG_KEY, newMap);

  return { itemId: candidate.Id, index: idx, url };
}

function loadCache(k, ttl) {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > ttl) return null;
    return obj.data;
  } catch { return null; }
}
function saveCache(k, data) {
  try {
    let d = data;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const MAX = 300;
      const ent = Object.entries(d);
      if (ent.length > MAX) d = Object.fromEntries(ent.slice(-MAX));
    }
    localStorage.setItem(k, JSON.stringify({ ts: Date.now(), data: d }));
  } catch {}
}

function buildStudioHref(studioId, serverId) {
  return `#/list?studioId=${encodeURIComponent(studioId)}${serverId ? `&serverId=${encodeURIComponent(serverId)}` : ""}`;
}

function createBackdropCardShell(title, studio, serverId) {
  const a = document.createElement("a");
  a.className = "hub-card skeleton";
  a.dataset.hub = title;
  a.href = studio?.Id ? buildStudioHref(studio.Id, serverId) : "javascript:void(0)";
  a.setAttribute("aria-label", title);

  const overlay = document.createElement("div");
  overlay.className = "hub-overlay";

  const label = document.createElement("div");
  label.className = "hub-title-text";
  label.textContent = title;

  overlay.appendChild(label);
  a.appendChild(overlay);
  return a;
}

function cleanupStudioHubsSection() {
  clearTimeout(__studioHubsRetryTo);
  __studioHubsRetryTo = null;
  __studioHubBusy = false;
  __studioHubsMounting = false;
  __studioHubsMountedOnce = false;
  setStudioHubsReady(false);

  if (__fetchAbort) {
    try { __fetchAbort.abort(); } catch {}
  }
  __fetchAbort = null;

  document.querySelectorAll("#studio-hubs").forEach((section) => {
    try {
      section.querySelectorAll('video.hub-video').forEach(v => {
        try { v.pause(); } catch {}
        try { v.removeAttribute('src'); v.load?.(); } catch {}
      });
    } catch {}

    try { section.remove(); } catch {}
  });
}

export function cleanupStudioHubs() {
  cleanupStudioHubsSection();
}

export async function renderStudioHubs() {
  const runtimeConfig = getConfig?.() || config || {};
  const homeSectionsConfig = getHomeSectionsRuntimeConfig(runtimeConfig);
  if (!homeSectionsConfig.enableStudioHubs) {
    cleanupStudioHubsSection();
    return;
  }
  if (__studioHubBusy) return;
  __studioHubBusy = true;
  setStudioHubsReady(false);

  if (__fetchAbort) { try { __fetchAbort.abort(); } catch {} }
  __fetchAbort = new AbortController();

  try {
    const indexPage =
      document.querySelector("#indexPage:not(.hide)") ||
      document.querySelector("#homePage:not(.hide)");
    if (!indexPage) {
      return;
    }
     const row = ensureContainer(indexPage);
    if (!row) {
      return;
    }
    const section = row.closest("#studio-hubs");
     setupScroller(row);
     resetHubRowScrollPosition(row);
     row.innerHTML = "";
     let { serverId, userId } = getSessionInfo();
     serverId = serverId || localStorage.getItem("serverId") || sessionStorage.getItem("serverId") || null;
     const shells = {};

    const manualEntries = await fetchStudioHubManualEntries().catch(() => []);
    const hiddenNames = await getHiddenStudioNameSet(manualEntries);
    const userOrder = await getStudioOrderList(manualEntries);
    const manualOrder = (manualEntries || [])
      .map(entry => String(entry?.name || entry?.Name || "").trim())
      .filter(Boolean);
    const effectiveOrder = mergeOrder(manualOrder, userOrder);
    const visibleOrder = effectiveOrder.filter(name => !hiddenNames.has(nameKey(name)));
    if (!visibleOrder.length) {
      if (section) section.style.display = "none";
      setStudioHubsReady(true);
      return;
    }

    const maxCards = Number.isFinite(config.studioHubsCardCount) ? config.studioHubsCardCount : visibleOrder.length;
    const wanted = visibleOrder.slice(0, Math.max(1, maxCards));
    const sharedVideos = config.studioHubsHoverVideo
      ? await fetchStudioHubVideoEntries().catch(() => [])
      : [];

    for (const desired of wanted) {
      const existing = row.querySelector(`.hub-card[data-hub="${CSS.escape(desired)}"]`);
      const card = existing || createBackdropCardShell(desired, null, null);
      if (!existing) row.appendChild(card);
      shells[desired] = card;
    }
    if (section) section.style.display = "";

    const cached = loadCache(LS_KEY, CACHE_TTL);
    const studios = cached || await fetchStudios(__fetchAbort.signal, userId).catch(() => []);
    if (!cached && studios.length) saveCache(LS_KEY, studios);

    // One shared fetch for every brand: the tag axis is how film brands reach their series,
    // which carry the broadcasting network as their studio rather than the production company.
    const seriesTagVocabulary = await fetchSeriesTagVocabulary(userId, __fetchAbort.signal);

    // A hub is a brand, and a brand spans every Jellyfin Studio entity matching
    // its rules — resolving to a single "best" entity is what hid most of the
    // library behind each card.
    //
    // Resolution runs every render. It is pure and operates on an array we
    // already hold, so it costs nothing, and caching it would re-create the bug
    // one level up: a stored mapping would outlive new studios, metadata
    // refreshes and registry edits. MAP_KEY is only an offline fallback for
    // when the studio fetch fails outright.
    const fallbackMap = loadCache(MAP_KEY, MAP_TTL) || {};
    const nextMap = {};
    const resolved = [];

    for (const desired of wanted) {
      const manualEntry = (manualEntries || []).find(entry => nameKey(entry?.name || entry?.Name) === nameKey(desired)) || null;
      const manualId = String(manualEntry?.studioId || manualEntry?.StudioId || "").trim();

      let brand;
      if (manualId) {
        // Manual entries stay single-entity on purpose: the admin picked one
        // specific studio, so we honour exactly that.
        brand = { canonical: desired, studioIds: [manualId], studioNames: [desired], primaryId: manualId };
      } else if (studios.length) {
        brand = resolveStudioBrandEntities(desired, studios);
      } else {
        brand = fallbackMap[desired];
      }

      if (brand?.studioIds?.length) {
        resolved.push({ name: desired, brand });
        nextMap[desired] = brand;
      }
    }

    if (studios.length) saveCache(MAP_KEY, nextMap);

    const resolvedNames = new Set(resolved.map(({ name }) => nameKey(name)));
    for (const desired of wanted) {
      if (resolvedNames.has(nameKey(desired))) continue;
      if (!isDefaultStudioHub(desired)) continue;
      try { shells[desired]?.remove?.(); } catch {}
      delete shells[desired];
    }

    await mapSettledLimit(resolved, STUDIO_RENDER_CONCURRENCY, async ({ name, brand }) => {
      const card = shells[name];
      if (!card) return;
      const enableColorize = config.studioHubsColorize !== false;

      if (enableColorize) {
        const { bg, shadow } = stringToColor(name);
        card.style.setProperty('--hub-card-bg', bg);
        card.style.setProperty('--hub-card-shadow', shadow);
      } else {
        card.style.removeProperty('--hub-card-bg');
        card.style.removeProperty('--hub-card-shadow');
      }
      // Native #/list cannot take a multi-id studioId (the route 404s on the
      // getItem lookup and renders nothing), so the card opens the explorer.
      // The href keeps the primary entity so middle-click still does something.
      card.href = buildStudioHref(brand.primaryId, serverId);
      bindStudioExplorerCard(card, {
        name,
        studioIds: brand.studioIds,
        seriesTags: resolveStudioBrandSeriesTags(name, seriesTagVocabulary),
        userId
      });
      card.classList.remove("hub-card-textonly");

      const isDefaultHub = isDefaultStudioHub(name);
      const manualEntry = (manualEntries || []).find(entry => nameKey(entry?.name || entry?.Name) === nameKey(name)) || null;
      const customLogoUrl = buildStudioHubLogoUrl(manualEntry);
      const logoUrl = customLogoUrl || await resolveLogoUrl(name);
      const sharedVideoEntry = findStudioHubVideoEntry(sharedVideos, name);
      const customVideoUrl = buildStudioHubVideoUrl(sharedVideoEntry);
      const needsStudioItems = isDefaultHub && !logoUrl;
      const studioItems = needsStudioItems
        ? await fetchStudioItemsViaUsers(brand.studioIds, name, userId, __fetchAbort.signal, {
            limit: STUDIO_ITEMS_LIMIT
          })
        : null;
      if (needsStudioItems && !studioItems?.length) {
        try { card.remove(); } catch {}
        return;
      }

      let used = false;

      if (logoUrl) {
        const img = upsertImg(card, "hub-img hub-logo");
        img.alt = `${name} logo`;
        if (img.src !== logoUrl) {
          img.style.opacity = '0';
          img.src = logoUrl;
        }
        markCardReady(card);
        used = true;
      }

      if (!used) {
        const chosen = await chooseBackdropForStudio(brand, userId, __fetchAbort.signal, { items: studioItems });
        if (chosen?.url) {
          const img = upsertImg(card, "hub-img");
          img.alt = name;
          if (img.src !== chosen.url) {
            img.style.opacity = '0';
            img.src = chosen.url;
          }
          markCardReady(card);
        } else if (!customVideoUrl) {
          clearCardImage(card);
          markCardReady(card, { textOnly: true });
        } else {
          clearCardImage(card);
          markCardReady(card, { textOnly: true });
        }
      }

      ensurePreviewButton(card, name, brand.studioIds, userId);

      if (config.studioHubsHoverVideo) {
        await setupHoverVideo(card, {
          logoUrl,
          customVideoUrl,
          studioName: name,
          studioIds: brand.studioIds,
          userId
        });
      }
    });

    requestAnimationFrame(() => {
      try {
        row.__updateButtons?.();
      } catch {}
    });

    const renderedCards = row.querySelectorAll(".hub-card").length;
    if (section) section.style.display = renderedCards ? "" : "none";

    if (!resolved.length || !renderedCards) {
      setStudioHubsReady(true);
    }

  } catch (e) {
    console.warn("Studio hubs render hatası:", e);
    setStudioHubsReady(true);
  } finally {
    __studioHubBusy = false;
    __fetchAbort = null;
  }
}

window.addEventListener("jms:studio-hubs-visibility-updated", () => {
  try {
    void renderStudioHubs();
  } catch {}
});

function enforceStudioHubsOrder(homeSections) {
  if (!homeSections) return;
  bindManagedSectionsBelowNative(homeSections);
  try { keepManagedSectionsBelowNative(homeSections); } catch {}
  try { homeSections.__jmsManagedBelowNativeSchedule?.(); } catch {}
}

function ensureContainer(indexPage) {
  const all = document.querySelectorAll("#studio-hubs");
  if (all.length > 1) {
    const keep = indexPage.querySelector("#studio-hubs") || all[0];
    for (let i = 0; i < all.length; i++) {
     if (all[i] === keep) continue;
     all[i].querySelectorAll('video.hub-video').forEach(v => {
       try { v.pause(); } catch {}
       try { v.removeAttribute('src'); v.load?.(); } catch {}
     });
     all[i].remove();
    }
  }
  const homeSections = indexPage.querySelector(".homeSectionsContainer");
  if (!homeSections) return null;
  enforceStudioHubsOrder(homeSections);
  const moveSectionIntoPlace = (section) => {
    if (section.parentElement !== homeSections) {
      homeSections.appendChild(section);
    }
    enforceStudioHubsOrder(homeSections);
  };

  let section = indexPage.querySelector("#studio-hubs") || document.getElementById("studio-hubs");
  if (!section) {
    section = document.createElement("div");
    section.id = "studio-hubs";
    section.classList.add("homeSection");
    section.innerHTML = `
      <div class="sectionTitleContainer sectionTitleContainer-cards">
        <h2 class="sectionTitle sectionTitle-cards">${config.languageLabels.studioHubs || 'Studio Collections'}</h2>
      </div>
      <div class="hub-scroll-wrap">
        <button class="hub-scroll-btn hub-scroll-left" aria-label="${config.languageLabels.scrollLeft || 'Scroll left'}" aria-disabled="true">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
        <div class="itemsContainer hub-row backdrop-mode" role="list"></div>
        <button class="hub-scroll-btn hub-scroll-right" aria-label="${config.languageLabels.scrollRight || 'Scroll right'}" aria-disabled="true">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        </button>
      </div>
    `;
    moveSectionIntoPlace(section);
  } else if (section.parentElement !== homeSections) {
    moveSectionIntoPlace(section);
  } else {
    moveSectionIntoPlace(section);
  }
  return section.querySelector(".hub-row");
}

function resetHubRowScrollPosition(row) {
  if (!(row instanceof HTMLElement)) return;
  row.style.overflowAnchor = "none";
  if (Math.abs(Number(row.scrollLeft) || 0) <= 1) {
    try {
      row.__updateButtons?.();
    } catch {}
    return;
  }

  const previousInlineBehavior = row.style.scrollBehavior;
  row.style.scrollBehavior = "auto";
  row.scrollLeft = 0;

  requestAnimationFrame(() => {
    if (!row.isConnected) return;
    row.style.scrollBehavior = previousInlineBehavior;
    try {
      row.__updateButtons?.();
    } catch {}
  });
}

function setupScroller(row) {
  if (row.dataset.scrollerMounted === "1") {
    requestAnimationFrame(() => {
      try {
        row.__updateButtons?.();
      } catch {}
    });
    return;
  }
  row.dataset.scrollerMounted = "1";
  const section = row.closest("#studio-hubs");
  if (!section) return;
  const btnL = section.querySelector(".hub-scroll-left");
  const btnR = section.querySelector(".hub-scroll-right");
  const step = () => Math.max(240, Math.floor(row.clientWidth * 0.9));
  const updateButtons = () => {
    const max = row.scrollWidth - row.clientWidth - 1;
    const atStart = row.scrollLeft <= 1;
    const atEnd   = row.scrollLeft >= max;
    if (btnL) btnL.setAttribute("aria-disabled", atStart ? "true" : "false");
    if (btnR) btnR.setAttribute("aria-disabled", atEnd   ? "true" : "false");
  };
  row.__updateButtons = updateButtons;
  const blurAfterPointerClick = (btn, e) => {
    if (!btn) return;
    if ((e?.detail || 0) <= 0) return;
    requestAnimationFrame(() => { try { btn.blur(); } catch {} });
  };
  if (btnL) btnL.onclick = (e) => {
    row.scrollBy({ left: -step(), behavior: "smooth" });
    blurAfterPointerClick(btnL, e);
  };
  if (btnR) btnR.onclick = (e) => {
    row.scrollBy({ left: step(), behavior: "smooth" });
    blurAfterPointerClick(btnR, e);
  };

  row.addEventListener("scroll", updateButtons, { passive: true });
  const ro = new ResizeObserver(() => updateButtons());
  ro.observe(row);
  row.__ro = ro;

  row.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
  row.addEventListener('touchmove',  (e) => { e.stopPropagation(); }, { passive: true });

  requestAnimationFrame(updateButtons);
}

export function ensureStudioHubsMounted({ eager=false, force=false } = {}) {
  const runtimeConfig = getConfig?.() || config || {};
  const homeSectionsConfig = getHomeSectionsRuntimeConfig(runtimeConfig);
  if (!homeSectionsConfig.enableStudioHubs) {
    cleanupStudioHubsSection();
    return;
  }

  if (!force && __studioHubsMountedOnce && hasMountedStudioHubsSection()) {
    return;
  }

  const kick = async () => {
    if (__studioHubsMounting) return;
    __studioHubsMounting = true;
    try {
      const host = await waitForVisibleHomeSections({
        timeout: eager ? 4000 : 12000
      });
      if (!host?.page) {
        scheduleRetry(1200);
        return;
      }
      const homeSections = host.page.querySelector(".homeSectionsContainer");
      if (!homeSections) {
        scheduleRetry(900);
        return;
      }
      if (!host.page.querySelector("#studio-hubs")) {
        try {
          await waitForNativeHomeSectionStability(homeSections, {
            timeoutMs: 1800,
            stableMs: 220,
            minVisibleCount: 1,
          });
        } catch {}
      }

      await enqueueManagedSectionRender("studioHubs", async () => {
        await waitForManagedSectionGate("studioHubs", { timeoutMs: 25000 });
        await waitForManagedSectionDependencyCompletion("studioHubs", { timeoutMs: 25000 });
        if (!host.page?.isConnected || !getActiveHomePage()) {
          scheduleRetry(800);
          return false;
        }
        try {
          await waitForManagedHomeRowRelease({
            timeoutMs: 25000,
            rootMargin: "0px 0px 0px 0px",
          });
        } catch {}
        const row = ensureContainer(host.page);
        if (!row) {
          scheduleRetry(800);
          return false;
        }
        try { registerManagedHomeRowAnchor(host.page.querySelector("#studio-hubs")); } catch {}
        if (!force && __studioHubsMountedOnce && hasMountedStudioHubsSection()) {
          setStudioHubsReady(true);
          return true;
        }
        await renderStudioHubs();
        __studioHubsMountedOnce = true;
        return true;
      }, {
        force,
        isStillValid: () => !!(host.page?.isConnected && getActiveHomePage()),
      });
    } finally {
      __studioHubsMounting = false;
    }
  };

  const scheduleRetry = (ms=1000) => {
    clearTimeout(__studioHubsRetryTo);
    __studioHubsRetryTo = setTimeout(() => ensureStudioHubsMounted(), ms);
  };

  kick();
}
