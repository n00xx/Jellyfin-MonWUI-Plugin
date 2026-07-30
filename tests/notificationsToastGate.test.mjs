// Regression test for a notification leak: turning off "Enable toast for newly added
// content" (config.enableToastNew) only ever silenced the transient toast popup. The
// underlying list/badge storage path (pollLatest() -> pushNotification()) had no gate at
// all, so newly added items kept appearing in the "Newly Added" drawer tab and bumping the
// unread badge even with the setting off — the one control this category exposes doing
// nothing the user could observe.
//
// The fix wraps the pushNotification() call in pollLatest() with the same enableToastNew
// check the toast functions already used, while still recording seenIds unconditionally so
// a suppressed item isn't reprocessed forever. This exercises the real notifications.js
// (with pollLatest/notifState exported for this purpose) end to end through fetchLatestAll's
// real fresh-item filtering logic, not a reimplementation.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const modulePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider/modules/notifications.js");
const moduleSource = readFileSync(modulePath, "utf8");

class FakeLocalStorage {
  constructor() { this._store = {}; }
  getItem(key) { return Object.prototype.hasOwnProperty.call(this._store, key) ? this._store[key] : null; }
  setItem(key, value) { this._store[key] = String(value); }
  removeItem(key) { delete this._store[key]; }
  clear() { this._store = {}; }
}

const toDataUrl = (src) => "data:text/javascript;charset=utf-8," + encodeURIComponent(src);
const noopStub = (names) => toDataUrl(names.map((n) => `export function ${n}(){}`).join("\n"));

async function loadModule({ enableToastNew, freshItems }) {
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute() {}, getAttribute() {}, appendChild() {}, style: {}, dataset: {},
      addEventListener() {}, removeEventListener() {},
    }),
    addEventListener() {}, removeEventListener() {},
    body: { appendChild() {} },
    head: { appendChild() {} },
  };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    innerWidth: 1024,
    location: { hash: "" },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { maxTouchPoints: 0, userAgent: "node-test-agent" },
    configurable: true,
  });
  globalThis.localStorage = new FakeLocalStorage();

  globalThis.__TEST_FRESH_ITEMS__ = freshItems;

  const apiStubUrl = toDataUrl(`
    export function getSessionInfo(){ return { accessToken: "tok", userId: "u1", serverId: "s1" }; }
    export async function makeApiRequest(url){
      if (String(url).includes("IncludeItemTypes=Audio")) return { Items: [] };
      return { Items: globalThis.__TEST_FRESH_ITEMS__ || [] };
    }
    export async function fetchItemsBulk(){ return { found: new Map() }; }
    export async function fetchItemDetails(){ return {}; }
    export function getVideoStreamUrl(){ return ""; }
    export function playNow(){}
    export function isCurrentUserAdmin(){ return false; }
  `);
  const configStubUrl = toDataUrl(`
    const cfg = {
      enableToastNew: ${JSON.stringify(enableToastNew)},
      toastGroupThreshold: 5,
      languageLabels: { newContentDefault: "New content" },
    };
    globalThis.__TEST_CONFIG__ = cfg;
    export function getConfig(){ return cfg; }
    export function getServerAddress(){ return "http://localhost"; }
  `);

  const doctored = moduleSource
    .replace(
      `import { makeApiRequest, getSessionInfo, fetchItemDetails, getVideoStreamUrl, playNow, isCurrentUserAdmin, fetchItemsBulk } from "../../Plugins/JMSFusion/runtime/api.js";`,
      `import { makeApiRequest, getSessionInfo, fetchItemDetails, getVideoStreamUrl, playNow, isCurrentUserAdmin, fetchItemsBulk } from "${apiStubUrl}";`
    )
    .replace(`import { getConfig, getServerAddress } from "./config.js";`, `import { getConfig, getServerAddress } from "${configStubUrl}";`)
    .replace(`import { getVideoQualityText } from "./containerUtils.js";`, `import { getVideoQualityText } from "${noopStub(["getVideoQualityText"])}";`)
    .replace(`import { getCurrentVersionFromEnv, compareSemver } from "./update.js";`, `import { getCurrentVersionFromEnv, compareSemver } from "${noopStub(["getCurrentVersionFromEnv", "compareSemver"])}";`)
    .replace(`import { resolveSliderAssetHref } from "./assetLinks.js";`, `import { resolveSliderAssetHref } from "${noopStub(["resolveSliderAssetHref"])}";`)
    .replace(`import { withServer } from "./jfUrl.js";`, `import { withServer } from "${noopStub(["withServer"])}";`)
    .replace(`import { faIconHtml } from "./faIcons.js";`, `import { faIconHtml } from "${toDataUrl('export function faIconHtml(){ return ""; }')}";`)
    .replace(`import { openDetailsModal } from "./detailsModalLoader.js";`, `import { openDetailsModal } from "${noopStub(["openDetailsModal"])}";`)
    .replace(
      `import { applyHeaderIconButtonMode, findHeaderMountTarget } from "./headerCompat.js";`,
      `import { applyHeaderIconButtonMode, findHeaderMountTarget } from "${noopStub(["applyHeaderIconButtonMode", "findHeaderMountTarget"])}";`
    )
    .replace(
      `import { ensureSerrNotificationsTab, getCachedSerrNotificationCount, markSerrNotificationsSeen, refreshSerrNotifications, renderSerrNotifications, scheduleSerrNotificationsPoll, stopSerrNotificationsPoll } from "./seerr/notificationsPanel.js";`,
      `import { ensureSerrNotificationsTab, getCachedSerrNotificationCount, markSerrNotificationsSeen, refreshSerrNotifications, renderSerrNotifications, scheduleSerrNotificationsPoll, stopSerrNotificationsPoll } from "${noopStub(["ensureSerrNotificationsTab", "getCachedSerrNotificationCount", "markSerrNotificationsSeen", "refreshSerrNotifications", "renderSerrNotifications", "scheduleSerrNotificationsPoll", "stopSerrNotificationsPoll"])}";`
    )
    .replace(
      `import { ensureSerrIssuesTab, refreshSerrIssues, removeSerrIssuesTab } from "./seerr/issuesPanel.js";`,
      `import { ensureSerrIssuesTab, refreshSerrIssues, removeSerrIssuesTab } from "${noopStub(["ensureSerrIssuesTab", "refreshSerrIssues", "removeSerrIssuesTab"])}";`
    )
    + `\n// instance:${Math.random()}\n`;

  return import(toDataUrl(doctored));
}

console.log("enableToastNew=false must keep newly-added items out of the list and badge, not just the toast");
{
  const freshItems = [
    { Id: "dark-s1e6", Name: "Dark - S1E6", Type: "Movie", DateCreated: new Date().toISOString() },
    { Id: "silo-s2e1", Name: "Silo - S2E1", Type: "Movie", DateCreated: new Date().toISOString() },
    { Id: "ted-lasso-s3e11", Name: "Ted Lasso - S3E11", Type: "Movie", DateCreated: new Date().toISOString() },
  ];
  const mod = await loadModule({ enableToastNew: false, freshItems });

  await mod.pollLatest();

  if (mod.notifState.list.length !== 0) {
    fail(`expected 0 entries in notifState.list with the toggle off, got ${mod.notifState.list.length}`);
  } else {
    ok("no entries land in the drawer list/badge when enableToastNew is off");
  }

  const allSeen = freshItems.every((it) => mod.notifState.seenIds.has(it.Id));
  if (!allSeen) {
    fail("suppressed items were not marked seen — they would be reprocessed forever");
  } else {
    ok("suppressed items are still marked seen, so they aren't reprocessed on every poll");
  }
}

console.log("\nenableToastNew=true must still populate the list and badge as before (no regression the other way)");
{
  const freshItems = [
    { Id: "foundation-s3e1", Name: "Foundation - S3E1", Type: "Movie", DateCreated: new Date().toISOString() },
    { Id: "severance-s2e5", Name: "Severance - S2E5", Type: "Movie", DateCreated: new Date().toISOString() },
  ];
  const mod = await loadModule({ enableToastNew: true, freshItems });

  await mod.pollLatest();

  if (mod.notifState.list.length !== freshItems.length) {
    fail(`expected ${freshItems.length} entries in notifState.list with the toggle on, got ${mod.notifState.list.length}`);
  } else {
    ok("entries still land in the drawer list/badge when enableToastNew is on");
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
