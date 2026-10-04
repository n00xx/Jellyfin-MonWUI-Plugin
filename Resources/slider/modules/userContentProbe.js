// "Can this user see any item at all?" — asked once per home visit. No imports on purpose, so
// it can be unit-tested on its own (tests/userContentProbe.test.mjs); userContentGate.js wires
// it to the live API.
//
// On Neexy an expired membership does not disable the account. It cuts the user's library
// access down to one EMPTY library whose image is the renewal QR, so jellyfin-web's own
// "My Media" card is the whole screen. moui has nothing to add there: its slider, studio row and
// home rows would only mount empty shells (and, before v3.7.1.34, loop doing so).
//
// The answer comes from content, never from a library name. Every doubt — network error,
// timeout, a response we do not understand — answers "has content", so a paying user can never
// lose moui to a hiccup.

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_NEGATIVE_TTL_MS = 60_000;

export function buildUserContentProbeUrl(userId) {
  const params = new URLSearchParams({
    userId: String(userId || ""),
    Recursive: "true",
    IsFolder: "false",
    Limit: "1",
    EnableTotalRecordCount: "true",
    EnableImages: "false",
    EnableUserData: "false",
    Fields: "",
  });
  return `/Items?${params}`;
}

/** true = the user can see at least one item. Anything unexpected is "true" (fail-open). */
export function interpretUserContentProbe(payload) {
  if (!payload || typeof payload !== "object") return true;
  const items = Array.isArray(payload.Items) ? payload.Items : null;
  if (items && items.length > 0) return true;
  const total = Number(payload.TotalRecordCount);
  if (payload.TotalRecordCount != null && Number.isFinite(total)) return total > 0;
  if (items) return false;
  return true;
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
