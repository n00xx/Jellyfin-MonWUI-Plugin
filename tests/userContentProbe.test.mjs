// The home screen asks one question before mounting moui's rows: can this user see any item at
// all? On Neexy an expired membership cuts the user's access down to one EMPTY library whose
// image is the renewal QR; moui must stand down so jellyfin-web's "My Media" card is all that
// shows. The probe must never hide moui from a paying user, so every doubt answers "yes".

import {
  buildUserContentProbeUrl,
  interpretUserContentProbe,
  createUserContentProbe,
} from "../Resources/slider/modules/userContentProbe.js";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);
const expectEq = (label, got, want) => {
  if (got === want) ok(`${label} -> ${JSON.stringify(got)}`);
  else fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

console.log("probe url");
{
  // The user's library views with their child counts: 20-80 ms on tv.neexy.net, against
  // 1.7-3.4 s for a recursive /Items count over a 12,504-item library. Rows wait on this.
  const url = buildUserContentProbeUrl("abc 123");
  const [path, query] = url.split("?");
  const params = new URLSearchParams(query);
  expectEq("path (the route moui already uses, works on 10.x and 12.x)", path, "/Users/abc%20123/Views");
  expectEq("asks for child counts", params.get("Fields"), "ChildCount");
  if (/membres|vencid/i.test(url)) fail("the probe must not key off the library name");
  else ok("does not mention any library name");
}

console.log("\ninterpreting the response (shapes measured on tv.neexy.net, 2026-10-04)");
const view = (CollectionType, ChildCount, Type = "CollectionFolder") => ({ CollectionType, ChildCount, Type });
expectEq("expired: one empty movie library",
  interpretUserContentProbe({ Items: [view("movies", 0)] }), false);
expectEq("expired with leftover playlists (they are not content)",
  interpretUserContentProbe({ Items: [view("movies", 0), view("playlists", 2, "UserView")] }), false);
expectEq("paying user",
  interpretUserContentProbe({ Items: [view("boxsets", 90), view("movies", 882), view("tvshows", 470)] }), true);
expectEq("admin: full libraries next to the empty one",
  interpretUserContentProbe({ Items: [view("movies", 882), view("movies", 0), view("livetv", 0, "UserView")] }), true);
expectEq("collections alone are not content (their titles live in libraries)",
  interpretUserContentProbe({ Items: [view("boxsets", 90)] }), false);
expectEq("live TV alone is not something moui shows",
  interpretUserContentProbe({ Items: [view("livetv", 12, "UserView")] }), false);
expectEq("mixed-content library (no CollectionType) with children",
  interpretUserContentProbe({ Items: [view(undefined, 5)] }), true);
expectEq("music library",
  interpretUserContentProbe({ Items: [view("music", 40)] }), true);
expectEq("no library at all", interpretUserContentProbe({ Items: [] }), false);
expectEq("ChildCount missing on a content library (fail-open)",
  interpretUserContentProbe({ Items: [{ CollectionType: "movies", Type: "CollectionFolder" }] }), true);
expectEq("null (fail-open)", interpretUserContentProbe(null), true);
expectEq("string (fail-open)", interpretUserContentProbe("<html>"), true);
expectEq("no Items array (fail-open)", interpretUserContentProbe({ ok: true }), true);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRequest(responses) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (typeof next === "function") return next(url);
    if (next instanceof Error) throw next;
    return next;
  };
  return { request, calls };
}

console.log("\nprobe: answers and caching");
{
  const { request, calls } = fakeRequest([{ Items: [], TotalRecordCount: 0 }]);
  let now = 0;
  const probe = createUserContentProbe({ request, now: () => now, negativeTtlMs: 30_000 });
  expectEq("expired user", await probe.check("u1"), false);
  expectEq("one request", calls.length, 1);
  expectEq("peek knows", probe.peek("u1"), false);
  expectEq("second check inside the TTL is cached", await probe.check("u1"), false);
  expectEq("still one request", calls.length, 1);
  expectEq("refresh re-asks (a renewal shows up on the next home visit)", await probe.check("u1", { refresh: true }), false);
  expectEq("two requests", calls.length, 2);
  now = 31_000;
  expectEq("peek after the TTL is unknown", probe.peek("u1"), undefined);
  await probe.check("u1");
  expectEq("expired negative re-asks", calls.length, 3);
}

{
  const { request, calls } = fakeRequest([{ Items: [{ Id: "x" }], TotalRecordCount: 5 }]);
  const probe = createUserContentProbe({ request });
  expectEq("paying user", await probe.check("u2"), true);
  await probe.check("u2", { refresh: true });
  expectEq("a positive answer is kept for the session, even on refresh", calls.length, 1);
}

console.log("\nprobe: concurrent callers share one request");
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const { request, calls } = fakeRequest([async () => { await gate; return { Items: [], TotalRecordCount: 0 }; }]);
  const probe = createUserContentProbe({ request });
  const a = probe.check("u3");
  const b = probe.check("u3");
  const c = probe.whenKnown("u3");
  release();
  const results = await Promise.all([a, b, c]);
  expectEq("all three agree", JSON.stringify(results), JSON.stringify([false, false, false]));
  expectEq("one request", calls.length, 1);
}

console.log("\nprobe: fail-open");
{
  const { request, calls } = fakeRequest([new Error("network down")]);
  const probe = createUserContentProbe({ request });
  expectEq("request error -> has content", await probe.check("u4"), true);
  expectEq("an error is not remembered", probe.peek("u4"), undefined);
  await probe.check("u4");
  expectEq("so the next check asks again", calls.length, 2);
}
{
  const { request } = fakeRequest([async () => { await sleep(200); return { Items: [], TotalRecordCount: 0 }; }]);
  const probe = createUserContentProbe({ request, timeoutMs: 20 });
  expectEq("slow server -> has content", await probe.check("u5"), true);
  expectEq("a timeout is not remembered", probe.peek("u5"), undefined);
}
{
  const { request, calls } = fakeRequest([{ Items: [], TotalRecordCount: 0 }]);
  const probe = createUserContentProbe({ request });
  expectEq("no user id -> has content", await probe.check(""), true);
  expectEq("and no request", calls.length, 0);
  expectEq("whenKnown without a check in flight -> has content", await probe.whenKnown("nobody"), true);
}

console.log("\nprobe: users do not share answers");
{
  const { request } = fakeRequest([(url) => (
    url.includes("expired") ? { Items: [], TotalRecordCount: 0 } : { Items: [{ Id: "1" }], TotalRecordCount: 1 }
  )]);
  const probe = createUserContentProbe({ request });
  expectEq("expired", await probe.check("expired"), false);
  expectEq("paying", await probe.check("paying"), true);
  expectEq("expired still expired", probe.peek("expired"), false);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
