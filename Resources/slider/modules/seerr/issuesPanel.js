import {
  commentSerrIssue,
  getSerrIssue,
  getSerrMovieDetails,
  getSerrTvDetails,
  listSerrIssues,
  setSerrIssueStatus
} from "./api.js";
import { getConfig } from "../config.js";
import { getLanguageLabels } from "../../language/index.js";
import { showNotification } from "../player/ui/notification.js";

/**
 * The Issues tab of the notification panel. Admins get the full Jellyseerr workflow — read the
 * report, comment on it, close or reopen it — so an issue never has to be chased into Jellyseerr's
 * own UI. Regular users get a read-only view of *their* reports and only when they have some, so
 * the tab never appears as an empty shelf for people who have never reported anything.
 *
 * The list is scoped server-side (SerrController.ListIssues): the Jellyseerr API key is an admin
 * credential, so filtering here would leave the unfiltered payload one devtools request away.
 */

const TAB_KEY = "issues";
const STYLE_ID = "monwui-serr-issues-styles";
const SERR_IMAGE_BASE = "https://image.tmdb.org/t/p";
const POSTER_SIZE = "w154";
const MAX_COMMENT_LENGTH = 1000;

const STATUS_RESOLVED = 2;

const ISSUE_TYPE_LABELS = {
  1: ["serrIssueTypeVideo", "Video"],
  2: ["serrIssueTypeAudio", "Audio"],
  3: ["serrIssueTypeSubtitle", "Subtitles"],
  4: ["serrIssueTypeOther", "Other"],
};

let cachedIssues = [];
let cachedIsAdmin = false;
let cachedSupported = true;
let refreshPromise = null;
let openIssueId = 0;
let openIssue = null;
let detailBusy = false;
let detailSeq = 0;
const metadataCache = new Map();
const metadataPromises = new Map();

function labels() {
  try {
    return getLanguageLabels() || {};
  } catch {
    return {};
  }
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

function moduleEnabled() {
  try {
    return getConfig()?.enableSerrArrIntegrationModule !== false;
  } catch {
    return true;
  }
}

function notify(message, type = "info") {
  const clean = text(message);
  if (!clean) return;
  try {
    showNotification(`<i class="fas fa-triangle-exclamation" style="margin-right:8px;"></i>${escapeHtml(clean)}`, 3200, type);
  } catch {
    window.showMessage?.(clean, type === "error" ? "error" : "success");
  }
}

function issueId(issue) {
  const id = Number(issue?.id);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function isResolved(issue) {
  return Number(issue?.status) === STATUS_RESOLVED;
}

function issueTypeText(issue) {
  const entry = ISSUE_TYPE_LABELS[Number(issue?.issueType)] || ISSUE_TYPE_LABELS[4];
  return L(entry[0], entry[1]);
}

function statusText(issue) {
  return isResolved(issue)
    ? L("serrIssueResolved", "Resuelto")
    : L("serrIssueOpen", "Abierto");
}

function authorName(issue) {
  const by = issue?.createdBy || {};
  return text(by.displayName || by.username || by.jellyfinUsername || by.email, L("issuesUnknownUser", "—"));
}

// Jellyseerr keeps the report body in the first comment and mirrors it onto the issue itself
// depending on version, so both are checked before giving up.
function issueMessage(issue) {
  return text(issue?.message || issue?.comments?.[0]?.message, "");
}

// The bundle language is ISO 639-2 ("spa"/"eng") and Intl wants BCP 47, so the browser locale is
// used instead of translating between the two for a timestamp.
function formatDate(value) {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return "";
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

/**
 * Jellyseerr's issue payload carries a MediaInfo row, not a title or a poster, so the readable
 * parts come from the metadata endpoints this plugin already proxies. Resolution is lazy and
 * cached: a list of twenty issues must not fan out into twenty blocking lookups before it renders.
 */
function mediaKey(issue) {
  const media = issue?.media || {};
  const tmdbId = Number(media.tmdbId);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return "";
  const kind = String(media.mediaType || "").toLowerCase() === "tv" ? "tv" : "movie";
  return `${kind}:${tmdbId}`;
}

async function resolveMediaMeta(issue) {
  const key = mediaKey(issue);
  if (!key) return null;
  if (metadataCache.has(key)) return metadataCache.get(key);
  if (metadataPromises.has(key)) return metadataPromises.get(key);

  const [kind, rawId] = key.split(":");
  const promise = (async () => {
    try {
      const details = kind === "tv"
        ? await getSerrTvDetails(Number(rawId))
        : await getSerrMovieDetails(Number(rawId));
      const meta = {
        title: text(details?.title || details?.name),
        year: text(String(details?.releaseDate || details?.firstAirDate || "").slice(0, 4)),
        posterPath: text(details?.posterPath)
      };
      metadataCache.set(key, meta);
      return meta;
    } catch {
      metadataCache.set(key, null);
      return null;
    } finally {
      metadataPromises.delete(key);
    }
  })();

  metadataPromises.set(key, promise);
  return promise;
}

function cachedMeta(issue) {
  const key = mediaKey(issue);
  return key ? (metadataCache.get(key) || null) : null;
}

function posterUrl(meta) {
  const path = text(meta?.posterPath);
  return path ? `${SERR_IMAGE_BASE}/${POSTER_SIZE}${path}` : "";
}

function issueTitle(issue) {
  const meta = cachedMeta(issue);
  return text(meta?.title || issue?.media?.title || issue?.media?.name, L("issuesUnknownTitle", "—"));
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #jfNotifModal .monwui-issues-host { display: grid; gap: 10px; }
    #jfNotifModal .monwui-issue-row {
      align-items: center; background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.09); border-radius: 12px;
      cursor: pointer; display: grid; gap: 12px;
      grid-template-columns: 46px minmax(0,1fr) auto; padding: 10px 12px;
      text-align: left; width: 100%;
      transition: background .18s ease, border-color .18s ease, transform .18s ease;
    }
    #jfNotifModal .monwui-issue-row:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.2); transform: translateX(2px); }
    #jfNotifModal .monwui-issue-row:focus-visible { outline: 2px solid var(--monwui-primary, #ffb703); outline-offset: 2px; }
    #jfNotifModal .monwui-issue-poster {
      aspect-ratio: 2/3; background: rgba(255,255,255,.07); border-radius: 6px;
      object-fit: cover; width: 46px;
    }
    #jfNotifModal .monwui-issue-main { min-width: 0; }
    #jfNotifModal .monwui-issue-title {
      font-size: 13px; font-weight: 750; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    #jfNotifModal .monwui-issue-sub { color: rgba(255,255,255,.6); font-size: 11px; margin-top: 2px; }
    #jfNotifModal .monwui-issue-msg {
      color: rgba(255,255,255,.78); font-size: 12px; margin-top: 4px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #jfNotifModal .monwui-issue-badge {
      border-radius: 999px; font-size: 10px; font-weight: 850;
      letter-spacing: .04em; padding: 4px 9px; text-transform: uppercase; white-space: nowrap;
    }
    #jfNotifModal .monwui-issue-badge.is-open { background: #ffbf5f; color: #111; }
    #jfNotifModal .monwui-issue-badge.is-resolved { background: rgba(255,255,255,.14); color: rgba(255,255,255,.82); }
    #jfNotifModal .monwui-issue-empty { color: rgba(255,255,255,.6); font-size: 13px; padding: 18px 4px; text-align: center; }
    #jfNotifModal .monwui-issue-back {
      background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14);
      border-radius: 9px; color: inherit; cursor: pointer; font-size: 12px;
      font-weight: 700; margin-bottom: 12px; padding: 7px 12px;
    }
    #jfNotifModal .monwui-issue-back:hover { background: rgba(255,255,255,.13); }
    #jfNotifModal .monwui-issue-detail-head { display: grid; gap: 12px; grid-template-columns: 78px minmax(0,1fr); }
    #jfNotifModal .monwui-issue-detail-head img { aspect-ratio: 2/3; border-radius: 8px; object-fit: cover; width: 78px; }
    #jfNotifModal .monwui-issue-detail-title { font-size: 17px; font-weight: 800; line-height: 1.2; }
    #jfNotifModal .monwui-issue-section-title {
      color: rgba(255,255,255,.55); font-size: 11px; font-weight: 800;
      letter-spacing: .08em; margin: 16px 0 6px; text-transform: uppercase;
    }
    #jfNotifModal .monwui-issue-body { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    #jfNotifModal .monwui-issue-comment {
      background: rgba(255,255,255,.04); border-radius: 10px; margin-bottom: 8px; padding: 9px 11px;
    }
    #jfNotifModal .monwui-issue-comment-head { color: rgba(255,255,255,.55); font-size: 11px; margin-bottom: 3px; }
    #jfNotifModal .monwui-issue-composer { display: grid; gap: 8px; margin-top: 12px; }
    #jfNotifModal .monwui-issue-composer textarea {
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px; color: inherit; font: inherit; font-size: 13px;
      min-height: 74px; padding: 9px 11px; resize: vertical; width: 100%;
    }
    #jfNotifModal .monwui-issue-composer textarea:focus-visible { border-color: var(--monwui-primary, #ffb703); outline: none; }
    #jfNotifModal .monwui-issue-actions { display: flex; gap: 8px; justify-content: flex-end; }
    #jfNotifModal .monwui-issue-btn {
      border: 1px solid transparent; border-radius: 9px; cursor: pointer;
      font-size: 12px; font-weight: 750; padding: 8px 14px;
    }
    #jfNotifModal .monwui-issue-btn[disabled] { cursor: default; opacity: .5; }
    #jfNotifModal .monwui-issue-btn.is-primary { background: var(--monwui-primary, #ffb703); color: #141822; }
    #jfNotifModal .monwui-issue-btn.is-danger { background: #c0392b; color: #fff; }
    #jfNotifModal .monwui-issue-btn.is-ghost { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.16); color: inherit; }
    #jfNotifModal .jf-notif-tab[data-tab="${TAB_KEY}"] { align-items: center; display: inline-flex; flex-direction: column-reverse; gap: 6px; }
    #jfNotifModal .monwui-issues-tab-badge {
      align-items: center; background: #ffbf5f; border-radius: 999px; color: #111;
      display: inline-flex; font-size: 11px; font-weight: 850; height: 18px;
      justify-content: center; line-height: 1; min-width: 18px; padding: 0 6px;
    }
    #jfNotifModal .monwui-issues-tab-badge[hidden] { display: none !important; }
    @media (prefers-reduced-motion: reduce) {
      #jfNotifModal .monwui-issue-row { transition-duration: .01ms !important; }
    }
  `;
  document.head.appendChild(style);
}

function panelHost() {
  return document.getElementById("monwuiSerrIssuesHost");
}

function isPanelVisible() {
  const pane = document.querySelector(`#jfNotifModal .jf-notif-tab-content[data-tab="${TAB_KEY}"]`);
  return !!pane && pane.style.display !== "none";
}

function openIssueCount() {
  return cachedIssues.filter((issue) => !isResolved(issue)).length;
}

function renderTabBadge() {
  const tab = document.querySelector(`#jfNotifModal .jf-notif-tab[data-tab="${TAB_KEY}"]`);
  if (!tab) return;

  let label = tab.querySelector(".monwui-issues-tab-label");
  let badge = tab.querySelector(".monwui-issues-tab-badge");
  if (!label || !badge) {
    tab.textContent = "";
    label = document.createElement("span");
    label.className = "monwui-issues-tab-label";
    badge = document.createElement("span");
    badge.className = "monwui-issues-tab-badge";
    badge.setAttribute("aria-hidden", "true");
    tab.append(label, badge);
  }

  label.textContent = L("issuesTab", "Problemas");
  const count = openIssueCount();
  badge.textContent = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
  badge.hidden = count <= 0;
}

function listRowHtml(issue) {
  const meta = cachedMeta(issue);
  const poster = posterUrl(meta);
  const resolved = isResolved(issue);
  const year = text(meta?.year);
  const message = issueMessage(issue);
  const sub = [issueTypeText(issue), authorName(issue), formatDate(issue?.createdAt)].filter(Boolean).join(" · ");

  return `
    <button type="button" class="monwui-issue-row" data-issue-id="${escapeHtml(String(issueId(issue)))}">
      ${poster
        ? `<img class="monwui-issue-poster" src="${escapeHtml(poster)}" alt="" loading="lazy" width="46" height="69">`
        : `<span class="monwui-issue-poster" aria-hidden="true"></span>`}
      <span class="monwui-issue-main">
        <span class="monwui-issue-title">${escapeHtml(issueTitle(issue))}${year ? ` (${escapeHtml(year)})` : ""}</span>
        <span class="monwui-issue-sub">${escapeHtml(sub)}</span>
        ${message ? `<span class="monwui-issue-msg">${escapeHtml(message)}</span>` : ""}
      </span>
      <span class="monwui-issue-badge ${resolved ? "is-resolved" : "is-open"}">${escapeHtml(statusText(issue))}</span>
    </button>
  `;
}

function renderList() {
  const host = panelHost();
  if (!host) return;

  if (!cachedIssues.length) {
    host.innerHTML = `<div class="monwui-issue-empty">${escapeHtml(L("issuesEmpty", "No hay problemas reportados."))}</div>`;
    return;
  }

  host.innerHTML = cachedIssues.map(listRowHtml).join("");

  // Titles and posters arrive after the rows do; re-render once they land rather than blocking the
  // list on a metadata round trip per issue.
  const pending = cachedIssues.filter((issue) => mediaKey(issue) && !metadataCache.has(mediaKey(issue)));
  if (!pending.length) return;
  Promise.all(pending.map((issue) => resolveMediaMeta(issue).catch(() => null))).then(() => {
    if (!openIssueId && isPanelVisible()) renderList();
  });
}

function commentsHtml(issue) {
  const comments = Array.isArray(issue?.comments) ? issue.comments : [];
  // The first comment is the report body itself, already shown as the description.
  const rest = comments.slice(1);
  if (!rest.length) {
    return `<div class="monwui-issue-empty">${escapeHtml(L("issuesNoComments", "Sin comentarios."))}</div>`;
  }

  return rest.map((comment) => `
    <div class="monwui-issue-comment">
      <div class="monwui-issue-comment-head">${escapeHtml([
        text(comment?.user?.displayName || comment?.user?.username || comment?.user?.email, "—"),
        formatDate(comment?.createdAt)
      ].filter(Boolean).join(" · "))}</div>
      <div class="monwui-issue-body">${escapeHtml(text(comment?.message))}</div>
    </div>
  `).join("");
}

function renderDetail() {
  const host = panelHost();
  if (!host || !openIssue) return;

  const meta = cachedMeta(openIssue);
  const poster = posterUrl(meta);
  const year = text(meta?.year);
  const resolved = isResolved(openIssue);
  const description = issueMessage(openIssue);
  const id = issueId(openIssue);

  host.innerHTML = `
    <button type="button" class="monwui-issue-back" data-issues-back>← ${escapeHtml(L("issuesBackToList", "Volver"))}</button>
    <div class="monwui-issue-detail-head">
      ${poster ? `<img src="${escapeHtml(poster)}" alt="" loading="lazy" width="78" height="117">` : `<span></span>`}
      <div>
        <div class="monwui-issue-badge ${resolved ? "is-resolved" : "is-open"}" style="display:inline-block;margin-bottom:6px;">${escapeHtml(statusText(openIssue))}</div>
        <div class="monwui-issue-detail-title">${escapeHtml(issueTitle(openIssue))}${year ? ` (${escapeHtml(year)})` : ""}</div>
        <div class="monwui-issue-sub">#${escapeHtml(String(id))} · ${escapeHtml(issueTypeText(openIssue))} · ${escapeHtml(L("issuesOpenedBy", "abierto por"))} ${escapeHtml(authorName(openIssue))}${
          formatDate(openIssue?.createdAt) ? ` · ${escapeHtml(formatDate(openIssue.createdAt))}` : ""
        }</div>
      </div>
    </div>

    <div class="monwui-issue-section-title">${escapeHtml(L("issuesDescription", "Descripción"))}</div>
    <div class="monwui-issue-body">${escapeHtml(description || L("issuesNoDescription", "—"))}</div>

    <div class="monwui-issue-section-title">${escapeHtml(L("issuesCommentsTitle", "Comentarios"))}</div>
    ${commentsHtml(openIssue)}

    ${cachedIsAdmin ? `
      <div class="monwui-issue-composer">
        <textarea data-issue-comment maxlength="${MAX_COMMENT_LENGTH}" placeholder="${escapeHtml(L("issuesCommentPlaceholder", "Añadir un comentario..."))}"></textarea>
        <div class="monwui-issue-actions">
          <button type="button" class="monwui-issue-btn ${resolved ? "is-ghost" : "is-danger"}" data-issue-status="${resolved ? "open" : "resolved"}">
            ${escapeHtml(resolved ? L("issuesReopenButton", "Reabrir problema") : L("issuesCloseButton", "Cerrar problema"))}
          </button>
          <button type="button" class="monwui-issue-btn is-primary" data-issue-comment-send>
            ${escapeHtml(L("issuesCommentButton", "Comentar"))}
          </button>
        </div>
      </div>
    ` : ""}
  `;
}

function render() {
  if (openIssueId && openIssue) renderDetail();
  else renderList();
  renderTabBadge();
}

async function openDetail(id) {
  const host = panelHost();
  if (!host) return;

  // Going back, or opening another issue, while this fetch is in flight must not have the stale
  // response paint itself over whatever the user is looking at now.
  const seq = ++detailSeq;
  openIssueId = id;
  openIssue = null;
  host.innerHTML = `<div class="monwui-issue-empty">${escapeHtml(L("loadingText", "Cargando..."))}</div>`;

  try {
    const data = await getSerrIssue(id);
    if (seq !== detailSeq) return;
    const issue = data?.issue || null;
    if (typeof data?.isAdmin === "boolean") cachedIsAdmin = data.isAdmin;
    if (!issue) throw new Error(L("issuesLoadFailed", "No se pudo cargar el problema."));
    await resolveMediaMeta(issue).catch(() => null);
    if (seq !== detailSeq) return;
    openIssue = issue;
    renderDetail();
  } catch (error) {
    if (seq !== detailSeq) return;
    openIssueId = 0;
    openIssue = null;
    notify(error?.message || L("issuesLoadFailed", "No se pudo cargar el problema."), "error");
    renderList();
  }
}

function backToList() {
  detailSeq++;
  openIssueId = 0;
  openIssue = null;
  renderList();
}

async function submitComment(button) {
  const host = panelHost();
  const field = host?.querySelector("[data-issue-comment]");
  const message = text(field?.value);
  if (!message) return;
  if (detailBusy) return;

  detailBusy = true;
  button.disabled = true;
  try {
    await commentSerrIssue(openIssueId, message);
    if (field) field.value = "";
    await openDetail(openIssueId);
    // The list still holds the pre-comment copy of this issue.
    void refresh({ render: false });
  } catch (error) {
    notify(error?.message || L("issuesCommentFailed", "No se pudo publicar el comentario."), "error");
  } finally {
    detailBusy = false;
    if (button.isConnected) button.disabled = false;
  }
}

async function submitStatus(button, status) {
  if (detailBusy) return;
  detailBusy = true;
  button.disabled = true;
  try {
    await setSerrIssueStatus(openIssueId, status);
    await refresh({ render: false });
    await openDetail(openIssueId);
  } catch (error) {
    notify(error?.message || L("issuesStatusFailed", "No se pudo cambiar el estado."), "error");
  } finally {
    detailBusy = false;
    if (button.isConnected) button.disabled = false;
  }
}

function bindPane(pane) {
  if (!pane || pane.__monwuiIssuesBound) return;
  pane.__monwuiIssuesBound = true;

  pane.addEventListener("click", (event) => {
    const row = event.target?.closest?.("[data-issue-id]");
    if (row && pane.contains(row)) {
      const id = Number(row.getAttribute("data-issue-id"));
      if (Number.isFinite(id) && id > 0) void openDetail(id);
      return;
    }

    if (event.target?.closest?.("[data-issues-back]")) {
      backToList();
      return;
    }

    const statusBtn = event.target?.closest?.("[data-issue-status]");
    if (statusBtn && pane.contains(statusBtn)) {
      void submitStatus(statusBtn, statusBtn.getAttribute("data-issue-status") || "resolved");
      return;
    }

    const sendBtn = event.target?.closest?.("[data-issue-comment-send]");
    if (sendBtn && pane.contains(sendBtn)) {
      void submitComment(sendBtn);
    }
  });
}

async function refresh({ render: shouldRender = false } = {}) {
  if (!moduleEnabled()) {
    cachedIssues = [];
    cachedIsAdmin = false;
    cachedSupported = false;
    return null;
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const data = await listSerrIssues();
      cachedSupported = data?.ok !== false;
      cachedIsAdmin = data?.isAdmin === true;
      cachedIssues = Array.isArray(data?.issues) ? data.issues : [];
      return data;
    } catch {
      cachedSupported = false;
      cachedIssues = [];
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  const result = await refreshPromise;
  if (shouldRender) render();
  return result;
}

/**
 * Always shown once the module is enabled and reachable — admins see every issue, regular users
 * see only their own (server-scoped, see SerrController.ListIssues) plus renderList()'s empty
 * state when they have not reported anything yet.
 */
function shouldShowTab() {
  return moduleEnabled() && cachedSupported;
}

export function removeSerrIssuesTab() {
  const tab = document.querySelector(`#jfNotifModal .jf-notif-tab[data-tab="${TAB_KEY}"]`);
  const pane = document.querySelector(`#jfNotifModal .jf-notif-tab-content[data-tab="${TAB_KEY}"]`);
  const wasActive = tab?.classList?.contains("active") === true || (pane ? pane.style.display !== "none" : false);
  tab?.remove?.();
  pane?.remove?.();
  openIssueId = 0;
  openIssue = null;
  // Removing the active tab would otherwise leave the panel showing nothing at all.
  if (wasActive) {
    const first = document.querySelector("#jfNotifModal .jf-notif-tab");
    first?.click?.();
  }
}

/**
 * Unlike the Seerr requests tab, whether this tab exists at all depends on fetched data, so the
 * whole thing is async and the callers in notifications.js fire it without awaiting.
 */
export async function ensureSerrIssuesTab({ bindNotifTabButton } = {}) {
  if (!moduleEnabled()) {
    removeSerrIssuesTab();
    return;
  }

  // Bail before the network call when there is no panel to hang the tab on: this runs on every
  // settings sync, not just when the panel opens.
  const tabs = document.querySelector("#jfNotifModal .jf-notif-tabs");
  const contentHost = document.querySelector("#jfNotifModal .jf-notif-content");
  if (!tabs || !contentHost) return;

  await refresh({ render: false });

  if (!shouldShowTab()) {
    removeSerrIssuesTab();
    return;
  }

  ensureStyles();

  if (!tabs.querySelector(`[data-tab="${TAB_KEY}"]`)) {
    const btn = document.createElement("button");
    btn.className = "jf-notif-tab";
    btn.setAttribute("data-tab", TAB_KEY);
    tabs.appendChild(btn);
    bindNotifTabButton?.(btn);
  }

  let pane = contentHost.querySelector(`.jf-notif-tab-content[data-tab="${TAB_KEY}"]`);
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "jf-notif-tab-content";
    pane.setAttribute("data-tab", TAB_KEY);
    pane.style.display = "none";
    pane.innerHTML = `<div class="monwui-issues-host" id="monwuiSerrIssuesHost"></div>`;
    contentHost.appendChild(pane);
  }

  bindPane(pane);
  render();

  if (!document.querySelector("#jfNotifModal .jf-notif-tab.active")) {
    document.querySelector("#jfNotifModal .jf-notif-tab")?.click?.();
  }
}

export function refreshSerrIssues(options = {}) {
  return refresh(options);
}
