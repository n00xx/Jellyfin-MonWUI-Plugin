import { getConfig } from "../config.js";
import { withServer } from "../jfUrl.js";
import { getEffectiveLanguage, getLanguageLabels } from "../../language/index.js";
import { showNotification } from "../player/ui/notification.js";
import { requestMovieFromArr } from "../arr/requestFallback.js";
import { createSerrRequest, getSerrAccess, getSerrCollectionDetails, getSerrMovieDetails, getSerrTvDetails, listSerrRequests, searchSerr, searchSerrCollections } from "./api.js";
import { openSerrCollectionRequestModal } from "./itemPageBridge.js";
import { ensureSerrStyles } from "./styles.js";

const SERR_IMAGE_BASE = "https://image.tmdb.org/t/p";
let modalSearchAbort = null;
let searchTimer = 0;

function cfg() {
  try { return getConfig?.() || {}; } catch { return {}; }
}

function moduleEnabled() {
  return cfg()?.enableSerrArrIntegrationModule !== false;
}

function labels() {
  try {
    const activeLabels = getLanguageLabels?.(getEffectiveLanguage?.()) || {};
    if (Object.keys(activeLabels).length) return activeLabels;
  } catch {}
  return cfg()?.languageLabels || {};
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

function providerId(item, ...keys) {
  const ids = item?.ProviderIds || item?.providerIds || {};
  for (const key of keys) {
    const value =
      item?.[key] ??
      ids?.[key] ??
      ids?.[key?.toUpperCase?.()] ??
      ids?.[key?.toLowerCase?.()];
    const clean = text(value);
    if (clean) return clean;
  }
  return "";
}

function normalizeItemType(item) {
  const type = text(item?.Type || item?.type || item?.ItemType || item?.itemType).toLowerCase();
  if (["series", "season", "episode", "tv", "show"].includes(type)) return "tv";
  if (["movie", "trailer"].includes(type) || item?.__monwuiVirtualTrailer === true) return "movie";
  return "";
}

export function accessHasSerr(access) {
  return access?.serrEnabled !== false && access?.enabled === true;
}

function access4KEnabled(access) {
  return access?.settings?.enable4KRequests === true;
}

function accessCanRequestMedia(access, mediaType, is4K = false) {
  const type = text(mediaType).toLowerCase();
  if (is4K && !access4KEnabled(access)) return false;
  if (accessHasSerr(access)) return true;
  if (type === "movie") return is4K
    ? (access?.arrRadarr4KEnabled === true || access?.arrRadarrEnabled === true)
    : access?.arrRadarrEnabled === true;
  if (type === "tv") return is4K
    ? (access?.arrSonarr4KEnabled === true || access?.arrSonarrEnabled === true)
    : access?.arrSonarrEnabled === true;
  return false;
}

function inferTmdbId(item) {
  const direct = item?.__tmdbId ?? item?.tmdbId ?? item?.TmdbId;
  if (Number.isFinite(Number(direct)) && Number(direct) > 0) return Number(direct);
  const id = providerId(item, "Tmdb", "TMDb", "tmdb");
  return Number.isFinite(Number(id)) && Number(id) > 0 ? Number(id) : 0;
}

function inferTvdbId(item) {
  const id = providerId(item, "Tvdb", "TVDB", "tvdb");
  return Number.isFinite(Number(id)) && Number(id) > 0 ? Number(id) : undefined;
}

function tmdbImageUrl(path, size = "w342") {
  const clean = text(path);
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean) || /^blob:/i.test(clean)) return clean;
  if (/^\/(?:Items|Users|Videos|web|Plugins)\//i.test(clean)) return withServer(clean);
  return `${SERR_IMAGE_BASE}/${size}${clean.startsWith("/") ? clean : `/${clean}`}`;
}

function jellyfinPrimaryImageUrl(item, maxHeight = 420) {
  const tags = item?.ImageTags || item?.imageTags || {};
  const primaryTag = text(item?.PrimaryImageTag || item?.primaryImageTag || tags?.Primary || tags?.primary);
  const itemId = text(item?.Id || item?.id);
  const hasPrimary = primaryTag || item?.HasPrimaryImage === true || item?.hasPrimaryImage === true;
  if (itemId && hasPrimary) return buildJellyfinPrimaryImageUrl(itemId, primaryTag, maxHeight);

  const series = item?.Series || item?.series || {};
  const seriesTag = text(item?.SeriesPrimaryImageTag || item?.seriesPrimaryImageTag || series?.PrimaryImageTag || series?.ImageTags?.Primary);
  const seriesId = text(item?.SeriesId || item?.seriesId || series?.Id || series?.id);
  if (seriesId && seriesTag) return buildJellyfinPrimaryImageUrl(seriesId, seriesTag, maxHeight);

  const parentTag = text(item?.ParentPrimaryImageTag || item?.parentPrimaryImageTag);
  const parentId = text(item?.ParentPrimaryImageItemId || item?.parentPrimaryImageItemId || item?.ParentId || item?.parentId);
  if (parentId && parentTag) return buildJellyfinPrimaryImageUrl(parentId, parentTag, maxHeight);

  return "";
}

function buildJellyfinPrimaryImageUrl(itemId, tag = "", maxHeight = 420) {
  const cleanId = text(itemId);
  if (!cleanId) return "";
  const qs = new URLSearchParams();
  qs.set("quality", "88");
  qs.set("maxHeight", String(maxHeight));
  if (tag) qs.set("tag", tag);
  return withServer(`/Items/${encodeURIComponent(cleanId)}/Images/Primary?${qs.toString()}`);
}

function requestPosterUrl(item, options = {}) {
  return tmdbImageUrl(
    options.posterUrl ||
      options.imageUrl ||
      item?.posterUrl ||
      item?.PosterUrl ||
      item?.imageUrl ||
      item?.ImageUrl,
    "w342"
  ) || tmdbImageUrl(
    item?.PosterPath ||
      item?.posterPath ||
      item?.poster_path ||
      item?.__monwuiSerrPosterPath ||
      item?.StillPath ||
      item?.stillPath,
    "w342"
  ) || jellyfinPrimaryImageUrl(item);
}

function requestPosterUrlFromPayload(payload = {}) {
  return tmdbImageUrl(
    payload?.posterUrl ||
      payload?.imageUrl ||
      payload?.posterPath ||
      payload?.poster_path,
    "w342"
  );
}

function inferSeasonNumbers(item, explicitSeasons = null) {
  if (Array.isArray(explicitSeasons) && explicitSeasons.length) {
    return explicitSeasons.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0);
  }

  const type = text(item?.Type || item?.type).toLowerCase();
  const number =
    type === "season"
      ? Number(item?.IndexNumber)
      : type === "episode"
        ? Number(item?.ParentIndexNumber)
        : NaN;
  return Number.isFinite(number) && number >= 0 ? [number] : [];
}

function itemTitle(item) {
  if (item?.__monwuiVirtualTrailer) return text(item?.Name, L("serrUntitled", "İçerik"));
  const type = text(item?.Type || item?.type).toLowerCase();
  if (type === "episode") {
    return [item?.SeriesName, item?.Name].map((v) => text(v)).filter(Boolean).join(" - ") || text(item?.Name);
  }
  return text(item?.Name || item?.name || item?.Title || item?.title, L("serrUntitled", "İçerik"));
}

function isAvailableJellyfinItem(item) {
  if (!item || item?.__monwuiVirtualTrailer === true) return false;
  const type = text(item?.Type || item?.type || item?.ItemType || item?.itemType).toLowerCase();
  if (!["movie", "episode"].includes(type)) return false;
  if (item?.IsMissing === true || item?.isMissing === true) return false;
  if (item?.IsVirtualItem === true || item?.isVirtualItem === true) return false;
  const location = text(item?.LocationType || item?.locationType).toLowerCase();
  if (location === "virtual") return false;
  const mediaSources = Array.isArray(item?.MediaSources || item?.mediaSources)
    ? (item?.MediaSources || item?.mediaSources)
    : [];
  return location === "filesystem" ||
    !!text(item?.Path || item?.path) ||
    mediaSources.length > 0 ||
    Number(item?.RunTimeTicks || item?.runTimeTicks || 0) > 0;
}

function buildPayloadFromItem(item, options = {}) {
  const mediaType = options.mediaType || normalizeItemType(item);
  const mediaId = Number(options.mediaId || inferTmdbId(item));
  const seasons = inferSeasonNumbers(item, options.seasons);
  const title = text(options.title || itemTitle(item));

  if (!mediaType || !mediaId) return null;

  return {
    mediaType,
    mediaId,
    tvdbId: options.tvdbId || (mediaType === "tv" ? inferTvdbId(item) : undefined),
    seasons,
    requestAllSeasons: mediaType === "tv" ? (options.requestAllSeasons === true || !seasons.length) : false,
    is4K: options.is4K === true,
    title,
    posterUrl: requestPosterUrl(item, options),
    source: text(options.source, "jellyfin"),
    jellyfinItemId: text(options.jellyfinItemId || item?.Id || item?.id)
  };
}

export function notify(message, type = "info") {
  const clean = text(message);
  if (!clean) return;
  try {
    showNotification(`<i class="fas fa-clapperboard" style="margin-right:8px;"></i>${escapeHtml(clean)}`, 3200, type);
  } catch {
    window.showMessage?.(clean, type === "error" ? "error" : "success");
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
    default: return L("serrStatusApproved", "Onaylandı");
  }
}

function lowerStatusLabel(status) {
  const label = statusLabel(status);
  try { return label.toLocaleLowerCase("tr-TR"); } catch { return label.toLowerCase(); }
}

function statusMessage(result) {
  if (result?.ok !== false && (result?.backend === "arr" || result?.service === "radarr" || result?.service === "sonarr")) {
    return arrStatusMessage(result);
  }
  if (result?.duplicate) {
    const status = lowerStatusLabel(result?.duplicateStatus || result?.request?.Status || result?.request?.status);
    const own = result?.duplicateOwnedByCurrentUser === true;
    const fallback = own
      ? "Bu istek zaten sizin tarafınızdan oluşturuldu ve {status}."
      : "Bu istek başka bir kullanıcı tarafından oluşturuldu ve {status}.";
    return L(own ? "serrDuplicateOwnRequest" : "serrDuplicateOtherRequest", fallback).replace("{status}", status);
  }
  if (result?.pendingApproval) return L("serrRequestPendingToast", "İstek yönetici onayına gönderildi.");
  if (result?.request?.episodeOnly || result?.request?.EpisodeOnly) return L("serrRequestCreatedToast", "İstek oluşturuldu.");
  const status = text(result?.request?.Status || result?.request?.status);
  if (status === "approved" || status === "processing") return L("serrRequestApprovedToast", "İstek Seerr'e gönderildi.");
  return L("serrRequestCreatedToast", "İstek oluşturuldu.");
}

function statusType(result) {
  return result?.duplicate || result?.ok === false ? "error" : "success";
}

function arrStatusMessage(result) {
  if (result?.service === "sonarr") return L("arrEpisodeRequestSent", "Bölüm isteği Sonarr'a gönderildi.");
  if (result?.service === "radarr") return L("arrMovieRequestSent", "Film isteği Radarr'a gönderildi.");
  return L("arrRequestSent", "Arr isteği gönderildi.");
}

function shouldUseDirectArrMovieFallback(access) {
  return accessHasSerr(access);
}

function shouldFallbackMovieToArr(result) {
  if (result?.backend === "arr" || result?.service === "radarr" || result?.service === "sonarr") return false;
  if (result?.pendingApproval) return false;
  if (result?.ok === false) return true;

  const request = result?.request || result?.Request || {};
  const mediaType = text(request?.MediaType || request?.mediaType).toLowerCase();
  if (mediaType && mediaType !== "movie") return false;

  const status = text(result?.duplicateStatus || request?.Status || request?.status).toLowerCase();
  return result?.duplicate === true && (status === "completed" || status === "available");
}

export function requestErrorMessage(error, fallback = L("serrRequestFailed", "Seerr isteği oluşturulamadı.")) {
  const code = text(error?.payload?.code || error?.payload?.errorCode);
  const message = text(error?.message || error?.payload?.error);
  if (code === "serrAlreadyAvailable" || code === "already_available" || /already available in jellyfin/i.test(message)) {
    return L("serrAlreadyAvailable", "Bu içerik Jellyfin'de zaten mevcut.");
  }
  return message || fallback;
}

function isJellyfinAlreadyAvailableError(error) {
  const code = text(error?.payload?.code || error?.payload?.errorCode);
  const message = text(error?.message || error?.payload?.error);
  return code === "serrAlreadyAvailable" || /already available in jellyfin/i.test(message);
}

function markRequestButtonRequested(button, title = L("serrStatusRequested", "İstendi")) {
  if (!button) return;
  button.disabled = true;
  button.classList.add("monwui-serr-requested");
  button.setAttribute("data-serr-requested", "1");
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("title", title);
  button.setAttribute("aria-label", title);
  button.innerHTML = `<i class="fas fa-check" aria-hidden="true"></i><span>${escapeHtml(title)}</span>`;
}

function shouldMarkRequestButtonRequested(result) {
  return !!result && result.cancelled !== true && result.openedSearch !== true && result.ok !== false;
}

export function requestMatchesPayload(req, payload) {
  const reqType = text(req?.MediaType || req?.mediaType).toLowerCase();
  const payloadType = text(payload?.mediaType).toLowerCase();
  const reqId = Number(req?.MediaId || req?.mediaId || 0);
  const payloadId = Number(payload?.mediaId || 0);
  const reqIs4K = req?.Is4K === true || req?.is4K === true;
  const payloadIs4K = payload?.is4K === true;
  if (!reqType || !payloadType || reqType !== payloadType) return false;
  if (!Number.isFinite(reqId) || !Number.isFinite(payloadId) || reqId <= 0 || payloadId <= 0 || reqId !== payloadId) return false;
  if (reqIs4K !== payloadIs4K) return false;
  if (payloadType !== "tv") return true;
  if (req?.RequestAllSeasons === true || req?.requestAllSeasons === true || payload?.requestAllSeasons === true) return true;
  const reqSeasons = Array.isArray(req?.seasons) ? req.seasons.map(Number).filter(Number.isFinite) : [];
  const payloadSeasons = Array.isArray(payload?.seasons) ? payload.seasons.map(Number).filter(Number.isFinite) : [];
  if (!payloadSeasons.length || !reqSeasons.length) return true;
  return payloadSeasons.some((season) => reqSeasons.includes(season));
}

async function markButtonIfAlreadyRequested(button, item, options = {}) {
  const payload = buildPayloadFromItem(item, options);
  if (!payload) return;
  const data = await listSerrRequests({ includeDownloads: false }).catch(() => null);
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  if (requests.some((req) => requestMatchesPayload(req, payload))) {
    markRequestButtonRequested(button);
  }
}

function shouldConfirmRequests(access = null) {
  if (access4KEnabled(access)) return true;
  return access?.settings?.confirmRequests !== false;
}

function requestConfirmTitle(payload = {}) {
  const mediaType = text(payload?.mediaType).toLowerCase();
  if (mediaType === "movie") return L("serrNativeMovieModalTitle", "Seerr Film İsteği");
  if (mediaType === "tv") return L("serrNativeSeasonModalTitle", "Seerr Sezon İsteği");
  return L("serrRequestConfirmHint", "İstek onayı");
}

function requestConfirmHint(payload = {}) {
  const mediaType = text(payload?.mediaType).toLowerCase();
  if (mediaType === "movie") {
    return L("serrMovieConfirmHint", "Film isteği gönderilmeden önce içeriği kontrol edin.");
  }
  return L("serrSeasonConfirmHint", "Sezon isteği gönderilmeden önce kapsamı kontrol edin.");
}

function requestConfirmMeta(payload = {}) {
  const mediaType = text(payload?.mediaType).toLowerCase();
  const seasons = Array.isArray(payload?.seasons) ? payload.seasons : [];
  const parts = [
    payload?.is4K === true ? L("serrRequest4KBadge", "4K") : "",
    mediaType === "tv" ? L("serrTv", "Dizi") : L("serrMovie", "Film"),
    payload?.requestAllSeasons === true
      ? L("serrAllSeasons", "Tüm sezonlar")
      : (mediaType === "tv" && seasons.length
        ? `${seasons.length} ${L("season", "Sezon")}`
        : ""),
    Number(payload?.mediaId) > 0 ? `TMDb ${Number(payload.mediaId)}` : ""
  ].filter(Boolean);
  return parts.join(" - ");
}

function requestConfirmInfo(access = null) {
  return access?.isAdmin === true
    ? L("serrConfirmDirectInfo", "Onayladığınızda istek gönderilecek.")
    : L("serrConfirmPendingInfo", "Onayladığınızda istek yönetici onayına gönderilecek.");
}

function closeRequestConfirmModal(value = false) {
  const modal = document.getElementById("monwuiSerrConfirmModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("hidden", "hidden");
  const resolve = modal.__serrResolve;
  modal.__serrResolve = null;
  if (typeof resolve === "function") resolve(value);
}

function ensureRequestConfirmModal() {
  ensureSerrStyles();
  let modal = document.getElementById("monwuiSerrConfirmModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "monwuiSerrConfirmModal";
  modal.setAttribute("hidden", "hidden");
  modal.innerHTML = `
    <div class="monwui-serr-card monwui-serr-confirm-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(L("serrRequestConfirmHint", "İstek onayı"))}">
      <div class="monwui-serr-head">
        <h2 class="monwui-serr-title" data-serr-confirm-title>${escapeHtml(L("serrRequestConfirmHint", "İstek onayı"))}</h2>
        <button type="button" class="monwui-serr-close" data-serr-confirm-cancel aria-label="${escapeHtml(L("close", "Kapat"))}">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
      <div class="monwui-serr-confirm-body">
        <div class="monwui-serr-confirm-layout">
          <div class="monwui-serr-confirm-poster" data-serr-confirm-poster-wrap hidden>
            <img data-serr-confirm-poster alt="">
            <i class="fas fa-clapperboard" aria-hidden="true"></i>
          </div>
          <div class="monwui-serr-confirm-summary">
            <div class="monwui-serr-confirm-eyebrow">${escapeHtml(L("serrRequestConfirmHint", "İstek onayı"))}</div>
            <div class="monwui-serr-confirm-name" data-serr-confirm-name></div>
            <div class="monwui-serr-confirm-meta" data-serr-confirm-meta></div>
            <div class="monwui-serr-confirm-hint" data-serr-confirm-hint></div>
            <div class="monwui-serr-confirm-info" data-serr-confirm-info></div>
          </div>
        </div>
      </div>
      <div class="monwui-serr-footer">
        <button type="button" class="monwui-serr-mini-btn" data-serr-confirm-cancel>${escapeHtml(L("cancel", "İptal"))}</button>
        <button type="button" class="monwui-serr-btn" data-serr-confirm-submit>
          <i class="fas fa-paper-plane" aria-hidden="true"></i><span>${escapeHtml(L("serrRequestButton", "İste"))}</span>
        </button>
        <button type="button" class="monwui-serr-btn monwui-serr-4k-btn" data-serr-confirm-submit-4k hidden>
          <i class="fas fa-film" aria-hidden="true"></i><span>${escapeHtml(L("serrRequest4KButton", "4K İste"))}</span>
        </button>
      </div>
    </div>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target?.closest?.("[data-serr-confirm-cancel]")) {
      closeRequestConfirmModal(false);
      return;
    }
    if (event.target?.closest?.("[data-serr-confirm-submit]")) {
      closeRequestConfirmModal(true);
      return;
    }
    if (event.target?.closest?.("[data-serr-confirm-submit-4k]")) {
      closeRequestConfirmModal("4k");
    }
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRequestConfirmModal(false);
  });

  document.body.appendChild(modal);
  return modal;
}

async function confirmRequestBeforeSend(payload = {}, access = null) {
  if (!shouldConfirmRequests(access)) return true;
  const modal = ensureRequestConfirmModal();
  const title = requestConfirmTitle(payload);
  const name = text(payload?.title, L("serrUntitled", "İçerik"));
  const meta = requestConfirmMeta(payload);

  const titleNode = modal.querySelector("[data-serr-confirm-title]");
  const nameNode = modal.querySelector("[data-serr-confirm-name]");
  const metaNode = modal.querySelector("[data-serr-confirm-meta]");
  const hintNode = modal.querySelector("[data-serr-confirm-hint]");
  const infoNode = modal.querySelector("[data-serr-confirm-info]");
  const layoutNode = modal.querySelector(".monwui-serr-confirm-layout");
  const posterWrapNode = modal.querySelector("[data-serr-confirm-poster-wrap]");
  const posterNode = modal.querySelector("[data-serr-confirm-poster]");
  const submitNode = modal.querySelector("[data-serr-confirm-submit] span");
  const submit4KNode = modal.querySelector("[data-serr-confirm-submit-4k]");
  const poster = requestPosterUrlFromPayload(payload);
  if (titleNode) titleNode.textContent = title;
  if (nameNode) nameNode.textContent = name;
  if (metaNode) metaNode.textContent = meta;
  if (hintNode) hintNode.textContent = requestConfirmHint(payload);
  if (infoNode) infoNode.textContent = requestConfirmInfo(access);
  if (posterWrapNode && posterNode) {
    posterNode.onerror = null;
    if (poster) {
      layoutNode?.classList?.add("has-poster");
      posterWrapNode.removeAttribute("hidden");
      posterNode.alt = name;
      posterNode.onerror = () => {
        posterNode.removeAttribute("src");
        posterWrapNode.setAttribute("hidden", "hidden");
        layoutNode?.classList?.remove("has-poster");
      };
      posterNode.src = poster;
    } else {
      posterNode.removeAttribute("src");
      posterNode.alt = "";
      posterWrapNode.setAttribute("hidden", "hidden");
      layoutNode?.classList?.remove("has-poster");
    }
  }
  if (submitNode) submitNode.textContent = payload?.is4K === true
    ? L("serrRequest4KButton", "4K İste")
    : L("serrRequestButton", "İste");
  if (submit4KNode) {
    const allow4KChoice = payload?.is4K !== true && accessCanRequestMedia(access, payload?.mediaType, true);
    if (allow4KChoice) submit4KNode.removeAttribute("hidden");
    else submit4KNode.setAttribute("hidden", "hidden");
  }

  if (typeof modal.__serrResolve === "function") {
    modal.__serrResolve(false);
  }

  return await new Promise((resolve) => {
    modal.__serrResolve = resolve;
    modal.classList.add("open");
    modal.removeAttribute("hidden");
    setTimeout(() => modal.querySelector("[data-serr-confirm-submit]")?.focus?.(), 0);
  });
}

export async function requestSerrFromItem(item, options = {}) {
  const access = await getSerrAccess().catch(() => null);
  const requestedMediaType = options.mediaType || normalizeItemType(item);
  if (!access?.enabled || !accessCanRequestMedia(access, requestedMediaType, options.is4K === true)) {
    throw new Error(L("serrDisabled", "Seerr entegrasyonu etkin değil."));
  }

  if (options.allowAvailable !== true && isAvailableJellyfinItem(item)) {
    throw new Error(L("serrAlreadyAvailable", "Bu içerik Jellyfin'de zaten mevcut."));
  }

  const payload = buildPayloadFromItem(item, options);
  if (!payload) {
    const query = text(options.query || itemTitle(item));
    if (query) {
      openSerrSearchModal(query, { source: options.source || "jellyfin" });
      return { openedSearch: true };
    }
    throw new Error(L("serrTmdbMissing", "TMDb ID bulunamadı. Seerr araması ile devam edin."));
  }

  const confirmed = await confirmRequestBeforeSend(payload, access);
  if (!confirmed) return { cancelled: true };
  if (confirmed === "4k") payload.is4K = true;

  let submitStarted = false;
  const notifySubmitStarting = () => {
    if (submitStarted) return;
    submitStarted = true;
    options.onBeforeSubmit?.();
  };

  const runMovieFallback = async () => {
    notifySubmitStarting();
    const arrResult = await requestMovieFromArr(item, {
      tmdbId: payload.mediaId,
      title: payload.title,
      year: item?.ProductionYear || item?.productionYear,
      is4K: payload.is4K === true
    });
    notify(arrStatusMessage(arrResult), "success");
    return arrResult;
  };

  let result;
  try {
    notifySubmitStarting();
    result = await createSerrRequest(payload);
  } catch (error) {
    if (payload.mediaType === "movie" && shouldUseDirectArrMovieFallback(access) && !isJellyfinAlreadyAvailableError(error)) return await runMovieFallback();
    throw error;
  }

  if (result?.ok === false) {
    const err = new Error(result?.error || L("serrRequestFailed", "İstek oluşturulamadı."));
    err.payload = result;
    throw err;
  }

  if (payload.mediaType === "movie" && shouldUseDirectArrMovieFallback(access) && shouldFallbackMovieToArr(result)) {
    return await runMovieFallback();
  }
  notify(statusMessage(result), statusType(result));
  try { window.dispatchEvent(new CustomEvent("monwui:serr-requests-changed")); } catch {}
  return result;
}

export function createSerrRequestButton(item, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = options.className || "monwui-serr-btn";
  const defaultLabel = options.is4K === true ? L("serrRequest4KButton", "4K İste") : L("serrRequestButton", "İste");
  button.innerHTML = `<i class="fas fa-clapperboard" aria-hidden="true"></i><span>${escapeHtml(options.label || defaultLabel)}</span>`;
  button.title = options.title || (options.is4K === true ? L("serrRequest4KButtonTitle", "Bu içeriği 4K iste") : L("serrRequestButtonTitle", "Bu içeriği iste"));

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    const old = button.innerHTML;
    let completed = false;
    try {
      button.disabled = true;
      const result = await requestSerrFromItem(item, {
        ...options,
        onBeforeSubmit: () => {
          button.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>${escapeHtml(L("serrRequestSending", "Gönderiliyor..."))}</span>`;
        }
      });
      if (shouldMarkRequestButtonRequested(result)) {
        markRequestButtonRequested(button);
        completed = true;
      }
    } catch (error) {
      notify(requestErrorMessage(error), "error");
    } finally {
      if (!completed) {
        button.disabled = false;
        button.removeAttribute("aria-disabled");
        button.innerHTML = old;
      }
    }
  });

  return button;
}

export async function appendSerrRequestButton(host, item, options = {}) {
  if (!host || host.querySelector?.(".monwui-serr-btn")) return null;
  if (!moduleEnabled()) return null;
  const access = await getSerrAccess().catch(() => null);
  const requestedMediaType = options.mediaType || normalizeItemType(item);
  if (!access?.enabled || !accessCanRequestMedia(access, requestedMediaType, options.is4K === true)) return null;
  const label = accessHasSerr(access)
    ? (options.label || (options.is4K === true ? L("serrRequest4KButton", "4K İste") : L("serrRequestButton", "İste")))
    : L("arrRequestButton", "İste");
  const title = accessHasSerr(access)
    ? (options.title || (options.is4K === true ? L("serrRequest4KButtonTitle", "Bu içeriği 4K iste") : L("serrRequestButtonTitle", "Bu içeriği iste")))
    : L("arrRequestButtonTitle", "Bu içeriği iste");
  const button = createSerrRequestButton(item, { ...options, label, title });
  host.appendChild(button);
  markButtonIfAlreadyRequested(button, item, options).catch(() => {});
  return button;
}

export function posterUrl(result) {
  const path = text(result?.posterPath || result?.poster_path || result?.remotePoster || result?.posterUrl);
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `https://image.tmdb.org/t/p/w154${path}`;
}

export function resultTitle(result) {
  return text(result?.title || result?.name || result?.originalTitle || result?.originalName, L("serrUntitled", "İçerik"));
}

export function resultMediaType(result) {
  const type = text(result?.mediaType || result?.media_type).toLowerCase();
  return type === "tv" || type === "movie" || type === "collection" ? type : "";
}

export function resultYear(result) {
  const date = text(result?.releaseDate || result?.firstAirDate || result?.release_date || result?.first_air_date);
  const year = Number(result?.year || result?.Year);
  if (Number.isFinite(year) && year > 1800) return String(year);
  return date.length >= 4 ? date.slice(0, 4) : "";
}

function resultMeta(result) {
  const mediaType = resultMediaType(result);
  const type = mediaType === "tv"
    ? L("serrTv", "Dizi")
    : (mediaType === "collection" ? L("boxset", "Koleksiyon") : L("serrMovie", "Film"));
  const tmdbId = Number(result?.id);
  return [type, resultYear(result), Number.isFinite(tmdbId) && tmdbId > 0 ? `TMDb ${tmdbId}` : ""].filter(Boolean).join(" • ");
}

function parseTmdbSearch(value) {
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

function normalizeTmdbDetail(raw, mediaType, id) {
  if (!raw || typeof raw !== "object") return null;
  const title = text(raw?.title || raw?.name || raw?.originalTitle || raw?.originalName || raw?.original_name);
  const resolvedId = Number(raw?.id) || id;
  if (!title || !Number.isFinite(resolvedId) || resolvedId <= 0) return null;
  return {
    ...raw,
    id: resolvedId,
    mediaType,
    media_type: mediaType
  };
}

async function searchSerrByTmdbId({ id, type, language }) {
  const jobs = [];
  if (!type || type === "movie") {
    jobs.push(getSerrMovieDetails(id, { language }).then((raw) => normalizeTmdbDetail(raw, "movie", id)).catch(() => null));
  }
  if (!type || type === "tv") {
    jobs.push(getSerrTvDetails(id, { language }).then((raw) => normalizeTmdbDetail(raw, "tv", id)).catch(() => null));
  }
  if (!type || type === "collection") {
    jobs.push(getSerrCollectionDetails(id, { language }).then((raw) => normalizeTmdbDetail(raw, "collection", id)).catch(() => null));
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

export function mergeSearchResults(...lists) {
  const seen = new Set();
  const output = [];
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      const type = resultMediaType(row);
      const id = Number(row?.id);
      const key = type && Number.isFinite(id) && id > 0
        ? `${type}:${id}`
        : `${type}:${resultTitle(row).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(row);
    }
  }
  return output;
}

function balancedSearchResults(results = [], limit = 30) {
  const movies = [];
  const tv = [];
  const collections = [];
  const other = [];
  for (const row of Array.isArray(results) ? results : []) {
    const type = resultMediaType(row);
    if (type === "movie") movies.push(row);
    else if (type === "tv") tv.push(row);
    else if (type === "collection") collections.push(row);
    else other.push(row);
  }

  const output = [];
  while (output.length < limit && (movies.length || tv.length || collections.length)) {
    if (collections.length) output.push(collections.shift());
    if (output.length >= limit) break;
    if (movies.length) output.push(movies.shift());
    if (output.length >= limit) break;
    if (tv.length) output.push(tv.shift());
  }
  return output.concat(other).slice(0, limit);
}

function ensureModal() {
  ensureSerrStyles();
  let modal = document.getElementById("monwuiSerrModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "monwuiSerrModal";
  modal.innerHTML = `
    <div class="monwui-serr-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(L("serrSearchTitle", "Seerr'de Ara"))}">
      <div class="monwui-serr-head">
        <h2 class="monwui-serr-title">${escapeHtml(L("serrSearchTitle", "Seerr'de Ara"))}</h2>
        <button type="button" class="monwui-serr-close" data-serr-close aria-label="${escapeHtml(L("close", "Kapat"))}">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
      <div class="monwui-serr-searchbar">
        <input class="monwui-serr-input" type="search" autocomplete="off" spellcheck="false">
        <button type="button" class="monwui-serr-btn" data-serr-run>
          <i class="fas fa-search" aria-hidden="true"></i><span>${escapeHtml(L("search", "Ara"))}</span>
        </button>
      </div>
      <div class="monwui-serr-results"></div>
    </div>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target?.closest?.("[data-serr-close]")) {
      closeSerrSearchModal();
    }
  });
  modal.querySelector("[data-serr-run]")?.addEventListener("click", () => {
    runModalSearch(modal).catch(() => {});
  });
  modal.querySelector(".monwui-serr-input")?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runModalSearch(modal).catch(() => {}), 350);
  });
  modal.querySelector(".monwui-serr-input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runModalSearch(modal).catch(() => {});
  });

  document.body.appendChild(modal);
  return modal;
}

export function openSerrSearchModal(query = "", options = {}) {
  const modal = ensureModal();
  modal.__serrOptions = options || {};
  const input = modal.querySelector(".monwui-serr-input");
  if (input) input.value = text(query);
  modal.classList.add("open");
  modal.removeAttribute("hidden");
  setTimeout(() => input?.focus?.(), 0);
  runModalSearch(modal).catch(() => {});
}

export function closeSerrSearchModal() {
  const modal = document.getElementById("monwuiSerrModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("hidden", "hidden");
  if (modalSearchAbort) {
    try { modalSearchAbort.abort(); } catch {}
    modalSearchAbort = null;
  }
}

async function runModalSearch(modal) {
  const input = modal.querySelector(".monwui-serr-input");
  const host = modal.querySelector(".monwui-serr-results");
  const query = text(input?.value);
  if (!host || query.length < 2) {
    if (host) host.innerHTML = `<div class="monwui-serr-empty">${escapeHtml(L("serrSearchHint", "Aramak için en az 2 karakter yazın."))}</div>`;
    return;
  }

  if (modalSearchAbort) {
    try { modalSearchAbort.abort(); } catch {}
  }
  modalSearchAbort = new AbortController();
  host.innerHTML = `<div class="monwui-serr-loading">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;

  try {
    const access = await getSerrAccess();
    if (!access?.enabled) {
      host.innerHTML = `<div class="monwui-serr-error">${escapeHtml(L("serrDisabled", "Seerr entegrasyonu etkin değil."))}</div>`;
      return;
    }
    const language = access?.settings?.defaultLanguage || cfg()?.defaultLanguage || "";
    const tmdbSearch = parseTmdbSearch(query);
    if (tmdbSearch) {
      const [tmdbResults, textData, collectionData] = await Promise.all([
        searchSerrByTmdbId({ ...tmdbSearch, language }),
        searchSerr(query, { language }).catch(() => null),
        searchSerrCollections(query, { language }).catch(() => null)
      ]);
      const textResults = Array.isArray(textData?.results) ? textData.results : [];
      const collectionResults = Array.isArray(collectionData?.results) ? collectionData.results : [];
      renderSearchResults(host, mergeSearchResults(tmdbResults, collectionResults, textResults), { ...(modal.__serrOptions || {}), access });
      return;
    }
    const searchQuery = tmdbSearch ? `tmdb:${tmdbSearch.id}` : query;

    const [page1, page2, collections] = await Promise.all([
      searchSerr(searchQuery, { page: 1, language }),
      searchSerr(searchQuery, { page: 2, language }),
      searchSerrCollections(query, { language }).catch(() => null)
    ]);

    const results = mergeSearchResults(
      Array.isArray(collections?.results) ? collections.results : [],
      Array.isArray(page1?.results) ? page1.results : [],
      Array.isArray(page2?.results) ? page2.results : []
    );

    renderSearchResults(host, results, { ...(modal.__serrOptions || {}), access });
  } catch (error) {
    host.innerHTML = `<div class="monwui-serr-error">${escapeHtml(error?.message || L("serrSearchFailed", "Seerr araması başarısız."))}</div>`;
  }
}

function renderSearchResults(host, results, options = {}) {
  const media = balancedSearchResults(results.filter((result) => resultMediaType(result)));
  if (!media.length) {
    host.innerHTML = `<div class="monwui-serr-empty">${escapeHtml(L("serrNoResults", "Seerr'de sonuç bulunamadı."))}</div>`;
    return;
  }

  host.innerHTML = "";
  const frag = document.createDocumentFragment();
  const pendingRequestChecks = [];
  media.forEach((result) => {
    const mediaType = resultMediaType(result);
    const id = Number(result?.id);
    const title = resultTitle(result);
    const img = posterUrl(result);
    const row = document.createElement("article");
    row.className = "monwui-serr-result";
    row.innerHTML = `
      ${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(title)}" loading="lazy">` : `<div class="monwui-serr-poster-fallback">${escapeHtml(mediaType.toUpperCase())}</div>`}
      <div>
        <div class="monwui-serr-name">${escapeHtml(title)}</div>
        <div class="monwui-serr-meta">${escapeHtml(resultMeta(result))}</div>
        ${text(result?.overview) ? `<div class="monwui-serr-overview">${escapeHtml(result.overview)}</div>` : ""}
      </div>
      <div class="monwui-serr-result-actions">
        <button type="button" class="monwui-serr-btn" data-serr-result-request>
          <i class="fas fa-paper-plane" aria-hidden="true"></i><span>${escapeHtml(accessHasSerr(options.access) ? L("serrRequestButton", "İste") : L("arrRequestButton", "İste"))}</span>
        </button>
      </div>
    `;

    const requestButton = row.querySelector("[data-serr-result-request]");
    if (mediaType !== "collection" && requestButton) {
      pendingRequestChecks.push({
        button: requestButton,
        payload: { mediaType, mediaId: id, is4K: false, requestAllSeasons: mediaType === "tv", seasons: [] }
      });
    }

    const handleRequest = async (btn, is4K = false) => {
      const old = btn.innerHTML;
      let effectiveIs4K = is4K === true;
      let completed = false;
      try {
        btn.disabled = true;
        if (mediaType === "collection") {
          btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(L("loadingText", "Yükleniyor..."))}</span>`;
          await openSerrCollectionRequestModal(result, { source: text(options.source, "search") });
          return;
        }
        const payload = {
          mediaType,
          mediaId: id,
          tvdbId: Number(result?.tvdbId || result?.tvdb_id || 0) || undefined,
          title,
          posterUrl: img,
          requestAllSeasons: mediaType === "tv",
          seasons: [],
          source: text(options.source, "search"),
          is4K: effectiveIs4K
        };
        const confirmed = await confirmRequestBeforeSend(payload, options.access);
        if (!confirmed) return;
        if (confirmed === "4k") {
          payload.is4K = true;
          effectiveIs4K = true;
        }

        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(L("serrRequestSending", "Gönderiliyor..."))}</span>`;
        const response = await createSerrRequest(payload);
        if (response?.ok === false) {
          const err = new Error(response?.error || L("serrRequestFailed", "İstek oluşturulamadı."));
          err.payload = response;
          throw err;
        }
        if (mediaType === "movie" && shouldUseDirectArrMovieFallback(options.access) && shouldFallbackMovieToArr(response)) {
          const arrResult = await requestMovieFromArr({ __tmdbId: id, Name: title }, { tmdbId: id, title, is4K: payload.is4K === true });
          notify(arrStatusMessage(arrResult), "success");
          markRequestButtonRequested(btn);
          completed = true;
          try { window.dispatchEvent(new CustomEvent("monwui:serr-requests-changed")); } catch {}
          return;
        }
        notify(statusMessage(response), statusType(response));
        markRequestButtonRequested(btn);
        completed = true;
        try { window.dispatchEvent(new CustomEvent("monwui:serr-requests-changed")); } catch {}
      } catch (error) {
        if (mediaType === "movie" && shouldUseDirectArrMovieFallback(options.access) && !isJellyfinAlreadyAvailableError(error)) {
          try {
            const arrResult = await requestMovieFromArr({ __tmdbId: id, Name: title }, { tmdbId: id, title, is4K: effectiveIs4K });
            notify(arrStatusMessage(arrResult), "success");
            markRequestButtonRequested(btn);
            completed = true;
            try { window.dispatchEvent(new CustomEvent("monwui:serr-requests-changed")); } catch {}
            return;
          } catch (arrError) {
            notify(arrError?.message || requestErrorMessage(error), "error");
            return;
          }
        }
        notify(requestErrorMessage(error), "error");
      } finally {
        if (!completed) {
          btn.disabled = false;
          btn.innerHTML = old;
        }
      }
    };

    requestButton?.addEventListener("click", (event) => {
      if (event.currentTarget.disabled) return;
      handleRequest(event.currentTarget, false).catch(() => {});
    });

    frag.appendChild(row);
  });
  host.appendChild(frag);

  if (pendingRequestChecks.length) {
    listSerrRequests({ includeDownloads: false }).then((data) => {
      const requests = Array.isArray(data?.requests) ? data.requests : [];
      if (!requests.length) return;
      pendingRequestChecks.forEach(({ button, payload }) => {
        if (button?.isConnected && !button.disabled && requests.some((req) => requestMatchesPayload(req, payload))) {
          markRequestButtonRequested(button);
        }
      });
    }).catch(() => {});
  }
}
