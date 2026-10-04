// "Can this user see any item at all?" — asked once per home visit. No imports on purpose, so
// it can be unit-tested on its own (tests/userContentProbe.test.mjs); userContentGate.js wires
// it to the live API.
//
// On Neexy an expired membership does not disable the account. It cuts the user's library
// access down to one EMPTY library whose image is the renewal QR, so jellyfin-web's own
// "My Media" card is the whole screen. moui has nothing to add there: its slider, studio row and
// home rows would only mount empty shells (and, before v3.7.1.34, loop doing so).
//
// The answer comes from content, never from a library name: does any library the user can see
// hold anything? Every doubt — network error, timeout, a response we do not understand, a
// missing count — answers "has content", so a paying user can never lose moui to a hiccup.
//
// Why the library views and not /Items: measured on tv.neexy.net (12.1, 12,504 items), the views
// with ChildCount answer in 20-80 ms, while a recursive /Items count took 1.7-3.4 s, and every
// home row waits on this answer. /Items also ignored IsFolder=false there, so an expired user's
// leftover playlists came back as 3 "items".

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_NEGATIVE_TTL_MS = 60_000;

// Views whose children are not titles moui can show on its own: playlists and collections point
// at titles in libraries (an expired user keeps old playlists), Live TV and photos have no row.
const NON_CONTENT_COLLECTION_TYPES = new Set([
  "playlists",
  "boxsets",
  "livetv",
  "photos",
  "channels",
]);

export function buildUserContentProbeUrl(userId) {
  return `/Users/${encodeURIComponent(String(userId || ""))}/Views?Fields=ChildCount`;
}

/** true = some library the user can see has children. Anything unexpected is "true" (fail-open). */
export function interpretUserContentProbe(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.Items)) return true;
  const contentViews = payload.Items.filter((view) => (
    !NON_CONTENT_COLLECTION_TYPES.has(String(view?.CollectionType || "").toLowerCase())
  ));
  return contentViews.some((view) => {
    const count = Number(view?.ChildCount);
    if (view?.ChildCount == null || !Number.isFinite(count)) return true;
    return count > 0;
  });
}

function withTimeout(promise, timeoutMs) {
  let timer = 0;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("user content probe timed out")), timeoutMs);
    }),
  ]);
}

/**
 * @param {object} deps
 * @param {(url: string) => Promise<any>} deps.request  resolves the parsed JSON, throws on error
 * @param {() => number} [deps.now]
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.negativeTtlMs]  how long a "no content" answer is reused without asking.
 *   A positive answer is kept for the page's lifetime: content does not vanish mid-session, and
 *   re-asking would add a request to every home visit of every paying user.
 */
export function createUserContentProbe({
  request,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
} = {}) {
  const known = new Map();
  const inFlight = new Map();

  function peek(userId) {
    const entry = known.get(String(userId || ""));
    if (!entry) return undefined;
    if (entry.hasContent) return true;
    if (now() - entry.at > negativeTtlMs) return undefined;
    return false;
  }

  function check(userId, { refresh = false } = {}) {
    const key = String(userId || "").trim();
    if (!key || typeof request !== "function") return Promise.resolve(true);

    const cached = peek(key);
    if (cached === true) return Promise.resolve(true);
    if (cached === false && !refresh) return Promise.resolve(false);

    const pending = inFlight.get(key);
    if (pending) return pending;

    const run = withTimeout(Promise.resolve().then(() => request(buildUserContentProbeUrl(key))), timeoutMs)
      .then((payload) => {
        const hasContent = interpretUserContentProbe(payload);
        known.set(key, { hasContent, at: now() });
        return hasContent;
      })
      .catch(() => true)
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, run);
    return run;
  }

  /** The answer of the check in flight, the remembered answer, or "has content" if neither. */
  function whenKnown(userId) {
    const key = String(userId || "").trim();
    const pending = inFlight.get(key);
    if (pending) return pending;
    const cached = peek(key);
    return Promise.resolve(cached === false ? false : true);
  }

  return { check, peek, whenKnown };
}
