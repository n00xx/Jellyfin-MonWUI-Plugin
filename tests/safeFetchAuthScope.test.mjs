// Covers which URLs safeFetch is allowed to put the user's access token on.
//
// Jellyfin 12 only honours `Authorization: MediaBrowser Token="..."`, so buildSafeFetchHeaders
// has to attach it where the old code attached the (now ignored) X-Emby-Token. The tempting
// shortcut is "attach it to everything same-origin" — but safeFetch also serves the plugin's
// own assets, and normalizeWithServer() rewrites /slider/* to /web/slider/*. Attaching the
// session token to those hands a credential to requests that have no use for it.
//
// So the predicate is a list of Jellyfin API roots, and these assertions pin both edges:
// the API paths that must carry a credential (the old predicate missed /Items, /Shows/NextUp
// and /Studios entirely, which is the bug this replaced) and the paths that must not.
//
// Image routes are the subtle one: they are anonymous in Jellyfin 12 and get fetched before
// login, so requiring a token there would break the profile chooser's avatars.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const here = path.dirname(new URL(import.meta.url).pathname);
const main = readFileSync(path.resolve(here, "../Resources/slider/main.js"), "utf8");

// main.js is the bundle entry point and cannot be imported in Node, so the three functions
// under test are lifted verbatim and evaluated with stubbed collaborators — same read-the-real-
// source approach the other suites use, so the assertions track the shipped code.
function lift(pattern, label) {
  const m = main.match(pattern);
  if (!m) throw new Error(`could not lift ${label} from main.js`);
  return m[0];
}

const parts = [
  lift(/const JELLYFIN_AUTHED_PATH =\n[\s\S]*?;\n/, "JELLYFIN_AUTHED_PATH"),
  lift(/const JELLYFIN_TOKEN_REQUIRED_PATH =\n[\s\S]*?;\n/, "JELLYFIN_TOKEN_REQUIRED_PATH"),
  lift(/function requiresTokenBeforeRequest\(url = ""\) \{[\s\S]*?\n\}/, "requiresTokenBeforeRequest"),
  lift(/function requiresAuthRequest\(url = ""\) \{[\s\S]*?\n\}/, "requiresAuthRequest"),
  lift(/function isSameOriginRequest\(url = ""\) \{[\s\S]*?\n\}/, "isSameOriginRequest"),
  lift(/function buildSafeFetchHeaders\(url, incomingHeaders\) \{[\s\S]*?\n\}/, "buildSafeFetchHeaders"),
];

const stubs = `
const window = { location: { origin: "http://jf.local" } };
const getSessionInfo = () => ({ accessToken: "tok123", userId: "u1" });
const getAuthToken = () => "tok123";
const getAuthHeader = () => 'MediaBrowser Client="Jellyfin Web Client", Token="tok123"';
`;

const mod = await import(
  "data:text/javascript;charset=utf-8," +
    encodeURIComponent(
      stubs + parts.join("\n") + "\nexport { requiresAuthRequest, requiresTokenBeforeRequest, buildSafeFetchHeaders };"
    )
);

const authOn = (url) => mod.buildSafeFetchHeaders(url, {}).get("Authorization");

{
  // The paths the previous predicate missed: these 401 on 12.1 without a credential.
  for (const url of ["/Items?Limit=1", "/Shows/NextUp?userId=u1", "/Studios?Limit=1",
                     "/Genres", "/UserViews?userId=u1", "/Users/u1/Items"]) {
    if (!authOn(url)) fail(`${url} must carry Authorization`);
    else ok(`${url} carries Authorization`);
  }
}

{
  // The regression guard: plugin assets must not receive the user's token.
  for (const url of ["/web/slider/main.js", "/web/slider/modules/config.js",
                     "/slider/language/spa.js", "/Plugins/JMSFusion/ping"]) {
    if (authOn(url)) fail(`${url} must NOT carry Authorization — that leaks the session token`);
    else ok(`${url} carries no credential`);
  }
}

{
  // Anonymous in Jellyfin 12, and fetched before login.
  for (const url of ["/Items/abc/Images/Primary", "/Users/u1/Images/Primary?tag=x"]) {
    if (authOn(url)) fail(`${url} is anonymous; it must not demand a credential`);
    else ok(`${url} stays anonymous`);
  }
}

{
  // An absolute third-party URL containing an API-shaped path must never get the token.
  const url = "https://api.themoviedb.org/3/Items/123";
  if (authOn(url)) fail("cross-origin URL must NOT carry Authorization");
  else ok("cross-origin URL carries no credential");
}

{
  // Same path, same origin, spelled absolutely — this one should still authenticate.
  const url = "http://jf.local/Users/u1/Items";
  if (!authOn(url)) fail("same-origin absolute URL must carry Authorization");
  else ok("same-origin absolute URL carries Authorization");
}

{
  // safeFetch blocks (waits, then throws "Auth not ready") on this narrower predicate.
  // Anonymous routes must stay out of it: gating them on auth-readiness costs a 5s stall on a
  // cold load and then throws, which surfaces as "the player hangs", not as a 401.
  const blocks = (url) => mod.requiresTokenBeforeRequest(url);

  for (const url of ["/Users/u1/Items", "/Sessions", "/Items/abc/PlaybackInfo"]) {
    if (!blocks(url)) fail(`${url} must wait for a token before firing`);
    else ok(`${url} waits for a token`);
  }

  // Measured on the live 12.1 server: /Videos/{id}/stream and the image routes answer 200
  // with no credential at all.
  for (const url of ["/Items/abc/Images/Primary", "/web/slider/main.js", "/Items?Limit=1",
                     "/Shows/NextUp", "/Studios"]) {
    if (blocks(url)) fail(`${url} is anonymous or optional-auth; it must not block on a token`);
    else ok(`${url} does not block on a token`);
  }

  // The two predicates are deliberately different: broad for "may carry a credential",
  // narrow for "must have one before firing".
  if (!mod.requiresAuthRequest("/Items?Limit=1") || blocks("/Items?Limit=1")) {
    fail("/Items must carry a credential without blocking on one");
  } else {
    ok("/Items carries a credential without blocking on one");
  }
}

console.log(failures === 0 ? "\nPASS safeFetchAuthScope" : `\nFAIL safeFetchAuthScope (${failures})`);
process.exit(failures === 0 ? 0 : 1);
