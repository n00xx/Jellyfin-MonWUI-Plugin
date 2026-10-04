// The studio row showed Marvel/Pixar/Disney to users who could see none of it. Its two caches
// (the studio list and the brand->ids map) were one per browser, not one per user, and an empty
// /Studios answer fell back to the 30-day map as if the request had failed. An expired user in a
// browser that had held anyone's session inherited that person's studio row.

import {
  scopeStudioHubCacheKey,
  pickStudioBrandSource,
} from "../Resources/slider/modules/studioHubCache.js";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);
const expectEq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok(`${label} -> ${g}`);
  else fail(`${label}: expected ${w}, got ${g}`);
};

console.log("cache keys are per user");
{
  const a = scopeStudioHubCacheKey("studioHub_cache_v7", "user-a");
  const b = scopeStudioHubCacheKey("studioHub_cache_v7", "user-b");
  if (a !== b) ok(`two users, two keys (${a} / ${b})`);
  else fail("two users must not share a key");
  if (a.startsWith("studioHub_")) ok("keeps the studioHub_ prefix the snapshot deny lists match on");
  else fail(`lost the studioHub_ prefix: ${a}`);
  expectEq("no user -> no key (nothing to cache against)", scopeStudioHubCacheKey("studioHub_cache_v7", ""), null);
  expectEq("whitespace user -> no key", scopeStudioHubCacheKey("studioHub_cache_v7", "   "), null);
}

console.log("\nwhich studio source to resolve brands from");
const FALLBACK = { "Marvel Studios": { studioIds: ["m1"] } };
const LIVE = [{ Id: "m1", Name: "Marvel Studios" }];
expectEq(
  "live list wins",
  pickStudioBrandSource({ studios: LIVE, fetchFailed: false, fallbackMap: FALLBACK }),
  { kind: "live", studios: LIVE, fallbackMap: {} }
);
expectEq(
  "empty live list is an answer, not a failure (expired user)",
  pickStudioBrandSource({ studios: [], fetchFailed: false, fallbackMap: FALLBACK }),
  { kind: "empty", studios: [], fallbackMap: {} }
);
expectEq(
  "failed fetch uses the offline map",
  pickStudioBrandSource({ studios: [], fetchFailed: true, fallbackMap: FALLBACK }),
  { kind: "fallback", studios: [], fallbackMap: FALLBACK }
);
expectEq(
  "failed fetch without a map has nothing",
  pickStudioBrandSource({ studios: null, fetchFailed: true, fallbackMap: null }),
  { kind: "fallback", studios: [], fallbackMap: {} }
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
