// Covers the credential the player modules put on Jellyfin requests.
//
// Jellyfin 12 stopped reading `X-Emby-Token` and `?api_key=`: both now answer 401, and only
// `Authorization: MediaBrowser Token="..."` authenticates. Measured against a live 12.1 server,
// the legacy pair is *ignored* rather than rejected when a valid Authorization is present — so
// authHeaders() sends both, keeping 10.11 servers working. These assertions pin that contract:
// drop the Authorization line and every playlist/lyrics/player call 401s on 12.1; drop
// X-Emby-Token and the same calls break on 10.11.
//
// The token-less case matters because getAuthToken() legitimately returns "" before login
// completes. Emitting `Token=""` would send a malformed credential; authHeaders must emit
// neither header and leave the caller's own auth-ready gate to handle it.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const here = path.dirname(new URL(import.meta.url).pathname);
const src = readFileSync(
  path.resolve(here, "../Resources/slider/modules/player/core/auth.js"),
  "utf8"
);

// auth.js reads its token from sessionStorage and its device fields off window.ApiClient;
// both are stubbed here so the header construction can be exercised in Node.
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { location: { href: "http://localhost/web/", origin: "http://localhost" } };

const { authHeaders } = await import(
  "data:text/javascript;charset=utf-8," + encodeURIComponent(src)
);

const setToken = (t) => (t ? store.set("api-key", t) : store.delete("api-key"));
const setApiClient = (c) => { globalThis.window.ApiClient = c; };

const CLIENT = {
  deviceName: () => 'Living "Room" TV',
  deviceId: () => "abc123",
  appVersion: () => "10.9.11",
};

{
  setToken("tok123");
  setApiClient(CLIENT);
  const headers = authHeaders();

  if (typeof headers.Authorization !== "string" || !headers.Authorization.startsWith("MediaBrowser ")) {
    fail("Authorization must be a MediaBrowser credential, got: " + headers.Authorization);
  } else {
    ok("emits a MediaBrowser Authorization header");
  }

  if (!String(headers.Authorization).includes('Token="tok123"')) {
    fail('Authorization must carry Token="tok123", got: ' + headers.Authorization);
  } else {
    ok("carries the access token in the Token field");
  }

  if (headers["X-Emby-Token"] !== "tok123") {
    fail("X-Emby-Token must still be sent for 10.11 compatibility");
  } else {
    ok("keeps X-Emby-Token for older servers");
  }

  // A quote in a device name would close the header value early and corrupt the credential.
  const device = String(headers.Authorization).match(/Device="([^"]*)"/);
  if (!device || device[1] !== "Living Room TV") {
    fail("quotes in the device name must be stripped, got: " + headers.Authorization);
  } else {
    ok("strips quotes out of ApiClient-supplied fields");
  }
}

{
  setToken("");
  setApiClient(CLIENT);
  const headers = authHeaders({ Accept: "application/json" });

  if ("Authorization" in headers || "X-Emby-Token" in headers) {
    fail("no credential may be emitted when there is no token");
  } else {
    ok("emits no credential when the token is empty");
  }

  if (headers.Accept !== "application/json") {
    fail("caller-supplied headers must survive");
  } else {
    ok("preserves caller-supplied headers when unauthenticated");
  }
}

{
  setToken("tok123");
  setApiClient(CLIENT);
  const headers = authHeaders({ "Content-Type": "application/json" });

  if (headers["Content-Type"] !== "application/json" || !headers.Authorization) {
    fail("extra headers must merge with the credential");
  } else {
    ok("merges extra headers with the credential");
  }
}

{
  // ApiClient is absent during early boot; the helper must still produce a usable credential.
  setToken("tok123");
  setApiClient(undefined);
  const headers = authHeaders();

  if (!String(headers.Authorization).includes('Token="tok123"')) {
    fail("must still authenticate when window.ApiClient is unavailable");
  } else {
    ok("falls back to defaults when ApiClient is unavailable");
  }
}

console.log(failures === 0 ? "\nPASS jellyfinAuthHeaders" : `\nFAIL jellyfinAuthHeaders (${failures})`);
process.exit(failures === 0 ? 0 : 1);
