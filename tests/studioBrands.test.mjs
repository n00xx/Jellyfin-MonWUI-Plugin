import { resolveStudioBrandMap, resolveStudioBrandEntities, normalizeStudioName, resolveStudioBrandSeriesTags } from "../Resources/slider/modules/studioBrands.js";

// The 28 studio entities in the live library whose names contain any brand
// keyword. Names containing none cannot match an include rule, so this subset
// is complete for both recall and false-positive checks.
const NAMES = ["Columbia Pictures","DC","DC Films","DC Studios","DC Vertigo","Disney+","DreamWorks Animation","DreamWorks Pictures","Ehime Broadcasting","Hokkaido Cultural Broadcasting","Kochi Sun Sun Broadcasting","Lucasfilm Ltd.","Marvel Entertainment","Marvel Studios","Netflix","Okinawa Television Broadcasting","Oriental DreamWorks","Paramount+","Paramount Network","Paramount Pictures","Pixar","Tokai Television Broadcasting","Walt Disney Animation Studios","Walt Disney Feature Animation","Walt Disney Pictures","Walt Disney Productions","Warner Bros. Animation","Warner Bros. Pictures"];
const STUDIOS = NAMES.map((Name, i) => ({ Id: `id${i}`, Name }));

const ORDER = ["Marvel Studios","Pixar","Walt Disney Pictures","Disney+","DC",
  "Warner Bros. Pictures","Lucasfilm Ltd.","Columbia Pictures","Paramount Pictures",
  "Netflix","DreamWorks Animation"];

const EXPECTED = {
  "Marvel Studios": ["Marvel Studios","Marvel Entertainment"],
  "Pixar": ["Pixar"],
  "Walt Disney Pictures": ["Walt Disney Pictures","Walt Disney Animation Studios","Walt Disney Feature Animation","Walt Disney Productions"],
  "Disney+": ["Disney+"],
  "DC": ["DC","DC Films","DC Studios","DC Vertigo"],
  "Warner Bros. Pictures": ["Warner Bros. Pictures","Warner Bros. Animation"],
  "Lucasfilm Ltd.": ["Lucasfilm Ltd."],
  "Columbia Pictures": ["Columbia Pictures"],
  "Paramount Pictures": ["Paramount Pictures"],
  "Netflix": ["Netflix"],
  "DreamWorks Animation": ["DreamWorks Animation","DreamWorks Pictures","Oriental DreamWorks"],
};

// Entities that must never be claimed by any brand.
const FORBIDDEN = ["Ehime Broadcasting","Hokkaido Cultural Broadcasting","Kochi Sun Sun Broadcasting",
  "Okinawa Television Broadcasting","Tokai Television Broadcasting","Paramount+","Paramount Network"];

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };

const { brands, unmatched } = resolveStudioBrandMap(ORDER, STUDIOS);

console.log("brand resolution");
for (const name of ORDER) {
  const got = brands.get(name.toLowerCase())?.studioNames || [];
  const want = EXPECTED[name];
  const same = got.length === want.length && want.every(n => got.includes(n));
  if (!same) fail(`${name}: got [${got}] want [${want}]`);
  else console.log(`  ok   ${name.padEnd(22)} ${got.length} entit${got.length === 1 ? "y" : "ies"}`);
}

console.log("\nno false positives");
const claimed = new Set([...brands.values()].flatMap(b => b.studioNames));
for (const name of FORBIDDEN) {
  if (claimed.has(name)) fail(`"${name}" was claimed by a brand`);
}
if (!FORBIDDEN.some(n => claimed.has(n))) console.log(`  ok   all ${FORBIDDEN.length} excluded entities stayed out`);

console.log("\nprimaryId prefers the exact canonical name");
for (const [name, want] of [["Marvel Studios","Marvel Studios"],["DC","DC"],["Walt Disney Pictures","Walt Disney Pictures"],["Warner Bros. Pictures","Warner Bros. Pictures"]]) {
  const b = resolveStudioBrandEntities(name, STUDIOS);
  if (b.studioNames[0] !== want) fail(`${name}: primary is "${b.studioNames[0]}", want "${want}"`);
  else console.log(`  ok   ${name.padEnd(22)} -> ${want}`);
}

console.log("\nnormalization");
for (const [input, want] of [["Disney+","disney plus"],["Warner Bros. Pictures","warner bros pictures"],
  ["Café Studios","cafe studios"],["Tom & Jerry Prod.","tom and jerry prod"],["  DC   Vertigo ","dc vertigo"]]) {
  const got = normalizeStudioName(input);
  if (got !== want) fail(`normalize("${input}") = "${got}", want "${want}"`);
  else console.log(`  ok   ${JSON.stringify(input).padEnd(24)} -> ${got}`);
}

console.log("\nunknown name falls back to exact match (manual entries)");
const a24 = resolveStudioBrandEntities("Columbia Pictures", STUDIOS);
if (a24.studioIds.length !== 1) fail("expected a single entity for a non-fanned-out brand");
const nope = resolveStudioBrandEntities("Totally Absent Studio", STUDIOS);
if (nope.studioIds.length !== 0) fail("absent brand should resolve to nothing");
else console.log("  ok   absent brand resolves to no entities");

// A film brand's series carry the broadcasting network as their studio, not the production
// company, so the studio axis returns zero series for Marvel, DC and Lucasfilm. The tag axis
// is what reaches them — and it is noisier than studio names, so these guard the false
// positives that a brand-name-derived pattern actually produced against the live vocabulary.
console.log("\nseries tags: franchise keywords resolve");
// Every tag in the reference library (1824 of them) that contains any brand keyword.
const TAGS = ["marvel cinematic universe (mcu)", "dc universe (dcu)", "dc extended universe (dceu)",
  "star wars", "washington dc, usa", "based on podcast"];
for (const [brand, want] of [
  ["Marvel Studios", ["marvel cinematic universe (mcu)"]],
  ["DC", ["dc universe (dcu)", "dc extended universe (dceu)"]],
  ["Lucasfilm Ltd.", ["star wars"]],
]) {
  const got = resolveStudioBrandSeriesTags(brand, TAGS);
  if (JSON.stringify(got.slice().sort()) !== JSON.stringify(want.slice().sort())) {
    fail(`${brand}: tags ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${brand.padEnd(22)} -> ${got.join(", ")}`);
}

console.log("\nseries tags: no false positives");
// "washington dc, usa" is a filming location and "based on podcast" contains "dc" inside
// "po(dc)ast". A bare /dc/ over the tag vocabulary claims both.
for (const junk of ["washington dc, usa", "based on podcast"]) {
  const claimedBy = ["Marvel Studios", "DC", "Lucasfilm Ltd."].filter(b =>
    resolveStudioBrandSeriesTags(b, [junk]).length);
  if (claimedBy.length) fail(`"${junk}" was claimed by ${claimedBy.join(", ")}`);
  else console.log(`  ok   ${JSON.stringify(junk).padEnd(24)} claimed by nobody`);
}

console.log("\nseries tags: brands without a franchise keyword stay on the studio axis");
for (const brand of ["Pixar", "Walt Disney Pictures", "Netflix", "Disney+"]) {
  const got = resolveStudioBrandSeriesTags(brand, TAGS);
  if (got.length) fail(`${brand}: expected no series tags, got ${JSON.stringify(got)}`);
  else console.log(`  ok   ${brand.padEnd(22)} -> studio axis`);
}

console.log("\nseries tags: matching is case- and punctuation-insensitive");
// Another library may spell the same TMDB keyword differently; the query filters on the
// literal the server reported, so the returned value must be that literal, not the pattern.
const shouty = resolveStudioBrandSeriesTags("Marvel Studios", ["Marvel Cinematic Universe (MCU)"]);
if (shouty[0] !== "Marvel Cinematic Universe (MCU)") fail(`expected the library's own spelling, got ${JSON.stringify(shouty)}`);
else console.log("  ok   returns the library's own spelling verbatim");

console.log(`\nunassigned: ${unmatched.length} (${unmatched.map(u => u.name).join(", ")})`);
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
