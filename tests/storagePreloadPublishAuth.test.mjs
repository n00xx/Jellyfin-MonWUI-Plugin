// Regression test: the shared settings snapshot is written only with the caller's credential.
//
// /UserSettings/Publish used to accept anonymous writes, and the snapshot it stores is forced
// onto every browser. From v3.7.1.32 the server requires an administrator, so the preload has to:
//
//   1. send `Authorization: MediaBrowser Token="..."` (Jellyfin 12 ignores X-Emby-Token) and
//      nothing else identifying: a DeviceId here would be one more shared device id;
//   2. not POST at all without a token, keeping the edit pending for a later signed-in load;
//   3. on 403 drop the pending flag and stop retrying. A flag that survives would make this
//      browser's local values win over the admin's snapshot on every load, forever;
//   4. on 401 (stale token) keep the edit pending, since signing in again can still publish it.
//
// Exercised against the real module (with a minimal browser shim), not a reimplementation.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const PENDING = "jms:managedStorage:pendingPublish:v1";

class FakeLocalStorage {
  constructor(initial = {}) { this._store = { ...initial }; }
  getItem(key) { return Object.prototype.hasOwnProperty.call(this._store, key) ? this._store[key] : null; }
  setItem(key, value) { this._store[key] = String(value); }
  removeItem(key) { delete this._store[key]; }
  clear() { this._store = {}; }
}

const modulePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../RuntimeModules/storagePreload.js");
const moduleSource = readFileSync(modulePath, "utf8");

const credentials = (token) => JSON.stringify({
  Servers: [
    { Id: "old", AccessToken: "stale-token", DateLastAccessed: 1000 },
    { Id: "current", AccessToken: token, DateLastAccessed: 2000 },
  ],
});

async function loadModule({ initialStorage = {}, publishStatus = 200 } = {}) {
  const storage = new FakeLocalStorage(initialStorage);
  const posts = [];

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
      posts.push({ headers: { ...(init.headers || {}) }, body: JSON.parse(init.body) });
      const okStatus = publishStatus >= 200 && publishStatus < 300;
      return {
        ok: okStatus,
        status: publishStatus,
        text: async () => "",
        json: async () => (okStatus ? { ok: true, rev: 2 } : {}),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ profile: "desktop", rev: 1, forceGlobal: true, global: { enableSlider: "true" } }),
    };
  };

  // See storagePreloadWipe.test.mjs: a data: URL forces ESM parsing and a fresh instance.
  const instanced = moduleSource + `\n// instance:${Math.random()}\n`;
  await import("data:text/javascript;charset=utf-8," + encodeURIComponent(instanced));

  return { storage, bridge: globalThis.window.__JMS_MANAGED_STORAGE__, posts };
}

// Edits a managed key the way the app does, then forces the debounced publish to run now.
async function editAndFlush(storage, bridge, value) {
  storage.setItem("enableSlider", value);
  await bridge.flush().catch(() => {});
}

console.log("a publish carries the signed-in user's token and nothing that names a device");
{
  const { storage, bridge, posts } = await loadModule({
    initialStorage: { jellyfin_credentials: credentials("current-token") },
  });
  await editAndFlush(storage, bridge, "false");

  const auth = posts[0]?.headers?.Authorization;
  if (auth !== 'MediaBrowser Token="current-token"') {
    fail(`expected the most recently used server's token, got Authorization=${JSON.stringify(auth)}`);
  } else {
    ok("Authorization: MediaBrowser Token=\"<most recent server token>\"");
  }
  if (posts[0] && /DeviceId/i.test(JSON.stringify(posts[0].headers))) {
    fail("the publish names a DeviceId");
  } else {
    ok("no DeviceId in the publish headers");
  }
}

console.log("\nwithout a token nothing is posted and the edit stays pending");
{
  const { storage, bridge, posts } = await loadModule();
  await editAndFlush(storage, bridge, "false");

  if (posts.length) fail(`posted ${posts.length} time(s) with no credential`);
  else ok("no anonymous POST");
  if (storage.getItem(PENDING) !== "1") fail("the pending flag was dropped, so the edit can never be retried");
  else ok("edit left pending for a later signed-in load");
}

console.log("\na 403 drops the pending flag and stops retrying");
{
  const { storage, bridge, posts } = await loadModule({
    initialStorage: { jellyfin_credentials: credentials("viewer-token") },
    publishStatus: 403,
  });
  await editAndFlush(storage, bridge, "false");
  const afterFirst = posts.length;
  const pendingAfter403 = storage.getItem(PENDING);
  // Not "true": that is the server's value, and matching it would skip the publish on its own.
  await editAndFlush(storage, bridge, "second-edit");

  if (afterFirst !== 1) fail(`expected exactly one attempt, got ${afterFirst}`);
  else ok("one attempt reached the server");
  if (pendingAfter403 !== null) fail("pending flag survived a 403; this browser would override the admin snapshot forever");
  else ok("pending flag cleared, so the admin snapshot applies on the next load");
  if (posts.length !== afterFirst) fail(`kept posting after a 403 (${posts.length} attempts)`);
  else ok("no further attempts after the 403");
}

console.log("\na 401 keeps the edit pending");
{
  const { storage, bridge } = await loadModule({
    initialStorage: { jellyfin_credentials: credentials("expired-token") },
    publishStatus: 401,
  });
  await editAndFlush(storage, bridge, "false");

  if (storage.getItem(PENDING) !== "1") fail("pending flag dropped on 401");
  else ok("edit stays pending until the user signs in again");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
