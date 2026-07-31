// config.js touches browser globals at import time; shim them before loading it.
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [] };
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "node", maxTouchPoints: 0, language: "es" },
  configurable: true,
});

const { normalizeManagedHomeSectionOrder, DEFAULT_MANAGED_HOME_SECTION_ORDER } =
  await import("../Resources/slider/modules/config.js");

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

// A order stored before becauseYouWatched / libraryHubs existed as keys, with
// continueRows deliberately moved ahead of the Top 10 rows.
const LEGACY_STORED = [
  "studioHubs", "personalRecommendations", "recentRows", "continueRows",
  "nextUpRows", "top10SeriesRows", "top10MovieRows", "genreHubs", "directorRows",
];

const after = (order, key) => order[order.indexOf(key) - 1];
const isAdjacent = (order, anchor, follower) =>
  order.indexOf(follower) === order.indexOf(anchor) + 1;

console.log("every default key survives normalization");
for (const source of [null, LEGACY_STORED, "not json at all"]) {
  const order = normalizeManagedHomeSectionOrder(source);
  const missing = DEFAULT_MANAGED_HOME_SECTION_ORDER.filter((k) => !order.includes(k));
  if (missing.length) fail(`missing ${missing.join(",")} for source ${JSON.stringify(source)}`);
  else if (new Set(order).size !== order.length) fail("duplicate keys in output");
  else ok(`${String(source).slice(0, 24).padEnd(26)} -> ${order.length} keys, no dupes`);
}

console.log("\nfollower rules apply to keys the user never ordered");
// Regression: `DEFAULT_...forEach(push)` passed the array index as push()'s
// `fromExplicit` argument, marking every default key after the first as
// user-ordered, which made all four follower rules dead code.
{
  const order = normalizeManagedHomeSectionOrder(LEGACY_STORED);
  for (const [anchor, follower] of [
    ["studioHubs", "libraryHubs"],
    ["tmdbTopMoviesRows", "tmdbTrailerRows"],
    ["recentRows", "continueRows"],
    ["continueRows", "nextUpRows"],
    ["nextUpRows", "becauseYouWatched"],
  ]) {
    if (!isAdjacent(order, anchor, follower)) {
      fail(`${follower} should sit right after ${anchor}, got after ${after(order, follower)}`);
    } else ok(`${follower.padEnd(18)} follows ${anchor}`);
  }
}

console.log("\nbecauseYouWatched lands with Continue Watching, not at the tail");
{
  const order = normalizeManagedHomeSectionOrder(LEGACY_STORED);
  const byw = order.indexOf("becauseYouWatched");
  if (byw >= order.length - 1) fail("becauseYouWatched was appended at the very end");
  else if (order.indexOf("continueRows") > byw) fail("becauseYouWatched landed before continueRows");
  else ok(`index ${byw}/${order.length - 1}, right after ${after(order, "becauseYouWatched")}`);
}

console.log("\nan explicit user ordering still wins over the follower rules");
{
  const explicitTail = [...LEGACY_STORED, "becauseYouWatched"];
  const order = normalizeManagedHomeSectionOrder(explicitTail);
  if (after(order, "becauseYouWatched") !== "directorRows") {
    fail(`explicit placement was overridden; byw follows ${after(order, "becauseYouWatched")}`);
  } else ok("becauseYouWatched stayed where the user put it");

  const explicitFirst = ["becauseYouWatched", ...LEGACY_STORED];
  const first = normalizeManagedHomeSectionOrder(explicitFirst);
  if (first[0] !== "becauseYouWatched") fail("explicit first position was not honoured");
  else ok("becauseYouWatched honoured at position 0");
}

console.log("\nunknown and malformed entries are dropped, not carried through");
{
  const order = normalizeManagedHomeSectionOrder(["studioHubs", "notASection", "", null, "studioHubs"]);
  if (order.includes("notASection")) fail("unknown key leaked into the order");
  else if (order.filter((k) => k === "studioHubs").length !== 1) fail("duplicate studioHubs kept");
  else ok("unknown/empty/duplicate entries dropped");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
