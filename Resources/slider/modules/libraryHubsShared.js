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

    __cache = { at: Date.now(), items: categories };
    return categories;
  } catch (e) {
    console.warn("libraryHubs: category fetch error:", e);
    return Array.isArray(__cache.items) ? __cache.items : [];
  }
}
