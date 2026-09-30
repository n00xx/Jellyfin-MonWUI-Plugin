// Regression test: jellyfin-web's device id must never travel through the shared snapshot.
//
// jellyfin-web keeps its DeviceId in localStorage under `_deviceId2`. The deny list only
// knew the older names (deviceId, jf_api_deviceId, persist_device_id...), so `_deviceId2`
// got published into the global UserSettings snapshot and applySnapshotToStorage() wrote
// that one value into every browser. Jellyfin then saw all web clients as a single device
// and, since it revokes a user's previous token on the same DeviceId at login, signing in
// on one browser silently logged the same user out of every other one.
//
// The same holds for any key that names a user, server or library id (v3.7.1.33): jellyfin-web's
// cached user record `user-<userId>-<serverId>`, its per-user prefs `<userId>-homesection0`,
// KefinTweaks' `kefinTweaks_watchlist_movies_<userId>`... They reached the snapshot through
// "Publish global" (which dumps all of localStorage) and the anonymous Get served them to anyone.
//
// Exercised against the real module (with a minimal browser shim), not a reimplementation.

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

  // See storagePreloadWipe.test.mjs: a data: URL forces ESM parsing and a fresh instance.
  const instanced = moduleSource + `\n// instance:${Math.random()}\n`;
  await import("data:text/javascript;charset=utf-8," + encodeURIComponent(instanced));

  return { storage, bridge: globalThis.window.__JMS_MANAGED_STORAGE__, publishedBodies };
}

console.log("a server snapshot carrying _deviceId2 must not overwrite this browser's device id");
{
  const { storage } = await loadModule({
    initialStorage: { _deviceId2: "this-browser" },
    serverSnapshot: { _deviceId2: "some-other-browser", enableSlider: "true" },
  });

  if (storage.getItem("_deviceId2") !== "this-browser") {
    fail(`device id was replaced by the shared one; got ${JSON.stringify(storage.getItem("_deviceId2"))}`);
  } else {
    ok("local _deviceId2 survives a snapshot that contains one");
  }
  if (storage.getItem("enableSlider") !== "true") {
    fail("the rest of the snapshot was not applied");
  } else {
    ok("ordinary settings from the same snapshot are still applied");
  }
}

console.log("\n_deviceId2 must never be published, even when registered explicitly");
{
  const { storage, bridge, publishedBodies } = await loadModule({
    // Signed in: since v3.7.1.32 nothing is published without a token.
    initialStorage: {
      _deviceId2: "this-browser",
      jellyfin_credentials: JSON.stringify({ Servers: [{ AccessToken: "admin-token", DateLastAccessed: 1 }] }),
    },
    serverSnapshot: { enableSlider: "true" },
  });

  bridge.registerKeys(["_deviceId2", "enableSlider"]);
  storage.setItem("_deviceId2", "regenerated-id");
  storage.setItem("enableSlider", "false");
  await bridge.flush();

  const leaked = publishedBodies.filter((body) => Object.hasOwn(body?.global || {}, "_deviceId2"));
  if (!publishedBodies.length) {
    fail("nothing was published, so the assertion below proves nothing");
  } else if (leaked.length) {
    fail(`_deviceId2 was published in ${leaked.length} of ${publishedBodies.length} snapshot(s)`);
  } else {
    ok(`no published snapshot contains _deviceId2 (${publishedBodies.length} checked)`);
  }
}

const USER = "ffac969e9e834b289249f29e5cf5b36b";
const SERVER = "94853d4c6a91445ab7199c4ce8c36d12";
const INSTANCE_KEYS = [
  `user-${USER}-${SERVER}`,
  `${USER}-homesection0`,
  `${USER}-5ddaa59a73205234890fdcfc683e14ed-series`,
  `kefinTweaks_watchlist_movies_${USER}`,
  `prc:genresListLS:${SERVER}|${USER}`,
  `jf_profileChooser_lastActive::${SERVER}`,
  "note-6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", // dashed GUID form
];

console.log("\nkeys naming a user, server or library id are never taken from the snapshot");
{
  const { storage } = await loadModule({
    serverSnapshot: Object.fromEntries([...INSTANCE_KEYS.map((key) => [key, "from-another-browser"]), ["enableSlider", "true"]]),
  });

  const applied = INSTANCE_KEYS.filter((key) => storage.getItem(key) !== null);
  if (applied.length) fail(`applied from the snapshot: ${applied.join(", ")}`);
  else ok(`none of the ${INSTANCE_KEYS.length} instance-scoped keys was written locally`);
  if (storage.getItem("enableSlider") !== "true") fail("an ordinary setting from the same snapshot was not applied");
  else ok("ordinary settings still apply");
}

console.log("\nkeys naming a user, server or library id are never published");
{
  const { storage, bridge, publishedBodies } = await loadModule({
    initialStorage: {
      jellyfin_credentials: JSON.stringify({ Servers: [{ AccessToken: "admin-token", DateLastAccessed: 1 }] }),
    },
    serverSnapshot: { enableSlider: "true" },
  });

  bridge.registerKeys([...INSTANCE_KEYS, "enableSlider"]);
  for (const key of INSTANCE_KEYS) storage.setItem(key, "local");
  storage.setItem("enableSlider", "false");
  await bridge.flush();

  const leaked = new Set(publishedBodies.flatMap((body) => INSTANCE_KEYS.filter((key) => Object.hasOwn(body?.global || {}, key))));
  if (!publishedBodies.length) fail("nothing was published, so the assertion below proves nothing");
  else if (leaked.size) fail(`published: ${[...leaked].join(", ")}`);
  else ok(`no published snapshot contains an instance-scoped key (${publishedBodies.length} checked)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
