const SERR_ENDPOINT = "/Plugins/MonWUI/seerr";

let accessCache = null;
let accessCacheAt = 0;
const ACCESS_CACHE_MS = 30_000;

function tokenSafe() {
  try {
    return window.ApiClient?.accessToken?.() || window.ApiClient?._accessToken || "";
  } catch {
    return "";
  }
}

async function userIdSafe() {
  try {
    const user = await window.ApiClient?.getCurrentUser?.();
    return user?.Id || "";
  } catch {
    return "";
  }
}

async function headers(json = true) {
  const h = { Accept: "application/json" };
  if (json) h["Content-Type"] = "application/json";
  const token = tokenSafe();
  const userId = await userIdSafe();
  if (token) h["X-Emby-Token"] = token;
  if (userId) h["X-Emby-UserId"] = userId;
  return h;
}

async function request(path = "", options = {}) {
  const res = await fetch(`${SERR_ENDPOINT}${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(await headers(options.body !== undefined)),
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    const message = data?.error || data?.message || `Seerr HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.payload = data;
    throw error;
  }

  return data;
}

export async function getSerrAccess({ force = false } = {}) {
  const now = Date.now();
  if (!force && accessCache && (now - accessCacheAt) < ACCESS_CACHE_MS) {
    return accessCache;
  }

  accessCache = await request("/access");
  accessCacheAt = Date.now();
  return accessCache;
}

export async function getSerrSettings() {
  return request("/settings");
}

export async function saveSerrSettings(settings = {}) {
  accessCache = null;
  return request("/settings", {
    method: "POST",
    body: JSON.stringify(settings || {})
  });
}

export async function testSerrConnection() {
  return request("/test", { method: "POST", body: JSON.stringify({}) });
}

export async function searchSerr(query, { page = 1, language = "" } = {}) {
  const qs = new URLSearchParams();
  qs.set("query", String(query || "").trim());
  qs.set("page", String(Math.max(1, Number(page) || 1)));
  if (language) qs.set("language", language);
  return request(`/search?${qs.toString()}`);
}

function metadataQuery({ language = "" } = {}) {
  const qs = new URLSearchParams();
  if (language) qs.set("language", language);
  const out = qs.toString();
  return out ? `?${out}` : "";
}

export async function getSerrTvDetails(id, options = {}) {
  const clean = Number(id);
  if (!Number.isFinite(clean) || clean <= 0) return null;
  return request(`/metadata/tv/${encodeURIComponent(String(Math.floor(clean)))}${metadataQuery(options)}`);
}

export async function getSerrTvSeasonDetails(id, seasonNumber, options = {}) {
  const clean = Number(id);
  const season = Number(seasonNumber);
  if (!Number.isFinite(clean) || clean <= 0 || !Number.isFinite(season) || season < 0) return null;
  return request(`/metadata/tv/${encodeURIComponent(String(Math.floor(clean)))}/season/${encodeURIComponent(String(Math.floor(season)))}${metadataQuery(options)}`);
}

export async function getSerrMovieDetails(id, options = {}) {
  const clean = Number(id);
  if (!Number.isFinite(clean) || clean <= 0) return null;
  return request(`/metadata/movie/${encodeURIComponent(String(Math.floor(clean)))}${metadataQuery(options)}`);
}

export async function getSerrCollectionDetails(id, options = {}) {
  const clean = Number(id);
  if (!Number.isFinite(clean) || clean <= 0) return null;
  return request(`/metadata/collection/${encodeURIComponent(String(Math.floor(clean)))}${metadataQuery(options)}`);
}

export async function searchSerrCollections(query, { page = 1, language = "" } = {}) {
  const qs = new URLSearchParams();
  qs.set("query", String(query || "").trim());
  qs.set("page", String(Math.max(1, Number(page) || 1)));
  if (language) qs.set("language", language);
  return request(`/metadata/collection/search?${qs.toString()}`);
}

export async function searchJellyfinByTmdbId(id) {
  const clean = Number(id);
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, items: [] };
  return request(`/local/tmdb/${encodeURIComponent(String(Math.floor(clean)))}`);
}

export async function createSerrRequest(payload = {}) {
  return request("/request", {
    method: "POST",
    body: JSON.stringify(payload || {})
  });
}

export async function listSerrRequests({ includeHistory = false, includeDownloads = true } = {}) {
  const qs = new URLSearchParams();
  if (includeHistory) qs.set("includeHistory", "true");
  if (!includeDownloads) qs.set("includeDownloads", "false");
  const query = qs.toString();
  return request(`/requests${query ? `?${query}` : ""}`);
}

export async function approveSerrRequest(id) {
  return request(`/requests/${encodeURIComponent(String(id || ""))}/approve`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function upgradeSerrRequest4K(id) {
  return request(`/requests/${encodeURIComponent(String(id || ""))}/upgrade4k`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function declineSerrRequest(id) {
  return request(`/requests/${encodeURIComponent(String(id || ""))}/decline`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

// Jellyseerr issue types.
export const SERR_ISSUE_TYPE = Object.freeze({
  VIDEO: 1,
  AUDIO: 2,
  SUBTITLE: 3,
  OTHER: 4,
});

export async function createSerrIssue({ issueType, mediaId, message = "", problemSeason = 0, problemEpisode = 0 } = {}) {
  return request("/issue", {
    method: "POST",
    body: JSON.stringify({ issueType, mediaId, message, problemSeason, problemEpisode })
  });
}

// Resolves to { ok:false, issues:[] } when the instance has issues turned off, so callers can
// hide the entry point instead of showing an error the user cannot act on.
// The controller scopes the list to the caller (admins see everything) and flattens Jellyseerr's
// paginated envelope, so `issues` is always a plain array.
export async function listSerrIssues() {
  try {
    return await request("/issues");
  } catch (error) {
    return { ok: false, error: String(error?.message || error || ""), issues: [], isAdmin: false };
  }
}

export async function getSerrIssue(id) {
  return request(`/issues/${encodeURIComponent(String(id || ""))}`);
}

export async function commentSerrIssue(id, message) {
  return request(`/issues/${encodeURIComponent(String(id || ""))}/comment`, {
    method: "POST",
    body: JSON.stringify({ message: String(message || "") })
  });
}

// status is "open" or "resolved"; anything else is rejected by the controller.
export async function setSerrIssueStatus(id, status) {
  return request(`/issues/${encodeURIComponent(String(id || ""))}/status`, {
    method: "POST",
    body: JSON.stringify({ status: String(status || "") })
  });
}

export async function withdrawSerrRequest(id) {
  return request(`/requests/${encodeURIComponent(String(id || ""))}/withdraw`, {
    method: "POST",
    body: JSON.stringify({})
  });
}
