// Shared retry policy for the managed home rows. No imports on purpose, so it can be
// unit-tested on its own (tests/homeRowRetry.test.mjs).
//
// Every row module (recentRows, personalRecommendations, directorRows) used to retry a row that
// rendered empty every 1.4 s with no limit. For a user who can see nothing — an expired Neexy
// membership leaves exactly one empty library — that loop never ends: the rows mount, find
// nothing, remove themselves and mount again, which is the "blink" on the expired screen, and
// each pass hits /Items again. The same loop caught paying users whose "Continue watching" was
// simply empty.
//
// The fix is to keep two questions apart:
// - "Did every row come back with nothing?" — a final answer. Settle, never retry.
// - "Did something fail or not finish?" — worth a few retries with backoff, then stop.

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1400;
const DEFAULT_MAX_DELAY_MS = 12_000;

function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Exponential backoff with a hard stop. `next()` returns the delay for the next retry, or
 * null once the budget is spent; `reset()` after a success.
 */
export function createRetryBudget({
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
} = {}) {
  const limit = Math.floor(positiveOr(maxAttempts, DEFAULT_MAX_ATTEMPTS));
  const base = positiveOr(baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const cap = Math.max(base, positiveOr(maxDelayMs, DEFAULT_MAX_DELAY_MS));
  let attempts = 0;

  return {
    next() {
      if (attempts >= limit) return null;
      const delay = Math.min(cap, base * 2 ** attempts);
      attempts += 1;
      return delay;
    },
    reset() {
      attempts = 0;
    },
    get attempts() {
      return attempts;
    },
  };
}

const OUTCOME_KINDS = new Set(["rendered", "empty", "error", "stale", "pending"]);

/**
 * Tally of how each planned row of one mount run ended.
 * - rendered: cards, cached cards or an explicit empty-state message are on screen
 * - empty:    the fetch succeeded and returned nothing, so the row removed itself
 * - error:    the fetch threw
 * - stale:    the render was superseded (navigation, newer mount) before it finished
 * - pending:  the fetch runs in the background and has not answered yet
 * Set `completed` once every planned row has been started.
 */
export function createRowOutcomeTracker(planned = 0) {
  return {
    planned: Math.max(0, Number(planned) || 0),
    completed: false,
    rendered: 0,
    empty: 0,
    error: 0,
    stale: 0,
    pending: 0,
  };
}

/**
 * Count one row's outcome. `resolvesPending` moves a row that was counted as pending to its
 * final kind once its background fetch answers.
 */
export function recordRowOutcome(tracker, kind, { resolvesPending = false } = {}) {
  if (!tracker || !OUTCOME_KINDS.has(kind)) return;
  if (resolvesPending && tracker.pending > 0) tracker.pending -= 1;
  tracker[kind] += 1;
}

/**
 * True only when the run finished and every row it planned reported a successful, empty fetch.
 * A row that never reported (it threw before fetching) does not count as empty.
 */
export function isRowSettledEmpty(tracker) {
  if (!tracker || tracker.completed !== true) return false;
  return (
    tracker.empty >= tracker.planned &&
    tracker.rendered === 0 &&
    tracker.error === 0 &&
    tracker.stale === 0 &&
    tracker.pending === 0
  );
}
