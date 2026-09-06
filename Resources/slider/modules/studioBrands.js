// Pure studio-brand matching. No imports on purpose: this is the one piece of
// studio logic worth unit-testing on its own, and every consumer (home row,
// settings page, diagnostics) must share it or they drift apart again.

function nameKey(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Single source of truth for studio brands.
 *
 * A brand is not a Jellyfin Studio entity — Jellyfin creates one entity per
 * distinct studio string found in metadata, so "Marvel" spans `Marvel Studios`,
 * `Marvel Entertainment`, `Marvel Animation`, ... A hub must union all of them,
 * otherwise it shows a fraction of the library (the original bug: the Marvel hub
 * resolved to `Marvel Entertainment` and showed 2 of 12 titles).
 *
 * Matching rules run against `normalizeStudioName` output and MUST use word
 * boundaries. A substring test for "dc" matches "Broa(dc)asting" and drags in
 * every Japanese broadcaster in the library.
 *
 * - `include`    — entity matches the brand if ANY pattern hits
 * - `includeAll` — entity matches only if EVERY pattern hits
 * - `exclude`    — entity is rejected if ANY pattern hits (wins over include)
 * - `aliases`    — extra spellings for canonicalization and TMDB logo lookup
 * - `seriesTags` — patterns matched against the library's *tag* vocabulary, not
 *                  against studio entities. See below.
 *
 * ## Why series need a second axis
 *
 * A brand's films carry it as a studio; its series usually do not. TMDB and TVDB
 * write the broadcasting *network* onto a series, not the production company, so
 * `StudioIds` for "Marvel Studios" returns every Marvel film and zero Marvel
 * series — the shows are filed under Disney+, Netflix, ABC, Hulu and FX. Unioning
 * those networks into the brand is not a fix: it would pull a platform's entire
 * catalogue into a hub (measured on the reference library: Netflix alone holds 102
 * series, of which six are Marvel).
 *
 * The precise signal is the TMDB keyword, which Jellyfin imports as a tag —
 * "marvel cinematic universe (mcu)" sits on exactly the 16 Marvel series and on
 * nothing else.
 *
 * `seriesTags` patterns MUST be specific to the franchise, never derived from the
 * brand name. Tag vocabularies are far noisier than studio names: a bare /dc/ over
 * the reference library's 1824 tags hits "washington dc, usa" (a filming location)
 * and "based on po(dc)ast". Same trap as the studio rules, one namespace over.
 *
 * A brand with no `seriesTags` keeps matching series by `StudioIds` alone. That is
 * correct for the brands that *are* networks — Netflix and Disney+ resolve their
 * series through the studio axis already.
 */
export const STUDIO_BRANDS = [
  {
    canonical: "Marvel Studios",
    aliases: ["marvel", "marvel entertainment", "marvel studios llc"],
    include: [/\bmarvel\b/],
    exclude: [/\bmarvel\s+music\b/],
    seriesTags: [/\bmarvel\b/]
  },
  {
    canonical: "Pixar",
    aliases: ["pixar animation studios", "disney pixar"],
    include: [/\bpixar\b/]
  },
  {
    canonical: "Walt Disney Pictures",
    aliases: ["walt disney"],
    // `^disney$` catches a bare "Disney" entity; `plus` keeps Disney+ separate,
    // `pixar` keeps "Disney Pixar" from swallowing the Pixar hub.
    include: [/\bwalt\s+disney\b/, /^disney$/],
    exclude: [/\bplus\b/, /\bpixar\b/]
  },
  {
    canonical: "Disney+",
    aliases: ["disney plus", "disney+ originals", "disney plus originals", "disney+ studio"],
    includeAll: [/\bdisney\b/, /\bplus\b/]
  },
  {
    canonical: "DC",
    // No bare /dc/ here: it hits "washington dc, usa" and "based on podcast".
    // Each pattern names the franchise outright.
    seriesTags: [/\bdc\s+universe\b/, /\bdc\s+extended\s+universe\b/, /\bdceu\b/, /\bdcu\b/],
    aliases: ["dc entertainment", "dc comics"],
    include: [/\bdc\b/]
  },
  {
    canonical: "Warner Bros. Pictures",
    aliases: ["warner bros", "warner bros pictures", "warner brothers"],
    include: [/\bwarner\b/]
  },
  {
    canonical: "Lucasfilm Ltd.",
    aliases: ["lucasfilm", "lucasfilm ltd"],
    include: [/\blucasfilm\b/],
    // Partial by nature: on the reference library only one of six Star Wars series
    // carries the keyword. One is still more than the zero the studio axis returns,
    // and a looser pattern would cost precision without recovering the rest —
    // "The Mandalorian" and "Andor" carry neither the tag nor the studio.
    seriesTags: [/\bstar\s+wars\b/]
  },
  {
    canonical: "Columbia Pictures",
    aliases: ["columbia", "columbia pictures industries"],
    include: [/\bcolumbia\b/]
  },
  {
    canonical: "Paramount Pictures",
    aliases: ["paramount", "paramount pictures corporation"],
    // Paramount+ and Paramount Network are streaming labels, not the film
    // studio — kept out for the same reason Disney+ is its own hub.
    include: [/\bparamount\b/],
    exclude: [/\bplus\b/, /\bnetwork\b/]
  },
  {
    canonical: "Netflix",
    aliases: ["netflix originals"],
    include: [/\bnetflix\b/]
  },
  {
    canonical: "DreamWorks Animation",
    aliases: ["dreamworks", "dreamworks pictures", "oriental dreamworks"],
    include: [/\bdreamworks\b/]
  }
];

const STUDIO_BRAND_BY_KEY = new Map(
  STUDIO_BRANDS.map((brand) => [String(brand.canonical || "").toLowerCase(), brand])
);

const STUDIO_CANONICAL_NAME_MAP = new Map(
  STUDIO_BRANDS.map((brand) => [String(brand.canonical || "").toLowerCase(), brand.canonical])
);

const STUDIO_ALIAS_NAME_MAP = (() => {
  const out = new Map();
  for (const brand of STUDIO_BRANDS) {
    out.set(String(brand.canonical || "").toLowerCase(), brand.canonical);
    for (const alias of brand.aliases || []) {
      out.set(String(alias || "").toLowerCase(), brand.canonical);
    }
  }
  return out;
})();

const STUDIO_HUB_DEFAULT_NAME_KEYS = new Set(
  STUDIO_BRANDS.map((brand) => String(brand.canonical || "").trim().toLowerCase())
);

function toCanonicalStudioName(name) {
  if (!name) return null;
  const key = String(name || "").toLowerCase();
  return STUDIO_ALIAS_NAME_MAP.get(key) || STUDIO_CANONICAL_NAME_MAP.get(key) || null;
}

export function getCanonicalStudioHubName(name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return "";
  return toCanonicalStudioName(cleanName) || cleanName;
}

/**
 * Deterministic key the brand rules match against.
 *
 * Deliberately does NOT strip junk words: collapsing "Marvel Studios" to
 * "marvel" is what made it tie with "Marvel Entertainment" and let alphabetical
 * order decide which entity a hub bound to.
 */
export function normalizeStudioName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findStudioBrand(name) {
  const canonicalName = getCanonicalStudioHubName(name);
  return STUDIO_BRAND_BY_KEY.get(nameKey(canonicalName)) || null;
}

function studioEntityMatchesBrand(brand, entityName) {
  const key = normalizeStudioName(entityName);
  if (!key || !brand) return false;

  if ((brand.exclude || []).some((rx) => rx.test(key))) return false;

  const includeAll = brand.includeAll || [];
  if (includeAll.length && includeAll.every((rx) => rx.test(key))) return true;

  const include = brand.include || [];
  if (include.length && include.some((rx) => rx.test(key))) return true;

  return false;
}

/**
 * The library's own tags that identify `brandName`'s series, as literal tag names.
 *
 * Returns the tags themselves rather than the patterns because the query filters on exact
 * names — matching against the vocabulary the server reports keeps this working across
 * libraries whose keyword casing or wording differs, instead of pinning one spelling.
 *
 * An empty result is a normal answer, not a failure: it means the brand has no franchise
 * keyword in this library, and its series stay on the studio axis.
 */
export function resolveStudioBrandSeriesTags(brandName, availableTags = []) {
  const brand = findStudioBrand(brandName);
  const patterns = brand?.seriesTags || [];
  if (!patterns.length) return [];

  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(availableTags) ? availableTags : []) {
    const tag = String(raw || "").trim();
    if (!tag) continue;
    const key = normalizeStudioName(tag);
    if (!key || seen.has(key)) continue;
    if (!patterns.some((rx) => rx.test(key))) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Every Jellyfin Studio entity belonging to `brandName`, best candidate first.
 *
 * `primaryId` is the exact canonical-name match when the library has one; it is
 * what logo lookup and the single-id fallback href use. `studioIds` is the set
 * the hub actually queries with.
 */
export function resolveStudioBrandEntities(brandName, studios = []) {
  const cleanName = String(brandName || "").trim();
  const list = Array.isArray(studios) ? studios : [];
  const brand = findStudioBrand(cleanName);
  const canonical = getCanonicalStudioHubName(cleanName) || cleanName;

  const matched = brand
    ? list.filter((studio) => studioEntityMatchesBrand(brand, studio?.Name))
    : list.filter((studio) => normalizeStudioName(studio?.Name) === normalizeStudioName(cleanName));

  const canonicalKey = normalizeStudioName(canonical);
  const rank = (studio) => {
    const key = normalizeStudioName(studio?.Name);
    if (key === canonicalKey) return 2;
    if (key.startsWith(canonicalKey) || canonicalKey.startsWith(key)) return 1;
    return 0;
  };

  const ordered = [...matched].sort((a, b) => {
    const byRank = rank(b) - rank(a);
    if (byRank) return byRank;
    return String(a?.Name || "").localeCompare(String(b?.Name || ""));
  });

  return {
    canonical,
    matchedByRules: !!brand,
    studioIds: ordered.map((studio) => String(studio?.Id || "")).filter(Boolean),
    studioNames: ordered.map((studio) => String(studio?.Name || "")).filter(Boolean),
    primaryId: String(ordered[0]?.Id || "")
  };
}

/**
 * Bulk resolution plus the entities no brand claimed — the raw material for the
 * settings diagnostics panel, which is what makes a mis-resolution visible
 * instead of silent.
 */
export function resolveStudioBrandMap(brandNames = [], studios = []) {
  const list = Array.isArray(studios) ? studios : [];
  const brands = new Map();
  const claimed = new Set();

  for (const name of brandNames || []) {
    const resolved = resolveStudioBrandEntities(name, list);
    brands.set(nameKey(resolved.canonical), resolved);
    resolved.studioIds.forEach((id) => claimed.add(String(id)));
  }

  const unmatched = list
    .filter((studio) => !claimed.has(String(studio?.Id || "")))
    .map((studio) => ({ id: String(studio?.Id || ""), name: String(studio?.Name || "") }));

  return { brands, unmatched };
}


export const STUDIO_HUB_DEFAULT_NAMES = STUDIO_BRANDS.map((brand) => brand.canonical);
