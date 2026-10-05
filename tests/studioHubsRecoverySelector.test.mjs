// Regression test for a selector drift between two files.
//
// main.js decides whether the studio row still needs "recovery" by looking for rendered cards.
// It looked for `.studio-hub-card` / `.studio-card`, but studioHubs.js has always built its
// cards as `hub-card` (with `skeleton` until markCardReady). The check could never pass, so the
// managed recovery ran all five passes (300 ms .. 7.6 s) on every home visit of every user.
//
// main.js cannot be imported in node (it boots the whole UI), so this reads both sources: the
// class the card shell is created with, and the selector the recovery check uses.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider");
const mainSrc = readFileSync(path.join(root, "main.js"), "utf8");
const hubsSrc = readFileSync(path.join(root, "modules/studioHubs.js"), "utf8");

function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  // Skip the parameter list first: destructured params (`{ textOnly = false } = {}`) hold braces.
  let parens = 0;
  let paramsEnd = -1;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) { paramsEnd = i; break; }
  }
  if (paramsEnd < 0) return "";
  let depth = 0;
  for (let i = src.indexOf("{", paramsEnd); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}

console.log("the card class studioHubs.js renders");
const shellBody = functionBody(hubsSrc, "createBackdropCardShell");
const shellClass = (shellBody.match(/className\s*=\s*"([^"]*hub-card[^"]*)"/) || [])[1] || "";
const cardClass = shellClass.split(/\s+/).find((c) => c.endsWith("card")) || "";
if (cardClass === "hub-card") ok(`card shell class: "${shellClass}"`);
else fail(`could not find the card class in createBackdropCardShell (got "${shellClass}")`);
const readyBody = functionBody(hubsSrc, "markCardReady");
if (/classList\.remove\(\s*"skeleton"\s*\)/.test(readyBody)) ok("markCardReady drops `skeleton` once a card is real");
else fail("markCardReady no longer removes `skeleton`; revisit the selector below");

console.log("\nthe selector main.js recovers against");
const checkBody = functionBody(mainSrc, "hasRenderableStudioHubsUi");
if (!checkBody) fail("hasRenderableStudioHubsUi not found in main.js");
const selectors = [...checkBody.matchAll(/"([^"]*#studio-hubs[^"]*)"/g)].map((m) => m[1]).join(", ");
if (new RegExp(`\\.${cardClass}:not\\(\\.skeleton\\)`).test(selectors)) ok(`counts ready .${cardClass} cards`);
else fail(`selector does not count ready .${cardClass} cards: ${selectors}`);
if (/\.studio-hub-card|\.studio-card/.test(selectors)) fail("still looks for classes nothing renders (.studio-hub-card / .studio-card)");
else ok("no longer looks for .studio-hub-card / .studio-card");
if (/__jmsStudioHubsReady/.test(checkBody)) ok("a row the module settled without cards counts as done");
else fail("a studio row settled empty (user sees no studio) would still trigger recovery");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
