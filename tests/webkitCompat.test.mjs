// WebKit (every iOS browser and both Jellyfin iOS apps) lacks two things the rest of the code
// base can lean on in Chromium, and each one failed silently on iPhone and iPad:
//
//   1. requestIdleCallback. WebKit does not expose it, and `requestIdleCallback?.()` does not
//      help: optional chaining on an undeclared global still throws ReferenceError. In
//      pauseModul.js that throw left setupPauseScreen() half-installed - its listeners were
//      attached, but it never registered destroy() or returned its cleanup.
//   2. Regex lookbehind before iOS 16.4. A regex literal is validated when the module is
//      parsed, so one lookbehind in artistModal.js failed the module and everything that
//      imports it statically: the whole music player.
//
// Both are checked across every shipped module, so the next one is caught here, not on a phone.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const sliderDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider");
const SKIP = new Set(["jsmediatags.min.js"]);

function listModules(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listModules(full));
    else if (name.endsWith(".js") && !SKIP.has(name)) out.push(full);
  }
  return out;
}
// Comment lines are blanked (not dropped) so reported line numbers stay right.
const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);
const modules = listModules(sliderDir).map((file) => ({
  rel: path.relative(sliderDir, file),
  lines: readFileSync(file, "utf8").split("\n").map((line) => (isCommentLine(line) ? "" : line)),
}));

console.log("idle callbacks are guarded");
{
  const IDLE = ["requestIdleCallback", "cancelIdleCallback"];
  // How many lines above a bare call its guard may sit (an `if (typeof ...)` around a block).
  const GUARD_WINDOW = 6;
  let bareCalls = 0;
  for (const { rel, lines } of modules) {
    const text = lines.join("\n");
    for (const name of IDLE) {
      // Constants computed once from a typeof check, e.g. `const HAS_RIC = typeof requestIdleCallback === 'function'`.
      const guardVars = [...text.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*typeof\\s+(?:window\\.)?${name}\\b`, "g"))]
        .map((m) => m[1]);
      const guards = [
        new RegExp(`typeof\\s+(?:window\\.)?${name}\\b`),
        new RegExp(`["']${name}["']\\s+in\\s+window`),
        ...guardVars.map((v) => new RegExp(`\\b${v}\\b`)),
      ];
      const bare = new RegExp(`(?<![\\w$.])${name}\\s*(\\?\\.)?\\s*\\(`);
      lines.forEach((line, i) => {
        const m = line.match(bare);
        if (!m) return;
        bareCalls++;
        const where = `${rel}:${i + 1}`;
        if (m[1]) {
          fail(`${where}: \`${name}?.()\` still throws ReferenceError where ${name} is undeclared`);
          return;
        }
        const context = lines.slice(Math.max(0, i - GUARD_WINDOW), i + 1).join("\n");
        if (!guards.some((g) => g.test(context))) fail(`${where}: bare ${name}() with no typeof guard`);
      });
    }
  }
  ok(`checked ${bareCalls} bare idle-callback calls across ${modules.length} modules`);
}

console.log("\nno regex lookbehind (iOS < 16.4 fails the whole module)");
{
  let found = 0;
  for (const { rel, lines } of modules) {
    lines.forEach((line, i) => {
      if (/\(\?<[!=]/.test(line)) {
        found++;
        fail(`${rel}:${i + 1}: lookbehind`);
      }
    });
  }
  if (!found) ok("none");
}

console.log("\nartist bio sentence breaks match the old lookbehind regex");
{
  // The exact expression artistModal.js shipped with; Node supports lookbehind, iOS < 16.4 does not.
  // Built from a string so this test file itself stays free of a lookbehind literal.
  const original = new RegExp(
    "(?" + "<!\\b(?:Mr|Mrs|Ms|Dr|Prof|Sn|St|vs|No|etc|Jr|Sr|Ltd|Inc|Co|Doç|Av|Yrd|Öğr\\.?Gör|Arş\\.?Gör|Bkz))\\.(\\s+)(?=\\p{Lu})",
    "gu"
  );
  const legacy = (text) => text.replace(original, ".<br>");

  let breakBioSentences = null;
  try {
    ({ breakBioSentences } = await import("../Resources/slider/modules/player/utils/bioText.js"));
  } catch (e) {
    fail(`cannot import modules/player/utils/bioText.js: ${e.message}`);
  }

  const corpus = [
    "First sentence. Second sentence.",
    "Formed in 1990. The band toured.  Then split.",
    "Signed with Mr. Brown and Dr. Smith. They left.",
    "Prof. Adams met St. James. Later vs. Others. Done.",
    "Founded by Doç. Dr. Yılmaz. Albüm çıktı. Öğr.Gör. Kaya katıldı. Arş. Gör. Ece de.",
    "Lowercase after period. then nothing. Ünlü oldu. Çok sattı.",
    "Ends with abbreviation Inc. And continues. Co. Op.",
    "Mr.Smith no space. Mrs. Jones. Smr. Tall.",
    "No period at all",
    "",
    "Trailing period.",
    "Newline break.\nNext line. Tab.\tTabbed.",
    "Bkz. Ayrıca. No. 5 is a song. Jr. Sr. Ltd. Done.",
    "Emr. Kaya. Mrs. no. Mr. Écrit.",
    // An abbreviation glued to the word before it: \b sees the character in front of it.
    "XMr. Smith. aÖğr.Gör. Kaya. _Dr. Who. 9St. Louis. éDr. Zed.",
    "Öğr.Gör. Ali. Arş.Gör. Veli. xArş.Gör. Ece. Öğr. Gör. Ayşe.",
    "😀Dr. Emoji. 😀. Next.",
  ];
  if (breakBioSentences) {
    let same = 0;
    for (const text of corpus) {
      const want = legacy(text);
      const got = breakBioSentences(text);
      if (got === want) same++;
      else fail(`${JSON.stringify(text)}\n         want ${JSON.stringify(want)}\n         got  ${JSON.stringify(got)}`);
    }
    if (same === corpus.length) ok(`identical on all ${corpus.length} samples`);

    // Seeded fuzz over the pieces that matter: abbreviation fragments, periods, whitespace,
    // word and non-word characters on either side of \b, upper and lower case, astral chars.
    const PIECES = ["Mr", "Mrs", "Dr", "St", "Co", "Doç", "Öğr", "Arş", "Gör", "Bkz", "etc", "No",
      ".", ". ", ".  ", ".\n", " ", "A", "a", "Ö", "ö", "Ç", "x", "_", "9", "é", "😀", "Smith", "çok"];
    let seed = 0x2f6b1a;
    const rand = (n) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
    const FUZZ_CASES = 3000;
    let fuzzDiffs = 0;
    for (let i = 0; i < FUZZ_CASES; i++) {
      let text = "";
      for (let j = rand(24); j >= 0; j--) text += PIECES[rand(PIECES.length)];
      if (breakBioSentences(text) !== legacy(text)) {
        if (++fuzzDiffs <= 3) fail(`fuzz ${JSON.stringify(text)}: ${JSON.stringify(breakBioSentences(text))} vs ${JSON.stringify(legacy(text))}`);
      }
    }
    if (!fuzzDiffs) ok(`identical on ${FUZZ_CASES} fuzzed strings`);
    if (breakBioSentences(null) !== "" || breakBioSentences(undefined) !== "") fail("null/undefined should give an empty string");
    else ok("null and undefined give an empty string");

    // The bio comes from server metadata. Checking the abbreviation against the whole text in
    // front of every break is quadratic, so a long bio would freeze the tab; the old regex was
    // linear. 30k sentences finish in a few ms when linear and take seconds when quadratic.
    const MAX_MS = 500;
    const long = "Ab. Cd ".repeat(30000);
    const started = performance.now();
    const out = breakBioSentences(long);
    const took = performance.now() - started;
    if (took > MAX_MS) fail(`30k sentences took ${took.toFixed(0)} ms (limit ${MAX_MS}): not linear`);
    else if (out !== legacy(long)) fail("long input differs from the old regex");
    else ok(`30k sentences in ${took.toFixed(1)} ms, identical to the old regex`);

    // V8 skips straight to the end for a `$`-anchored pattern, so the timing above cannot see a
    // whole-prefix check; not every engine does that. Assert the input each check sees is bounded.
    const MAX_CHECKED = 16;
    const realTest = RegExp.prototype.test;
    let longestChecked = 0;
    RegExp.prototype.test = function (s) {
      longestChecked = Math.max(longestChecked, String(s).length);
      return realTest.call(this, s);
    };
    try { breakBioSentences(long); } finally { RegExp.prototype.test = realTest; }
    if (longestChecked > MAX_CHECKED) fail(`an abbreviation check saw ${longestChecked} chars (limit ${MAX_CHECKED})`);
    else ok(`each abbreviation check sees at most ${longestChecked} chars`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
