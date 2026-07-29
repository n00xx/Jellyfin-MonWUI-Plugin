import { getSerrMovieDetails, getSerrTvDetails, createSerrIssue, SERR_ISSUE_TYPE } from "./api.js";
import { getLanguageLabels } from "../../language/index.js";
import { showNotification } from "../player/ui/notification.js";

const OVERLAY_ID = "jmsSerrIssueOverlay";

const label = (key, fallback) => {
  try {
    const labels = getLanguageLabels() || {};
    const value = labels[key];
    return typeof value === "string" && value.trim() ? value : fallback;
  } catch {
    return fallback;
  }
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

// Fixed choices, no free text: the point is that reporting costs one click.
export const ISSUE_CHOICES = [
  { id: "playback", type: SERR_ISSUE_TYPE.VIDEO,    labelKey: "issueNoPlayback",   fallback: "No se reproduce" },
  { id: "audio",    type: SERR_ISSUE_TYPE.AUDIO,    labelKey: "issueNoAudio",      fallback: "No se escucha" },
  { id: "subs",     type: SERR_ISSUE_TYPE.SUBTITLE, labelKey: "issueNoSubtitles",  fallback: "Los subtítulos no se ven" },
  { id: "mismatch", type: SERR_ISSUE_TYPE.OTHER,    labelKey: "issueWrongContent", fallback: "El video no coincide con la descripción" },
  { id: "language", type: SERR_ISSUE_TYPE.AUDIO,    labelKey: "issueWrongLanguage", fallback: "Está en otro idioma" },
];

/**
 * Jellyseerr's issue API keys off its own internal media row id, which is not the TMDb id.
 * The metadata endpoints this plugin already proxies return it verbatim under mediaInfo.id,
 * so no extra lookup route is needed — but it is only present for titles Jellyseerr has scanned.
 * Returns 0 when the title is unknown to Jellyseerr, and the caller then hides the button.
 */
export async function resolveSerrMediaId({ tmdbId, kind }) {
  const id = Number(tmdbId);
  if (!Number.isFinite(id) || id <= 0) return 0;

  try {
    const details = kind === "tv"
      ? await getSerrTvDetails(id)
      : await getSerrMovieDetails(id);
    const mediaId = Number(details?.mediaInfo?.id);
    return Number.isFinite(mediaId) && mediaId > 0 ? mediaId : 0;
  } catch {
    return 0;
  }
}

function removeOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
}

/**
 * Opens the picker and resolves once the issue has been sent or the user backed out.
 * `title` is only used to build the message body Jellyseerr stores.
 */
export function openIssueReporter({ mediaId, title = "", seasonNumber = 0, episodeNumber = 0 } = {}) {
  removeOverlay();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "jms-issue-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label("issueReportTitle", "Reportar un problema"));

  overlay.innerHTML = `
    <div class="jms-issue-sheet">
      <div class="jms-issue-head">
        <div class="jms-issue-title">${escapeHtml(label("issueReportTitle", "Reportar un problema"))}</div>
        <button type="button" class="jms-issue-close" aria-label="${escapeHtml(label("closeButton", "Cerrar"))}">✕</button>
      </div>
      <div class="jms-issue-question">${escapeHtml(label("issueReportQuestion", "¿Qué problema presenta el video?"))}</div>
      <div class="jms-issue-options">
        ${ISSUE_CHOICES.map((choice) => `
          <button type="button" class="jms-issue-option" data-issue="${choice.id}">
            ${escapeHtml(label(choice.labelKey, choice.fallback))}
          </button>
        `).join("")}
      </div>
      <div class="jms-issue-status" aria-live="polite"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const statusEl = overlay.querySelector(".jms-issue-status");
  const optionsEl = overlay.querySelector(".jms-issue-options");

  const close = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    removeOverlay();
  };

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }
  document.addEventListener("keydown", onKeyDown, true);

  overlay.querySelector(".jms-issue-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  optionsEl?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.(".jms-issue-option");
    if (!button) return;

    const choice = ISSUE_CHOICES.find((c) => c.id === button.getAttribute("data-issue"));
    if (!choice) return;

    const choiceText = label(choice.labelKey, choice.fallback);
    optionsEl.querySelectorAll(".jms-issue-option").forEach((el) => { el.disabled = true; });
    button.classList.add("is-sending");
    if (statusEl) statusEl.textContent = label("issueReportSending", "Enviando...");

    try {
      await createSerrIssue({
        issueType: choice.type,
        mediaId,
        message: title ? `${choiceText} — ${title}` : choiceText,
        problemSeason: seasonNumber,
        problemEpisode: episodeNumber,
      });
      close();
      showNotification(
        `<i class="fa-solid fa-circle-check" style="margin-right:8px;"></i>${escapeHtml(label("issueReportSent", "Reporte enviado. Gracias."))}`,
        3000,
        "success"
      );
    } catch (error) {
      console.warn("[JMSFusion] Seerr issue report failed:", error);
      button.classList.remove("is-sending");
      optionsEl.querySelectorAll(".jms-issue-option").forEach((el) => { el.disabled = false; });
      if (statusEl) statusEl.textContent = label("issueReportFailed", "No se pudo enviar el reporte.");
    }
  });
}
