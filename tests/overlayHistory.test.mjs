// Android's Back button is history.back() inside the page. Only the Watchlist overlay used to
// push a history entry, so Back closed no other overlay: it navigated the page underneath while
// the overlay stayed up, or closed the overlay only because the user was thrown off the page.
// Measured on a phone profile against the live server: notifications, details, profiles stayed
// open; explorers and studio hubs closed but left the page. overlayHistory.js gives every overlay
// the Watchlist behaviour, plus what one private copy never needed: overlays stacked on overlays.
//
// The fake history below is pessimistic on purpose: back() runs a tick later, relative to
// whatever entry is current by then. That is the race a real browser has when a pushState lands
// while a back() is still pending.

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);
const expect = (label, cond, detail = "") => (cond ? ok(label) : fail(`${label}${detail ? ` — ${detail}` : ""}`));
const tick = () => new Promise((r) => setTimeout(r, 5));

const URL = "http://jf.test/web/#/home";
const listeners = new Map();
const history = {
  entries: [{ state: { idx: 3, key: "router" }, url: URL }],
  index: 0,
  calls: { back: 0, push: 0, replace: 0 },
  get state() { return this.entries[this.index].state; },
  pushState(state, _t, url) {
    this.calls.push++;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ state, url: String(url) });
    this.index++;
  },
  replaceState(state, _t, url) { this.calls.replace++; this.entries[this.index] = { state, url: String(url) }; },
  back() { this.calls.back++; this.go(-1); },
  go(n) {
    setTimeout(() => {
      const target = Math.max(0, Math.min(this.entries.length - 1, this.index + n));
      if (target === this.index) return;
      this.index = target;
      for (const fn of listeners.get("popstate") || []) fn({ state: this.state });
    }, 0);
  },
};
// The SPA router's own navigation: a real route change, with a state of its own.
const routerPush = (hash) => history.pushState({ idx: 4, key: "r2" }, "", `http://jf.test/web/${hash}`);
globalThis.window = {
  history,
  get location() { return { href: history.entries[history.index].url }; },
  addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
  removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
};

const { claimBackButton, dropAllBackClaims } = await import("../Resources/slider/modules/overlayHistory.js");

function overlay(name) {
  const o = { name, open: false, closes: 0, claim: null };
  o.show = () => { o.open = true; o.claim = claimBackButton(name, () => o.hide({ viaBack: true })); };
  o.hide = ({ viaBack = false } = {}) => {
    if (!o.open) return;
    o.open = false;
    o.closes++;
    if (!viaBack) o.claim?.release();
    o.claim = null;
  };
  return o;
}
const reset = () => {
  dropAllBackClaims();
  history.entries = [{ state: { idx: 3, key: "router" }, url: URL }];
  history.index = 0;
  history.calls = { back: 0, push: 0, replace: 0 };
};

console.log("Back closes the overlay and nothing else");
{
  reset();
  const a = overlay("explorer");
  a.show();
  expect("opening pushes one entry at the same URL", history.calls.push === 1 && history.entries[1].url === URL);
  expect("the router's state survives, idx untouched", history.entries[1].state.idx === 3 && history.entries[1].state.key === "router");
  history.back();
  await tick();
  expect("Back closes it", !a.open && a.closes === 1);
  expect("and lands on the page it was opened from", history.index === 0 && window.location.href === URL);
}

console.log("\nclosing from the overlay's own button gives the entry back");
{
  reset();
  const a = overlay("details");
  a.show();
  a.hide();
  await tick();
  expect("history is back where it started", history.index === 0, `index ${history.index}`);
  expect("closed exactly once", a.closes === 1, `closes ${a.closes}`);
  history.back();
  await tick();
  expect("the next Back does not reopen or re-close anything", a.closes === 1);
}

console.log("\nstacked overlays close one Back at a time");
{
  reset();
  const ex = overlay("explorer"), dm = overlay("details");
  ex.show(); dm.show();
  history.back();
  await tick();
  expect("first Back closes only the top one", !dm.open && ex.open);
  history.back();
  await tick();
  expect("second Back closes the one under it", !ex.open && history.index === 0);
}

console.log("\nhistory.go(-2) closes everything it skips, top first");
{
  reset();
  const order = [];
  const ex = overlay("explorer"), dm = overlay("details");
  ex.show(); dm.show();
  const exHide = ex.hide, dmHide = dm.hide;
  ex.hide = (o) => { order.push("explorer"); exHide(o); };
  dm.hide = (o) => { order.push("details"); dmHide(o); };
  history.go(-2);
  await tick();
  expect("both closed", !ex.open && !dm.open);
  expect("top first", order.join(",") === "details,explorer", order.join(","));
}

console.log("\nclose-then-navigate drops the claim without moving the user");
{
  reset();
  const a = overlay("explorer");
  a.show();
  a.open = false;
  a.claim.drop();
  routerPush("#/details?id=1");
  await tick();
  expect("no history.back() raced the navigation", history.calls.back === 0);
  expect("the user is on the page they opened", history.entries[history.index].url.endsWith("#/details?id=1"));
  history.back();
  await tick();
  expect("Back from there goes to the pre-overlay page", history.index === 1 && history.entries[1].url === URL);
  expect("and nothing tries to close again", a.closes === 0);
}

console.log("\nan overlay closed by a route change does not steal the new route's entry");
{
  reset();
  const a = overlay("notifications");
  a.show();
  routerPush("#/details?id=2");
  a.hide();
  await tick();
  expect("no back() when the current entry is the router's", history.calls.back === 0);
  expect("the user stays on the new route", history.entries[history.index].url.endsWith("#/details?id=2"));
}

console.log("\nopening twice keeps one entry");
{
  reset();
  const a = overlay("profile");
  a.show();
  const again = claimBackButton("profile", () => a.hide({ viaBack: true }));
  expect("one push", history.calls.push === 1);
  expect("same handle", again === a.claim);
  history.back();
  await tick();
  expect("one Back closes it", !a.open);
}

console.log("\nreleasing a layer under another leaves the top one working");
{
  reset();
  const ex = overlay("explorer"), dm = overlay("details");
  ex.show(); dm.show();
  ex.hide();
  await tick();
  expect("no back() for a layer that is not on top", history.calls.back === 0);
  history.back();
  await tick();
  expect("Back still closes the top one", !dm.open);
  expect("and does not re-close the released one", ex.closes === 1);
}

console.log("\nclose then reopen before the browser has gone back");
{
  reset();
  const a = overlay("explorer"), b = overlay("details");
  a.show();
  a.hide();   // back() pending
  b.show();   // must not be the entry that pending back() pops
  await tick();
  await tick();
  expect("the new overlay is still open", b.open, `closes ${b.closes}`);
  expect("it owns the top entry", history.index === 1 && history.state?.jmsOverlayDepth === 1, JSON.stringify(history.state));
  history.back();
  await tick();
  expect("and Back closes it", !b.open && history.index === 0);
}
{
  // Same race, but the second overlay is then closed with its own button: its entry has to be
  // the one on top, or closing it leaves a dead entry and the next Back appears to do nothing.
  reset();
  const a = overlay("explorer"), b = overlay("details");
  a.show();
  a.hide();
  b.show();
  await tick();
  await tick();
  b.hide();
  await tick();
  expect("closing it with its button returns history to the start", history.index === 0, `index ${history.index}`);
}

console.log("\ndropAllBackClaims (play from inside an overlay) gives up every claim in place");
{
  reset();
  const ex = overlay("explorer"), dm = overlay("details");
  ex.show(); dm.show();
  dropAllBackClaims();
  routerPush("#/video");
  await tick();
  expect("no back()", history.calls.back === 0);
  history.back();
  await tick();
  expect("Back from the player closes nothing", ex.closes === 0 && dm.closes === 0);
}

console.log("\noverlays closed right after playback is requested give their entry up in place");
{
  // playNow(), the cinema pre-roll and the parental PIN gate all announce playback with this
  // event before routing to the player, so no play path has to remember to drop its overlay.
  reset();
  const ex = overlay("explorer"), dm = overlay("details");
  ex.show(); dm.show();
  for (const fn of listeners.get("jms:playback-start-requested") || []) fn({ detail: { source: "api.playNow" } });
  dm.hide(); ex.hide();
  routerPush("#/video");
  await tick();
  expect("no back() raced the player route", history.calls.back === 0, `back ${history.calls.back}`);
  expect("the player route is current", history.entries[history.index].url.endsWith("#/video"));
}

console.log("\nplayback that never starts leaves Back working");
{
  // playNow() announces playback before it knows the outcome. When it then returns false (PIN
  // cancelled, membership expired, network error) the details modal stays open, and must still
  // close on Back: the announcement may not cost it its claim.
  reset();
  const dm = overlay("details");
  dm.show();
  for (const fn of listeners.get("jms:playback-start-requested") || []) fn({ detail: { source: "api.playNow" } });
  history.back();
  await tick();
  expect("Back still closes the overlay", !dm.open && history.index === 0, `open ${dm.open}, index ${history.index}`);
}
{
  // Once the announcement is stale, closing with the overlay's own button pops its entry again.
  reset();
  const dm = overlay("details");
  dm.show();
  for (const fn of listeners.get("jms:playback-start-requested") || []) fn({ detail: { source: "api.playNow" } });
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    dm.hide();
    await tick();
  } finally {
    Date.now = realNow;
  }
  expect("a later close gives the entry back", history.index === 0 && history.calls.back === 1, `index ${history.index}, back ${history.calls.back}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
