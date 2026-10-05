// Gives moui's overlays a history entry, so Android's Back button (history.back() inside the
// page) closes the overlay instead of navigating the page underneath it.
//
// The entry is pushed at the *same* URL. Jellyfin routes on the hash, so an unchanged hash means
// the SPA router never sees a route change: the entry exists only for Back to pop. The router's
// own history.state is spread forward and its `idx` is left alone, because this push does not
// notify the router and an incremented idx would collide with its next real push.
//
// Overlays stack (explorer -> details -> trailer). Each entry records its depth, and a popstate
// closes every overlay deeper than the entry it landed on, topmost first, so one Back closes one
// layer and history.go(-n) closes everything it skipped.

const DEPTH_KEY = "jmsOverlayDepth";
// Dispatched by playNow(), the cinema pre-roll and the parental PIN gate before they route to
// the player. An overlay that closes shortly after it is closing to navigate, so it may not pop.
// It is a window, not a drop: playNow() announces before it knows the outcome, and when playback
// does not start (PIN cancelled, membership expired) the overlay stays open and keeps its claim.
const PLAYBACK_START_REQUESTED_EVENT = "jms:playback-start-requested";
const PLAYBACK_NAVIGATION_WINDOW_MS = 3000;
let navigatingUntil = 0;
// How long to wait for our own history.back() to land before assuming it never will.
const BACK_SETTLE_MS = 1000;

const claims = [];
// Claims made while one of our back() calls is still in flight. Pushing then would hand the
// pending back() the new entry to pop, closing the overlay that just opened.
const deferred = [];
let pendingBacks = 0;
let pendingTimer = 0;
let listening = false;

function readDepth(state) {
  const depth = Number(state?.[DEPTH_KEY]);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

function currentDepth() {
  try {
    return readDepth(window.history.state);
  } catch {
    return 0;
  }
}

function withDepth(state, depth) {
  const { [DEPTH_KEY]: _previous, ...rest } = state || {};
  return depth > 0 ? { ...rest, [DEPTH_KEY]: depth } : rest;
}

function pushEntry(claim) {
  const depth = currentDepth() + 1;
  try {
    window.history.pushState(withDepth(window.history.state, depth), "", window.location.href);
    claim.depth = depth;
  } catch {
    // No entry means Back cannot reach this overlay, but release() and drop() still work.
    claim.depth = 0;
  }
}

function settlePendingBacks() {
  pendingBacks = 0;
  clearTimeout(pendingTimer);
  pendingTimer = 0;
  while (deferred.length) {
    const claim = deferred.shift();
    if (claims.includes(claim)) pushEntry(claim);
  }
}

function onPopState(event) {
  if (pendingBacks > 0) {
    pendingBacks -= 1;
    if (pendingBacks === 0) settlePendingBacks();
    return;
  }
  const landed = readDepth(event?.state);
  for (let i = claims.length - 1; i >= 0; i -= 1) {
    const claim = claims[i];
    if (!(claim.depth > landed)) continue;
    claims.splice(i, 1);
    try { claim.onBack(); } catch {}
  }
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", onPopState);
  window.addEventListener(PLAYBACK_START_REQUESTED_EVENT, () => {
    navigatingUntil = Date.now() + PLAYBACK_NAVIGATION_WINDOW_MS;
  });
}

function forget(claim) {
  const index = claims.indexOf(claim);
  if (index < 0) return null;
  claims.splice(index, 1);
  const waiting = deferred.indexOf(claim);
  if (waiting >= 0) {
    deferred.splice(waiting, 1);
    return { pushed: false, wasTop: false };
  }
  return { pushed: claim.depth > 0, wasTop: index === claims.length };
}

/**
 * Claims the Back button for an overlay that just opened.
 *
 * @param {string} key  one claim per overlay; claiming again while open keeps the same entry
 * @param {() => void} onBack  closes the overlay when Back pops its entry. It must not call
 *   release() itself (the claim is already gone by then); calling it is a harmless no-op.
 * @returns {{ release: () => void, drop: () => void }}
 *   release(): the overlay closed by itself (✕, Escape, backdrop) - its entry is popped so the
 *     next Back does what the user expects.
 *   drop(): the overlay closed because the caller is about to navigate - the entry is stripped
 *     in place, never popped, because an async history.back() would race that navigation and
 *     send the user backwards out of the page they just opened.
 */
export function claimBackButton(key, onBack) {
  listen();
  const existing = claims.find((claim) => claim.key === key);
  if (existing) {
    existing.onBack = onBack;
    return existing.handle;
  }

  const claim = { key, onBack, depth: 0, handle: null };
  claim.handle = {
    release() {
      if (Date.now() < navigatingUntil) {
        claim.handle.drop();
        return;
      }
      const gone = forget(claim);
      if (!gone?.pushed || !gone.wasTop) return;
      // Only pop an entry that is still ours. If the router pushed a route on top of it, the
      // user has moved on, and going back would move them again.
      if (currentDepth() - pendingBacks !== claim.depth) return;
      pendingBacks += 1;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(settlePendingBacks, BACK_SETTLE_MS);
      try {
        window.history.back();
      } catch {
        settlePendingBacks();
      }
    },
    drop() {
      const gone = forget(claim);
      if (!gone?.pushed || pendingBacks > 0 || currentDepth() !== claim.depth) return;
      try {
        window.history.replaceState(withDepth(window.history.state, claim.depth - 1), "", window.location.href);
      } catch {}
    },
  };
  claims.push(claim);

  if (pendingBacks > 0) deferred.push(claim);
  else pushEntry(claim);
  return claim.handle;
}

/** Gives up every claim in place, for a caller about to navigate (e.g. starting playback). */
export function dropAllBackClaims() {
  for (let i = claims.length - 1; i >= 0; i -= 1) claims[i].handle.drop();
}
