// Regression test: a failed director-row render scheduled its retry and then cleaned up, and
// cleanupDirectorRows() starts with clearDirectorRowsRetry() — so the retry it had just queued
// was cancelled every time and a render error was never retried.
//
// directorRows.js needs a DOM, IndexedDB and ~15 sibling modules, so this reads the source of
// the render-error handler: cleanup must come first, the retry last, and cleanup must still be
// the function that clears pending retries (otherwise the order would not matter and this test
// would be guarding nothing).

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const src = readFileSync(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider/modules/directorRows.js"),
  "utf8"
);

function functionBody(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  let parens = 0;
  let paramsEnd = -1;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) { paramsEnd = i; break; }
  }
  let depth = 0;
  for (let i = src.indexOf("{", paramsEnd); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}

console.log("cleanupDirectorRows still cancels a pending retry");
const cleanup = functionBody("cleanupDirectorRows");
if (/clearDirectorRowsRetry\(\)/.test(cleanup)) ok("cleanupDirectorRows() calls clearDirectorRowsRetry()");
else fail("cleanupDirectorRows() no longer clears retries; this test's premise changed");

console.log("\nthe render-error handler cleans up before it schedules the retry");
const errorBlocks = [...src.matchAll(/dirRowsWarn\("render:error"[\s\S]*?\n {4}\}/g)].map((m) => m[0]);
if (!errorBlocks.length) fail('no "render:error" handler found');
for (const block of errorBlocks) {
  const cleanupAt = block.search(/cleanupDirectorRows\(/);
  const retryAt = block.search(/scheduleDirectorRowsRetry\(/);
  if (retryAt < 0) fail("render:error handler no longer schedules a retry");
  else if (cleanupAt < 0) ok("render:error handler schedules a retry and does not clean up after it");
  else if (cleanupAt < retryAt) ok("cleanup runs first, the retry is scheduled last and survives");
  else fail("the retry is scheduled before cleanupDirectorRows(), which cancels it");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
