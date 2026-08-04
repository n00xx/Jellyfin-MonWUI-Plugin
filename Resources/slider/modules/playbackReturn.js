/**
 * Sends the player's back arrow to the item's details page instead of the home page.
 *
 * Playback started from a slide or a row card is a programmatic playNow() call: nothing ever
 * pushed a details entry onto the history stack, so Jellyfin's back arrow unwinds to whatever was
 * underneath — the home page — and the user loses the title they were just watching.
 *
 * Rather than cancel the native navigation and take over the player teardown, this records the
 * intent when the arrow is clicked and acts once the route has actually settled. Jellyfin still
 * tears the player down exactly as it always did; the details view is opened afterwards.
 */

import { isArrowBackButton } from "./muiBackButton.js";
import { openDetailsModal } from "./detailsModalLoader.js";

const PLAYBACK_START_REQUESTED_EVENT = "jms:playback-start-requested";
const PLAYER_CONTAINER_SELECTOR = ".videoPlayerContainer";
/**
 * Jellyfin unwinds the history and tears the player down asynchronously, and how long that takes
 * depends on the device — so the details view waits for the player to actually leave the DOM
 * rather than betting on a single fixed delay. Polled, with a ceiling: if the player is still
 * there when the budget runs out the navigation never happened (the arrow closed a menu, or
 * playback re-entered) and native behaviour is left alone.
 */
const PLAYER_EXIT_POLL_MS = 60;
const PLAYER_EXIT_BUDGET_MS = 2000;
/**
 * A remembered item older than this is not what the user is looking at any more — playback was
 * abandoned in another tab or a previous session. Past that, the arrow keeps native behaviour.
 */
const REMEMBERED_ITEM_TTL_MS = 12 * 60 * 60 * 1000;

let rememberedItemId = "";
let rememberedAt = 0;
let returnTimer = 0;
let initialized = false;

/**
 * The id the *user* asked for, not the leaf playNow resolved to: playNow fires this before it
 * walks a Series down to an episode, so pressing back on a series lands on the series rather than
 * on episode 4 of season 2, which is where the user actually came from.
 */
function rememberPlaybackItem(itemId) {
  const id = String(itemId || "").trim();
  if (!id) return;
  rememberedItemId = id;
  rememberedAt = Date.now();
}

function readRememberedItem() {
  if (!rememberedItemId) return "";
  if (Date.now() - rememberedAt > REMEMBERED_ITEM_TTL_MS) {
    rememberedItemId = "";
    rememberedAt = 0;
    return "";
  }
  return rememberedItemId;
}

function isPlayerOnScreen() {
  try {
    return !!document.querySelector(PLAYER_CONTAINER_SELECTOR);
  } catch {
    return false;
  }
}

function cancelPendingReturn() {
  if (!returnTimer) return;
  try { window.clearTimeout(returnTimer); } catch {}
  returnTimer = 0;
}

/**
 * Waits for the player to actually leave the DOM before opening the details view, so the modal
 * never lands on the page that is about to be replaced — and never opens over a player that is
 * still running.
 */
function scheduleDetailsReturn(itemId) {
  cancelPendingReturn();

  const deadline = Date.now() + PLAYER_EXIT_BUDGET_MS;

  const tick = async () => {
    returnTimer = 0;

    if (isPlayerOnScreen()) {
      if (Date.now() >= deadline) return;
      returnTimer = window.setTimeout(tick, PLAYER_EXIT_POLL_MS);
      return;
    }

    // Consumed either way: a failed open must not leave the arrow armed for a later, unrelated
    // navigation. openDetailsModal falls back to the native #/details route on its own.
    rememberedItemId = "";
    rememberedAt = 0;

    try {
      await openDetailsModal({ itemId });
    } catch (error) {
      console.warn("[JMSFusion] Details return after playback failed:", error);
    }
  };

  returnTimer = window.setTimeout(tick, PLAYER_EXIT_POLL_MS);
}

function handleBackButtonClick(event) {
  try {
    if (!isPlayerOnScreen()) return;

    const button = event.target?.closest?.("button");
    if (!button || !isArrowBackButton(button)) return;

    const itemId = readRememberedItem();
    if (!itemId) return;

    scheduleDetailsReturn(itemId);
  } catch (error) {
    console.warn("[JMSFusion] Playback return click handler error:", error);
  }
}

export function initPlaybackReturn() {
  if (initialized) return () => {};
  initialized = true;

  const onPlaybackStartRequested = (event) => rememberPlaybackItem(event?.detail?.itemId);
  // Capture phase: Jellyfin's own handler navigates away, and a bubbling listener on a detached
  // subtree may never run.
  const onClick = (event) => handleBackButtonClick(event);

  window.addEventListener(PLAYBACK_START_REQUESTED_EVENT, onPlaybackStartRequested);
  document.addEventListener("click", onClick, true);

  return () => {
    window.removeEventListener(PLAYBACK_START_REQUESTED_EVENT, onPlaybackStartRequested);
    document.removeEventListener("click", onClick, true);
    cancelPendingReturn();
    initialized = false;
  };
}
