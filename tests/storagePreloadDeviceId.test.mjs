// Regression test: jellyfin-web's device id must never travel through the shared snapshot.
//
// jellyfin-web keeps its DeviceId in localStorage under `_deviceId2`. The deny list only
// knew the older names (deviceId, jf_api_deviceId, persist_device_id...), so `_deviceId2`
// got published into the global UserSettings snapshot and applySnapshotToStorage() wrote
// that one value into every browser. Jellyfin then saw all web clients as a single device
// and, since it revokes a user's previous token on the same DeviceId at login, signing in
// on one browser silently logged the same user out of every other one.
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
    initialStorage: { _deviceId2: "this-browser" },
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

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
