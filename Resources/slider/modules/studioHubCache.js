// Cache policy for the studio row. No imports on purpose, so it can be unit-tested on its own
// (tests/studioHubCache.test.mjs).
//
// Before v3.7.1.34 both studio caches were one per browser. Any user who logged in after
// someone else — or an expired user on the device they used while paying — got the previous
// session's Marvel/Pixar/Disney cards, because an empty /Studios answer also fell back to the
// 30-day brand map. Keys are now per user, and only a FAILED fetch reaches the offline map.
//
// Keep the `studioHub_` prefix: both shared-snapshot deny lists (storagePreload.js DENY_PREFIXES
// and UserSettingsController.cs DeniedSnapshotPrefixes) match on it.

export function scopeStudioHubCacheKey(baseKey, userId) {
  const user = String(userId || "").trim();
  if (!user) return null;
  return `${baseKey}:${user}`;
}

/**
 * Decide what brand resolution runs against.
 * - live:     the user's own studio list
 * - empty:    the server answered and the user can see no studio; show no studio row
 * - fallback: the request failed; the last good brand map keeps the row usable offline
 */
export function pickStudioBrandSource({ studios, fetchFailed, fallbackMap }) {
  const list = Array.isArray(studios) ? studios : [];
  if (fetchFailed) {
    const map = fallbackMap && typeof fallbackMap === "object" ? fallbackMap : {};
    return { kind: "fallback", studios: [], fallbackMap: map };
  }
  if (list.length) return { kind: "live", studios: list, fallbackMap: {} };
  return { kind: "empty", studios: [], fallbackMap: {} };
}
