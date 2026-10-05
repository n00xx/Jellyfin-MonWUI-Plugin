// The expired-membership home shows one card, the empty library whose image carries the renewal
// QR. On a desktop the card is ~300 px wide and its QR ~70 px: a phone camera cannot read it, and
// clicking the card opened an empty library. In no-content mode the card now opens its own image
// full screen. These are the pure decisions behind that; the overlay itself is DOM.

import {
  buildFullResolutionImageUrl,
  readCardImageUrl,
  isZoomableLibraryCard,
} from "../Resources/slider/modules/noContentCardZoom.js";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);
const expectEq = (label, got, want) => {
  if (got === want) ok(`${label} -> ${JSON.stringify(got)}`);
  else fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

console.log("full-resolution url");
{
  // The shape jellyfin-web uses for a My Media tile (Thumb, filled to the card box).
  const card = "https://tv.neexy.net/Items/abc/Images/Thumb?fillHeight=169&fillWidth=300&quality=96&tag=t1";
  const full = new URL(buildFullResolutionImageUrl(card, 2560));
  expectEq("same image", full.pathname, "/Items/abc/Images/Thumb");
  expectEq("keeps the cache tag", full.searchParams.get("tag"), "t1");
  expectEq("drops fillHeight", full.searchParams.has("fillHeight"), false);
  expectEq("drops fillWidth", full.searchParams.has("fillWidth"), false);
  expectEq("asks for the screen width", full.searchParams.get("maxWidth"), "2560");
  expectEq("full quality", full.searchParams.get("quality"), "100");
  expectEq("stays absolute", buildFullResolutionImageUrl(card, 2560).startsWith("https://tv.neexy.net/"), true);
}
{
  const rel = buildFullResolutionImageUrl("/Items/abc/Images/Primary?maxHeight=200&MaxWidth=300&width=10&height=10", 1200);
  expectEq("relative stays relative", rel.startsWith("/Items/abc/Images/Primary?"), true);
  const params = new URLSearchParams(rel.split("?")[1]);
  expectEq("every size param replaced (any case)", [...params.keys()].sort().join(","), "maxWidth,quality");
}
expectEq("width is clamped high", new URL(buildFullResolutionImageUrl("/Items/a/Images/Thumb", 99999), "http://x").searchParams.get("maxWidth"), "3840");
expectEq("width is clamped low", new URL(buildFullResolutionImageUrl("/Items/a/Images/Thumb", 10), "http://x").searchParams.get("maxWidth"), "800");
expectEq("not an image url is left alone", buildFullResolutionImageUrl("https://example.com/a.png?w=1", 2000), "https://example.com/a.png?w=1");
expectEq("empty stays empty", buildFullResolutionImageUrl("", 2000), "");

// Minimal element fakes: only what the helpers read.
function el({ dataset = {}, style = {}, attrs = {}, children = {}, closest = {} } = {}) {
  return {
    dataset,
    style,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: (sel) => {
      for (const [key, child] of Object.entries(children)) if (sel.split(",").map((s) => s.trim()).includes(key)) return child;
      return null;
    },
    closest: (sel) => {
      for (const [key, value] of Object.entries(closest)) if (sel.split(",").map((s) => s.trim()).includes(key)) return value;
      return null;
    },
  };
}

console.log("\nreading the image the card shows");
expectEq("loaded background image",
  readCardImageUrl(el({ children: { ".cardImageContainer": el({ style: { backgroundImage: 'url("/Items/a/Images/Thumb?tag=1")' } }) } })),
  "/Items/a/Images/Thumb?tag=1");
expectEq("still lazy (data-src)",
  readCardImageUrl(el({ children: { ".cardImageContainer": el({ attrs: { "data-src": "/Items/a/Images/Thumb?tag=2" } }) } })),
  "/Items/a/Images/Thumb?tag=2");
expectEq("an <img> card",
  readCardImageUrl(el({ children: { img: { currentSrc: "/Items/a/Images/Primary?tag=3", src: "", getAttribute: () => null } } })),
  "/Items/a/Images/Primary?tag=3");
expectEq("no image", readCardImageUrl(el()), "");

console.log("\nwhich cards open the viewer");
const libraryCard = (dataset, closest = {}) => el({ dataset: { id: "lib1", ...dataset }, closest });
expectEq("empty movie library", isZoomableLibraryCard(libraryCard({ type: "CollectionFolder", collectiontype: "movies" })), true);
expectEq("library card without a collection type", isZoomableLibraryCard(libraryCard({ type: "CollectionFolder" })), true);
expectEq("the Playlists view keeps opening playlists", isZoomableLibraryCard(libraryCard({ type: "UserView", collectiontype: "playlists" })), false);
expectEq("Live TV keeps its page", isZoomableLibraryCard(libraryCard({ type: "UserView", collectiontype: "livetv" })), false);
expectEq("a title card is not a library", isZoomableLibraryCard(libraryCard({ type: "Movie" })), false);
expectEq("a card without an id", isZoomableLibraryCard(el({ dataset: { type: "CollectionFolder" } })), false);
expectEq("a card inside a moui row is never hijacked",
  isZoomableLibraryCard(libraryCard({ type: "CollectionFolder" }, { "#studio-hubs": {} })), false);
expectEq("null", isZoomableLibraryCard(null), false);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
