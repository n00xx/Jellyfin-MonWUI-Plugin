// Live wiring of userContentProbe: one shared verdict per signed-in user, asked once per home
// visit by main.js and awaited by every module that mounts something on the home screen
// (slider, studio row, recent/continue/library rows, recommendations, director rows).
//
// A user with no visible content (an expired Neexy membership) gets jellyfin-web's own home
// only: the "My Media" card with the renewal QR. See userContentProbe.js for why.

import { getSessionInfo, makeApiRequest } from "../../Plugins/JMSFusion/runtime/api.js";
import { createUserContentProbe } from "./userContentProbe.js";

export const NO_CONTENT_ATTR = "data-jms-no-content";
export const USER_CONTENT_VERDICT_EVENT = "jms:user-content-verdict";

const probe = createUserContentProbe({
  request: (url) => makeApiRequest(url),
});

function currentUserId() {
  try {
    return String(getSessionInfo()?.userId || "").trim();
  } catch {
    return "";
  }
}

function applyVerdict(userId, hasContent) {
  if (userId !== currentUserId()) return;
  const root = document.documentElement;
  const wasNoContent = root.getAttribute(NO_CONTENT_ATTR) === "1";
  if (hasContent) {
    root.removeAttribute(NO_CONTENT_ATTR);
  } else {
    root.setAttribute(NO_CONTENT_ATTR, "1");
  }
  if (wasNoContent === !hasContent) return;
  try {
    window.dispatchEvent(new CustomEvent(USER_CONTENT_VERDICT_EVENT, {
      detail: { userId, hasContent },
    }));
  } catch {}
}

function checkAndApply(userId, options) {
  return probe.check(userId, options).then((hasContent) => {
    applyVerdict(userId, hasContent);
    return hasContent;
  });
}

/**
 * Asks again for the signed-in user. Called at every home boot so a renewed membership shows
 * up on the next home visit; a positive answer is cached for the page, so for a paying user
 * this costs one request per page load.
 */
export function refreshUserContentVerdict() {
  const userId = currentUserId();
  if (!userId) {
    try { document.documentElement.removeAttribute(NO_CONTENT_ATTR); } catch {}
    return Promise.resolve(true);
  }
  return checkAndApply(userId, { refresh: true });
}

/**
 * Resolves false only when the signed-in user can see nothing. Never rejects, and every doubt
 * resolves true. Mount entry points await this before touching the DOM.
 */
export function userHasHomeContent() {
  const userId = currentUserId();
  if (!userId) return Promise.resolve(true);
  const known = probe.peek(userId);
  if (known !== undefined) return probe.whenKnown(userId);
  return checkAndApply(userId);
}

/** Synchronous view for timers and observers: true only after a "no content" verdict. */
export function isNoContentHome() {
  const userId = currentUserId();
  return !!userId && probe.peek(userId) === false;
}
