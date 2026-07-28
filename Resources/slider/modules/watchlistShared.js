import { getConfig } from "./config.js";

// The small, dependency-light slice of the watchlist that the home page needs before it can
// paint: button labels and "is this item on the list?".
//
// watchlist.js is ~260 KB and statically pulls in seerr/itemPageBridge.js for another ~137 KB,
// almost all of it modal, sharing and tab UI that is not needed until the user opens something.
// Splitting these few helpers out keeps that ~400 KB off the first-load path while leaving the
// watchlist's own state where it lives, in watchlist.js.

function cfg() {
  return getConfig?.() || {};
}

function labels() {
  return cfg()?.languageLabels || {};
}

export function getWatchlistLabel(key, fallback) {
  const map = labels();
  const value = map?.[key];
  return (typeof value === "string" && value.trim()) ? value : fallback;
}

export function normalizeText(value, fallback = "") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

const L = getWatchlistLabel;
const text = normalizeText;

export function getItemTypeName(itemLike) {
  return text(
    itemLike?.Type ||
    itemLike?.ItemType ||
    itemLike?.type ||
    itemLike?.itemType
  ).toLowerCase();
}

function getItemMediaTypeName(itemLike) {
  return text(
    itemLike?.MediaType ||
    itemLike?.mediaType
  ).toLowerCase();
}

export function isMusicAlbumItem(itemLike) {
  return getItemTypeName(itemLike) === "musicalbum";
}

export function isCollectionItem(itemLike) {
  const type = getItemTypeName(itemLike);
  return type === "boxset" || type === "collectionfolder";
}

export function isSeriesItem(itemLike) {
  const type = getItemTypeName(itemLike);
  return type === "series" || type === "season" || type === "episode";
}

export function isMusicItem(itemLike) {
  const type = getItemTypeName(itemLike);
  const mediaType = getItemMediaTypeName(itemLike);
  if (type === "musicalbum") return false;
  if (mediaType === "audio") return true;
  return [
    "audio",
    "musicartist",
    "musicvideo",
    "playlist",
    "folder",
    "audiobook"
  ].includes(type);
}

export function getWatchlistButtonText(itemLike, inWatchlist) {
  if (inWatchlist) {
    return isMusicAlbumItem(itemLike)
      ? L("watchlistAlbumRemove", "Albüm listesinden çıkar")
      : L("watchlistRemove", "Listeden çıkar");
  }

  return isMusicAlbumItem(itemLike)
    ? L("watchlistAlbumAdd", "Albüm listeme ekle")
    : L("watchlistAdd", "Listeme ekle");
}

export function getWatchlistButtonTitle(itemLike, inWatchlist) {
  return getWatchlistButtonText(itemLike, inWatchlist);
}

export function getWatchlistToast(itemLike, added) {
  if (added) {
    return isMusicAlbumItem(itemLike)
      ? L("watchlistAlbumAdded", "Albüm listene eklendi")
      : L("watchlistAdded", "Öğe listene eklendi");
  }

  return isMusicAlbumItem(itemLike)
    ? L("watchlistAlbumRemoved", "Albüm listenden çıkarıldı")
    : L("watchlistRemoved", "Öğe listenden çıkarıldı");
}

export function getWatchlistTabKey(itemLike) {
  if (isMusicAlbumItem(itemLike)) return "albums";
  if (isCollectionItem(itemLike)) return "collections";
  if (isSeriesItem(itemLike)) return "series";
  if (isMusicItem(itemLike)) return "music";
  return "movies";
}

// Membership is owned by watchlist.js, which republishes the set here every time it rebuilds it.
// Readers therefore never have to load watchlist.js just to ask whether an item is on the list.
let membershipSet = null;

export function publishWatchlistMembership(set) {
  membershipSet = set instanceof Set ? set : null;
}

/**
 * Whether an item is on the watchlist, per the last published membership set.
 *
 * Returns `fallback` when membership has not been loaded yet — the same answer this gave before
 * the split, when the dashboard cache was still null. Callers that need a definitive answer
 * already await `ensureWatchlistLoaded()` first.
 */
export function getCachedWatchlistMembership(itemId, fallback = false) {
  const id = text(itemId);
  if (!id) return !!fallback;
  if (membershipSet instanceof Set) return membershipSet.has(id);
  return !!fallback;
}
