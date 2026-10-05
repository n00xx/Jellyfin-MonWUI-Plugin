// fetchLocalTrailers() authenticated with `X-Emby-Token` alone. Jellyfin 12 ignores that
// header, so every /Items/{id}/LocalTrailers call answered 401 and returned no trailers: the
// hover trailer, the details modal and the studio popover all fell back to YouTube or nothing.
// It surfaced on phones first because the touch path asks for local trailers without a hover.
//
// The fix routes it through buildEmbyHeaders(), the same builder the other api.js requests use,
// which always sends `Authorization: MediaBrowser … Token="…"` (and keeps X-Emby-Token for 10.11).

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const here = path.dirname(new URL(import.meta.url).pathname);
const toDataUrl = (src) => "data:text/javascript;charset=utf-8," + encodeURIComponent(src);

// api.js imports three modules through its served path; stub each with the names it imports.
const stubs = {
  "../../../slider/modules/config.js": `
    export const getConfig = () => ({});
    export const getServerAddress = () => "";
    export const isCinemaPreRollModuleEnabled = () => false;
    export const isParentalPinModuleEnabled = () => false;`,
  "./auth.js": `
    export const clearCredentials = () => {};
    export const getWebClientHints = () => ({});
    export const getStoredServerBase = () => "";`,
  "../../../slider/modules/jfUrl.js": `
    export const withServer = (u) => "http://jf.test" + u;
    export const withServerSrcset = (s) => s;
    export const invalidateServerBaseCache = () => {};
    export const resolveServerBase = () => "http://jf.test";`,
};
let src = readFileSync(path.resolve(here, "../RuntimeModules/api.js"), "utf8");
for (const [spec, body] of Object.entries(stubs)) {
  const quoted = new RegExp(`(["'])${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\1`, "g");
  if (!quoted.test(src)) throw new Error(`api.js no longer imports ${spec}; update the stubs`);
  src = src.replace(quoted, JSON.stringify(toDataUrl(body)));
}

const storage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
// api.js schedules timers and listeners on window as it loads, so window is the real global.
globalThis.window = globalThis;
globalThis.location = { href: "http://jf.test/web/", origin: "http://jf.test", hash: "" };
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.dispatchEvent ??= () => true;
// Shaped like 12.1's ApiClient, which has no getAuthorizationHeader(): the header has to be
// built from the token, the way it is on a real server.
globalThis.ApiClient = {
  accessToken: () => "tok123",
  getCurrentUserId: () => "u1",
  deviceId: () => "d1",
  deviceName: () => "Phone",
  serverAddress: () => "http://jf.test",
};
globalThis.document = { cookie: "", addEventListener: () => {}, removeEventListener: () => {}, visibilityState: "visible" };

let sent = null;
globalThis.fetch = async (url, init = {}) => {
  sent = { url: String(url), headers: { ...(init.headers || {}) } };
  return { ok: true, status: 200, json: async () => ({ Items: [{ Id: "t1" }] }) };
};

const { fetchLocalTrailers } = await import(toDataUrl(src));

console.log("LocalTrailers request carries a credential Jellyfin 12 reads");
{
  const items = await fetchLocalTrailers("item42");
  if (!sent) fail("no request was made");
  else {
    const auth = sent.headers.Authorization || sent.headers.authorization || "";
    if (!/^MediaBrowser /.test(auth) || !/Token="tok123"/.test(auth)) fail(`Authorization missing or without the token: ${JSON.stringify(sent.headers)}`);
    else ok("Authorization: MediaBrowser … Token=\"tok123\"");
    if (!/\/Items\/item42\/LocalTrailers\?userId=u1$/.test(sent.url)) fail(`unexpected url ${sent.url}`);
    else ok("url keeps /Items/{id}/LocalTrailers?userId=");
  }
  if (items.length !== 1 || items[0].Id !== "t1") fail(`expected the trailer list back, got ${JSON.stringify(items)}`);
  else ok("returns the trailer items");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
