// The studio card's eye preview picks five titles for a brand. It used to pick them films-only
// whenever the brand held both types, and the failure was silent — the popover looked fine, it
// just never contained a series.
//
// Two independent causes, both guarded here:
//
//   1. The rating threshold ran over the pooled list. Jellyfin leaves CommunityRating unset on
//      many series, getRating scores those 0, and MIN_RATING is 6.5 — so every series failed.
//      The unfiltered fallback only fired when *nothing* cleared the bar, so a single qualifying
//      film was enough to drop the entire series side.
//
//   2. The query feeding it set SortOrder: Descending with no SortBy, so Jellyfin fell back to
//      SortName and the cap returned the brand's alphabetically last titles. Once SortBy became
//      CommunityRating, a single Movie,Series page would have filled with films for the same
//      reason as (1) — which is why the caller now issues one request per type. Test 3 pins the
//      query shape, since neither parameter has a visible effect until a brand is large enough
//      for the cap to bite.

import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const SRC = readFileSync(
  path.join(import.meta.dirname, "..", "Resources", "slider", "modules", "studioHubs.js"),
  "utf8"
);

/**
 * Lifts a top-level declaration out of the module by brace matching.
 *
 * Matching starts *after* the header so a default like `options = {}` in the parameter list
 * does not close the count before the body has opened.
 */
function extract(header) {
  const start = SRC.indexOf(header);
  assert.notEqual(start, -1, `not found in studioHubs.js: ${header}`);
  let depth = 0;
  for (let i = start + header.length; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after: ${header}`);
}

const MIN_RATING = 6.5;
const selectTopNWithMinRating = new Function(
  "MIN_RATING",
  `
  const getRating = (it) => Number(it?.CommunityRating ?? it?.CriticRating ?? 0);
  ${extract("function randomSample(arr, n)")}
  ${extract("function selectTopNWithMinRating(items, min = MIN_RATING, count = 5)")}
  return selectTopNWithMinRating;
`
)(MIN_RATING);

const film = (id, rating) => ({ Id: id, Type: "Movie", CommunityRating: rating });
/** No CommunityRating: the shape Jellyfin actually returns for most series. */
const show = (id, rating) => ({ Id: id, Type: "Series", ...(rating == null ? {} : { CommunityRating: rating }) });

const countOf = (picks, type) => picks.filter(p => p.Type === type).length;

test("unrated series survive a pool of qualifying films", () => {
  // The exact shape of the bug: ten films clear 6.5, eight series carry no rating at all.
  const films = Array.from({ length: 10 }, (_, i) => film(`m${i}`, 8));
  const shows = Array.from({ length: 8 }, (_, i) => show(`s${i}`));

  // Repeated because the pick inside each type is a random sample; a single run could pass
  // by luck under an implementation that only sometimes reaches the series.
  for (let run = 0; run < 50; run++) {
    const picks = selectTopNWithMinRating([...films, ...shows], MIN_RATING, 5);
    assert.equal(picks.length, 5);
    assert.ok(countOf(picks, "Series") >= 1, "no series in the preview");
    assert.ok(countOf(picks, "Movie") >= 1, "no films in the preview");
  }
});

test("films lead the preview, matching the grid's grouping", () => {
  const items = [
    ...Array.from({ length: 10 }, (_, i) => film(`m${i}`, 8)),
    ...Array.from({ length: 10 }, (_, i) => show(`s${i}`))
  ];
  for (let run = 0; run < 20; run++) {
    const types = selectTopNWithMinRating(items, MIN_RATING, 5).map(p => p.Type);
    const firstSeries = types.indexOf("Series");
    // Every film index must precede every series index — no interleaving.
    assert.ok(firstSeries === -1 || !types.slice(firstSeries).includes("Movie"), types.join(","));
  }
});

test("a single-type brand still fills the preview", () => {
  const filmsOnly = Array.from({ length: 9 }, (_, i) => film(`m${i}`, 8));
  assert.equal(selectTopNWithMinRating(filmsOnly, MIN_RATING, 5).length, 5);

  const showsOnly = Array.from({ length: 9 }, (_, i) => show(`s${i}`));
  const picks = selectTopNWithMinRating(showsOnly, MIN_RATING, 5);
  assert.equal(picks.length, 5, "unrated series must not empty a series-only preview");
  assert.equal(countOf(picks, "Series"), 5);
});

test("a brand below the threshold falls back within its type, not across types", () => {
  // Films clear the bar, series do not — the case the old global fallback could not see.
  const items = [...Array.from({ length: 8 }, (_, i) => film(`m${i}`, 9)),
                 ...Array.from({ length: 8 }, (_, i) => show(`s${i}`, 3))];
  const picks = selectTopNWithMinRating(items, MIN_RATING, 5);
  assert.ok(countOf(picks, "Series") >= 1, "low-rated series were dropped instead of demoted");
});

test("fewer items than slots returns everything, both types included", () => {
  const items = [film("m0", 2), show("s0"), film("m1", 9)];
  const picks = selectTopNWithMinRating(items, MIN_RATING, 5);
  assert.equal(picks.length, 3);
  assert.equal(countOf(picks, "Series"), 1);
});

test("the studio item query sorts explicitly and accepts a single type", () => {
  const fn = extract("async function fetchStudioItemsViaUsers(studioIds, studioName, userId, signal, options = {})");

  // Without SortBy, SortOrder: Descending means SortName descending — the brand's
  // alphabetically last titles, presented as if they were its best.
  assert.match(fn, /SortBy:\s*"CommunityRating,DateCreated"/, "SortBy is missing");
  assert.match(fn, /SortOrder:\s*"Descending"/);
  assert.match(fn, /IncludeItemTypes:\s*String\(options\.itemTypes \|\| "Movie,Series"\)/,
    "itemTypes must be overridable, and default to both");

  // The preview must ask per type; one combined page sorted by rating comes back films-only.
  const caller = extract("function createPreviewButton(card, studioName, studioIds, userId)");
  assert.match(caller, /itemTypes:\s*"Movie"/);
  assert.match(caller, /itemTypes:\s*"Series"/);
});
