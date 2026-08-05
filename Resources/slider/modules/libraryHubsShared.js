import { getSessionInfo, makeApiRequest } from "../../Plugins/JMSFusion/runtime/api.js";
import { getConfig } from "./config.js";

/**
 * Shared helpers for the Library Hubs home rows.
 *
 * Categories are the user's Jellyfin libraries, enumerated at runtime rather than
 * hardcoded, so the feature keeps working when a dataset is renamed or added.
 * The settings panel imports this module instead of recentRows.js to avoid
 * pulling the full row renderer into the settings bundle.
 */

export const LIBRARY_HUBS_DEFAULT_EXCLUDED_NAMES = Object.freeze(["Downloads"]);
export const LIBRARY_HUBS_DEFAULT_CARD_COUNT = 12;

const LIBRARY_HUBS_CACHE_TTL_MS = 60_000;

/**
 * Display order for the category rows, by normalized name. Anything not listed
 * here sorts after these but before the collections row, keeping its original
 * order, so a newly added library shows up without a code change.
 */
const LIBRARY_HUBS_NAME_ORDER = Object.freeze([
  "peliculas",
  "series",
  "doramas",
  "anime",
  "donghuas",
  "shows",
  "documentales"
]);

/** Collections always sorts last, whatever the library is named. */
const LIBRARY_HUBS_COLLECTIONS_RANK = Number.MAX_SAFE_INTEGER;
const LIBRARY_HUBS_UNLISTED_RANK = LIBRARY_HUBS_NAME_ORDER.length;

/** Strips accents and case so "Peliculas" with or without the accent match. */
function normalizeCategoryName(name) {
  return String(name || "")
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function isLibraryHubCollections(lib) {
  if (String(lib?.CollectionType || "").trim().toLowerCase() === "boxsets") return true;
  return normalizeCategoryName(lib?.Name) === "collections";
}

/**
 * True when the display order names this library explicitly. Lets callers tell a
 * library the user expects in a specific slot apart from one that merely sorts after.
 */
export function isOrderedCategoryName(name) {
  return LIBRARY_HUBS_NAME_ORDER.includes(normalizeCategoryName(name));
}

function getLibraryHubOrderRank(lib) {
  if (isLibraryHubCollections(lib)) return LIBRARY_HUBS_COLLECTIONS_RANK;
  const index = LIBRARY_HUBS_NAME_ORDER.indexOf(normalizeCategoryName(lib?.Name));
  return index >= 0 ? index : LIBRARY_HUBS_UNLISTED_RANK;
}

/**
 * Orders the category rows for display. Shared by the settings panel and the
 * home rows so the two never disagree; returns a new array rather than sorting
 * the caller's in place.
 */
export function sortLibraryHubCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .map((lib, index) => ({ lib, index, rank: getLibraryHubOrderRank(lib) }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((entry) => entry.lib);
}

let __cache = { at: 0, items: null };

function readJsonArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw === "[object Object]") return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.map((x) => String(x || "").trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export function getLibraryHubsExcludedNames() {
  const fromLs = readJsonArray("libraryHubsExcludedNames");
  const cfg = getConfig?.() || {};
  const fromCfg = Array.isArray(cfg.libraryHubsExcludedNames) ? cfg.libraryHubsExcludedNames : null;
  const list = (fromLs && fromLs.length)
    ? fromLs
    : ((fromCfg && fromCfg.length) ? fromCfg : LIBRARY_HUBS_DEFAULT_EXCLUDED_NAMES);
  return list.map((x) => String(x || "").trim()).filter(Boolean);
}

export function getLibraryHubsHiddenIds() {
  const fromLs = readJsonArray("libraryHubsHidden");
  if (fromLs) return fromLs;
  const cfg = getConfig?.() || {};
  const fromCfg = Array.isArray(cfg.libraryHubsHidden) ? cfg.libraryHubsHidden : [];
  return fromCfg.map((x) => String(x || "").trim()).filter(Boolean);
}

export function isLibraryHubExcluded(name, excludedNames = getLibraryHubsExcludedNames()) {
  const target = String(name || "").trim().toLowerCase();
  if (!target) return false;
  return excludedNames.some((x) => String(x).trim().toLowerCase() === target);
}

export function clearLibraryHubCategoriesCache() {
  __cache = { at: 0, items: null };
}

/**
 * Returns the selectable categories: every Jellyfin library minus the excluded
 * utility folders. Hidden (unchecked) categories are still returned here so the
 * settings panel can render their unchecked checkbox.
 */
export async function fetchLibraryHubCategories({ force = false } = {}) {
  const fresh = !force
    && Array.isArray(__cache.items)
    && (Date.now() - __cache.at) <= LIBRARY_HUBS_CACHE_TTL_MS;
  if (fresh) return __cache.items;

  const { userId } = getSessionInfo() || {};
  if (!userId) return [];

  try {
    const data = await makeApiRequest(`/Users/${userId}/Views`);
    const items = Array.isArray(data?.Items) ? data.Items : [];
    const excluded = getLibraryHubsExcludedNames();

    const categories = items
      .filter((x) => x?.Id)
      .map((x) => ({
        Id: String(x.Id),
        Name: x.Name || "",
        CollectionType: String(x.CollectionType || "")
      }))
      .filter((x) => !isLibraryHubExcluded(x.Name, excluded));

    __cache = { at: Date.now(), items: sortLibraryHubCategories(categories) };
    return __cache.items;
  } catch (e) {
    console.warn("libraryHubs: category fetch error:", e);
    return Array.isArray(__cache.items) ? __cache.items : [];
  }
}
