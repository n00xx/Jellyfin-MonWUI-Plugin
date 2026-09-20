// Covers how moui finds jellyfin-web's own modules inside webpack.
//
// Local playback reaches into jellyfin-web for two modules: playbackManager (used when the
// caller picked audio/subtitle tracks) and itemShortcuts (the shortcut path the home cards
// take). Both used to be fetched by hardcoded webpack module id -- 39738 and 22832 -- with a
// scan of `req.c` as the fallback.
//
// Jellyfin 12.1 broke both halves at once. The ids are from the 10.11 build and do not exist
// there, and webpack 5 only emits `req.c` when a runtime module asks for it: 12.1's require
// exposes O, b, d, dn, e, f, g, l, m, miniCssF, n, nmd, o, p, r, t, u -- no c. So the lookup
// returned null and every local playback path failed with "playback manager yok", from the
// details modal and from the home alike.
//
// The replacement reads `req.m`, the factory map, which 12.1 does expose. Factories can be
// stringified without being run, so the module is found by what its source contains.
//
// Two properties matter most here and are the reason this file exists:
//   - a source match is only a guess, so nothing is returned until `validate` confirms the
//     shape. The export keys (.f, .Ay) are minified names that can change too.
//   - factories that do not match are never required, so the scan cannot fire a module's
//     side effects looking for a different one.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const here = path.dirname(new URL(import.meta.url).pathname);
const src = readFileSync(path.resolve(here, "../RuntimeModules/api.js"), "utf8");

// api.js imports browser-only siblings, so the function under test is lifted out rather than
// imported -- the same read-the-real-source approach the other suites use.
function lift(pattern, label) {
  const m = src.match(pattern);
  if (!m) throw new Error(`could not lift ${label} from RuntimeModules/api.js`);
  return m[0];
}

const parts = [
  lift(/const webpackModuleIdCache = new Map\(\);/, "webpackModuleIdCache"),
  lift(/function findWebpackModuleBySignature\(req, \{[\s\S]*?\n\}/, "findWebpackModuleBySignature"),
];

const mod = await import(
  "data:text/javascript;charset=utf-8," +
    encodeURIComponent(parts.join("\n") + "\nexport { findWebpackModuleBySignature, webpackModuleIdCache };")
);
const { findWebpackModuleBySignature, webpackModuleIdCache } = mod;

const PLAYBACK_MANAGER = {
  play: () => {},
  canPlay: () => true,
  getCurrentPlayer: () => null,
};

// Stands in for jellyfin-web's real factory: source carries the markers, exports hide the
// object under a minified key.
function playbackFactory() {
  return { f: "getCurrentPlayer setDefaultPlayerActive" };
}
function unrelatedFactory() {
  return { A: "something else entirely" };
}

const SPEC = {
  label: "playbackManager",
  markers: ["getCurrentPlayer", "setDefaultPlayerActive"],
  directIds: [39738],
  validate: (c) => !!(c && c.play && c.canPlay && c.getCurrentPlayer),
};

// Builds a fake webpack require. `expose` controls which of .c / .m exist, so the 10.11 and
// 12.1 shapes can both be simulated.
function makeReq({ modules, expose = ["m"], cache = null }) {
  const required = [];
  const req = (id) => {
    required.push(String(id));
    if (!(String(id) in modules)) throw new Error("module not found: " + id);
    return modules[String(id)].exports;
  };
  if (expose.includes("m")) {
    req.m = Object.fromEntries(Object.entries(modules).map(([id, m]) => [id, m.factory]));
  }
  if (expose.includes("c")) req.c = cache ?? modules;
  req.required = required;
  return req;
}

const reset = () => webpackModuleIdCache.clear();

{
  // The 12.1 shape: no .c, and the hardcoded id is absent.
  reset();
  const req = makeReq({
    modules: {
      "111": { factory: unrelatedFactory, exports: { A: {} } },
      "222": { factory: playbackFactory, exports: { f: PLAYBACK_MANAGER } },
    },
    expose: ["m"],
  });
  const found = findWebpackModuleBySignature(req, SPEC);
  if (found !== PLAYBACK_MANAGER) fail("must find the module by source signature when only .m exists");
  else ok("finds the module by source signature (the 12.1 shape)");

  if (req.required.includes("111")) fail("must not require factories that do not match the signature");
  else ok("never requires a non-matching factory");

  if (!req.required.includes("39738")) fail("should still try the known id first");
  else ok("tries the hardcoded id first, so 10.11 costs nothing");
}

{
  // A module whose source matches but whose exports are the wrong shape must be rejected,
  // not returned. This is the guard against grabbing the wrong module.
  reset();
  const req = makeReq({
    modules: {
      "333": { factory: playbackFactory, exports: { f: { play: () => {} } } },
    },
    expose: ["m"],
  });
  if (findWebpackModuleBySignature(req, SPEC) !== null) {
    fail("a source match with the wrong shape must be rejected");
  } else {
    ok("rejects a source match whose shape does not validate");
  }
}

{
  // The export key is minified and may change; the value is found wherever it sits.
  reset();
  const req = makeReq({
    modules: { "444": { factory: playbackFactory, exports: { somethingElse: PLAYBACK_MANAGER } } },
    expose: ["m"],
  });
  if (findWebpackModuleBySignature(req, SPEC) !== PLAYBACK_MANAGER) {
    fail("must not depend on the export key name");
  } else {
    ok("finds the export under any key name");
  }
}

{
  // Second lookup must reuse the resolved id instead of walking every factory again.
  reset();
  const modules = {
    "111": { factory: unrelatedFactory, exports: { A: {} } },
    "222": { factory: playbackFactory, exports: { f: PLAYBACK_MANAGER } },
  };
  const first = makeReq({ modules, expose: ["m"] });
  findWebpackModuleBySignature(first, SPEC);

  const second = makeReq({ modules, expose: ["m"] });
  const found = findWebpackModuleBySignature(second, SPEC);
  if (found !== PLAYBACK_MANAGER) fail("cached lookup must still return the module");
  else if (second.required.length !== 1 || second.required[0] !== "222") {
    fail("cached lookup must go straight to the known id, got: " + second.required.join(","));
  } else {
    ok("caches the resolved id and skips the scan next time");
  }
}

{
  // The 10.11 shape: .c exists and the hardcoded id resolves.
  reset();
  const req = makeReq({
    modules: { "39738": { factory: playbackFactory, exports: { f: PLAYBACK_MANAGER } } },
    expose: ["c", "m"],
  });
  if (findWebpackModuleBySignature(req, SPEC) !== PLAYBACK_MANAGER) {
    fail("the 10.11 fast path must keep working");
  } else {
    ok("still resolves via the hardcoded id (the 10.11 shape)");
  }
}

{
  reset();
  const req = makeReq({ modules: { "111": { factory: unrelatedFactory, exports: { A: {} } } }, expose: ["m"] });
  if (findWebpackModuleBySignature(req, SPEC) !== null) fail("must return null when nothing matches");
  else ok("returns null when no module matches");

  if (findWebpackModuleBySignature(null, SPEC) !== null) fail("must tolerate a missing require");
  else ok("tolerates a missing webpack require");
}

console.log(failures === 0 ? "\nPASS webpackModuleLookup" : `\nFAIL webpackModuleLookup (${failures})`);
process.exit(failures === 0 ? 0 : 1);
