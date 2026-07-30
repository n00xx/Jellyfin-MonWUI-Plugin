// Regression test for two managed-storage defects that silently erased settings the
// user had already configured:
//
//  1. registerKeys() used to delete a local value the moment its key was registered as
//     managed if the server's last-published snapshot didn't happen to include it — even
//     though "absent from the snapshot" usually just meant "never round-tripped from this
//     profile", not "the server cleared it".
//  2. loadServerSnapshot() used to overwrite local storage with the server snapshot on
//     every page load unconditionally, even when the local value was a newer edit that a
//     previous session had not yet confirmed as published (network error, tab closed
//     mid-debounce, etc).
//
// Both are exercised against the real module (with a minimal browser shim), not a
// reimplementation, so this fails if the wipe behavior is reintroduced.

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

async function loadModule({ initialStorage = {}, serverSnapshot = {}, forceGlobal = false } = {}) {
  const storage = new FakeLocalStorage(initialStorage);

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
  // Node >=21 exposes a read-only `navigator` global (Navigator API compat), so it can't be
  // assigned directly — redefine it instead.
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node-test-agent" },
    configurable: true,
  });
  globalThis.localStorage = storage;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ profile: "desktop", rev: 1, forceGlobal, global: serverSnapshot }),
  });

  // storagePreload.js ships as a plain browser <script type="module">, and this repo has
  // no package.json declaring "type": "module", so Node would treat a direct file import
  // as CommonJS and choke on its top-level `await`. Importing it as a data: URL forces ESM
  // parsing regardless, and appending a fresh instance marker each time guarantees a new
  // module instance (with its own module-scope state) per test instead of a cached one.
  const instanced = moduleSource + `\n// instance:${Math.random()}\n`;
  const dataUrl = "data:text/javascript;charset=utf-8," + encodeURIComponent(instanced);
  await import(dataUrl);

  return { storage, bridge: globalThis.window.__JMS_MANAGED_STORAGE__ };
}

console.log("registerKeys() must not delete a value absent from the server snapshot");
{
  const { storage, bridge } = await loadModule({
    initialStorage: { showDirectorWriter: "false" },
    // Non-empty on purpose: an empty snapshot was already exempt from the old wipe
    // condition. This mirrors the real case — a profile blob that has *some* keys
    // published but not this particular one (e.g. the incomplete mobile blob found in
    // production, which was missing enableToastNew/enableNotifications entirely).
    serverSnapshot: { enableSlider: "true" },
  });

  bridge.registerKeys(["showDirectorWriter"]);

  if (storage.getItem("showDirectorWriter") !== "false") {
    fail(`showDirectorWriter was wiped; got ${JSON.stringify(storage.getItem("showDirectorWriter"))}`);
  } else {
    ok("existing local value survives registration as a managed key");
  }
}

console.log("\na pending unconfirmed edit must not be overwritten by a stale server snapshot");
{
  const { storage } = await loadModule({
    initialStorage: {
      enableSerrArrIntegrationModule: "true",
      "jms:managedStorage:pendingPublish:v1": "1",
    },
    serverSnapshot: { enableSerrArrIntegrationModule: "false" }, // stale: predates the local edit
  });

  if (storage.getItem("enableSerrArrIntegrationModule") !== "true") {
    fail(`local edit was clobbered by the stale server value; got ${JSON.stringify(storage.getItem("enableSerrArrIntegrationModule"))}`);
  } else {
    ok("pending local edit wins over the stale server snapshot");
  }
}

console.log("\nwith no pending edit, the server snapshot is applied normally");
{
  const { storage } = await loadModule({
    initialStorage: { enableSerrArrIntegrationModule: "true" },
    serverSnapshot: { enableSerrArrIntegrationModule: "false" }, // another device's change
  });

  if (storage.getItem("enableSerrArrIntegrationModule") !== "false") {
    fail(`server snapshot was not applied; got ${JSON.stringify(storage.getItem("enableSerrArrIntegrationModule"))}`);
  } else {
    ok("no pending edit: server snapshot from another device is honored");
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
