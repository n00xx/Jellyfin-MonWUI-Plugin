import { getConfig } from "./config.js";
import { withServer } from "./jfUrl.js";

export const CINEMA_PREROLL_CACHE_ENDPOINT = "/Plugins/JMSFusion/cinema-preroll/cache";

export function normalizeCinemaPreRollLanguage(raw) {
  const value = String(raw || "").trim().replace("_", "-");
  if (/^[a-z]{2}-[A-Z]{2}$/.test(value)) return value;
  const lower = value.toLowerCase();
  if (lower === "en" || lower === "eng") return "en-US";
  if (lower === "es" || lower === "spa") return "es-MX";
  return "es-MX";
}

export function normalizeCinemaPreRollLanguageSetting(raw) {
  const value = String(raw || "").trim();
  if (!value) return "auto";
  if (value.toLowerCase() === "auto") return "auto";
  return normalizeCinemaPreRollLanguage(value);
}

export function normalizeCinemaPreRollRegionMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "global") return "global";
  return "custom";
}

export function normalizeCinemaPreRollCustomRegion(raw) {
  const value = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
  return value.length === 2 ? value : "";
}

export function normalizeCinemaPreRollFallbackMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "none") return "none";
  if (value === "global") return "global";
  return "custom";
}

export function normalizeCinemaPreRollFallbackRegion(raw) {
  return normalizeCinemaPreRollCustomRegion(raw) || "US";
}

export function resolveCinemaPreRollLocale(source = getConfig()) {
  const cfg = source || {};
  const fallbackLanguage = (
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language
      : "es-MX"
  );
  const languageSetting = normalizeCinemaPreRollLanguageSetting(cfg?.cinemaPreRollLanguage);
  const language = normalizeCinemaPreRollLanguage(
    languageSetting === "auto"
      ? (cfg?.defaultLanguage || fallbackLanguage)
      : languageSetting
  );
  const desiredMode = normalizeCinemaPreRollRegionMode(cfg?.cinemaPreRollRegionMode);
  const customRegion = normalizeCinemaPreRollCustomRegion(cfg?.cinemaPreRollCustomRegion);
  const fallbackMode = normalizeCinemaPreRollFallbackMode(cfg?.cinemaPreRollFallbackMode);
  const fallbackRegion = normalizeCinemaPreRollFallbackRegion(cfg?.cinemaPreRollFallbackRegion);
  const autoRegion = language.split("-")[1] || "MX";

  let regionMode = desiredMode;
  let region = "";

  if (desiredMode === "global") {
    region = "";
  } else {
    regionMode = "custom";
    region = customRegion || autoRegion;
  }

  const baseCacheKey = region ? `${language}:${region}` : `${language}:GLOBAL`;
  const fallbackCacheKey = fallbackMode === "global"
    ? "FB-GLOBAL"
    : (fallbackMode === "custom" ? `FB-${fallbackRegion}` : "FB-NONE");

  return {
    language,
    languageSetting,
    region,
    regionMode,
    customRegion,
    fallbackMode,
    fallbackRegion,
    cacheKey: `${baseCacheKey}:${fallbackCacheKey}`
  };
}

export function getCinemaPreRollLocaleSignature(source = getConfig()) {
  const locale = resolveCinemaPreRollLocale(source);
  return `${locale.language}|${locale.regionMode}|${locale.region || "GLOBAL"}|${locale.fallbackMode}|${locale.fallbackRegion}`;
}

export function buildCinemaPreRollCacheUrl(source = getConfig(), { force = false } = {}) {
  const locale =
    source && typeof source === "object" && typeof source.language === "string"
      ? source
      : resolveCinemaPreRollLocale(source);

  const endpoint = withServer(CINEMA_PREROLL_CACHE_ENDPOINT) || CINEMA_PREROLL_CACHE_ENDPOINT;
  const baseHref = (
    typeof window !== "undefined" && window.location?.href
      ? window.location.href
      : "http://localhost/"
  );
  const url = new URL(endpoint, baseHref);
  url.searchParams.set("language", locale.language);
  url.searchParams.set("regionMode", locale.regionMode || "custom");
  if (locale.region) {
    url.searchParams.set("region", locale.region);
  }
  url.searchParams.set("fallbackMode", normalizeCinemaPreRollFallbackMode(locale.fallbackMode));
  if (normalizeCinemaPreRollFallbackMode(locale.fallbackMode) === "custom") {
    url.searchParams.set("fallbackRegion", normalizeCinemaPreRollFallbackRegion(locale.fallbackRegion));
  }
  if (force) {
    url.searchParams.set("force", "true");
  }
  return url;
}
