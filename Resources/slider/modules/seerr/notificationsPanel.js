import {
  approveSerrRequest,
  declineSerrRequest,
  getSerrAccess,
  getSerrCollectionDetails,
  getSerrMovieDetails,
  getSerrTvDetails,
  listSerrRequests,
  searchSerr,
  searchSerrCollections,
  withdrawSerrRequest
} from "./api.js";
import { getConfig } from "../config.js";
import { getEffectiveLanguage, getLanguageLabels } from "../../language/index.js";
import { requestMovieFromArr } from "../arr/requestFallback.js";
import { getArrCalendar } from "../arr/api.js";
import { showNotification } from "../player/ui/notification.js";
import { openSerrCollectionRequestModal } from "./itemPageBridge.js";
import { requestSerrFromItem } from "./ui.js";

let cachedCount = 0;
let cachedRequests = [];
let lastIsAdmin = false;
let managerRequests = [];
let managerIsAdmin = false;
let managerRefreshPromise = null;
let managerPage = 1;
let managerSearchTimer = 0;
let managerSearchSeq = 0;
const managerSearchState = {
  query: "",
  results: [],
  loading: false,
  searched: false,
  error: ""
};
let refreshPromise = null;
let pollTimer = 0;
let pollEventsBound = false;
let pollEnabled = false;
let lastPanelDownloadRefreshAt = 0;
const ACTIVE_DOWNLOAD_POLL_MS = 5_000;
const OPEN_IDLE_POLL_MS = 10_000;
const BACKGROUND_POLL_MS = 60_000;
const PANEL_DOWNLOAD_REFRESH_MIN_MS = 30_000;
const MANAGER_REQUESTS_PAGE_SIZE = 18;
const SERR_IMAGE_BASE = "https://image.tmdb.org/t/p";
const CALENDAR_IMAGE_READY_TIMEOUT_MS = 3500;
const posterCache = new Map();
const posterPromises = new Map();
const backdropCache = new Map();
const backdropPromises = new Map();
const metadataCache = new Map();
const metadataPromises = new Map();

function currentUserId() {
  try { return text(window.ApiClient?.getCurrentUserId?.()); } catch {}
  try { return text(window.ApiClient?._currentUserId); } catch {}
  try { return text(window.ApiClient?._currentUser?.Id || window.ApiClient?._currentUser?.id); } catch {}
  try { return text(sessionStorage.getItem("currentUserId") || localStorage.getItem("currentUserId")); } catch {}
  return "";
}

function seenStorageKey() {
  return `jf:serrSeenRequests:${currentUserId() || "nouser"}`;
}

function readSeenRequestKeys() {
  try {
    const raw = localStorage.getItem(seenStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map((value) => text(value)).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function writeSeenRequestKeys(keys) {
  try {
    localStorage.setItem(seenStorageKey(), JSON.stringify(Array.from(keys || []).filter(Boolean)));
  } catch {}
}

function labels() {
  try {
    const activeLabels = getLanguageLabels?.(getEffectiveLanguage?.()) || {};
    if (Object.keys(activeLabels).length) return activeLabels;
  } catch {}
  try { return getConfig()?.languageLabels || {}; } catch { return {}; }
}

function moduleEnabled() {
  try { return getConfig()?.enableSerrArrIntegrationModule !== false; } catch { return true; }
}

function L(key, fallback) {
  const value = labels()?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function text(value, fallback = "") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[m]));
}

function serrLanguage() {
  try {
    const cfg = getConfig?.() || {};
    return text(cfg.serrDefaultLanguage || cfg.defaultLanguage || "");
  } catch {
    return "";
  }
}

function readFirst(source, ...keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function imageUrl(path, size = "w342") {
  const clean = text(path);
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean)) return clean;
  return `${SERR_IMAGE_BASE}/${size}${clean.startsWith("/") ? clean : `/${clean}`}`;
}

function resultMediaType(result) {
  const type = text(result?.mediaType || result?.media_type || result?.MediaType).toLowerCase();
  if (["tv", "series", "show", "tvshow"].includes(type)) return "tv";
  if (["movie", "film"].includes(type)) return "movie";
  if (["collection", "boxset", "box_set", "box set"].includes(type)) return "collection";
  return "";
}

function resultTitle(result) {
  return text(
    result?.title ||
    result?.name ||
    result?.Title ||
    result?.Name ||
    result?.originalTitle ||
    result?.original_title ||
    result?.originalName ||
    result?.original_name,
    L("serrUntitled", "İçerik")
  );
}

function resultYear(result) {
  const year = Number(result?.year || result?.Year);
  if (Number.isFinite(year) && year > 1800) return String(Math.floor(year));
  const date = text(
    result?.releaseDate ||
    result?.firstAirDate ||
    result?.release_date ||
    result?.first_air_date ||
    result?.PremiereDate ||
    result?.premiereDate
  );
  return date.length >= 4 ? date.slice(0, 4) : "";
}

function resultPosterUrl(result, size = "w154") {
  return imageUrl(
    result?.posterPath ||
    result?.poster_path ||
    result?.PosterPath ||
    result?.remotePoster ||
    result?.posterUrl ||
    result?.PosterUrl,
    size
  );
}

function resultMeta(result) {
  const mediaType = resultMediaType(result);
  const type = mediaType === "tv"
    ? L("serrTv", "Dizi")
    : (mediaType === "collection" ? L("boxset", "Koleksiyon") : L("serrMovie", "Film"));
  const tmdbId = Number(result?.id || result?.tmdbId || result?.tmdb_id || 0);
  return [type, resultYear(result), Number.isFinite(tmdbId) && tmdbId > 0 ? `TMDb ${Math.floor(tmdbId)}` : ""].filter(Boolean).join(" • ");
}

function normalizeCollectionSearchResults(data) {
  return (Array.isArray(data?.results) ? data.results : []).map((row) => ({
    ...row,
    mediaType: "collection",
    media_type: "collection"
  }));
}

function parseManagerTmdbSearch(value) {
  const clean = text(value);
  if (!clean) return null;
  let type = "";
  if (/\/movie\//i.test(clean) || /\b(movie|film)\b/i.test(clean)) type = "movie";
  if (/\/tv\//i.test(clean) || /\b(tv|series|show|dizi)\b/i.test(clean)) type = "tv";
  if (/\/collection\//i.test(clean) || /\b(collection|boxset|box\s*set|koleksiyon)\b/i.test(clean)) type = "collection";

  let match = clean.match(/^(?:https?:\/\/(?:www\.)?themoviedb\.org\/(?:movie|tv|collection)\/|tmdb\s*[:#-]?\s*)?(\d{1,10})(?:[-/?#].*)?$/i);
  if (!match && type === "collection") {
    const ids = clean.match(/\b\d{1,10}\b/g) || [];
    if (ids.length === 1) match = [ids[0], ids[0]];
  }
  if (!match) return null;

  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? { id: Math.floor(id), type } : null;
}

function normalizeManagerTmdbDetail(raw, mediaType, id) {
  if (!raw || typeof raw !== "object") return null;
  const title = resultTitle(raw);
  const resolvedId = Number(raw?.id || raw?.tmdbId || raw?.tmdb_id || id);
  if (!title || !Number.isFinite(resolvedId) || resolvedId <= 0) return null;
  return {
    ...raw,
    id: Math.floor(resolvedId),
    mediaType,
    media_type: mediaType
  };
}

async function searchManagerSerrByTmdbId({ id, type, language }) {
  const jobs = [];
  if (!type || type === "movie") {
    jobs.push(getSerrMovieDetails(id, { language }).then((raw) => normalizeManagerTmdbDetail(raw, "movie", id)).catch(() => null));
  }
  if (!type || type === "tv") {
    jobs.push(getSerrTvDetails(id, { language }).then((raw) => normalizeManagerTmdbDetail(raw, "tv", id)).catch(() => null));
  }
  if (!type || type === "collection") {
    jobs.push(getSerrCollectionDetails(id, { language }).then((raw) => normalizeManagerTmdbDetail(raw, "collection", id)).catch(() => null));
  }

  const rows = (await Promise.all(jobs)).filter(Boolean);
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${resultMediaType(row)}:${Number(row?.id) || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeManagerSearchResults(...lists) {
  const seen = new Set();
  const output = [];
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      const mediaType = resultMediaType(row);
      if (!mediaType) continue;
      const id = Number(row?.id || row?.tmdbId || row?.tmdb_id || 0);
      const key = Number.isFinite(id) && id > 0
        ? `${mediaType}:${Math.floor(id)}`
        : `${mediaType}:${resultTitle(row).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(row);
    }
  }
  return output;
}

function balancedManagerSearchResults(results = [], limit = 24) {
  const movies = [];
  const tv = [];
  const collections = [];
  const other = [];
  for (const row of Array.isArray(results) ? results : []) {
    const mediaType = resultMediaType(row);
    if (mediaType === "movie") movies.push(row);
    else if (mediaType === "tv") tv.push(row);
    else if (mediaType === "collection") collections.push(row);
    else other.push(row);
  }

  const output = [];
  while (output.length < limit && (collections.length || movies.length || tv.length)) {
    if (collections.length) output.push(collections.shift());
    if (output.length >= limit) break;
    if (movies.length) output.push(movies.shift());
    if (output.length >= limit) break;
    if (tv.length) output.push(tv.shift());
  }
  return output.concat(other).slice(0, limit);
}

function managerSearchResultItem(result) {
  const mediaType = resultMediaType(result);
  const id = Number(result?.id || result?.tmdbId || result?.tmdb_id || 0);
  const tvdbId = Number(result?.tvdbId || result?.tvdb_id || result?.TvdbId || 0);
  const title = resultTitle(result);
  return {
    Id: `monwui-serr-search-${mediaType}-${Number.isFinite(id) && id > 0 ? Math.floor(id) : title}`,
    Type: mediaType === "tv" ? "Series" : "Movie",
    Name: title,
    OriginalTitle: text(result?.originalTitle || result?.original_title || result?.originalName || result?.original_name, title),
    Overview: text(result?.overview || result?.Overview),
    ProductionYear: Number(resultYear(result)) || undefined,
    PremiereDate: text(result?.releaseDate || result?.firstAirDate || result?.release_date || result?.first_air_date),
    ProviderIds: {
      Tmdb: Number.isFinite(id) && id > 0 ? String(Math.floor(id)) : undefined,
      Tvdb: Number.isFinite(tvdbId) && tvdbId > 0 ? String(Math.floor(tvdbId)) : undefined
    },
    PosterPath: text(result?.posterPath || result?.poster_path || result?.PosterPath),
    posterUrl: resultPosterUrl(result, "w342"),
    __tmdbId: Number.isFinite(id) && id > 0 ? Math.floor(id) : 0
  };
}

function requestMediaType(req) {
  const type = text(req?.MediaType || req?.mediaType).toLowerCase();
  return type === "tv" || type === "series" || type === "show" || type === "tvshow" ? "tv" : "movie";
}

function requestMediaId(req) {
  const id = Number(req?.MediaId || req?.mediaId || 0);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
}

function requestIs4K(req) {
  const value = req?.Is4K ?? req?.is4K ?? req?.is4k;
  if (value === true || value === 1) return true;
  return text(value).toLowerCase() === "true";
}

function requestTimestampValue(value) {
  const clean = text(value);
  if (!clean || clean === "0") return 0;
  const direct = Number(clean);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(clean);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function requestLatestTimestamp(req) {
  return Math.max(
    requestTimestampValue(req?.UpdatedAtUtc || req?.updatedAtUtc),
    requestTimestampValue(req?.CompletedAtUtc || req?.completedAtUtc),
    requestTimestampValue(req?.CreatedAtUtc || req?.createdAtUtc)
  );
}

function managerRequestContentKey(req) {
  const mediaId = requestMediaId(req);
  if (mediaId > 0) return `${requestMediaType(req)}:${mediaId}`;
  const title = searchText(req?.Title || req?.title || req?.Name || req?.name);
  return title ? `${requestMediaType(req)}:title:${title}` : "";
}

function normalizeManagerRequests(requests) {
  const byContent = new Map();
  (Array.isArray(requests) ? requests : []).forEach((req, index) => {
    const key = managerRequestContentKey(req);
    if (!key) {
      byContent.set(`entry:${index}`, { req, index, ts: requestLatestTimestamp(req) });
      return;
    }

    const current = { req, index, ts: requestLatestTimestamp(req) };
    const previous = byContent.get(key);
    if (!previous || current.ts > previous.ts || (current.ts === previous.ts && current.index > previous.index)) {
      byContent.set(key, current);
    }
  });

  return Array.from(byContent.values())
    .sort((a, b) => (b.ts - a.ts) || (b.index - a.index))
    .map((entry) => entry.req);
}

function renderRequest4KBadge(req) {
  if (!requestIs4K(req)) return "";
  const label = L("serrRequest4KBadge", "4K");
  return `<span class="monwui-serr-4k-badge" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function requestNotificationKey(req) {
  const id = text(req?.Id || req?.id);
  if (id) return id;
  return [
    requestMediaType(req),
    requestMediaId(req),
    text(req?.CreatedAtUtc || req?.createdAtUtc),
    text(req?.Title || req?.title)
  ].filter(Boolean).join(":");
}

function posterCacheKey(req) {
  const id = requestMediaId(req);
  if (!id) return "";
  return `${requestMediaType(req)}:${id}`;
}

function findRequestByArtKey(key) {
  const clean = text(key);
  if (!clean) return null;
  return [...cachedRequests, ...managerRequests].find((entry) => posterCacheKey(entry) === clean) || null;
}

function isGeneratedSerrTitle(value, req) {
  const title = text(value);
  const requestId = Number(req?.SerrRequestId || req?.serrRequestId || 0);
  return requestId > 0 && title.toLowerCase() === `seerr #${requestId}`.toLowerCase();
}

function directPosterUrl(req) {
  return imageUrl(readFirst(req, "PosterUrl", "posterUrl", "PosterPath", "posterPath", "poster_path", "image", "Image"));
}

function directBackdropUrl(req) {
  return imageUrl(readFirst(req, "BackdropUrl", "backdropUrl", "BackdropPath", "backdropPath", "backdrop_path", "FanartUrl", "fanartUrl", "fanart"), "w780");
}

function metadataImageUrl(details, size, ...keys) {
  if (!details || typeof details !== "object") return "";
  const nested = readFirst(details, "media", "mediaInfo", "movie", "tv", "show", "item");
  return imageUrl(readFirst(details, ...keys) || readFirst(nested, ...keys), size);
}

function metadataPosterUrl(details) {
  return metadataImageUrl(details, "w342", "posterPath", "poster_path", "PosterPath", "posterUrl", "PosterUrl");
}

function metadataBackdropUrl(details) {
  return metadataImageUrl(details, "w780", "backdropPath", "backdrop_path", "BackdropPath", "backdropUrl", "BackdropUrl", "fanart", "Fanart");
}

async function resolvePosterUrl(req) {
  const direct = directPosterUrl(req);
  if (direct) return direct;

  const key = posterCacheKey(req);
  if (!key) return "";
  if (posterCache.has(key)) {
    if (isGeneratedSerrTitle(req?.Title || req?.title, req)) {
      return resolveRequestMetadata(req)
        .catch(() => null)
        .then(() => posterCache.get(key) || "");
    }
    return posterCache.get(key) || "";
  }
  if (posterPromises.has(key)) return posterPromises.get(key);

  const job = resolveRequestMetadata(req).then((details) => {
    const poster = metadataPosterUrl(details);
    posterCache.set(key, poster || "");
    return poster || "";
  }).finally(() => {
    posterPromises.delete(key);
  });

  posterPromises.set(key, job);
  return job;
}

async function resolveBackdropUrl(req) {
  const direct = directBackdropUrl(req);
  if (direct) return direct;

  const key = posterCacheKey(req);
  const posterFallback = directPosterUrl(req) || (key ? posterCache.get(key) : "");
  if (!key) return posterFallback || "";
  if (backdropCache.has(key)) return backdropCache.get(key) || posterFallback || "";
  if (backdropPromises.has(key)) return backdropPromises.get(key);

  const job = resolveRequestMetadata(req).then((details) => {
    const poster = metadataPosterUrl(details);
    const backdrop = metadataBackdropUrl(details) || poster || posterFallback;
    if (poster && !posterCache.get(key)) posterCache.set(key, poster);
    backdropCache.set(key, backdrop || "");
    return backdrop || "";
  }).finally(() => {
    backdropPromises.delete(key);
  });

  backdropPromises.set(key, job);
  return job;
}

async function resolveRequestMetadata(req) {
  const key = posterCacheKey(req);
  if (!key) return null;
  if (metadataCache.has(key)) {
    applyMetadataTitleToRequest(req, metadataCache.get(key));
    return metadataCache.get(key);
  }
  if (metadataPromises.has(key)) return metadataPromises.get(key);

  const job = (async () => {
    const id = requestMediaId(req);
    const mediaType = requestMediaType(req);
    const language = serrLanguage();
    const details = mediaType === "tv"
      ? await getSerrTvDetails(id, { language }).catch(() => null)
      : await getSerrMovieDetails(id, { language }).catch(() => null);
    applyMetadataTitleToRequest(req, details);
    metadataCache.set(key, details || null);
    return details || null;
  })().finally(() => {
    metadataPromises.delete(key);
  });

  metadataPromises.set(key, job);
  return job;
}

function metadataTitle(details) {
  if (!details || typeof details !== "object") return "";
  const nested = readFirst(details, "media", "mediaInfo", "movie", "tv", "show", "item");
  return text(
    readFirst(details, "title", "name", "originalTitle", "original_title", "originalName", "original_name", "displayTitle", "mediaTitle") ||
    readFirst(nested, "title", "name", "originalTitle", "original_title", "originalName", "original_name", "displayTitle", "mediaTitle")
  );
}

function applyMetadataTitleToRequest(req, details) {
  const title = metadataTitle(details);
  if (!title || !isGeneratedSerrTitle(req?.Title || req?.title, req)) return;
  req.Title = title;
  req.title = title;
}

function updateHydratedRequestTitle(node, req) {
  const title = text(req?.Title || req?.title);
  if (!title || isGeneratedSerrTitle(title, req)) return;
  const card = node.closest?.(".monwui-serr-request-card, .monwui-serr-notif-item");
  card?.querySelectorAll?.(".monwui-serr-request-name, .monwui-serr-name").forEach((target) => {
    target.textContent = title;
  });
}

function requestMetadataSources(req, details) {
  const sources = [];
  const add = (value) => {
    if (value && typeof value === "object" && !sources.includes(value)) sources.push(value);
  };

  add(req);
  add(details);
  add(readFirst(details, "media", "mediaInfo", "movie", "tv", "show", "item"));
  add(readFirst(details, "externalIds", "external_ids", "ids", "Ids"));
  add(readFirst(details, "providerIds", "ProviderIds"));
  return sources;
}

function readRequestMetadataValue(req, details, ...keys) {
  for (const source of requestMetadataSources(req, details)) {
    const direct = readFirst(source, ...keys);
    if (direct !== undefined && direct !== null && text(direct)) return direct;
    const providerIds = readFirst(source, "providerIds", "ProviderIds", "externalIds", "external_ids", "ids", "Ids");
    const providerValue = readFirst(providerIds, ...keys);
    if (providerValue !== undefined && providerValue !== null && text(providerValue)) return providerValue;
  }
  return undefined;
}

function numericRating(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const clean = text(value).replace(",", ".");
  if (!clean) return NaN;
  const match = clean.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function formatRatingScore(value) {
  const raw = numericRating(value);
  if (!Number.isFinite(raw) || raw <= 0) return "";
  const score = raw > 10 && raw <= 100 ? raw / 10 : raw;
  if (!Number.isFinite(score) || score <= 0 || score > 10) return "";
  return score >= 9.95 ? "10" : score.toFixed(1).replace(/\.0$/, "");
}

function ratingFromRatingsObject(ratings) {
  if (!ratings || typeof ratings !== "object") return "";
  const sources = [
    ratings,
    readFirst(ratings, "tmdb", "tmdbRating", "Tmdb", "TMDb", "theMovieDb"),
    readFirst(ratings, "imdb", "imdbRating", "Imdb", "IMDb")
  ].filter((value) => value && typeof value === "object");

  for (const source of sources) {
    const score = formatRatingScore(readFirst(source, "value", "score", "rating", "Rating", "average", "Average"));
    if (score) return score;
  }
  return formatRatingScore(readFirst(ratings, "value", "score", "rating", "Rating", "average", "Average"));
}

function requestRatingScore(req, details) {
  for (const source of requestMetadataSources(req, details)) {
    const score = formatRatingScore(readFirst(
      source,
      "CommunityRating",
      "communityRating",
      "voteAverage",
      "vote_average",
      "VoteAverage",
      "ratingValue",
      "RatingValue",
      "tmdbRating",
      "TmdbRating"
    ));
    if (score) return score;

    const nestedScore = ratingFromRatingsObject(readFirst(source, "ratings", "Ratings"));
    if (nestedScore) return nestedScore;
  }
  return "";
}

function requestOfficialRating(req, details) {
  const value = readRequestMetadataValue(
    req,
    details,
    "OfficialRating",
    "officialRating",
    "certification",
    "Certification",
    "contentRating",
    "content_rating",
    "mpaaRating",
    "MpaaRating",
    "rated",
    "Rated"
  );
  return text(value);
}

function renderRequestRatingContent(req, details) {
  const score = requestRatingScore(req, details);
  const official = requestOfficialRating(req, details);
  const display = [score, official].filter(Boolean).join(" / ");
  const label = [score ? `${L("rating", "Rating")} ${score}` : "", official].filter(Boolean).join(" / ");
  if (!display) return "";
  return `<span class="monwui-serr-rating-badge" title="${escapeHtml(label || display)}"><i class="fas fa-star" aria-hidden="true"></i><span>${escapeHtml(display)}</span></span>`;
}

function renderRequestRatingSlot(req, details) {
  const html = renderRequestRatingContent(req, details);
  return `<span class="monwui-serr-request-rating-slot" data-serr-rating-slot ${html ? "" : "hidden"}>${html}</span>`;
}

function requestProviderLinksContent(req, details) {
  const mediaType = requestMediaType(req);
  const tmdbId = calendarId(requestMediaId(req) || readRequestMetadataValue(req, details, "tmdbId", "TmdbId", "tmdb", "Tmdb") || readFirst(details, "id"));
  const imdbId = calendarId(readRequestMetadataValue(req, details, "imdbId", "ImdbId", "imdb_id", "Imdb", "IMDb"));
  const tvdbId = calendarId(readRequestMetadataValue(req, details, "tvdbId", "TvdbId", "tvdb", "Tvdb", "TVDb"));
  const serrUrl = safeExternalUrl(readRequestMetadataValue(req, details, "serrUrl", "SerrUrl", "seerrUrl", "SeerrUrl", "overseerrUrl", "OverseerrUrl"));
  const links = [];

  if (serrUrl) links.push(calendarIconLink({ key: "seerr", label: "Seerr", url: serrUrl }));
  if (tmdbId) links.push(calendarIconLink({ key: "tmdb", label: "TMDb", url: calendarProviderUrl("tmdb", tmdbId, mediaType) }));
  if (imdbId) links.push(calendarIconLink({ key: "imdb", label: "IMDb", url: calendarProviderUrl("imdb", imdbId, mediaType) }));
  if (tvdbId) links.push(calendarIconLink({ key: "tvdb", label: "TVDb", url: calendarProviderUrl("tvdb", tvdbId, mediaType) }));
  return links.filter(Boolean).join("");
}

function renderRequestProviderLinks(req, details) {
  const html = requestProviderLinksContent(req, details);
  return `<span class="monwui-serr-calendar-links monwui-serr-request-links" data-serr-provider-links ${html ? "" : "hidden"}>${html}</span>`;
}

function updateRequestCardMetadata(card, req, details) {
  if (!card || !req) return;
  const ratingSlot = card.querySelector?.("[data-serr-rating-slot]");
  if (ratingSlot) {
    const ratingHtml = renderRequestRatingContent(req, details);
    ratingSlot.innerHTML = ratingHtml;
    ratingSlot.hidden = !ratingHtml;
  }

  const linksSlot = card.querySelector?.("[data-serr-provider-links]");
  if (linksSlot) {
    const linksHtml = requestProviderLinksContent(req, details);
    linksSlot.innerHTML = linksHtml;
    linksSlot.hidden = !linksHtml;
  }
}

function posterFallbackLabel(req) {
  return requestMediaType(req) === "tv" ? L("serrTv", "Dizi") : L("serrMovie", "Film");
}

function renderPoster(req, className = "", { ratingSlotHtml = "" } = {}) {
  const direct = directPosterUrl(req);
  const key = posterCacheKey(req);
  const cached = key ? posterCache.get(key) : "";
  const url = direct || cached || "";
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const label = posterFallbackLabel(req);
  const attrs = [
    `class="monwui-serr-poster ${escapeHtml(className)}"`,
    key ? `data-serr-art-key="${escapeHtml(key)}"` : "",
    direct ? `data-serr-art-ready="1"` : "",
  ].filter(Boolean).join(" ");

  return `
    <div ${attrs}>
      ${url
        ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`
        : `<div class="monwui-serr-poster-fallback"><i class="fas fa-clapperboard" aria-hidden="true"></i><span>${escapeHtml(label)}</span></div>`}
      ${ratingSlotHtml}
    </div>
  `;
}

function renderBackdrop(req) {
  const direct = directBackdropUrl(req);
  const poster = directPosterUrl(req) || (posterCacheKey(req) ? posterCache.get(posterCacheKey(req)) : "");
  const key = posterCacheKey(req);
  const hasCached = key ? backdropCache.has(key) : false;
  const cached = hasCached ? backdropCache.get(key) : "";
  const url = direct || cached || poster || "";
  const isPosterFallback = !direct && (!cached || cached === poster) && !!poster;
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const attrs = [
    `class="monwui-serr-request-backdrop ${url ? "has-image" : ""} ${isPosterFallback ? "is-poster-fallback" : ""}"`,
    key ? `data-serr-art-key="${escapeHtml(key)}"` : "",
    direct || hasCached || (poster && !key) ? `data-serr-art-ready="1"` : "",
    url ? "" : `data-serr-art-empty="1"`
  ].filter(Boolean).join(" ");

  return `
    <div ${attrs} aria-hidden="true">
      ${url
        ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`
        : `<div class="monwui-serr-request-backdrop-fallback"><i class="fas fa-image" aria-hidden="true"></i></div>`}
    </div>
  `;
}

function hydrateRequestPosters(scope = document) {
  const nodes = Array.from(scope.querySelectorAll?.(".monwui-serr-poster[data-serr-art-key]:not([data-serr-art-ready='1'])") || []);

  for (const node of nodes) {
    const key = text(node.getAttribute("data-serr-art-key"));
    const req = findRequestByArtKey(key);
    if (!req) continue;

    resolvePosterUrl(req).then((url) => {
      if (!node.isConnected) return;
      updateHydratedRequestTitle(node, req);
      if (!url || node.getAttribute("data-serr-art-ready") === "1") return;
      const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
      const ratingSlot = node.querySelector?.("[data-serr-rating-slot]");
      node.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">${ratingSlot ? ratingSlot.outerHTML : ""}`;
      node.setAttribute("data-serr-art-ready", "1");
    }).catch(() => {});
  }

  const backdropNodes = Array.from(scope.querySelectorAll?.(".monwui-serr-request-backdrop[data-serr-art-key]:not([data-serr-art-ready='1'])") || []);
  for (const node of backdropNodes) {
    const key = text(node.getAttribute("data-serr-art-key"));
    const req = findRequestByArtKey(key);
    if (!req) continue;

    resolveBackdropUrl(req).then((url) => {
      if (!node.isConnected) return;
      if (!url) {
        node.setAttribute("data-serr-art-ready", "1");
        node.setAttribute("data-serr-art-empty", "1");
        return;
      }
      const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
      node.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`;
      node.classList.add("has-image");
      if (url === directPosterUrl(req) || url === (posterCacheKey(req) ? posterCache.get(posterCacheKey(req)) : "")) {
        node.classList.add("is-poster-fallback");
      } else {
        node.classList.remove("is-poster-fallback");
      }
      node.removeAttribute("data-serr-art-empty");
      node.setAttribute("data-serr-art-ready", "1");
    }).catch(() => {});
  }

  const cards = Array.from(scope.querySelectorAll?.(".monwui-serr-request-card[data-serr-request-key]:not([data-serr-meta-ready='1'])") || []);
  for (const card of cards) {
    const key = text(card.getAttribute("data-serr-request-key"));
    const req = findRequestByArtKey(key);
    if (!req) continue;

    updateRequestCardMetadata(card, req, metadataCache.get(key));
    resolveRequestMetadata(req).then((details) => {
      if (!card.isConnected) return;
      updateHydratedRequestTitle(card, req);
      updateRequestCardMetadata(card, req, details);
      card.setAttribute("data-serr-meta-ready", "1");
    }).catch(() => {
      if (card.isConnected) card.setAttribute("data-serr-meta-ready", "1");
    });
  }
}

function formatTime(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toLocaleString(labels()?.timeLocale || undefined);
  } catch {
    return "";
  }
}

function ensureSerrProgressStyles() {
  const id = "monwui-serr-download-progress-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #jfNotifModal .monwui-serr-download,
    .monwui-serr-requests-modal .monwui-serr-download {
      display: grid;
      gap: 5px;
      margin-top: 4px;
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-download-line,
    .monwui-serr-requests-modal .monwui-serr-download-line {
      align-items: center;
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.68)));
      display: flex;
      flex-wrap: wrap;
      font-size: 12px;
      gap: 6px;
      line-height: 1.35;
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-download-line b,
    .monwui-serr-requests-modal .monwui-serr-download-line b {
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font-weight: 800;
    }
    #jfNotifModal .monwui-serr-download-track,
    .monwui-serr-requests-modal .monwui-serr-download-track {
      background: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 26%, transparent);
      border-radius: 999px;
      height: 7px;
      overflow: hidden;
      width: 100%;
    }
    #jfNotifModal .monwui-serr-download-bar,
    .monwui-serr-requests-modal .monwui-serr-download-bar {
      background: var(--jf-notif-accent, var(--notif-accent, #6aa6ff));
      border-radius: inherit;
      height: 100%;
      min-width: 2px;
      transition: width .25s ease;
    }
    #jfNotifModal .monwui-serr-4k-badge,
    .monwui-serr-requests-modal .monwui-serr-4k-badge {
      align-items: center;
      background: color-mix(in srgb, var(--jf-notif-warning, var(--ntf-warning, #ffbf5f)) 84%, #fff);
      border: 1px solid color-mix(in srgb, var(--jf-notif-warning, var(--ntf-warning, #ffbf5f)) 72%, #111);
      border-radius: 6px;
      color: #111;
      display: inline-flex;
      font-size: 11px;
      font-weight: 900;
      justify-content: center;
      letter-spacing: 0;
      line-height: 1;
      padding: 3px 7px;
      white-space: nowrap;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-dialog {
      width: min(1440px, calc(100vw - 32px));
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-head {
      gap: 10px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-title {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-actions {
      align-items: center;
      display: flex;
      flex: 0 0 auto;
      gap: 8px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-switch {
      align-items: center;
      display: inline-flex;
      gap: 7px;
      justify-content: center;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-switch i {
      margin: 0;
      padding: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-search {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
      min-width: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-searchbar {
      align-items: center;
      background: var(--jf-notif-surface-2, var(--head-bg, rgba(255,255,255,.06)));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 8px;
      box-sizing: border-box;
      display: grid;
      gap: 8px;
      grid-template-columns: 20px minmax(0, 1fr) auto;
      min-width: 0;
      padding: 8px 10px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-searchbar i {
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.68)));
      text-align: center;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-search-input {
      background: transparent;
      border: 0;
      box-shadow: none;
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font: inherit;
      min-height: 34px;
      min-width: 0;
      outline: none;
      padding: 0;
      width: 100%;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-search-input::placeholder {
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.62)));
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-search-run,
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-btn {
      align-items: center;
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 6px;
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-size: 13px;
      font-weight: 800;
      gap: 7px;
      justify-content: center;
      min-height: 34px;
      padding: 7px 10px;
      white-space: nowrap;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-search-run,
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-btn {
      background: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 20%, transparent);
      border-color: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 36%, transparent);
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-search-run:hover,
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-btn:hover {
      background: var(--jf-notif-hover, var(--row-hover, rgba(255,255,255,.08)));
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-search-run:disabled,
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-btn:disabled {
      cursor: wait;
      opacity: .72;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-results {
      display: grid;
      gap: 8px;
      max-height: min(430px, 42vh);
      min-width: 0;
      overflow: auto;
      padding-right: 2px;
      scrollbar-color: var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) transparent;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-results[hidden] {
      display: none;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-section {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-section-title {
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.68)));
      font-size: 12px;
      font-weight: 850;
      line-height: 1.25;
      padding: 2px 2px 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result {
      align-items: center;
      background: color-mix(in srgb, var(--jf-notif-surface-2, var(--head-bg, #1f2937)) 82%, transparent);
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.1)));
      border-radius: 8px;
      box-sizing: border-box;
      display: grid;
      gap: 12px;
      grid-template-columns: 52px minmax(0, 1fr) auto;
      min-width: 0;
      padding: 8px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result.requested {
      border-color: color-mix(in srgb, var(--jf-notif-warning, var(--ntf-warning, #ffbf5f)) 42%, var(--jf-notif-border, rgba(255,255,255,.12)));
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-poster {
      align-items: center;
      aspect-ratio: 2 / 3;
      background: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 16%, transparent);
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 6px;
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.68)));
      display: flex;
      font-size: 11px;
      font-weight: 800;
      justify-content: center;
      overflow: hidden;
      text-align: center;
      width: 52px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-poster img {
      display: block;
      height: 100%;
      object-fit: cover;
      width: 100%;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-content {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-name {
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font-size: 14px;
      font-weight: 800;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-meta,
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-overview {
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.68)));
      font-size: 12px;
      line-height: 1.35;
      min-width: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-result-overview {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-pagination {
      align-items: center;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      margin-top: 14px;
      min-width: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-page-summary {
      align-items: center;
      background: var(--jf-notif-surface-2, var(--head-bg, rgba(255,255,255,.06)));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 999px;
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.68)));
      display: inline-flex;
      font-size: 12px;
      font-weight: 800;
      gap: 8px;
      min-height: 34px;
      padding: 7px 12px;
      box-sizing: border-box;
      white-space: nowrap;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-page-summary b {
      color: var(--jf-notif-text, #fff);
      font-weight: 900;
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-page-controls {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
      min-width: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-page-btn {
      align-items: center;
      background: var(--jf-notif-surface-2, var(--head-bg, rgba(255,255,255,.06)));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 8px;
      box-sizing: border-box;
      color: var(--jf-notif-text, #fff);
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-size: 12px;
      font-weight: 850;
      height: 34px;
      justify-content: center;
      line-height: 1;
      min-width: 34px;
      padding: 0 10px;
      transition: background .18s ease, border-color .18s ease, color .18s ease, opacity .18s ease;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-page-btn.icon {
      padding: 0;
      width: 34px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-page-btn:hover,
    .monwui-serr-requests-modal.open .monwui-serr-manager-page-btn.active {
      background: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 24%, transparent);
      border-color: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 52%, transparent);
      color: var(--jf-notif-text, #fff);
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-page-btn:disabled {
      cursor: default;
      opacity: .45;
    }
    .monwui-serr-requests-modal.open .monwui-serr-manager-page-gap {
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.62)));
      font-size: 12px;
      font-weight: 900;
      min-width: 16px;
      text-align: center;
    }
    @keyframes monwui-serr-manager-focus {
      0% {
        border-color: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 88%, #fff);
        box-shadow:
          var(--jf-notif-shadow, 0 28px 70px rgba(0,0,0,.28)),
          0 0 0 0 color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 0%, transparent);
      }
      24% {
        border-color: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 86%, #fff);
        box-shadow:
          var(--jf-notif-shadow, 0 34px 86px rgba(0,0,0,.36)),
          0 0 0 3px color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 32%, transparent),
          0 0 34px color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 30%, transparent);
      }
      100% {
        border-color: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 40%, var(--jf-notif-border, rgba(255,255,255,.13)));
        box-shadow:
          var(--jf-notif-shadow, 0 28px 70px rgba(0,0,0,.28)),
          0 0 0 1px color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 14%, transparent);
      }
    }
    @keyframes monwui-serr-manager-focus-sheen {
      from { transform: translateX(-120%); }
      to { transform: translateX(120%); }
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-card:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 70%, transparent);
      outline-offset: 3px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-card.monwui-serr-request-card-hit {
      animation: monwui-serr-manager-focus 1.6s cubic-bezier(.22,1,.36,1);
      border-color: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 58%, var(--jf-notif-border, rgba(255,255,255,.13)));
      box-shadow:
        var(--jf-notif-shadow, 0 28px 70px rgba(0,0,0,.28)),
        0 0 0 1px color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 18%, transparent);
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-card.monwui-serr-request-card-hit:after {
      background: linear-gradient(110deg, transparent 16%, color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 24%, transparent) 48%, transparent 72%);
      content: "";
      inset: 0;
      pointer-events: none;
      position: absolute;
      transform: translateX(-120%);
      z-index: 6;
      animation: monwui-serr-manager-focus-sheen .9s cubic-bezier(.22,1,.36,1);
    }
    .monwui-serr-requests-modal.open .monwui-serr-requests-list {
      align-items: stretch;
      display: grid;
      gap: 18px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-card {
      align-content: stretch;
      --monwui-serr-request-card-height: 250px;
      --monwui-serr-request-surface: var(--jf-notif-serr-btn, var(--head-bg, #171a23));
      background: var(--monwui-serr-request-surface);
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.13)));
      border-radius: 10px;
      box-shadow: var(--jf-notif-shadow, 0 28px 70px rgba(0,0,0,.28));
      box-sizing: border-box;
      display: grid;
      gap: 0;
      height: var(--monwui-serr-request-card-height);
      isolation: isolate;
      min-height: var(--monwui-serr-request-card-height);
      min-width: 0;
      overflow: hidden;
      padding: 0;
      position: relative;
      transition: transform .4s ease, box-shadow .2s ease, border-color .12s ease;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-card:before {
      background:
        linear-gradient(90deg, color-mix(in srgb, var(--jf-notif-text, #fff) 10%, transparent), transparent 44%),
        linear-gradient(180deg, color-mix(in srgb, var(--jf-notif-text, #fff) 5%, transparent), transparent);
      content: "";
      inset: 0;
      opacity: .72;
      pointer-events: none;
      position: absolute;
      z-index: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-card:hover {
      border-color: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 34%, var(--jf-notif-border, rgba(255,255,255,.2)));
      box-shadow:
        var(--jf-notif-shadow, 0 34px 86px rgba(0,0,0,.38)),
        0 0 0 1px color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 16%, transparent),
        inset 0 1px 0 color-mix(in srgb, var(--jf-notif-text, #fff) 12%, transparent);
      transform: scale(1.02);
    }

    .monwui-serr-requests-modal.open .monwui-serr-request-main {
      align-items: stretch;
      display: block;
      height: var(--monwui-serr-request-card-height);
      min-height: var(--monwui-serr-request-card-height);
      min-width: 0;
      position: relative;
      z-index: 1;
    }
    .monwui-serr-requests-modal.open .monwui-serr-poster.large {
      border-radius: 8px;
      box-shadow: 0 18px 38px rgba(0,0,0,.42);
      left: 18px;
      position: absolute;
      top: 40px;
      width: 78px;
      z-index: 4;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-content {
      align-content: start;
      box-sizing: border-box;
      display: grid;
      gap: 9px;
      height: var(--monwui-serr-request-card-height);
      min-height: var(--monwui-serr-request-card-height);
      min-width: 0;
      padding: 35px 8px 42px 110px;
      position: relative;
      width: 100%;
      z-index: auto;
    }
    .monwui-serr-requests-modal.open .monwui-serr-title-row {
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-content > .monwui-serr-calendar-links {
      align-self: start;
      gap: 5px;
      justify-content: flex-start;
      margin-top: -2px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-content > .monwui-serr-calendar-links .monwui-serr-calendar-link {
      border-radius: 7px;
      height: 24px;
      padding: 4px;
      width: 28px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-content > .monwui-serr-calendar-links .monwui-serr-calendar-link img {
      max-height: 20px;
      max-width: 24px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-poster.large .monwui-serr-request-rating-slot {
      align-items: center;
      display: flex;
      justify-content: center;
      left: 5px;
      pointer-events: none;
      position: absolute;
      right: 5px;
      top: 5px;
      z-index: 5;
    }
    .monwui-serr-requests-modal.open .monwui-serr-poster.large .monwui-serr-request-rating-slot[hidden] {
      display: none !important;
    }
    .monwui-serr-requests-modal.open .monwui-serr-rating-badge {
      align-items: center;
      background: rgba(16,18,24,.82);
      border: 1px solid color-mix(in srgb, var(--jf-notif-warning, #fbbf24) 34%, transparent);
      border-radius: 999px;
      box-sizing: border-box;
      color: var(--jf-notif-warning, #fbbf24);
      display: inline-flex;
      font-size: 10px;
      font-weight: 850;
      gap: 3px;
      justify-content: center;
      line-height: 1;
      max-width: 100%;
      min-width: 0;
      padding: 3px 5px;
      white-space: nowrap;
  }
    .monwui-serr-requests-modal.open .monwui-serr-rating-badge i,
    .monwui-serr-requests-modal.open .monwui-serr-rating-badge span {
      margin: 0;
      padding: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-rating-badge span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .monwui-serr-requests-modal.open .monwui-serr-rating-badge i {
      flex: 0 0 auto;
      font-size: .78rem;
  }
    .monwui-serr-requests-modal.open .monwui-serr-request-name {
      display: -webkit-box;
      font-size: 21px;
      font-weight: 900;
      line-height: 1.08;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .monwui-serr-requests-modal.open .monwui-serr-title-row .monwui-serr-state {
      color: var(--jf-notif-subtext, var(--jf-notif-text-dim, rgba(255,255,255,.56)));
      font-size: 11px;
      font-weight: 650;
      line-height: 1;
      position: absolute;
      top: 8px;
      left: 18px;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-backdrop {
      border: 0;
      bottom: 0;
      box-shadow: none;
      box-sizing: border-box;
      height: var(--monwui-serr-request-card-height);
      min-height: 0;
      overflow: hidden;
      position: absolute;
      right: 0;
      top: 0;
      width: 70%;
      z-index: -1;
      -webkit-mask-image: linear-gradient(
          to left,
          #000 0%,
          transparent 90%
      );
      mask-image: linear-gradient(
          to left,
          #000 0%,
          transparent 90%
      );
  }
    .monwui-serr-requests-modal.open .monwui-serr-request-backdrop img {
        display: block;
        height: 100%;
        object-fit: cover;
        width: 100%;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-backdrop-fallback {
      align-items: center;
      color: var(--jf-notif-subtext, var(--jf-notif-text-dim, rgba(255,255,255,.48)));
      display: flex;
      height: 100%;
      justify-content: center;
      min-height: inherit;
      width: 100%;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-type-badge {
      align-items: center;
      background: color-mix(in srgb, var(--monwui-serr-request-surface) 88%, transparent);
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.18)));
      border-radius: 999px;
      bottom: 8px;
      box-shadow: 0 12px 26px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.12);
      box-sizing: border-box;
      color: var(--jf-notif-text, rgba(255,255,255,.82));
      display: inline-flex;
      font-size: 11px;
      font-weight: 900;
      justify-content: center;
      line-height: 1.2;
      min-height: 24px;
      padding: 7px 10px;
      position: absolute;
      right: 8px;
      white-space: nowrap;
      z-index: 4;
      aspect-ratio: 1;
  }
    .monwui-serr-requests-modal.open .monwui-serr-request-backdrop.is-poster-fallback img {
      filter: saturate(.95) brightness(.82);
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-actions {
      align-self: start;
      display: flex;
      gap: 8px;
      margin-top: 2px;
      min-width: 0;
      position: absolute;
      z-index: 4;
      width: 80%;
      bottom: 10px;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 4px;
      left: 60px;
      flex-wrap: wrap;
  }
    .monwui-serr-requests-modal.open .monwui-serr-request-actions .monwui-serr-mini-btn {
      align-items: center;
      background: var(--jf-notif-serr-btn, var(--jf-notif-serr-btn, rgba(255,255,255,.08)));
      border: 1px solid var(--jf-notif-border);
      border-radius: 999px;
      color: var(--jf-notif-accent);
      display: inline-flex;
      font-size: 11px;
      font-weight: 850;
      gap: 7px;
      padding: 6px 10px;
      transition: color .2s ease, border-color .15s ease, background .25s ease;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-actions .monwui-serr-mini-btn:hover {
      color: var(--ntf-text);
      background: var(--notif-accent);
      border-color: var(--jf-notif-hover);
  }
    .monwui-serr-requests-modal.open .monwui-serr-request-actions .monwui-serr-mini-btn i,
    .monwui-serr-requests-modal.open .monwui-serr-request-actions .monwui-serr-mini-btn span {
      margin: 0;
      padding: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details-wrap {
      bottom: 16px;
      left: 18px;
      position: absolute;
      z-index: 7;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details-toggle {
      align-items: center;
      background: var(--jf-notif-card-bg, var(--head-bg, rgba(255,255,255,.08)));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.14)));
      border-radius: 999px;
      box-shadow: var(--jf-notif-shadow, 0 10px 24px rgba(0,0,0,.18));
      color: var(--jf-notif-text, #fff);
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-size: 12px;
      font-weight: 850;
      gap: 7px;
      justify-content: center;
      line-height: 1;
      min-height: 28px;
      padding: 8px 12px;
      white-space: nowrap;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details-toggle i {
      padding: 0;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details-toggle:hover,
    .monwui-serr-requests-modal.open .monwui-serr-request-details-wrap:focus-within .monwui-serr-request-details-toggle {
      background: var(--jf-notif-hover, var(--row-hover, rgba(255,255,255,.08)));
      border-color: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 42%, var(--jf-notif-border, rgba(255,255,255,.14)));
      color: var(--jf-notif-accent, var(--notif-accent, #6aa6ff));
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details {
      -webkit-backdrop-filter: blur(18px) saturate(1.08);
      backdrop-filter: blur(18px) saturate(1.08);
      background: color-mix(in srgb, var(--monwui-serr-request-surface) 94%, transparent);
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.14)));
      border-radius: 12px;
      bottom: 32px;
      box-shadow: var(--jf-notif-shadow, 0 18px 42px rgba(0,0,0,.28));
      box-sizing: border-box;
      display: grid;
      gap: 7px;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      margin-left: 0;
      max-height: 200px;
      min-width: 0;
      opacity: 0;
      overflow: auto;
      padding: 8px;
      pointer-events: none;
      position: absolute;
      text-align: left;
      transform: translateY(6px);
      transition:
       opacity .16s ease,
       transform .16s ease,
       visibility 0s linear .15s;
      visibility: hidden;
      width: min(350px, calc(100vw - 64px));
      z-index: 8;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details-wrap::before {
      content: "";
      position: absolute;
      left: 0;
      bottom: 28px;
      width: min(350px, calc(100vw - 64px));
      height: 16px;
      z-index: 7;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details-wrap:hover .monwui-serr-request-details,
    .monwui-serr-requests-modal.open .monwui-serr-request-details-wrap:focus-within .monwui-serr-request-details {
      opacity: 1;
      pointer-events: auto;
      transform: none;
      visibility: visible;
      text-align: left;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details div {
      align-items: flex-start;
      background: var(--jf-notif-card-bg, var(--head-bg, rgba(255,255,255,.08)));
      border: 1px solid var(--jf-notif-border);
      border-radius: 11px;
      box-sizing: border-box;
      display: grid;
      gap: 4px;
      min-width: 0;
      padding: 7px 9px;
      text-align: center;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details b {
      color: var(--jf-notif-warning);
      font-size: 10px;
      font-weight: 850;
      letter-spacing: 0;
      line-height: 1.1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-details span {
      color: var(--jf-notif-text);
      font-size: 11px;
      font-weight: 700;
      line-height: 1.25;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .monwui-serr-requests-modal.open .monwui-serr-request-card > [data-serr-error-host] {
      position: relative;
      z-index: 4;
    }
    @media (max-width: 760px), (hover: none) and (pointer: coarse) {
      .monwui-serr-requests-modal.open .monwui-serr-requests-body {
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-card {
        box-shadow: 0 1px 0 rgba(255,255,255,.06);
        contain: layout paint style;
        contain-intrinsic-size: var(--monwui-serr-request-card-height);
        content-visibility: auto;
        transition: none;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-card:before,
      .monwui-serr-requests-modal.open .monwui-serr-request-card.monwui-serr-request-card-hit:after {
        display: none;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-card:hover {
        border-color: var(--jf-notif-border, var(--border-color, rgba(255,255,255,.13)));
        box-shadow: 0 1px 0 rgba(255,255,255,.06);
        transform: none;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-card.monwui-serr-request-card-hit {
        animation: none;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 26%, transparent);
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-backdrop.is-poster-fallback img {
        filter: none;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-actions .monwui-serr-mini-btn,
      .monwui-serr-requests-modal.open .monwui-serr-request-details-toggle,
      .monwui-serr-requests-modal.open .monwui-serr-request-type-badge,
      .monwui-serr-requests-modal.open .monwui-serr-request-details,
      .monwui-serr-requests-modal.open .monwui-serr-poster.large,
      .monwui-serr-requests-modal.open .monwui-serr-rating-badge {
        -webkit-backdrop-filter: none;
        backdrop-filter: none;
        box-shadow: none;
        transition: none;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-details {
        background: var(--monwui-serr-request-surface);
      }
    }
    @media (min-width: 1260px) {
      .monwui-serr-requests-modal.open .monwui-serr-requests-list {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    @media (max-width: 760px) {
      .monwui-serr-requests-modal.open .monwui-serr-requests-list {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 680px) {
      .monwui-serr-requests-modal.open .monwui-serr-requests-dialog {
        width: min(100vw - 18px, 520px);
      }
      .monwui-serr-requests-modal.open .monwui-serr-requests-body {
        padding: 10px;
      }
      .monwui-serr-requests-modal.open .monwui-serr-requests-switch span {
        display: none;
      }
      .monwui-serr-requests-modal.open .monwui-serr-manager-search-run span {
        display: none;
      }
      .monwui-serr-requests-modal.open .monwui-serr-manager-result {
        grid-template-columns: 46px minmax(0, 1fr);
      }
      .monwui-serr-requests-modal.open .monwui-serr-manager-result-poster {
        width: 46px;
      }
      .monwui-serr-requests-modal.open .monwui-serr-manager-result-btn {
        grid-column: 1 / -1;
        justify-self: start;
      }
      .monwui-serr-requests-modal.open .monwui-serr-requests-pagination {
        align-items: stretch;
        flex-direction: column;
      }
      .monwui-serr-requests-modal.open .monwui-serr-requests-page-controls {
        justify-content: center;
      }
      .monwui-serr-requests-modal.open .monwui-serr-requests-page-summary {
        justify-content: center;
        width: 100%;
      }
      .monwui-serr-requests-modal.open .monwui-serr-requests-list {
        grid-template-columns: 1fr;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-card {
        border-radius: 10px;
        height: var(--monwui-serr-request-card-height);
        min-height: var(--monwui-serr-request-card-height);
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-main {
        height: var(--monwui-serr-request-card-height);
        min-height: var(--monwui-serr-request-card-height);
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-backdrop {
        min-height: 0;
        width: 100%;
      }
      .monwui-serr-requests-modal.open .monwui-serr-poster.large {
        width: 76px;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-name {
        font-size: 21px;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-actions .monwui-serr-mini-btn {
      font-size: 10px;
      padding: 4px 8px;
  }
      .monwui-serr-requests-modal.open .monwui-serr-request-details-wrap {
        bottom: 14px;
        left: 14px;
      }
    }
    @media (max-width: 460px) {
      .monwui-serr-requests-modal.open .monwui-serr-poster.large {
        width: 68px;
      }
      .monwui-serr-requests-modal.open .monwui-serr-title-row .monwui-serr-state {
        flex-basis: 100%;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-name {
        font-size: 19px;
      }
      .monwui-serr-requests-modal.open .monwui-serr-request-actions .monwui-serr-mini-btn {
        justify-content: center;
      }
    }
  `;
  document.head.appendChild(style);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function calendarRange(monthDate) {
  const first = startOfMonth(monthDate);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = addDays(first, -mondayOffset);
  return { start, end: addDays(start, 41) };
}

function parseEventDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function monthTitle(date) {
  try {
    return date.toLocaleDateString(labels()?.timeLocale || undefined, { month: "long", year: "numeric" });
  } catch {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }
}

function weekdayLabels() {
  const base = new Date(2024, 0, 1);
  return Array.from({ length: 7 }, (_, index) => {
    try {
      return addDays(base, index).toLocaleDateString(labels()?.timeLocale || undefined, { weekday: "short" });
    } catch {
      return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index];
    }
  });
}

function calendarStatusLabel(status) {
  switch (text(status).toLowerCase()) {
    case "available": return L("serrStatusCompleted", "Tamamlandı");
    case "missing": return L("serrCalendarMissing", "Eksik");
    case "unmonitored": return L("serrCalendarUnmonitored", "İzlenmiyor");
    case "upcoming":
    default: return L("serrCalendarUpcoming", "Yakında");
  }
}

function calendarReleaseLabel(type) {
  switch (text(type).toLowerCase()) {
    case "air": return L("episode", "Bölüm");
    case "cinema": return L("serrCalendarCinema", "Sinema");
    case "digital": return L("serrCalendarDigital", "Dijital");
    case "physical": return L("serrCalendarPhysical", "Fiziksel");
    case "release": return L("serrCalendarRelease", "Yayın");
    default: return "";
  }
}

function ensureSerrCalendarStyles() {
  const id = "monwui-serr-calendar-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #jfNotifModal .monwui-serr-notif-tools {
      gap: 8px;
    }
    #jfNotifModal .monwui-serr-calendar-btn,
    #jfNotifModal .monwui-serr-manage-btn {
      align-items: center;
      display: inline-flex;
      gap: 7px;
      justify-content: center;
      font-size: 0.875rem;
    }
    #jfNotifModal .monwui-serr-calendar-btn {
        background: var(--ntf-btn-bg, var(--jf-notif-hover, var(--panel-bg, rgba(255,255,255,.08))));
        border: 1px solid var(--ntf-divider, var(--jf-notif-border, rgba(255,255,255,.12)));
        border-radius: var(--ntf-radius-sm, 8px);
        color: var(--ntf-btn-text, var(--jf-notif-text, #fff));
        cursor: pointer;
        min-height: 32px;
        padding: 6px 10px;
        display: flex;
        flex-direction: row;
        align-items: center;
    }
    .monwui-serr-calendar-btn i,.monwui-serr-calendar-btn span {
        padding: 0;
        margin: 0;
        text-align: center;
    }
    #jfNotifModal .monwui-serr-calendar-btn:hover {
      background: var(--ntf-btn-hover, var(--jf-notif-card-bg-hover, rgba(255,255,255,.12)));
    }
    .monwui-serr-calendar-modal {
      box-sizing: border-box;
      display: none;
      inset: 0;
      overflow: auto;
      padding: 16px;
      position: fixed;
      z-index: 10002;
    }
    .monwui-serr-calendar-modal.open {
      align-items: flex-start;
      display: flex;
      justify-content: center;
    }
    .monwui-serr-calendar-backdrop {
      background: rgba(0,0,0,.52);
      inset: 0;
      position: absolute;
    }
    .monwui-serr-calendar-dialog {
      background: var(--jf-notif-bg, var(--panel-bg, #151924));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 12px;
      box-shadow: var(--jf-notif-shadow, 0 24px 70px rgba(0,0,0,.38));
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      margin: auto 0;
      max-height: calc(100dvh - 32px);
      overflow: hidden;
      position: relative;
      width: min(980px, calc(100vw - 28px));
    }
    .monwui-serr-calendar-head {
      align-items: center;
      border-bottom: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.1)));
      display: grid;
      gap: 10px;
      grid-template-columns: auto auto minmax(0, 1fr) auto auto auto;
      padding: 12px 14px;
    }
    .monwui-serr-calendar-title {
      font-size: 17px;
      font-weight: 800;
      overflow-wrap: anywhere;
      text-align: center;
    }
    .monwui-serr-calendar-nav,
    .monwui-serr-calendar-switch,
    .monwui-serr-calendar-close {
      align-items: center;
      background: var(--jf-notif-hover, var(--head-bg, rgba(255,255,255,.08)));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.12)));
      border-radius: 8px;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      height: 34px;
      justify-content: center;
      width: 34px;
    }
    .monwui-serr-calendar-switch {
      gap: 7px;
      padding: 0 10px;
      width: auto;
    }
    .monwui-serr-calendar-switch i,
    .monwui-serr-calendar-switch span {
      margin: 0;
      padding: 0;
    }
    .monwui-serr-calendar-nav:hover,
    .monwui-serr-calendar-switch:hover,
    .monwui-serr-calendar-close:hover {
      border-color: var(--jf-notif-accent, var(--notif-accent, #60a5fa));
      color: var(--jf-notif-accent, var(--notif-accent, #60a5fa));
    }
    .monwui-serr-calendar-body {
      display: grid;
      gap: 10px;
      min-height: 0;
      overflow: auto;
      padding: 12px;
      scrollbar-color: var(--jf-notif-accent, var(--notif-accent, #60a5fa)) transparent;
      scrollbar-width: thin;
    }
    .monwui-serr-calendar-legend {
      align-items: center;
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      display: flex;
      flex-wrap: wrap;
      font-size: 12px;
      gap: 10px;
    }
    .monwui-serr-calendar-legend span {
      align-items: center;
      display: inline-flex;
      gap: 6px;
    }
    .monwui-serr-calendar-dot {
      background: var(--dot-bg, var(--dot, var(--jf-notif-accent, #60a5fa)));
      border-radius: 999px;
      display: inline-block;
      height: 7px;
      width: 7px;
    }
    .monwui-serr-calendar-dot.is-split {
      background: linear-gradient(135deg,
        var(--dot-service, #60a5fa) 0 48%,
        rgba(255,255,255,.42) 48% 52%,
        var(--dot-status, #94a3b8) 52% 100%);
    }
    .monwui-serr-calendar-grid {
      display: grid;
      gap: 6px;
      grid-template-columns: repeat(7, minmax(42px, 1fr));
      overflow: visible;
    }
    .monwui-serr-calendar-weekday {
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      font-size: 11px;
      font-weight: 800;
      padding: 0 4px 2px;
      text-align: center;
    }
    .monwui-serr-calendar-day {
      background: var(--jf-notif-card-bg, var(--head-bg, rgba(255,255,255,.04)));
      border: 1px solid var(--jf-notif-border, var(--border-color, rgba(255,255,255,.1)));
      border-radius: 8px;
      min-height: clamp(62px, 10vh, 86px);
      overflow: visible;
      padding: 7px;
      position: relative;
    }
    .monwui-serr-calendar-day:hover,
    .monwui-serr-calendar-day:focus-within,
    .monwui-serr-calendar-day.is-open {
      z-index: 20;
    }
    .monwui-serr-calendar-day.is-muted {
      opacity: 1;
    }
    .monwui-serr-calendar-day.is-muted .monwui-serr-calendar-number,
    .monwui-serr-calendar-day.is-muted .monwui-serr-calendar-dot,
    .monwui-serr-calendar-day.is-muted .monwui-serr-calendar-more {
      opacity: .48;
    }
    .monwui-serr-calendar-day.is-muted .monwui-serr-calendar-popover {
      opacity: 1;
    }
    .monwui-serr-calendar-day.is-today {
      border-color: var(--jf-notif-accent, var(--notif-accent, #60a5fa));
    }
    .monwui-serr-calendar-number {
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font-size: 12px;
      font-weight: 800;
    }
    .monwui-serr-calendar-dots {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .monwui-serr-calendar-dot-wrap {
      align-items: center;
      cursor: pointer;
      display: inline-flex;
      height: 16px;
      justify-content: center;
      position: relative;
      width: 16px;
    }
    .monwui-serr-calendar-more {
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      font-size: 10px;
      line-height: 1;
    }
    .monwui-serr-calendar-popover {
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
      background: transparent;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 10px;
      box-shadow: 0 18px 40px rgba(0,0,0,.34);
      color: var(--jf-notif-subtext, rgba(255,255,255,.68));
      display: none;
      gap: 8px;
      isolation: isolate;
      left: 50%;
      min-width: min(310px, calc(100vw - 40px));
      overflow: hidden;
      padding: 10px;
      position: absolute;
      top: calc(100% - 1px);
      transform: translateX(-50%);
      width: min(360px, calc(100vw - 40px));
      z-index: 40;
    }
    .monwui-serr-calendar-popover-bg {
      inset: -18px;
      opacity: .28;
      overflow: hidden;
      pointer-events: none;
      position: absolute;
      z-index: 0;
    }
    .monwui-serr-calendar-popover-bg img {
      filter: blur(12px) saturate(1.12) contrast(1.04);
      height: 100%;
      object-fit: cover;
      transform: scale(1.08);
      width: 100%;
    }
    .monwui-serr-calendar-day.is-left-edge .monwui-serr-calendar-popover {
      left: 0;
      transform: none;
    }
    .monwui-serr-calendar-day.is-right-edge .monwui-serr-calendar-popover {
      left: auto;
      right: 0;
      transform: none;
    }
    .monwui-serr-calendar-day.is-bottom-row .monwui-serr-calendar-popover {
      bottom: calc(100% - 1px);
      top: auto;
    }
    .monwui-serr-calendar-dot-wrap.is-ready:hover .monwui-serr-calendar-popover,
    .monwui-serr-calendar-dot-wrap.is-ready.is-open .monwui-serr-calendar-popover {
      display: grid;
      z-index: 999;
    }
    .monwui-serr-calendar-event {
      display: grid;
      gap: 10px;
      grid-template-columns: 54px minmax(0, 1fr);
      position: relative;
      z-index: 1;
    }
    .monwui-serr-calendar-links {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      justify-content: center;
      margin-top: 8px;
    }
    .monwui-serr-calendar-link {
      align-items: center;
      background: rgba(255,255,255,.12);
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 8px;
      box-sizing: border-box;
      display: inline-flex;
      height: 28px;
      justify-content: center;
      padding: 5px;
      transition: background .16s ease,border-color .16s ease,transform .16s ease;
      width: 28px;
    }
    .monwui-serr-calendar-link:hover,
    .monwui-serr-calendar-link:focus-visible {
      background: rgba(255,255,255,.2);
      border-color: rgba(255,255,255,.34);
      outline: none;
      transform: translateY(-1px);
    }
    .monwui-serr-calendar-link img {
      display: block;
      max-height: 18px;
      max-width: 18px;
      object-fit: contain;
    }
    .monwui-serr-calendar-event-poster {
      align-items: center;
      aspect-ratio: 2 / 3;
      background: color-mix(in srgb, var(--jf-notif-accent, #60a5fa) 18%, transparent);
      border: 1px solid var(--jf-notif-border, rgba(255,255,255,.12));
      border-radius: 7px;
      color: var(--jf-notif-subtext, rgba(255,255,255,.68));
      display: flex;
      justify-content: center;
      overflow: hidden;
      width: 54px;
    }
    .monwui-serr-calendar-event-poster img {
      display: block;
      height: 100%;
      object-fit: cover;
      width: 100%;
    }
    .monwui-serr-calendar-event-poster i {
      font-size: 18px;
    }
    .monwui-serr-calendar-event strong,
    .monwui-serr-calendar-event small {
      overflow-wrap: anywhere;
    }
    .monwui-serr-calendar-event strong {
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font-size: 13px;
      line-height: 1.25;
      display: flex;
      text-align: center;
      align-items: center;
      justify-content: center;
    }
    .monwui-serr-calendar-event small {
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      color: var(--jf-notif-subtext, rgba(255,255,255,.68));
      font-size: 11px;
      line-height: 1.35;
      display: flex;
      padding: 10px;
      justify-content: center;
      align-items: center;
    }
    .monwui-serr-calendar-loading,
    .monwui-serr-calendar-empty,
    .monwui-serr-calendar-error {
      color: var(--jf-notif-subtext, var(--nft-text-secondary, rgba(255,255,255,.68)));
      padding: 28px;
      text-align: center;
    }
    .monwui-serr-calendar-error {
      color: #ef4444;
    }
    @media (max-width: 640px) {
      .monwui-serr-calendar-dialog {
        border-radius: 0;
        height: 100dvh;
        max-height: 100dvh;
        width: 100vw;
      }
      .monwui-serr-calendar-modal {
        padding: 0;
      }
      .monwui-serr-calendar-head {
        align-items: center;
        gap: 6px;
        display: flex;
        justify-content: space-between;
        min-height: 48px;
        padding: calc(7px + env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 7px max(8px, env(safe-area-inset-left));
      }
      .monwui-serr-calendar-title {
        font-size: 14px;
        line-height: 1.15;
        min-width: 0;
        overflow: hidden;
        overflow-wrap: normal;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .monwui-serr-calendar-nav,
      .monwui-serr-calendar-switch,
      .monwui-serr-calendar-close {
        box-sizing: border-box;
        font-size: 14px;
        height: 32px;
        line-height: 1;
        min-height: 0 !important;
        min-width: 0 !important;
        padding: 0 !important;
        width: 32px;
      }
      .monwui-serr-calendar-switch span {
        display: none;
      }
      .monwui-serr-calendar-close {
        font-size: 19px;
      }
      .monwui-serr-calendar-body {
        gap: 6px;
        grid-template-rows: auto minmax(0, 1fr);
        overflow: auto;
        padding: 8px;
      }
      .monwui-serr-calendar-legend {
        flex-wrap: wrap;
        gap: 6px;
        margin: 0 -8px;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 0 8px 4px;
        scrollbar-width: none;
        white-space: nowrap;
        align-items: center;
        justify-content: center;
        align-content: center;
      }
      .monwui-serr-calendar-legend::-webkit-scrollbar {
        display: none;
      }
      .monwui-serr-calendar-legend > span {
        flex: 0 0 auto;
        font-size: 10px;
        gap: 4px;
        line-height: 1;
        padding: 5px 7px;
      }
      .monwui-serr-calendar-grid {
        gap: 3px;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        min-width: 0;
        overflow: visible;
        padding: 12px;
      }
      .monwui-serr-calendar-weekday {
        font-size: 9px;
        padding: 0 1px 1px;
      }
      .monwui-serr-calendar-day {
        border-radius: 6px;
        min-height: 49px;
        min-width: 0;
        padding: 4px 3px;
      }
      .monwui-serr-calendar-number {
        font-size: 11px;
        line-height: 1;
      }
      .monwui-serr-calendar-dots {
        gap: 1px;
        margin-top: 5px;
      }
      .monwui-serr-calendar-dot-wrap {
        height: 12px;
        width: 12px;
      }
      .monwui-serr-calendar-dot {
        height: 6px;
        width: 6px;
      }
      .monwui-serr-calendar-more {
        font-size: 9px;
      }
      .monwui-serr-calendar-popover {
        min-width: min(280px, calc(100vw - 24px));
        width: min(320px, calc(100vw - 24px));
      }
      .monwui-serr-calendar-event {
        grid-template-columns: 46px minmax(0, 1fr);
      }
      .monwui-serr-calendar-event-poster {
        width: 46px;
      }
    }
  `;
  document.head.appendChild(style);
}

function calendarServiceColor(service) {
  return text(service).toLowerCase() === "radarr" ? "#f59e0b" : "#60a5fa";
}

function calendarServiceLabel(service) {
  return text(service).toLowerCase() === "radarr"
    ? L("serrCalendarRadarr", "Radarr")
    : L("serrCalendarSonarr", "Sonarr");
}

function normalizeCalendarStatusKey(status) {
  switch (text(status).toLowerCase()) {
    case "available":
    case "completed":
      return "completed";
    case "missing":
      return "missing";
    case "processing":
      return "processing";
    case "approved":
      return "approved";
    case "pending":
      return "pending";
    case "requested":
      return "requested";
    case "unmonitored":
      return "unmonitored";
    case "declined":
      return "declined";
    case "failed":
      return "failed";
    case "withdrawn":
      return "withdrawn";
    case "upcoming":
    default:
      return "upcoming";
  }
}

function calendarNumericId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function findCalendarRequest(event) {
  const mediaType = calendarMediaType(event);
  const tmdbId = calendarNumericId(readFirst(event, "tmdbId", "TmdbId"));
  const tvdbId = calendarNumericId(readFirst(event, "tvdbId", "TvdbId"));
  const requests = cachedRequests;

  return requests.find((req) => {
    if (requestMediaType(req) !== mediaType) return false;
    if (mediaType === "movie") return tmdbId > 0 && requestMediaId(req) === tmdbId;
    const reqTvdbId = calendarNumericId(readFirst(req, "TvdbId", "tvdbId"));
    return (tvdbId > 0 && reqTvdbId === tvdbId) || (tmdbId > 0 && requestMediaId(req) === tmdbId);
  }) || null;
}

function calendarRequestStatus(event) {
  const cached = findCalendarRequest(event);
  return text(readFirst(cached, "Status", "status") || readFirst(event, "requestStatus", "RequestStatus"));
}

function calendarDotStatusKey(event) {
  const requestStatus = calendarRequestStatus(event);
  if (requestStatus) return normalizeCalendarStatusKey(requestStatus);
  return normalizeCalendarStatusKey(readFirst(event, "status", "Status"));
}

function calendarStatusColor(status) {
  switch (normalizeCalendarStatusKey(status)) {
    case "completed": return "#22c55e";
    case "missing": return "#ef4444";
    case "processing": return "#a855f7";
    case "approved": return "#14b8a6";
    case "pending": return "#facc15";
    case "requested": return "#38bdf8";
    case "unmonitored": return "#94a3b8";
    case "declined": return "#fb7185";
    case "failed": return "#dc2626";
    case "withdrawn": return "#64748b";
    case "upcoming":
    default: return "#c084fc";
  }
}

function calendarDotStyle(event) {
  return `--dot-service:${calendarServiceColor(event?.service)};--dot-status:${calendarStatusColor(calendarDotStatusKey(event))};`;
}

function calendarLegendDot(label, color) {
  const safeColor = escapeHtml(color);
  return `<span><span class="monwui-serr-calendar-dot" style="--dot:${safeColor};--dot-bg:${safeColor};background:${safeColor};background-color:${safeColor}"></span>${escapeHtml(label)}</span>`;
}

function calendarLegendHtml() {
  return [
    calendarLegendDot(calendarServiceLabel("sonarr"), calendarServiceColor("sonarr")),
    calendarLegendDot(calendarServiceLabel("radarr"), calendarServiceColor("radarr")),
    calendarLegendDot(L("serrCalendarMissing", "Eksik"), calendarStatusColor("missing")),
    calendarLegendDot(L("serrCalendarUpcoming", "Yakında"), calendarStatusColor("upcoming")),
    calendarLegendDot(statusLabel("pending"), calendarStatusColor("pending")),
    calendarLegendDot(statusLabel("approved"), calendarStatusColor("approved")),
    calendarLegendDot(statusLabel("processing"), calendarStatusColor("processing")),
    calendarLegendDot(statusLabel("completed"), calendarStatusColor("completed")),
    calendarLegendDot(L("serrCalendarUnmonitored", "İzlenmiyor"), calendarStatusColor("unmonitored"))
  ].join("");
}

function servicePopoverClass(service) {
  return text(service).toLowerCase() === "radarr" ? "is-radarr" : "is-sonarr";
}

function calendarPosterUrl(event) {
  return imageUrl(readFirst(event, "posterUrl", "posterPath", "poster_path", "image", "thumbnail"), "w185");
}

const CALENDAR_ICON_BASE = "./slider/src/images/";

function safeExternalUrl(value) {
  const clean = text(value);
  return /^https?:\/\//i.test(clean) ? clean : "";
}

function calendarId(value) {
  const clean = text(value);
  if (!clean || clean === "0") return "";
  return clean;
}

function calendarMediaType(event) {
  return text(readFirst(event, "mediaType", "MediaType")).toLowerCase() === "tv" ? "tv" : "movie";
}

function calendarProviderUrl(provider, id, mediaType) {
  const cleanId = calendarId(id);
  if (!cleanId) return "";
  const encoded = encodeURIComponent(cleanId);
  switch (provider) {
    case "imdb":
      return `https://www.imdb.com/title/${encoded}/`;
    case "tmdb":
      return `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${encoded}`;
    case "tvdb":
      return `https://www.thetvdb.com/dereferrer/${mediaType === "tv" ? "series" : "movie"}/${encoded}`;
    default:
      return "";
  }
}

function calendarIconLink({ key, label, url }) {
  const cleanUrl = safeExternalUrl(url);
  if (!cleanUrl) return "";
  const cleanKey = text(key).toLowerCase();
  const cleanLabel = text(label, cleanKey);
  return `
    <a class="monwui-serr-calendar-link ${escapeHtml(cleanKey)}" href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(cleanLabel)}" aria-label="${escapeHtml(cleanLabel)}">
      <img src="${CALENDAR_ICON_BASE}${escapeHtml(cleanKey)}.svg" alt="">
    </a>
  `;
}

function renderCalendarLinks(event) {
  const mediaType = calendarMediaType(event);
  const service = text(readFirst(event, "service", "Service")).toLowerCase();
  const links = [];
  const arrUrl = safeExternalUrl(readFirst(event, "arrUrl", "ArrUrl"));
  const serrUrl = safeExternalUrl(readFirst(event, "serrUrl", "SerrUrl", "seerrUrl", "SeerrUrl"));
  const tmdbId = calendarId(readFirst(event, "tmdbId", "TmdbId"));
  const imdbId = calendarId(readFirst(event, "imdbId", "ImdbId"));
  const tvdbId = calendarId(readFirst(event, "tvdbId", "TvdbId"));

  if (arrUrl) {
    links.push(calendarIconLink({
      key: service === "radarr" ? "radarr" : "sonarr",
      label: calendarServiceLabel(service),
      url: arrUrl
    }));
  }
  if (serrUrl) links.push(calendarIconLink({ key: "seerr", label: "Seerr", url: serrUrl }));
  if (tmdbId) links.push(calendarIconLink({ key: "tmdb", label: "TMDb", url: calendarProviderUrl("tmdb", tmdbId, mediaType) }));
  if (imdbId) links.push(calendarIconLink({ key: "imdb", label: "IMDb", url: calendarProviderUrl("imdb", imdbId, mediaType) }));
  if (tvdbId) links.push(calendarIconLink({ key: "tvdb", label: "TVDb", url: calendarProviderUrl("tvdb", tvdbId, mediaType) }));

  const html = links.filter(Boolean).join("");
  return html ? `<span class="monwui-serr-calendar-links">${html}</span>` : "";
}

function normalizedCalendarText(value) {
  return text(value)
    .toLowerCase()
    .replace(/[•|/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUniqueCalendarPart(parts, value) {
  const clean = text(value);
  if (!clean) return;
  const normalized = normalizedCalendarText(clean);
  if (!normalized || parts.some((part) => normalizedCalendarText(part) === normalized)) return;
  parts.push(clean);
}

function calendarSubtitle(event, service, title) {
  let subtitle = text(event?.subtitle);
  if (!subtitle) return "";
  if (subtitle.toLowerCase().startsWith(service.toLowerCase())) {
    subtitle = subtitle.slice(service.length).replace(/^\s*(?:[•:|/\\-]\s*)?/, "").trim();
  }
  if (!subtitle) return "";
  const normalizedSubtitle = normalizedCalendarText(subtitle);
  const normalizedTitle = normalizedCalendarText(title);
  if (normalizedSubtitle && normalizedTitle.includes(normalizedSubtitle)) return "";
  return subtitle;
}

function renderCalendarEvent(event) {
  const service = calendarServiceLabel(event?.service);
  const status = calendarStatusLabel(event?.status);
  const release = calendarReleaseLabel(event?.releaseType);
  const requestStatusValue = calendarRequestStatus(event);
  const requestStatus = requestStatusValue ? statusLabel(requestStatusValue) : "";
  const title = text(event?.title, L("serrUntitled", "İçerik"));
  const metaParts = [];
  pushUniqueCalendarPart(metaParts, service);
  pushUniqueCalendarPart(metaParts, release);
  pushUniqueCalendarPart(metaParts, status);
  pushUniqueCalendarPart(metaParts, requestStatus);
  const meta = metaParts.join(" • ");
  const subtitle = calendarSubtitle(event, service, title);
  const poster = calendarPosterUrl(event);
  return `
    <div class="monwui-serr-calendar-event">
      <span class="monwui-serr-calendar-event-poster">
        ${poster
          ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`
          : `<i class="fas fa-clapperboard" aria-hidden="true"></i>`}
      </span>
      <span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(meta)}</small>
        ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}
        ${renderCalendarLinks(event)}
      </span>
    </div>
  `;
}

function renderCalendarDot(event) {
  const title = text(event?.title, L("serrUntitled", "İçerik"));
  const poster = calendarPosterUrl(event);
  return `
    <span class="monwui-serr-calendar-dot-wrap" role="button" tabindex="0" data-serr-calendar-event-dot aria-label="${escapeHtml(title)}">
      <span class="monwui-serr-calendar-dot is-split" style="${escapeHtml(calendarDotStyle(event))}" title="${escapeHtml(title)}"></span>
      <span class="monwui-serr-calendar-popover ${escapeHtml(servicePopoverClass(event?.service))}" role="tooltip">
        ${poster ? `<span class="monwui-serr-calendar-popover-bg" aria-hidden="true"><img src="${escapeHtml(poster)}" alt="" loading="lazy" decoding="async"></span>` : ""}
        ${renderCalendarEvent(event)}
      </span>
    </span>
  `;
}

function calendarPopoverImageUrls(dot) {
  const popover = dot?.querySelector?.(".monwui-serr-calendar-popover");
  if (!popover) return [];
  const seen = new Set();
  const urls = [];
  popover.querySelectorAll("img").forEach((img) => {
    const url = text(img.currentSrc || img.getAttribute("src") || img.src);
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  });
  return urls;
}

function waitForCalendarImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok === true);
    };
    const timer = setTimeout(() => finish(false), CALENDAR_IMAGE_READY_TIMEOUT_MS);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.decoding = "async";
    img.src = url;
    if (img.complete) finish(img.naturalWidth > 0);
  });
}

function replaceFailedCalendarImages(dot, failedUrls) {
  if (!dot || !failedUrls?.length) return;
  const failed = new Set(failedUrls);
  dot.querySelectorAll(".monwui-serr-calendar-popover img").forEach((img) => {
    const url = text(img.currentSrc || img.getAttribute("src") || img.src);
    if (!failed.has(url)) return;
    const bg = img.closest(".monwui-serr-calendar-popover-bg");
    if (bg) {
      bg.remove();
      return;
    }
    const poster = img.closest(".monwui-serr-calendar-event-poster");
    if (poster) {
      poster.innerHTML = `<i class="fas fa-clapperboard" aria-hidden="true"></i>`;
      return;
    }
    img.remove();
  });
}

function ensureCalendarDotImagesReady(dot) {
  if (!dot) return Promise.resolve(false);
  if (dot.classList.contains("is-ready")) return Promise.resolve(true);
  if (dot.__monwuiCalendarReadyPromise) return dot.__monwuiCalendarReadyPromise;

  const urls = calendarPopoverImageUrls(dot);
  if (!urls.length) {
    dot.classList.add("is-ready");
    dot.setAttribute("data-serr-calendar-images-ready", "1");
    return Promise.resolve(true);
  }

  dot.classList.add("is-loading");
  dot.__monwuiCalendarReadyPromise = Promise.all(urls.map(async (url) => ({
    url,
    ok: await waitForCalendarImage(url)
  }))).then((results) => {
    if (!dot.isConnected) return false;
    replaceFailedCalendarImages(dot, results.filter((item) => !item.ok).map((item) => item.url));
    dot.classList.remove("is-loading");
    dot.classList.add("is-ready");
    dot.setAttribute("data-serr-calendar-images-ready", "1");
    return true;
  }).finally(() => {
    dot.__monwuiCalendarReadyPromise = null;
  });

  return dot.__monwuiCalendarReadyPromise;
}

function closeCalendarDots(modal, exceptDot = null, exceptDay = null) {
  modal?.querySelectorAll?.(".monwui-serr-calendar-dot-wrap.is-open, .monwui-serr-calendar-dot-wrap.is-open-pending").forEach((node) => {
    if (node === exceptDot) return;
    node.classList.remove("is-open", "is-open-pending");
    node.__monwuiCalendarOpenToken = "";
  });
  modal?.querySelectorAll?.(".monwui-serr-calendar-day.is-open").forEach((node) => {
    if (node !== exceptDay) node.classList.remove("is-open");
  });
}

async function openCalendarDotAfterImages(dot, modal) {
  if (!dot) return;
  const day = dot.closest(".monwui-serr-calendar-day");
  const token = `${Date.now()}:${Math.random()}`;
  dot.__monwuiCalendarOpenToken = token;
  dot.classList.add("is-open-pending");
  closeCalendarDots(modal, dot, day);
  const ready = await ensureCalendarDotImagesReady(dot);
  if (!ready || !dot.isConnected || dot.__monwuiCalendarOpenToken !== token) return;
  dot.classList.remove("is-open-pending");
  dot.classList.add("is-open");
  day?.classList?.add?.("is-open");
}

function renderCalendarDay(day, monthDate, events, dayIndex = 0) {
  const key = dateKey(day);
  const today = dateKey(new Date()) === key;
  const muted = day.getMonth() !== monthDate.getMonth();
  const col = dayIndex % 7;
  const row = Math.floor(dayIndex / 7);
  const classes = [
    "monwui-serr-calendar-day",
    muted ? "is-muted" : "",
    today ? "is-today" : "",
    events.length ? "has-events" : "",
    col <= 1 ? "is-left-edge" : "",
    col >= 5 ? "is-right-edge" : "",
    row >= 4 ? "is-bottom-row" : ""
  ].filter(Boolean).join(" ");
  const visibleEvents = events.slice(0, 7);
  const dots = visibleEvents.map(renderCalendarDot).join("");
  return `
    <div class="${escapeHtml(classes)}" tabindex="0" data-serr-calendar-day="${escapeHtml(key)}">
      <div class="monwui-serr-calendar-number">${escapeHtml(String(day.getDate()))}</div>
      ${events.length ? `<div class="monwui-serr-calendar-dots">${dots}${events.length > visibleEvents.length ? `<span class="monwui-serr-calendar-more">+${events.length - visibleEvents.length}</span>` : ""}</div>` : ""}
    </div>
  `;
}

function ensureSerrCalendarModal() {
  ensureSerrCalendarStyles();
  let modal = document.getElementById("monwuiSerrCalendarModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "monwuiSerrCalendarModal";
  modal.className = "monwui-serr-calendar-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.__calendarMonth = startOfMonth(new Date());
  modal.innerHTML = `
    <div class="monwui-serr-calendar-backdrop" data-serr-calendar-close></div>
    <div class="monwui-serr-calendar-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L("serrCalendarTitle", "Arr Takvimi"))}">
      <div class="monwui-serr-calendar-head">
        <button type="button" class="monwui-serr-calendar-nav" data-serr-calendar-prev aria-label="${escapeHtml(L("previous", "Önceki"))}"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
        <button type="button" class="monwui-serr-calendar-nav" data-serr-calendar-today aria-label="${escapeHtml(L("today", "Bugün"))}"><i class="fas fa-calendar-day" aria-hidden="true"></i></button>
        <div class="monwui-serr-calendar-title" data-serr-calendar-title></div>
        <button type="button" class="monwui-serr-calendar-nav" data-serr-calendar-next aria-label="${escapeHtml(L("next", "Sonraki"))}"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
        <button type="button" class="monwui-serr-calendar-switch" data-serr-calendar-open-manager title="${escapeHtml(L("serrManageRequests", "İstekleri Yönet"))}" aria-label="${escapeHtml(L("serrManageRequests", "İstekleri Yönet"))}">
          <i class="fas fa-list-ul" aria-hidden="true"></i>
          <span>${escapeHtml(L("serrRequestsShort", "İstekler"))}</span>
        </button>
        <button type="button" class="monwui-serr-calendar-close" data-serr-calendar-close aria-label="${escapeHtml(L("close", "Kapat"))}">×</button>
      </div>
      <div class="monwui-serr-calendar-body">
        <div class="monwui-serr-calendar-legend">
          ${calendarLegendHtml()}
        </div>
        <div class="monwui-serr-calendar-grid" data-serr-calendar-grid></div>
      </div>
    </div>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target?.closest?.(".monwui-serr-calendar-link")) {
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-close]")) {
      closeSerrCalendarModal();
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-open-manager]")) {
      switchToSerrRequestsModal();
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-prev]")) {
      modal.__calendarMonth = addMonths(modal.__calendarMonth || new Date(), -1);
      void renderSerrCalendarModal(modal);
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-next]")) {
      modal.__calendarMonth = addMonths(modal.__calendarMonth || new Date(), 1);
      void renderSerrCalendarModal(modal);
      return;
    }
    if (event.target?.closest?.("[data-serr-calendar-today]")) {
      modal.__calendarMonth = startOfMonth(new Date());
      void renderSerrCalendarModal(modal);
      return;
    }
    const dot = event.target?.closest?.("[data-serr-calendar-event-dot]");
    if (dot) {
      const day = dot.closest(".monwui-serr-calendar-day");
      const willOpen = !dot.classList.contains("is-open");
      if (!willOpen) {
        dot.classList.remove("is-open", "is-open-pending");
        dot.__monwuiCalendarOpenToken = "";
        day?.classList?.remove?.("is-open");
        return;
      }
      void openCalendarDotAfterImages(dot, modal);
    }
  });
  modal.addEventListener("mouseover", (event) => {
    const dot = event.target?.closest?.("[data-serr-calendar-event-dot]");
    if (dot) void ensureCalendarDotImagesReady(dot);
  });
  modal.addEventListener("focusin", (event) => {
    const dot = event.target?.closest?.("[data-serr-calendar-event-dot]");
    if (dot) void ensureCalendarDotImagesReady(dot);
  });
  modal.addEventListener("keydown", (event) => {
    const dot = event.target?.closest?.("[data-serr-calendar-event-dot]");
    if (dot && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      dot.click();
      return;
    }
    if (event.key === "Escape") {
      closeSerrCalendarModal();
    }
  });
  document.body.appendChild(modal);
  return modal;
}

function closeSerrCalendarModal() {
  const modal = document.getElementById("monwuiSerrCalendarModal");
  if (!modal) return;
  closeCalendarDots(modal);
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

async function openSerrCalendarModal() {
  const modal = ensureSerrCalendarModal();
  modal.__calendarMonth = modal.__calendarMonth || startOfMonth(new Date());
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  await renderSerrCalendarModal(modal);
}

function switchToSerrRequestsModal() {
  closeSerrCalendarModal();
  void openSerrRequestsModal();
}

async function renderSerrCalendarModal(modal) {
  const month = startOfMonth(modal.__calendarMonth || new Date());
  modal.__calendarMonth = month;
  const title = modal.querySelector("[data-serr-calendar-title]");
  const grid = modal.querySelector("[data-serr-calendar-grid]");
  if (title) title.textContent = monthTitle(month);
  if (!grid) return;
  grid.innerHTML = `<div class="monwui-serr-calendar-loading" style="grid-column:1/-1">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;

  const range = calendarRange(month);
  try {
    const [data] = await Promise.all([
      getArrCalendar({ start: dateKey(range.start), end: dateKey(range.end) }),
      refresh({ render: false }).catch(() => null)
    ]);
    const events = Array.isArray(data?.events) ? data.events : [];
    const byDay = new Map();
    for (const event of events) {
      const parsed = parseEventDate(event?.date);
      if (!parsed) continue;
      const key = dateKey(parsed);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(event);
    }
    const days = Array.from({ length: 42 }, (_, index) => addDays(range.start, index));
    grid.innerHTML = [
      ...weekdayLabels().map((label) => `<div class="monwui-serr-calendar-weekday">${escapeHtml(label)}</div>`),
      ...days.map((day, index) => renderCalendarDay(day, month, byDay.get(dateKey(day)) || [], index))
    ].join("");
    if (!events.length) {
      grid.insertAdjacentHTML("beforeend", `<div class="monwui-serr-calendar-empty" style="grid-column:1/-1">${escapeHtml(L("serrCalendarEmpty", "Bu aralıkta takvim kaydı yok."))}</div>`);
    }
  } catch (error) {
    grid.innerHTML = `<div class="monwui-serr-calendar-error" style="grid-column:1/-1">${escapeHtml(error?.message || L("serrRequestFailed", "İşlem tamamlanamadı."))}</div>`;
  }
}

function statusLabel(status) {
  switch (text(status).toLowerCase()) {
    case "pending": return L("serrStatusPending", "Onay bekliyor");
    case "approved": return L("serrStatusApproved", "Onaylandı");
    case "processing": return L("serrStatusProcessing", "İşleniyor");
    case "completed":
    case "available": return L("serrStatusCompleted", "Tamamlandı");
    case "declined": return L("serrStatusDeclined", "Reddedildi");
    case "failed": return L("serrStatusFailed", "Hatalı");
    case "withdrawn": return L("serrStatusWithdrawn", "Geri çekildi");
    default: return L("serrStatusRequested", "İstendi");
  }
}

function downloadInfo(req) {
  const info = req?.download || req?.Download;
  return info && (info.active === true || info.IsActive === true) ? info : null;
}

function percentValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function serviceLabel(value) {
  const clean = text(value).toLowerCase();
  if (clean === "radarr") return L("serrCalendarRadarr", "Radarr");
  if (clean === "sonarr") return L("serrCalendarSonarr", "Sonarr");
  if (clean === "radarr4k" || clean === "4k radarr") return L("arrRadarr4KSection", "4K Radarr");
  if (clean === "sonarr4k" || clean === "4k sonarr") return L("arrSonarr4KSection", "4K Sonarr");
  return clean ? clean : "Arr";
}

function renderDownloadProgress(req) {
  const info = downloadInfo(req);
  if (!info) return "";
  const percent = percentValue(info.progressPercent ?? info.ProgressPercent);
  const service = serviceLabel(info.service || info.Service);
  const client = text(info.downloadClient || info.DownloadClient);
  const timeLeft = text(info.timeLeft || info.TimeLeft);
  const count = Number(info.itemCount ?? info.ItemCount ?? 1);
  const bits = [
    service,
    client,
    timeLeft ? `${L("arrDownloadRemaining", "Kalan")}: ${timeLeft}` : "",
    Number.isFinite(count) && count > 1 ? `${count} ${L("arrDownloadItems", "öğe")}` : ""
  ].filter(Boolean);

  return `
    <div class="monwui-serr-download">
      <div class="monwui-serr-download-line">
        <b>${escapeHtml(L("arrDownloadProgress", "İndirme"))} ${escapeHtml(percent.toFixed(percent >= 10 ? 0 : 1))}%</b>
        ${bits.length ? `<span>${escapeHtml(bits.join(" • "))}</span>` : ""}
      </div>
      <div class="monwui-serr-download-track" aria-label="${escapeHtml(L("arrDownloadProgress", "İndirme"))}">
        <div class="monwui-serr-download-bar" style="width:${escapeHtml(String(percent))}%"></div>
      </div>
    </div>
  `;
}

function renderDownloadProgressHost(req) {
  return `<div data-serr-download-host>${renderDownloadProgress(req)}</div>`;
}

function arrStatusMessage(result) {
  if (result?.service === "sonarr") return L("arrEpisodeRequestSent", "Bölüm isteği Sonarr'a gönderildi.");
  if (result?.service === "radarr") return L("arrMovieRequestSent", "Film isteği Radarr'a gönderildi.");
  return L("arrRequestSent", "Arr isteği gönderildi.");
}

function notify(message, type = "info") {
  const clean = text(message);
  if (!clean) return;
  try {
    showNotification(`<i class="fas fa-clapperboard" style="margin-right:8px;"></i>${escapeHtml(clean)}`, 3200, type);
  } catch {
    window.showMessage?.(clean, type === "error" ? "error" : "success");
  }
}

function shouldFallbackMovieToArr(result) {
  if (result?.backend === "arr" || result?.service === "radarr" || result?.service === "sonarr") return false;
  if (result?.pendingApproval) return false;
  if (result?.ok !== false) return false;

  const request = result?.request || result?.Request || {};
  const mediaType = requestMediaType(request);
  const mediaId = requestMediaId(request);
  return mediaType === "movie" && mediaId > 0;
}

async function approveSerrRequestWithArrFallback(id) {
  const result = await approveSerrRequest(id);
  if (result?.backend === "arr" || result?.service === "radarr" || result?.service === "sonarr") {
    notify(arrStatusMessage(result), "success");
  }
  if (shouldFallbackMovieToArr(result)) {
    const request = result?.request || result?.Request || {};
    const mediaId = requestMediaId(request);
    const title = text(request?.Title || request?.title, L("serrMovie", "Film"));
    const arrResult = await requestMovieFromArr({ __tmdbId: mediaId, Name: title }, { tmdbId: mediaId, title, is4K: requestIs4K(request) });
    notify(arrStatusMessage(arrResult), "success");
  }
  return result;
}

function isHiddenFromNotifications(req) {
  const status = text(req?.Status || req?.status).toLowerCase();
  return status === "completed" ||
    status === "available" ||
    status === "declined" ||
    status === "failed" ||
    status === "withdrawn";
}

function mediaLabel(req) {
  const type = requestMediaType(req);
  const episodes = Array.isArray(req?.episodes) ? req.episodes : (Array.isArray(req?.Episodes) ? req.Episodes : []);
  const episodeText = episodes.length
    ? episodes.slice(0, 4).map((entry) => {
        const seasonNumber = Number(entry?.SeasonNumber ?? entry?.seasonNumber);
        const episodeNumber = Number(entry?.EpisodeNumber ?? entry?.episodeNumber);
        const code = [
          Number.isFinite(seasonNumber) ? `S${String(seasonNumber).padStart(2, "0")}` : "",
          Number.isFinite(episodeNumber) ? `E${String(episodeNumber).padStart(2, "0")}` : ""
        ].filter(Boolean).join("");
        return code || text(entry?.Name || entry?.name, L("episode", "Bölüm"));
      }).join(", ") + (episodes.length > 4 ? ` +${episodes.length - 4}` : "")
    : "";
  const seasons = req?.RequestAllSeasons || req?.requestAllSeasons
    ? L("serrAllSeasons", "Tüm sezonlar")
    : (Array.isArray(req?.seasons) && req.seasons.length
      ? req.seasons.map((n) => `${L("season", "Sezon")} ${n}`).join(", ")
      : "");
  return [type === "tv" ? L("serrTv", "Dizi") : L("serrMovie", "Film"), seasons, episodeText].filter(Boolean).join(" • ");
}

function mediaTypeBadgeLabel(mediaType) {
  return mediaType === "tv" ? L("serrTv", "Dizi") : L("serrMovie", "Film");
}

function renderRequestInfoChip(label, value) {
  const clean = text(value);
  if (!clean) return "";
  return `<div><b>${escapeHtml(label)}</b><span>${escapeHtml(clean)}</span></div>`;
}

function computeCount(requests, isAdmin) {
  const seen = readSeenRequestKeys();
  return notificationCountableRequests(requests, isAdmin)
    .reduce((count, req) => {
      const key = requestNotificationKey(req);
      return count + (key && !seen.has(key) ? 1 : 0);
    }, 0);
}

function notificationCountableRequests(requests, isAdmin) {
  const list = Array.isArray(requests) ? requests : [];
  if (!isAdmin) return list;
  return list.filter((req) => text(req?.Status || req?.status).toLowerCase() === "pending");
}

function ensureSerrTabBadgeStyles() {
  const id = "monwui-serr-tab-badge-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #jfNotifModal .jf-notif-tab[data-tab="serr"] {
      align-items: center;
      display: inline-flex;
      gap: 6px;
      flex-direction: column-reverse;
    }
    #jfNotifModal .monwui-serr-tab-label {
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-tab-badge {
      align-items: center;
      background: var(--jf-notif-warning, #ffbf5f);
      border-radius: 999px;
      color: #111;
      display: inline-flex;
      font-size: 11px;
      font-weight: 850;
      height: 18px;
      justify-content: center;
      line-height: 1;
      min-width: 18px;
      padding: 0 6px;
    }
    #jfNotifModal .jf-notif-tab.active .monwui-serr-tab-badge {
      background: rgba(255,255,255,.92);
      color: #111;
    }
    #jfNotifModal .monwui-serr-tab-badge[hidden] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function renderSerrTabBadge() {
  const tab = document.querySelector('#jfNotifModal .jf-notif-tab[data-tab="serr"]');
  if (!tab) return;
  ensureSerrTabBadgeStyles();

  let label = tab.querySelector(".monwui-serr-tab-label");
  let badge = tab.querySelector(".monwui-serr-tab-badge");
  if (!label || !badge) {
    tab.textContent = "";
    label = document.createElement("span");
    label.className = "monwui-serr-tab-label";
    badge = document.createElement("span");
    badge.className = "monwui-serr-tab-badge";
    badge.setAttribute("aria-hidden", "true");
    tab.append(label, badge);
  }

  label.textContent = L("serrNotificationsTab", "Seerr İstekleri");
  const count = getCachedSerrNotificationCount();
  const visible = count > 0;
  const value = count > 99 ? "99+" : String(count);
  badge.textContent = visible ? value : "";
  badge.hidden = !visible;
  tab.setAttribute("data-serr-count", visible ? value : "");
  tab.classList.toggle("has-serr-count", visible);
}

function dispatchSerrCountChanged() {
  try { window.dispatchEvent(new CustomEvent("monwui:serr-notification-count-changed")); } catch {}
}

export function markSerrNotificationsSeen() {
  const before = cachedCount;
  const seen = readSeenRequestKeys();
  let changed = false;
  for (const req of notificationCountableRequests(cachedRequests, lastIsAdmin)) {
    const key = requestNotificationKey(req);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    changed = true;
  }
  if (!changed && cachedCount === 0) {
    renderSerrTabBadge();
    if (before !== cachedCount) dispatchSerrCountChanged();
    return;
  }

  if (changed) writeSeenRequestKeys(seen);
  cachedCount = computeCount(cachedRequests, lastIsAdmin);
  renderSerrTabBadge();
  if (changed || before !== cachedCount) dispatchSerrCountChanged();
}

function applyNotificationData(data, { render = false } = {}) {
  const previousCount = cachedCount;
  cachedRequests = (Array.isArray(data?.requests) ? data.requests : []).filter((req) => !isHiddenFromNotifications(req));
  lastIsAdmin = data?.isAdmin === true;
  cachedCount = computeCount(cachedRequests, lastIsAdmin);
  if (isSerrPanelVisible()) {
    markSerrNotificationsSeen();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
  } else {
    renderSerrTabBadge();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
  }
  if (render) renderSerrNotifications();
}

async function refresh({ render = false, includeDownloads = false } = {}) {
  if (!moduleEnabled()) {
    const previousCount = cachedCount;
    cachedRequests = [];
    cachedCount = 0;
    removeSerrNotificationsTab();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
    return null;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const data = await listSerrRequests({ includeDownloads: includeDownloads === true });
      if (includeDownloads === true) lastPanelDownloadRefreshAt = Date.now();
      applyNotificationData(data, { render });
      return data;
    } catch {
      const previousCount = cachedCount;
      cachedRequests = [];
      cachedCount = 0;
      renderSerrTabBadge();
      if (previousCount !== cachedCount) dispatchSerrCountChanged();
      if (render) renderSerrNotifications();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export function refreshSerrNotifications({ render = false, includeDownloads = false } = {}) {
  return refresh({ render, includeDownloads });
}

export function getCachedSerrNotificationCount() {
  return moduleEnabled() ? cachedCount : 0;
}

export function removeSerrNotificationsTab() {
  const tab = document.querySelector('#jfNotifModal .jf-notif-tab[data-tab="serr"]');
  const pane = document.querySelector('#jfNotifModal .jf-notif-tab-content[data-tab="serr"]');
  const wasActive = tab?.classList?.contains("active") === true || (pane ? pane.style.display !== "none" : false);
  tab?.remove?.();
  pane?.remove?.();
  if (wasActive) {
    const first = document.querySelector("#jfNotifModal .jf-notif-tab");
    first?.click?.();
  }
}

function serrToolsHtml() {
  return `
    <button type="button" class="monwui-serr-manage-btn" data-serr-open-manager>${escapeHtml(L("serrManageRequests", "İstekleri Yönet"))}</button>
    <button type="button" class="monwui-serr-calendar-btn" data-serr-open-calendar title="${escapeHtml(L("serrCalendarTitle", "Arr Takvimi"))}">
      <i class="fas fa-calendar-alt" aria-hidden="true"></i>
      <span>${escapeHtml(L("serrCalendarButton", "Takvim"))}</span>
    </button>
  `;
}

export function ensureSerrNotificationsTab({ bindNotifTabButton } = {}) {
  if (!moduleEnabled()) {
    removeSerrNotificationsTab();
    return;
  }
  ensureSerrTabBadgeStyles();
  ensureSerrCalendarStyles();
  const tabs = document.querySelector("#jfNotifModal .jf-notif-tabs");
  const contentHost = document.querySelector("#jfNotifModal .jf-notif-content");
  if (!tabs || !contentHost) return;

  if (!tabs.querySelector('[data-tab="serr"]')) {
    const btn = document.createElement("button");
    btn.className = "jf-notif-tab";
    btn.setAttribute("data-tab", "serr");
    tabs.appendChild(btn);
    bindNotifTabButton?.(btn);
  }
  renderSerrTabBadge();

  let pane = contentHost.querySelector('.jf-notif-tab-content[data-tab="serr"]');
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "jf-notif-tab-content";
    pane.setAttribute("data-tab", "serr");
    pane.style.display = "none";
    pane.innerHTML = `
      <div class="monwui-serr-notif-tools">
        ${serrToolsHtml()}
      </div>
      <div class="monwui-serr-notif-host" id="monwuiSerrNotifHost"></div>
    `;
    contentHost.appendChild(pane);
  }

  let tools = pane.querySelector(".monwui-serr-notif-tools");
  if (!tools) {
    tools = document.createElement("div");
    tools.className = "monwui-serr-notif-tools";
    pane.prepend(tools);
  }
  if (!tools.querySelector("[data-serr-open-manager]") || !tools.querySelector("[data-serr-open-calendar]")) {
    tools.innerHTML = serrToolsHtml();
  }

  if (!pane.querySelector("#monwuiSerrNotifHost")) {
    const host = document.createElement("div");
    host.className = "monwui-serr-notif-host";
    host.id = "monwuiSerrNotifHost";
    pane.appendChild(host);
  }

  bindSerrManagerButtons(pane);
  bindSerrCalendarButtons(pane);

  if (!document.querySelector("#jfNotifModal .jf-notif-tab.active")) {
    document.querySelector("#jfNotifModal .jf-notif-tab")?.click?.();
  }
}

export function renderSerrNotifications() {
  if (!moduleEnabled()) {
    removeSerrNotificationsTab();
    return;
  }
  ensureSerrProgressStyles();
  const host = document.getElementById("monwuiSerrNotifHost");
  if (!host) return;

  if (!cachedRequests.length) {
    host.innerHTML = `<div class="monwui-serr-empty">${escapeHtml(L("serrNoRequests", "Aktif Seerr isteği yok."))}</div>`;
    return;
  }

  host.innerHTML = `
    <ul class="monwui-serr-notif-list">
      ${cachedRequests.map((req) => renderRequest(req, lastIsAdmin)).join("")}
    </ul>
  `;

  host.querySelectorAll("[data-serr-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await runAction(btn, () => approveSerrRequestWithArrFallback(btn.getAttribute("data-serr-approve")));
    });
  });

  host.querySelectorAll("[data-serr-decline]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await runAction(btn, () => declineSerrRequest(btn.getAttribute("data-serr-decline")));
    });
  });

  hydrateRequestPosters(host);
}

function bindSerrManagerButtons(scope = document) {
  scope.querySelectorAll?.("[data-serr-open-manager]").forEach((button) => {
    if (button.__monwuiSerrManagerBound) return;
    button.__monwuiSerrManagerBound = true;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openSerrRequestsModal();
    });
  });
}

function bindSerrCalendarButtons(scope = document) {
  scope.querySelectorAll?.("[data-serr-open-calendar]").forEach((button) => {
    if (button.__monwuiSerrCalendarBound) return;
    button.__monwuiSerrCalendarBound = true;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openSerrCalendarModal();
    });
  });
}

function renderRequest(req, isAdmin) {
  const status = text(req?.Status || req?.status).toLowerCase();
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const requestedBy = req?.requestedBy?.userName || req?.RequestedBy?.UserName || "";
  const error = text(req?.Error || req?.error);
  const time = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc || req?.CreatedAtUtc || req?.createdAtUtc);
  const canApprove = isAdmin && status === "pending";

  return `
    <li class="monwui-serr-notif-item">
      <div class="monwui-serr-notif-top">
        ${renderPoster(req, "compact")}
        <div class="monwui-serr-notif-main">
          <div class="monwui-serr-title-row">
            <span class="monwui-serr-status ${escapeHtml(status || "pending")}">${escapeHtml(statusLabel(status))}</span>
            ${renderRequest4KBadge(req)}
            ${time ? `<span class="monwui-serr-state">${escapeHtml(time)}</span>` : ""}
          </div>
          <div class="monwui-serr-name">${escapeHtml(title)}</div>
          <div class="monwui-serr-meta">${escapeHtml(mediaLabel(req))}</div>
          ${renderDownloadProgressHost(req)}
          ${requestedBy ? `<div class="monwui-serr-state">${escapeHtml(L("serrRequestedBy", "İsteyen"))}: ${escapeHtml(requestedBy)}</div>` : ""}
          ${error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : ""}
        </div>
        ${canApprove ? `
          <div class="monwui-serr-notif-actions">
            <button type="button" class="monwui-serr-mini-btn primary" data-serr-approve="${escapeHtml(req.Id || req.id)}">${escapeHtml(L("serrApprove", "Onayla"))}</button>
            <button type="button" class="monwui-serr-mini-btn" data-serr-decline="${escapeHtml(req.Id || req.id)}">${escapeHtml(L("serrDecline", "Reddet"))}</button>
          </div>
        ` : ""}
      </div>
    </li>
  `;
}

function ensureSerrRequestsModal() {
  ensureSerrProgressStyles();
  let modal = document.getElementById("monwuiSerrRequestsModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "monwuiSerrRequestsModal";
  modal.className = "monwui-serr-requests-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="monwui-serr-requests-backdrop" data-serr-manager-close></div>
    <div class="monwui-serr-requests-dialog" role="dialog" aria-modal="true">
      <div class="monwui-serr-requests-head">
        <div class="monwui-serr-requests-title">${escapeHtml(L("serrRequestsModalTitle", "Seerr İstek Yönetimi"))}</div>
        <div class="monwui-serr-requests-actions">
          <button type="button" class="monwui-serr-requests-switch monwui-serr-mini-btn" data-serr-manager-open-calendar title="${escapeHtml(L("serrCalendarTitle", "Arr Takvimi"))}" aria-label="${escapeHtml(L("serrCalendarTitle", "Arr Takvimi"))}">
            <i class="fas fa-calendar-alt" aria-hidden="true"></i>
            <span>${escapeHtml(L("serrCalendarButton", "Takvim"))}</span>
          </button>
          <button type="button" class="monwui-serr-requests-close" data-serr-manager-close aria-label="${escapeHtml(L("close", "Kapat"))}">×</button>
        </div>
      </div>
      <div class="monwui-serr-requests-body"></div>
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-serr-manager-open-calendar]")) {
      switchToSerrCalendarModal();
      return;
    }
    if (event.target?.closest?.("[data-serr-manager-close]")) {
      closeSerrRequestsModal();
    }
  });
  document.body.appendChild(modal);
  return modal;
}

function closeSerrRequestsModal() {
  const modal = document.getElementById("monwuiSerrRequestsModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  scheduleNextPoll(nextPollDelay());
}

async function openSerrRequestsModal() {
  const modal = ensureSerrRequestsModal();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const body = modal.querySelector(".monwui-serr-requests-body");
  if (body) {
    body.innerHTML = `<div class="monwui-serr-loading">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;
  }
  const data = await refreshSerrRequestManager({ render: false, showError: true });
  if (data) renderSerrRequestManager();
  scheduleNextPoll(nextPollDelay());
}

function switchToSerrCalendarModal() {
  closeSerrRequestsModal();
  void openSerrCalendarModal();
}

async function refreshSerrRequestManager({ render = false, showError = render } = {}) {
  if (managerRefreshPromise) {
    const data = await managerRefreshPromise;
    if (render && data) renderSerrRequestManager();
    if (showError && !data) {
      const body = document.querySelector("#monwuiSerrRequestsModal .monwui-serr-requests-body");
      if (body) body.innerHTML = `<div class="monwui-serr-error">${escapeHtml(L("serrRequestFailed", "İşlem tamamlanamadı."))}</div>`;
    }
    return data;
  }
  managerRefreshPromise = (async () => {
    const modal = ensureSerrRequestsModal();
    const body = modal.querySelector(".monwui-serr-requests-body");
    if (render && body) {
      body.innerHTML = `<div class="monwui-serr-loading">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;
    }

    try {
      const data = await listSerrRequests({ includeHistory: true });
      managerRequests = normalizeManagerRequests(data?.requests);
      managerIsAdmin = data?.isAdmin === true;
    } catch (error) {
      managerRequests = [];
      managerIsAdmin = false;
      if (showError && body) {
        body.innerHTML = `<div class="monwui-serr-error">${escapeHtml(error?.message || L("serrRequestFailed", "İşlem tamamlanamadı."))}</div>`;
      }
      return null;
    } finally {
      managerRefreshPromise = null;
    }

    if (render) renderSerrRequestManager();
    return { requests: managerRequests, isAdmin: managerIsAdmin };
  })();
  return managerRefreshPromise;
}

function searchText(value) {
  const clean = text(value);
  if (!clean) return "";
  const normalized = clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  try {
    return normalized.toLocaleLowerCase(getEffectiveLanguage?.() || undefined);
  } catch {
    return normalized.toLowerCase();
  }
}

function managerRequestId(req) {
  return text(req?.Id || req?.id);
}

function managerTotalPages() {
  return Math.max(1, Math.ceil(managerRequests.length / MANAGER_REQUESTS_PAGE_SIZE));
}

function clampManagerPage(page = managerPage) {
  const n = Math.floor(Number(page) || 1);
  return Math.min(Math.max(1, n), managerTotalPages());
}

function managerVisibleRequests() {
  managerPage = clampManagerPage(managerPage);
  const start = (managerPage - 1) * MANAGER_REQUESTS_PAGE_SIZE;
  return managerRequests.slice(start, start + MANAGER_REQUESTS_PAGE_SIZE);
}

function managerRequestPageForId(id) {
  const clean = text(id);
  if (!clean) return 0;
  const index = managerRequests.findIndex((req) => managerRequestId(req) === clean);
  return index >= 0 ? Math.floor(index / MANAGER_REQUESTS_PAGE_SIZE) + 1 : 0;
}

function managerPageNumbers(current, total) {
  if (total <= 5) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = [1, current - 1, current, current + 1, total]
    .filter((page) => page >= 1 && page <= total)
    .filter((page, index, list) => list.indexOf(page) === index)
    .sort((a, b) => a - b);
  const output = [];
  pages.forEach((page, index) => {
    if (index > 0 && page - pages[index - 1] > 1) output.push("gap");
    output.push(page);
  });
  return output;
}

function renderManagerPagination() {
  if (!managerRequests.length) return "";
  const total = managerTotalPages();
  const current = clampManagerPage(managerPage);
  const start = (current - 1) * MANAGER_REQUESTS_PAGE_SIZE + 1;
  const end = Math.min(managerRequests.length, current * MANAGER_REQUESTS_PAGE_SIZE);
  const previousLabel = L("previous", "Önceki");
  const nextLabel = L("next", "Sonraki");
  const pageLabel = L("page", "Sayfa");
  const pageButtons = managerPageNumbers(current, total).map((page) => {
    if (page === "gap") return `<span class="monwui-serr-manager-page-gap" aria-hidden="true">...</span>`;
    const isCurrent = page === current;
    return `
      <button type="button" class="monwui-serr-manager-page-btn ${isCurrent ? "active" : ""}" data-serr-manager-page="${escapeHtml(page)}" ${isCurrent ? `aria-current="page"` : ""} aria-label="${escapeHtml(`${pageLabel} ${page}`)}">
        ${escapeHtml(page)}
      </button>
    `;
  }).join("");

  return `
    <div class="monwui-serr-requests-pagination" data-serr-manager-pagination>
      <div class="monwui-serr-requests-page-summary">
        <span>${escapeHtml(`${start}-${end}`)}</span>
        <span aria-hidden="true">/</span>
        <b>${escapeHtml(String(managerRequests.length))}</b>
      </div>
      ${total > 1 ? `
        <div class="monwui-serr-requests-page-controls">
          <button type="button" class="monwui-serr-manager-page-btn icon" data-serr-manager-page="prev" ${current <= 1 ? "disabled" : ""} aria-label="${escapeHtml(previousLabel)}">
            <i class="fas fa-chevron-left" aria-hidden="true"></i>
          </button>
          ${pageButtons}
          <button type="button" class="monwui-serr-manager-page-btn icon" data-serr-manager-page="next" ${current >= total ? "disabled" : ""} aria-label="${escapeHtml(nextLabel)}">
            <i class="fas fa-chevron-right" aria-hidden="true"></i>
          </button>
        </div>
      ` : ""}
    </div>
  `;
}

function bindManagerPagination(scope = document) {
  scope.querySelectorAll?.("[data-serr-manager-page]").forEach((button) => {
    if (button.__monwuiSerrManagerPageBound) return;
    button.__monwuiSerrManagerPageBound = true;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      const action = text(button.getAttribute("data-serr-manager-page"));
      const nextPage = action === "prev"
        ? managerPage - 1
        : (action === "next" ? managerPage + 1 : Number(action));
      const clamped = clampManagerPage(nextPage);
      if (clamped === managerPage) return;
      managerPage = clamped;
      renderSerrRequestManager();
      requestAnimationFrame(() => {
        const body = document.querySelector("#monwuiSerrRequestsModal .monwui-serr-requests-body");
        body?.querySelector?.(".monwui-serr-requests-list")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      });
    });
  });
}

function syncManagerPagination(scope = document) {
  const host = scope.querySelector?.("[data-serr-manager-pagination]");
  const html = renderManagerPagination();
  if (host) {
    if (html) {
      host.outerHTML = html;
      bindManagerPagination(scope);
    } else {
      host.remove();
    }
    return;
  }
  if (!html) return;
  const list = scope.querySelector?.(".monwui-serr-requests-list");
  list?.insertAdjacentHTML?.("afterend", html);
  bindManagerPagination(scope);
}

function managerRequestKey(req) {
  const id = requestMediaId(req);
  return id > 0 ? `${requestMediaType(req)}:${id}` : "";
}

function resultKey(result) {
  const mediaType = resultMediaType(result);
  const id = Number(result?.id || result?.tmdbId || result?.tmdb_id || 0);
  return mediaType && Number.isFinite(id) && id > 0 ? `${mediaType}:${Math.floor(id)}` : "";
}

function managerRequestForResult(result) {
  const key = resultKey(result);
  if (!key) return null;
  return managerRequests.find((req) => managerRequestKey(req) === key) || null;
}

function managerRequestDomTitle(req) {
  const id = managerRequestId(req);
  if (!id) return "";
  const cards = Array.from(document.querySelectorAll("#monwuiSerrRequestsModal [data-serr-request-id]"));
  const card = cards.find((node) => text(node.getAttribute("data-serr-request-id")) === id);
  return text(card?.querySelector?.(".monwui-serr-request-name")?.textContent);
}

function managerRequestDisplayTitle(req) {
  const requestId = Number(req?.SerrRequestId || req?.serrRequestId || 0);
  const direct = text(
    readFirst(req, "Title", "title", "Name", "name", "MediaTitle", "mediaTitle", "media_title", "OriginalTitle", "originalTitle", "original_title", "OriginalName", "originalName", "original_name")
  );
  if (direct && !isGeneratedSerrTitle(direct, { SerrRequestId: requestId })) return direct;

  const cachedTitle = metadataTitle(metadataCache.get(posterCacheKey(req)));
  if (cachedTitle) return cachedTitle;

  const domTitle = managerRequestDomTitle(req);
  if (domTitle && !isGeneratedSerrTitle(domTitle, { SerrRequestId: requestId })) return domTitle;

  return direct || text(req?.Title || req?.title, L("serrUntitled", "Content"));
}

function addManagerRequestMatch(output, seen, req) {
  const id = managerRequestId(req) || managerRequestKey(req);
  if (!id || seen.has(id)) return;
  seen.add(id);
  output.push(req);
}

function managerRequestSearchBlob(req) {
  const requestedBy = req?.requestedBy?.userName || req?.RequestedBy?.UserName || "";
  const cachedTitle = metadataTitle(metadataCache.get(posterCacheKey(req)));
  const domTitle = managerRequestDomTitle(req);
  return [
    managerRequestDisplayTitle(req),
    cachedTitle,
    domTitle,
    readFirst(req, "Title", "title", "Name", "name", "MediaTitle", "mediaTitle", "media_title", "OriginalTitle", "originalTitle", "original_title", "OriginalName", "originalName", "original_name"),
    mediaLabel(req),
    statusLabel(req?.Status || req?.status),
    req?.MediaId,
    req?.mediaId,
    req?.SerrRequestId ? `Seerr #${req.SerrRequestId}` : "",
    req?.serrRequestId ? `Seerr #${req.serrRequestId}` : "",
    requestedBy
  ].filter(Boolean).join(" ");
}

function managerRequestSearchMatches(query, catalogResults = managerSearchState.results, limit = 10) {
  const needle = searchText(query);
  if (needle.length < 2) return [];
  const output = [];
  const seen = new Set();

  for (const req of managerRequests) {
    if (!searchText(managerRequestSearchBlob(req)).includes(needle)) continue;
    addManagerRequestMatch(output, seen, req);
    if (output.length >= limit) return output;
  }

  const catalogKeys = new Set(
    (Array.isArray(catalogResults) ? catalogResults : [])
      .map((result) => resultKey(result))
      .filter(Boolean)
  );
  if (!catalogKeys.size) return output;

  for (const req of managerRequests) {
    const key = managerRequestKey(req);
    if (!key || !catalogKeys.has(key)) continue;
    addManagerRequestMatch(output, seen, req);
    if (output.length >= limit) break;
  }

  return output;
}

function renderManagerSearchShell() {
  const query = text(managerSearchState.query);
  const resultsHtml = managerSearchResultsHtml();
  return `
    <div class="monwui-serr-manager-search">
      <div class="monwui-serr-manager-searchbar">
        <i class="fas fa-search" aria-hidden="true"></i>
        <input
          class="monwui-serr-manager-search-input"
          data-serr-manager-search-input
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="${escapeHtml(L("serrManagerSearchPlaceholder", "Search movies, series, or boxsets"))}"
          value="${escapeHtml(query)}">
        <button type="button" class="monwui-serr-manager-search-run" data-serr-manager-search-run ${managerSearchState.loading ? "disabled" : ""}>
          <i class="fas fa-search" aria-hidden="true"></i><span>${escapeHtml(L("search", "Search"))}</span>
        </button>
      </div>
      <div class="monwui-serr-manager-results" data-serr-manager-search-results ${resultsHtml ? "" : "hidden"}>
        ${resultsHtml}
      </div>
    </div>
  `;
}

function managerSearchResultsHtml() {
  const query = text(managerSearchState.query);
  if (query && query.length < 2) {
    return `<div class="monwui-serr-empty">${escapeHtml(L("serrSearchHint", "Type at least 2 characters to search."))}</div>`;
  }
  if (!query) return "";

  const requestMatches = managerRequestSearchMatches(query);
  const blocks = [];
  if (requestMatches.length) {
    blocks.push(`
      <div class="monwui-serr-manager-result-section">
        <div class="monwui-serr-manager-section-title">${escapeHtml(L("serrManagerRequestedSection", "Existing requests"))}</div>
        ${requestMatches.map((req, index) => renderManagerRequestedSearchResult(req, index)).join("")}
      </div>
    `);
  }
  if (managerSearchState.loading) {
    blocks.push(`<div class="monwui-serr-loading">${escapeHtml(L("loadingText", "Loading..."))}</div>`);
  } else if (managerSearchState.error) {
    blocks.push(`<div class="monwui-serr-error">${escapeHtml(managerSearchState.error)}</div>`);
  }
  if (managerSearchState.results.length) {
    blocks.push(`
      <div class="monwui-serr-manager-result-section">
        <div class="monwui-serr-manager-section-title">${escapeHtml(L("serrManagerCatalogSection", "Seerr & Arr results"))}</div>
        ${managerSearchState.results.map((result, index) => renderManagerSearchResult(result, index)).join("")}
      </div>
    `);
  }
  if (!blocks.length && managerSearchState.searched) {
    return `<div class="monwui-serr-empty">${escapeHtml(L("serrNoResults", "No results found in Seerr & Arr."))}</div>`;
  }
  return blocks.join("");
}

function renderManagerRequestedSearchResult(req, index) {
  const id = managerRequestId(req);
  const status = text(req?.Status || req?.status).toLowerCase() || "pending";
  const title = managerRequestDisplayTitle(req);
  const requestedBy = req?.requestedBy?.userName || req?.RequestedBy?.UserName || "";
  const updated = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc || req?.CreatedAtUtc || req?.createdAtUtc);
  const meta = [mediaLabel(req), statusLabel(status), requestedBy, updated].filter(Boolean).join(" • ");
  return `
    <article class="monwui-serr-manager-result requested">
      ${renderPoster(req, "monwui-serr-manager-result-poster")}
      <div class="monwui-serr-manager-result-content">
        <div class="monwui-serr-manager-result-name">${escapeHtml(title)}</div>
        <div class="monwui-serr-manager-result-meta">${escapeHtml(meta)}</div>
      </div>
      <button type="button" class="monwui-serr-manager-result-btn" data-serr-manager-request-match="${escapeHtml(id)}" data-serr-manager-request-index="${escapeHtml(index)}" ${id ? "" : "disabled"}>
        <i class="fas fa-eye" aria-hidden="true"></i>
        <span>${escapeHtml(L("serrManagerShowRequest", "Show request"))}</span>
      </button>
    </article>
  `;
}

function renderManagerSearchResult(result, index) {
  const mediaType = resultMediaType(result);
  const title = resultTitle(result);
  const poster = resultPosterUrl(result);
  const overview = text(result?.overview || result?.Overview);
  const existingRequest = managerRequestForResult(result);
  const existingRequestId = managerRequestId(existingRequest);
  const fallback = mediaType === "tv"
    ? L("serrTv", "Series")
    : (mediaType === "collection" ? L("boxset", "Collection") : L("serrMovie", "Movie"));
  return `
    <article class="monwui-serr-manager-result ${existingRequest ? "requested" : ""}">
      <div class="monwui-serr-manager-result-poster">
        ${poster ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">` : `<span>${escapeHtml(fallback)}</span>`}
      </div>
      <div class="monwui-serr-manager-result-content">
        <div class="monwui-serr-manager-result-name">${escapeHtml(title)}</div>
        <div class="monwui-serr-manager-result-meta">${escapeHtml(resultMeta(result))}</div>
        ${overview ? `<div class="monwui-serr-manager-result-overview">${escapeHtml(overview)}</div>` : ""}
      </div>
      ${existingRequestId ? `
        <button type="button" class="monwui-serr-manager-result-btn" data-serr-manager-request-match="${escapeHtml(existingRequestId)}">
          <i class="fas fa-eye" aria-hidden="true"></i>
          <span>${escapeHtml(L("serrManagerShowRequest", "Show request"))}</span>
        </button>
      ` : `
        <button type="button" class="monwui-serr-manager-result-btn" data-serr-manager-result-request="${escapeHtml(index)}">
          <i class="fas ${mediaType === "collection" ? "fa-layer-group" : "fa-paper-plane"}" aria-hidden="true"></i>
          <span>${escapeHtml(L("serrRequestButton", "Request"))}</span>
        </button>
      `}
    </article>
  `;
}

function renderManagerSearchResults(scope = document) {
  const host = scope.querySelector?.("[data-serr-manager-search-results]");
  const html = managerSearchResultsHtml();
  if (host) {
    host.innerHTML = html;
    if (html) host.removeAttribute("hidden");
    else host.setAttribute("hidden", "hidden");
    bindManagerSearchResultButtons(host);
  }

  const query = text(managerSearchState.query);
  const input = scope.querySelector?.("[data-serr-manager-search-input]");
  if (input && input.value !== query && document.activeElement !== input) input.value = query;
  const run = scope.querySelector?.("[data-serr-manager-search-run]");
  if (run) run.disabled = managerSearchState.loading;
}

function bindManagerSearch(scope = document) {
  const input = scope.querySelector?.("[data-serr-manager-search-input]");
  const run = scope.querySelector?.("[data-serr-manager-search-run]");

  if (input && !input.__monwuiSerrManagerSearchBound) {
    input.__monwuiSerrManagerSearchBound = true;
    input.addEventListener("input", () => {
      managerSearchState.query = text(input.value);
      managerSearchState.error = "";
      if (managerSearchState.query.length < 2) {
        managerSearchState.results = [];
        managerSearchState.loading = false;
        managerSearchState.searched = false;
        managerSearchSeq += 1;
        renderManagerSearchResults(scope);
        return;
      }
      managerSearchState.results = [];
      managerSearchState.searched = false;
      clearTimeout(managerSearchTimer);
      managerSearchTimer = setTimeout(() => runManagerSearch(scope).catch(() => {}), 350);
      renderManagerSearchResults(scope);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      clearTimeout(managerSearchTimer);
      runManagerSearch(scope).catch(() => {});
    });
  }

  if (run && !run.__monwuiSerrManagerSearchBound) {
    run.__monwuiSerrManagerSearchBound = true;
    run.addEventListener("click", () => {
      clearTimeout(managerSearchTimer);
      runManagerSearch(scope).catch(() => {});
    });
  }

  bindManagerSearchResultButtons(scope);
}

function bindManagerSearchResultButtons(scope = document) {
  scope.querySelectorAll?.("[data-serr-manager-request-match]").forEach((button) => {
    if (button.__monwuiSerrManagerMatchBound) return;
    button.__monwuiSerrManagerMatchBound = true;
    button.addEventListener("click", () => {
      focusManagerRequestCard(button.getAttribute("data-serr-manager-request-match"));
    });
  });
  scope.querySelectorAll?.("[data-serr-manager-result-request]").forEach((button) => {
    if (button.__monwuiSerrManagerResultBound) return;
    button.__monwuiSerrManagerResultBound = true;
    button.addEventListener("click", () => {
      const index = Number(button.getAttribute("data-serr-manager-result-request"));
      const result = managerSearchState.results[index];
      if (result) requestManagerSearchResult(button, result).catch(() => {});
    });
  });
}

function managerCardHighlightReady(card) {
  if (!card?.isConnected) return true;
  const rect = card.getBoundingClientRect();
  const root = card.closest?.(".monwui-serr-requests-body");
  const rootRect = root?.getBoundingClientRect?.() || {
    top: 0,
    left: 0,
    right: window.innerWidth || document.documentElement.clientWidth || 0,
    bottom: window.innerHeight || document.documentElement.clientHeight || 0
  };
  if (rect.width <= 0 || rect.height <= 0) return false;
  const visibleWidth = Math.max(0, Math.min(rect.right, rootRect.right) - Math.max(rect.left, rootRect.left));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top));
  const centerY = rect.top + rect.height / 2;
  return visibleWidth >= rect.width * 0.5 &&
    visibleHeight >= Math.min(rect.height * 0.55, 160) &&
    centerY >= rootRect.top + 20 &&
    centerY <= rootRect.bottom - 20;
}

function waitForManagerCardHighlightReady(card, timeout = 1500) {
  const clock = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
  const startedAt = clock();
  return new Promise((resolve) => {
    const tick = () => {
      const now = clock();
      if (!card?.isConnected || managerCardHighlightReady(card) || now - startedAt >= timeout) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function focusManagerRequestCard(id) {
  const clean = text(id);
  if (!clean) return;
  const cards = Array.from(document.querySelectorAll("#monwuiSerrRequestsModal [data-serr-request-id]"));
  const card = cards.find((node) => text(node.getAttribute("data-serr-request-id")) === clean);
  if (!card) {
    const targetPage = managerRequestPageForId(clean);
    if (!targetPage) return;
    managerPage = targetPage;
    renderSerrRequestManager();
    requestAnimationFrame(() => { void focusManagerRequestCard(clean); });
    return;
  }
  const token = `${Date.now()}:${Math.random()}`;
  card.__monwuiSerrFocusToken = token;
  try { card.focus({ preventScroll: true }); } catch {}
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  await waitForManagerCardHighlightReady(card);
  if (!card.isConnected || card.__monwuiSerrFocusToken !== token) return;
  card.classList.remove("monwui-serr-request-card-hit");
  void card.offsetWidth;
  card.classList.add("monwui-serr-request-card-hit");
  clearTimeout(card.__monwuiSerrHitTimer);
  card.__monwuiSerrHitTimer = setTimeout(() => {
    card.classList.remove("monwui-serr-request-card-hit");
  }, 2200);
}

async function runManagerSearch(scope = document) {
  const body = scope.closest?.(".monwui-serr-requests-body") || scope;
  const input = body.querySelector?.("[data-serr-manager-search-input]");
  const query = input ? text(input.value) : text(managerSearchState.query);
  managerSearchState.query = query;

  if (query.length < 2) {
    managerSearchSeq += 1;
    managerSearchState.results = [];
    managerSearchState.loading = false;
    managerSearchState.searched = query.length > 0;
    managerSearchState.error = "";
    renderManagerSearchResults(body);
    return;
  }

  const seq = managerSearchSeq + 1;
  managerSearchSeq = seq;
  managerSearchState.loading = true;
  managerSearchState.searched = true;
  managerSearchState.error = "";
  managerSearchState.results = [];
  renderManagerSearchResults(body);

  try {
    const access = await getSerrAccess();
    if (seq !== managerSearchSeq) return;
    if (!access?.enabled) {
      managerSearchState.error = L("serrDisabled", "Seerr integration is disabled.");
      managerSearchState.results = [];
      return;
    }

    const language = access?.settings?.defaultLanguage || serrLanguage();
    const tmdbSearch = parseManagerTmdbSearch(query);
    let results = [];

    if (tmdbSearch) {
      const [tmdbResults, textData, collectionData] = await Promise.all([
        searchManagerSerrByTmdbId({ ...tmdbSearch, language }),
        searchSerr(query, { language }).catch(() => null),
        searchSerrCollections(query, { language }).catch(() => null)
      ]);
      results = mergeManagerSearchResults(
        tmdbResults,
        normalizeCollectionSearchResults(collectionData),
        Array.isArray(textData?.results) ? textData.results : []
      );
    } else {
      const [page1, page2, collections] = await Promise.all([
        searchSerr(query, { page: 1, language }),
        searchSerr(query, { page: 2, language }),
        searchSerrCollections(query, { language }).catch(() => null)
      ]);
      results = mergeManagerSearchResults(
        normalizeCollectionSearchResults(collections),
        Array.isArray(page1?.results) ? page1.results : [],
        Array.isArray(page2?.results) ? page2.results : []
      );
    }

    if (seq !== managerSearchSeq) return;
    managerSearchState.results = balancedManagerSearchResults(results);
  } catch (error) {
    if (seq !== managerSearchSeq) return;
    managerSearchState.results = [];
    managerSearchState.error = error?.message || L("serrSearchFailed", "Seerr & Arr search failed.");
  } finally {
    if (seq === managerSearchSeq) {
      managerSearchState.loading = false;
      renderManagerSearchResults(body);
    }
  }
}

async function requestManagerSearchResult(button, result) {
  if (!button || button.disabled) return;
  const mediaType = resultMediaType(result);
  const id = Number(result?.id || result?.tmdbId || result?.tmdb_id || 0);
  if (!mediaType || !Number.isFinite(id) || id <= 0) {
    notify(L("serrTmdbMissing", "TMDb ID not found. Continue with Seerr & Arr search."), "error");
    return;
  }

  const old = button.innerHTML;
  try {
    button.disabled = true;
    if (mediaType === "collection") {
      button.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>${escapeHtml(L("loadingText", "Loading..."))}</span>`;
      const response = await openSerrCollectionRequestModal(result, { source: "seerr-manager" });
      if (response?.submitted || response?.empty) {
        const data = await refreshSerrRequestManager({ render: false, showError: false });
        if (data) renderSerrRequestManager();
      }
      return;
    }

    const tvdbId = Number(result?.tvdbId || result?.tvdb_id || result?.TvdbId || 0);
    const response = await requestSerrFromItem(managerSearchResultItem(result), {
      source: "seerr-manager",
      mediaType,
      mediaId: Math.floor(id),
      tvdbId: Number.isFinite(tvdbId) && tvdbId > 0 ? Math.floor(tvdbId) : undefined,
      title: resultTitle(result),
      posterUrl: resultPosterUrl(result, "w342"),
      requestAllSeasons: mediaType === "tv",
      onBeforeSubmit: () => {
        button.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>${escapeHtml(L("serrRequestSending", "Sending..."))}</span>`;
      }
    });

    if (response?.cancelled) return;
    const data = await refreshSerrRequestManager({ render: false, showError: false });
    if (data) renderSerrRequestManager();
  } catch (error) {
    notify(error?.message || L("serrRequestFailed", "Unable to create the request."), "error");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = old;
    }
  }
}

function renderSerrRequestManager() {
  ensureSerrProgressStyles();
  const modal = ensureSerrRequestsModal();
  const body = modal.querySelector(".monwui-serr-requests-body");
  if (!body) return;
  const visibleRequests = managerVisibleRequests();

  body.innerHTML = `
    ${renderManagerSearchShell()}
    ${managerRequests.length
      ? `
        <div class="monwui-serr-requests-list" data-serr-manager-list>
          ${visibleRequests.map((req) => renderManagerRequest(req, managerIsAdmin)).join("")}
        </div>
        ${renderManagerPagination()}
      `
      : `<div class="monwui-serr-empty">${escapeHtml(L("serrNoRequestHistory", "Seerr istek geçmişi yok."))}</div>`}
  `;

  bindManagerSearch(body);
  bindManagerPagination(body);

  body.querySelectorAll("[data-serr-manager-approve]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => approveSerrRequestWithArrFallback(btn.getAttribute("data-serr-manager-approve"))));
  });
  body.querySelectorAll("[data-serr-manager-decline]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => declineSerrRequest(btn.getAttribute("data-serr-manager-decline"))));
  });
  body.querySelectorAll("[data-serr-manager-withdraw]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => withdrawSerrRequest(btn.getAttribute("data-serr-manager-withdraw"))));
  });

  hydrateRequestPosters(body);
}

function renderManagerRequest(req, isAdmin) {
  const id = text(req?.Id || req?.id);
  const status = text(req?.Status || req?.status).toLowerCase() || "pending";
  const requestKey = posterCacheKey(req);
  const metadata = requestKey ? metadataCache.get(requestKey) : null;
  const mediaType = requestMediaType(req);
  const media = mediaLabel(req);
  const typeBadge = mediaTypeBadgeLabel(mediaType);
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const requestedBy = req?.requestedBy?.userName || req?.RequestedBy?.UserName || "";
  const created = formatTime(req?.CreatedAtUtc || req?.createdAtUtc);
  const updated = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc);
  const completed = formatTime(req?.CompletedAtUtc || req?.completedAtUtc);
  const error = text(req?.Error || req?.error);
  const canApprove = isAdmin && (status === "pending" || status === "failed");
  const canDecline = isAdmin && (status === "pending" || status === "failed");
  const canWithdraw = id && (
    (isAdmin && status !== "withdrawn" && status !== "completed" && status !== "available") ||
    (!isAdmin && status === "pending")
  );
  const detailsHtml = [
    renderRequestInfoChip(L("created", "Oluşturuldu"), created),
    renderRequestInfoChip(L("updated", "Güncellendi"), updated),
    renderRequestInfoChip(L("serrStatusCompleted", "Tamamlandı"), completed),
    renderRequestInfoChip("TMDB", text(req?.MediaId || req?.mediaId, "-")),
    renderRequestInfoChip("Seerr", req?.SerrRequestId || req?.serrRequestId ? `#${req?.SerrRequestId || req?.serrRequestId}` : "")
  ].filter(Boolean).join("");
  const actionsHtml = [
    canApprove ? `<button type="button" class="monwui-serr-mini-btn primary" data-serr-manager-approve="${escapeHtml(id)}"><i class="fas fa-check" aria-hidden="true"></i><span>${escapeHtml(L("serrApprove", "Onayla"))}</span></button>` : "",
    canDecline ? `<button type="button" class="monwui-serr-mini-btn" data-serr-manager-decline="${escapeHtml(id)}"><i class="fas fa-times" aria-hidden="true"></i><span>${escapeHtml(L("serrDecline", "Reddet"))}</span></button>` : "",
    canWithdraw ? `<button type="button" class="monwui-serr-mini-btn" data-serr-manager-withdraw="${escapeHtml(id)}"><i class="fas fa-undo" aria-hidden="true"></i><span>${escapeHtml(L("serrWithdraw", "Geri Çek"))}</span></button>` : ""
  ].filter(Boolean).join("");
  const detailsLabel = L("serrRequestDetails", "İstek Detayları");

  return `
    <section class="monwui-serr-request-card" tabindex="-1" data-serr-request-id="${escapeHtml(id)}" data-serr-request-status="${escapeHtml(status)}" data-serr-request-media-type="${escapeHtml(mediaType)}" ${requestKey ? `data-serr-request-key="${escapeHtml(requestKey)}"` : ""}>
      <div class="monwui-serr-request-main">
        ${renderPoster(req, "large", { ratingSlotHtml: renderRequestRatingSlot(req, metadata) })}
        <div class="monwui-serr-request-content">
          <div class="monwui-serr-title-row">
            <span class="monwui-serr-status ${escapeHtml(status)}" data-serr-status>${escapeHtml(statusLabel(status))}</span>
            ${renderRequest4KBadge(req)}
            <span class="monwui-serr-state" data-serr-updated ${updated ? "" : "hidden"}>${escapeHtml(updated)}</span>
          </div>
          ${renderRequestProviderLinks(req, metadata)}
          ${requestedBy ? `<div class="monwui-serr-state">${escapeHtml(L("serrRequestedBy", "İsteyen"))}: ${escapeHtml(requestedBy)}</div>` : ""}
          <div class="monwui-serr-request-name">${escapeHtml(title)}</div>
          <div class="monwui-serr-request-details-wrap">
            <button type="button" class="monwui-serr-request-details-toggle" aria-label="${escapeHtml(detailsLabel)}">
              <i class="fas fa-info-circle" aria-hidden="true"></i>
              <span>${escapeHtml(L("serrRequestDetailsButton", L("details", "Ayrıntılar")))}</span>
            </button>
            <div class="monwui-serr-request-details" role="group" aria-label="${escapeHtml(detailsLabel)}">
              ${detailsHtml}
            </div>
          </div>
          ${renderDownloadProgressHost(req)}
          ${actionsHtml ? `<div class="monwui-serr-request-actions">${actionsHtml}</div>` : ""}
        </div>
        ${renderBackdrop(req)}
        <div class="monwui-serr-request-meta monwui-serr-request-type-badge ${escapeHtml(mediaType)}" title="${escapeHtml(media)}">${escapeHtml(typeBadge)}</div>
      </div>
      <div data-serr-error-host>${error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : ""}</div>
    </section>
  `;
}

function updateVisibleSerrRequestManager() {
  ensureSerrProgressStyles();
  const modal = document.querySelector(".monwui-serr-requests-modal.open");
  const body = modal?.querySelector(".monwui-serr-requests-body");
  if (!body) return;

  const visibleRequests = managerVisibleRequests();
  const cards = Array.from(body.querySelectorAll("[data-serr-request-id]"));
  if (!cards.length) {
    if (managerRequests.length) renderSerrRequestManager();
    return;
  }
  if (cards.length !== visibleRequests.length) {
    renderSerrRequestManager();
    return;
  }

  const visibleIds = visibleRequests.map((req) => managerRequestId(req));
  const cardIds = cards.map((card) => text(card.getAttribute("data-serr-request-id")));
  if (visibleIds.some((id, index) => id !== cardIds[index])) {
    renderSerrRequestManager();
    return;
  }

  const requestsById = new Map(
    visibleRequests
      .map((req) => [text(req?.Id || req?.id), req])
      .filter(([id]) => id)
  );

  for (const card of cards) {
    const id = text(card.getAttribute("data-serr-request-id"));
    const req = requestsById.get(id);
    if (!req) continue;

    const status = text(req?.Status || req?.status).toLowerCase() || "pending";
    if (text(card.getAttribute("data-serr-request-status")) !== status) {
      renderSerrRequestManager();
      return;
    }
    const statusNode = card.querySelector("[data-serr-status]");
    if (statusNode) {
      statusNode.className = `monwui-serr-status ${status}`;
      statusNode.textContent = statusLabel(status);
    }

    const updated = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc);
    card.querySelectorAll("[data-serr-updated]").forEach((node) => {
      node.textContent = updated;
      if (updated) node.removeAttribute("hidden");
      else node.setAttribute("hidden", "");
    });

    const progressHost = card.querySelector("[data-serr-download-host]");
    if (progressHost) progressHost.innerHTML = renderDownloadProgress(req);

    const errorHost = card.querySelector("[data-serr-error-host]");
    if (errorHost) {
      const error = text(req?.Error || req?.error);
      errorHost.innerHTML = error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : "";
    }
  }

  syncManagerPagination(body);
  hydrateRequestPosters(body);
}

async function runManagerAction(button, fn) {
  if (!button || button.disabled) return;
  const old = button.innerHTML;
  try {
    button.disabled = true;
    button.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>${escapeHtml(L("loadingText", "Yükleniyor..."))}</span>`;
    await fn();
    await refresh({ render: true });
    const data = await refreshSerrRequestManager({ render: false, showError: true });
    if (data) renderSerrRequestManager();
    try { window.dispatchEvent(new CustomEvent("monwui:serr-notification-count-changed")); } catch {}
  } catch (error) {
    button.textContent = error?.message || L("serrRequestFailed", "İşlem tamamlanamadı.");
    setTimeout(() => {
      button.innerHTML = old;
      button.disabled = false;
    }, 1800);
  }
}

async function runAction(button, fn) {
  if (!button || button.disabled) return;
  const old = button.textContent;
  try {
    button.disabled = true;
    button.textContent = L("loadingText", "Yükleniyor...");
    await fn();
    await refresh({ render: true });
  } catch (error) {
    button.textContent = error?.message || L("serrRequestFailed", "İşlem tamamlanamadı.");
    setTimeout(() => { button.textContent = old; button.disabled = false; }, 1800);
    return;
  }
  button.disabled = false;
  button.textContent = old;
}

function isSerrPanelVisible() {
  const tab = document.querySelector('.jf-notif-tab.active[data-tab="serr"]');
  if (!tab) return false;
  const modal = tab.closest("#jfNotifModal");
  return !modal || modal.classList.contains("open");
}

function isSerrManagerVisible() {
  return document.querySelector(".monwui-serr-requests-modal.open") != null;
}

function hasActiveDownload(requests) {
  return (Array.isArray(requests) ? requests : []).some((req) => downloadInfo(req));
}

function shouldIncludePanelDownloads({ force = false } = {}) {
  if (!isSerrPanelVisible()) return false;
  if (hasActiveDownload(cachedRequests)) return true;
  if (force) return true;
  return (Date.now() - lastPanelDownloadRefreshAt) >= PANEL_DOWNLOAD_REFRESH_MIN_MS;
}

function nextPollDelay() {
  if (document.hidden) return BACKGROUND_POLL_MS;
  const visibleSurface = isSerrPanelVisible() || isSerrManagerVisible();
  if (visibleSurface && (hasActiveDownload(cachedRequests) || hasActiveDownload(managerRequests))) {
    return ACTIVE_DOWNLOAD_POLL_MS;
  }
  return visibleSurface ? OPEN_IDLE_POLL_MS : BACKGROUND_POLL_MS;
}

function syncNotificationsFromManager({ renderPanel = false } = {}) {
  applyNotificationData({ requests: managerRequests, isAdmin: managerIsAdmin }, { render: renderPanel });
}

async function refreshVisibleSerrSurfaces({ forcePanelRender = false } = {}) {
  const renderPanel = forcePanelRender || isSerrPanelVisible();
  if (isSerrManagerVisible()) {
    const data = await refreshSerrRequestManager({ render: false });
    if (data) {
      updateVisibleSerrRequestManager();
      syncNotificationsFromManager({ renderPanel });
      return data;
    }
  }

  return refresh({
    render: renderPanel,
    includeDownloads: shouldIncludePanelDownloads({ force: forcePanelRender })
  });
}

function scheduleNextPoll(delay = nextPollDelay()) {
  clearTimeout(pollTimer);
  if (!pollEnabled || !moduleEnabled()) return;
  pollTimer = setTimeout(() => {
    pollTimer = 0;
    if (document.hidden) {
      scheduleNextPoll();
      return;
    }
    refreshVisibleSerrSurfaces()
      .catch(() => {})
      .finally(() => scheduleNextPoll());
  }, Math.max(500, delay));
}

export function scheduleSerrNotificationsPoll() {
  if (!moduleEnabled()) {
    stopSerrNotificationsPoll();
    return;
  }
  pollEnabled = true;
  clearTimeout(pollTimer);
  refresh({ render: false }).finally(() => scheduleNextPoll());

  if (pollEventsBound) return;
  pollEventsBound = true;

  window.addEventListener("monwui:serr-requests-changed", () => {
    if (!pollEnabled || !moduleEnabled()) return;
    refreshVisibleSerrSurfaces({ forcePanelRender: true })
      .catch(() => {})
      .finally(() => scheduleNextPoll(ACTIVE_DOWNLOAD_POLL_MS));
  });
  window.addEventListener("focus", () => {
    if (!pollEnabled || !moduleEnabled()) return;
    refreshVisibleSerrSurfaces({ forcePanelRender: document.querySelector("#jfNotifModal.open") != null })
      .catch(() => {})
      .finally(() => scheduleNextPoll());
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pollEnabled && moduleEnabled()) {
      refreshVisibleSerrSurfaces()
        .catch(() => {})
        .finally(() => scheduleNextPoll());
    }
  });
}

export function stopSerrNotificationsPoll() {
  pollEnabled = false;
  clearTimeout(pollTimer);
  pollTimer = 0;
  const previousCount = cachedCount;
  cachedRequests = [];
  cachedCount = 0;
  removeSerrNotificationsTab();
  if (previousCount !== cachedCount) dispatchSerrCountChanged();
}
