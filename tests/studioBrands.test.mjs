import { resolveStudioBrandMap, resolveStudioBrandEntities, normalizeStudioName } from "../Resources/slider/modules/studioBrands.js";

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

console.log(`\nunassigned: ${unmatched.length} (${unmatched.map(u => u.name).join(", ")})`);
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
