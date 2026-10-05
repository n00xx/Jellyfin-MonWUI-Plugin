// The music player builds its library database from /Users/{id}/Items, and artistModal.js sent
// those requests with X-Emby-Token alone. Jellyfin 12 ignores that header: measured against the
// 12.1 server, token-only answers 401 and the same request with `Authorization` answers 200.
// So on 12.1 the music library never synced, on every platform.
//
// buildArtistModalAuthHeaders() is module-private in a module too heavy to import here, so it is
// lifted from the source and run against the real auth.js helper it depends on.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (rel) => readFileSync(path.resolve(here, "../Resources/slider/modules/player", rel), "utf8");
const toDataUrl = (src) => "data:text/javascript;charset=utf-8," + encodeURIComponent(src);

const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = {
  location: { href: "http://localhost/web/", origin: "http://localhost" },
  ApiClient: { deviceName: () => 'Kitchen "iPad"', deviceId: () => "dev9", appVersion: () => "12.1.0" },
};

const auth = await import(toDataUrl(read("core/auth.js")));

const lifted = read("ui/artistModal.js").match(/function buildArtistModalAuthHeaders\([\s\S]*?\n}\n/);
if (!lifted) throw new Error("buildArtistModalAuthHeaders not found in artistModal.js");
const buildArtistModalAuthHeaders = new Function(
  "mediaBrowserAuthorization",
  `${lifted[0]}\nreturn buildArtistModalAuthHeaders;`
)(auth.mediaBrowserAuthorization);

console.log("music sync requests carry a credential Jellyfin 12 reads");
{
  const h = buildArtistModalAuthHeaders("k1", "u1");
  const a = h.Authorization || "";
  if (!a.startsWith("MediaBrowser ") || !a.includes('Token="k1"')) fail(`Authorization missing or without the token: ${JSON.stringify(h)}`);
  else ok('Authorization: MediaBrowser … Token="k1"');
  if (a.includes('"iPad"') || !a.includes('Device="Kitchen iPad"')) fail(`quotes in the device name must be stripped: ${a}`);
  else ok("device name quotes are stripped");
  if (h["X-Emby-Token"] !== "k1") fail("X-Emby-Token must stay for 10.11 servers");
  else ok("X-Emby-Token kept for 10.11");
  if (h["X-Emby-UserId"] !== "u1") fail("user id headers must stay");
  else ok("user id headers kept");
}
{
  const h = buildArtistModalAuthHeaders("", "u1");
  if ("Authorization" in h || "X-Emby-Token" in h) fail(`no token must mean no credential, got ${JSON.stringify(h)}`);
  else ok("no token, no credential headers");
}

console.log("\nauthHeaders() still builds the same header");
{
  store.set("api-key", "k2");
  const viaAuthHeaders = auth.authHeaders().Authorization;
  if (viaAuthHeaders !== auth.mediaBrowserAuthorization("k2")) fail(`authHeaders and mediaBrowserAuthorization disagree:\n    ${viaAuthHeaders}\n    ${auth.mediaBrowserAuthorization?.("k2")}`);
  else ok("authHeaders() and mediaBrowserAuthorization() agree");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
