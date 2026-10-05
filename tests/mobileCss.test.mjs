// Guards for the stylesheets phones depend on.
//
// 1. Paren balance across every src/*.css. One unclosed "(" in a minified sheet silently
//    discarded 14KB of rules in v3.7.1.20 (CSS Syntax L3: it consumes to EOF, and a "}" does not
//    end it). Nothing errors and the file looks fine, so this is checked mechanically.
// 2. src/mobile.css is loaded on every page. It carries the safe-area fixes for every theme
//    variant; gated behind a feature flag it would silently stop applying.
// 3. Every safe-area value in mobile.css must reduce to the original when the inset is 0, so
//    each declaration that mentions env() is matched against the form it is allowed to take.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const sliderDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider");
const srcDir = path.join(sliderDir, "src");
const stripNoise = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

console.log("every stylesheet closes its parens");
for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".css")).sort()) {
  const css = stripNoise(readFileSync(path.join(srcDir, name), "utf8"));
  let depth = 0;
  let firstBraceInsideParen = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "{" && depth > 0 && firstBraceInsideParen < 0) firstBraceInsideParen = i;
  }
  if (depth !== 0 || firstBraceInsideParen >= 0) {
    const at = firstBraceInsideParen >= 0 ? ` (first "{" inside a paren near: ${JSON.stringify(css.slice(Math.max(0, firstBraceInsideParen - 60), firstBraceInsideParen + 1))})` : "";
    fail(`${name}: paren depth ${depth}${at}`);
  } else {
    ok(name);
  }
}

console.log("\nmobile.css is loaded unconditionally");
{
  const main = readFileSync(path.join(sliderDir, "main.js"), "utf8");
  if (/syncCSS\(\s*'\/slider\/src\/mobile\.css'\s*,\s*'[^']+'\s*,\s*true\s*\)/.test(main)) ok("syncCSS('/slider/src/mobile.css', …, true)");
  else fail("main.js must load /slider/src/mobile.css with enabled=true");
}

console.log("\nevery safe-area value is a no-op without an inset");
{
  const css = readFileSync(path.join(srcDir, "mobile.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const ENV = String.raw`env\(safe-area-inset-(?:top|right|bottom|left)\)`;
  // Allowed: the bare inset (0 when absent, where the original is 0), max(original, inset),
  // or a size with the insets subtracted.
  const allowed = [
    new RegExp(String.raw`^${ENV}$`),
    new RegExp(String.raw`^max\(.+,\s*${ENV}\)$`),
    new RegExp(String.raw`^calc\(100d?v[hw]( - ${ENV})+\)$`),
  ];
  let checked = 0;
  for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    const [, prop, value] = m;
    if (!value.includes("safe-area-inset")) continue;
    // Shorthands list one value per side; each must be allowed on its own. Split on whitespace
    // at paren depth 0 only, since the values nest: max(clamp(…), env(…)).
    const parts = [];
    let depth = 0, current = "";
    for (const c of value.trim()) {
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (/\s/.test(c) && depth === 0) { if (current) parts.push(current); current = ""; }
      else current += c;
    }
    if (current) parts.push(current);
    for (const part of parts) {
      checked++;
      if (!allowed.some((re) => re.test(part.trim()))) fail(`${prop}: "${part.trim()}" is not one of the no-op-without-inset forms`);
    }
  }
  if (checked) ok(`${checked} safe-area values checked`);
  else fail("no safe-area values found in mobile.css");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
