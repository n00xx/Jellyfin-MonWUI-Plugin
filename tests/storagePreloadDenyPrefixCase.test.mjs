// Regression test: the browser deny list compared prefixes case-sensitively against a
// lowercased key. `lowered.startsWith("studioHub_")` can never be true, so the `studioHub_`
// and `jms:focusedUserDataSync:` prefixes never matched in the browser: the studio row's
// per-browser caches (logo, backdrop and series-tag maps) and the focused user-data sync
// markers were taken from, and published to, the shared snapshot like UI settings.
// UserSettingsController compares OrdinalIgnoreCase, so the server already dropped them;
// the browser now agrees with it.
//
// Exercised against the real module (with the same minimal browser shim as
// storagePreloadDeviceId.test.mjs), not a reimplementation.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

class FakeLocalStorage {
  constructor(initial = {}) { this._store = { ...initial }; }
  getItem(key) { return Object.prototype.hasOwnProperty.call(this._store, key) ? this._store[key] : null; }
  setItem(key, value) { this._store[key] = String(value); }
  removeItem(key) { delete this._store[key]; }
  clear() { this._store = {}; }
}

const modulePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../RuntimeModules/storagePreload.js");
const moduleSource = readFileSync(modulePath, "utf8");

async function loadModule({ initialStorage = {}, serverSnapshot = {} } = {}) {
  const storage = new FakeLocalStorage(initialStorage);
  const publishedBodies = [];

  globalThis.window = {
    localStorage: storage,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    __JMS_USER_SETTINGS_SNAPSHOT__: undefined,
    __JMS_USER_SETTINGS_PROMISE__: undefined,
  };
  globalThis.document = { addEventListener() {} };
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node-test-agent" },
    configurable: true,
  });
  globalThis.localStorage = storage;
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method || "GET").toUpperCase() === "POST") {
      publishedBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true, rev: 2 }) };
    }
    return {
      ok: true,
      json: async () => ({ profile: "desktop", rev: 1, forceGlobal: true, global: serverSnapshot }),
    };
  };

  // A data: URL forces ESM parsing and a fresh module instance per call.
  const instanced = moduleSource + `\n// instance:${Math.random()}\n`;
  await import("data:text/javascript;charset=utf-8," + encodeURIComponent(instanced));

  return { storage, bridge: globalThis.window.__JMS_MANAGED_STORAGE__, publishedBodies };
}

// Real key names written by moui (studioHubs.js, main.js), in the casing they are written in.
const DENIED = [
  "studioHub_logoUrlCache_v1",
  "studioHub_backdropMap_v2",
  "studioHub_seriesTags_v1",
  "jms:focusedUserDataSync:someUser:someItem",
];
// Real settings that share a stem but not the prefix; they must keep syncing.
const SETTINGS = ["studioHubsOrder", "studioHubsHidden", "enableStudioHubs"];

console.log("prefix-denied keys are never taken from the snapshot");
{
  const { storage } = await loadModule({
    serverSnapshot: Object.fromEntries([
      ...DENIED.map((key) => [key, "from-another-browser"]),
      ...SETTINGS.map((key) => [key, "shared"]),
    ]),
  });

  const applied = DENIED.filter((key) => storage.getItem(key) !== null);
  if (applied.length) fail(`applied from the snapshot: ${applied.join(", ")}`);
  else ok(`none of the ${DENIED.length} prefix-denied keys was written locally`);

  const missing = SETTINGS.filter((key) => storage.getItem(key) !== "shared");
  if (missing.length) fail(`settings sharing the stem were not applied: ${missing.join(", ")}`);
  else ok(`settings that only share the stem still apply (${SETTINGS.join(", ")})`);
}

console.log("\nprefix-denied keys are never published");
{
  const { storage, bridge, publishedBodies } = await loadModule({
    initialStorage: {
      jellyfin_credentials: JSON.stringify({ Servers: [{ AccessToken: "admin-token", DateLastAccessed: 1 }] }),
    },
    serverSnapshot: { enableSlider: "true" },
  });

  bridge.registerKeys([...DENIED, ...SETTINGS]);
  for (const key of DENIED) storage.setItem(key, "local");
  for (const key of SETTINGS) storage.setItem(key, "local-setting");
  await bridge.flush();

  const leaked = new Set(publishedBodies.flatMap((body) => DENIED.filter((key) => Object.hasOwn(body?.global || {}, key))));
  const kept = new Set(publishedBodies.flatMap((body) => SETTINGS.filter((key) => Object.hasOwn(body?.global || {}, key))));
  if (!publishedBodies.length) fail("nothing was published, so the assertions below prove nothing");
  else if (leaked.size) fail(`published: ${[...leaked].join(", ")}`);
  else ok(`no published snapshot contains a prefix-denied key (${publishedBodies.length} checked)`);
  if (publishedBodies.length && kept.size !== SETTINGS.length) {
    fail(`settings sharing the stem were not published: ${SETTINGS.filter((key) => !kept.has(key)).join(", ")}`);
  } else if (publishedBodies.length) {
    ok("settings that only share the stem are still published");
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
