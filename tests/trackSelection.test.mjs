// Covers the preferred-audio rules that decide which track playback starts on.
//
// These used to live inside detailsModal.js, so only the details modal's "Play Now" button applied
// them — the home slider's play button called playNow() with no selection at all and started
// titles on whatever track came first in the file, usually English. The rules now live in a shared
// module that playNow() itself falls back to, which is what makes every surface agree.
//
// The null case at the bottom is the one that actually caused the bug: buildTrackSelectionPayload
// cast the index with Number(), and Number(null) is 0 — so "no audio track identified" silently
// became "pin stream 0". resolvePreferredTrackSelection must report null, not a number, when it
// cannot identify an audio track.

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);

const modulesDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Resources/slider/modules");
const src = readFileSync(path.join(modulesDir, "trackSelection.js"), "utf8");
// trackSelection.js imports nothing, so it loads as-is with no stubbing.
const { pickPreferredAudioStream, resolvePreferredTrackSelection, SUBTITLE_OFF_INDEX } =
  await import("data:text/javascript;charset=utf-8," + encodeURIComponent(src));

const audio = (index, extra = {}) => ({ Index: index, Type: "Audio", ...extra });

console.log("a Spanish track is preferred over the file's default");
{
  const streams = [
    audio(1, { Language: "eng", IsDefault: true }),
    audio(2, { Language: "spa" }),
  ];
  const picked = pickPreferredAudioStream(streams);
  if (picked?.Index !== 2) fail(`expected the Spanish track (index 2), got ${picked?.Index}`);
  else ok("Spanish wins over an English track flagged IsDefault");
}

console.log("\nLatin American Spanish outranks European Spanish");
{
  const streams = [
    audio(1, { Language: "spa", DisplayTitle: "Castellano" }),
    audio(2, { Language: "spa", DisplayTitle: "Español Latino" }),
  ];
  const picked = pickPreferredAudioStream(streams);
  if (picked?.Index !== 2) fail(`expected the Latino track (index 2), got ${picked?.Index}`);
  else ok("Latino beats Castellano when both are Spanish");

  // The real-world label from the details modal screenshot carries no region at all, so the ISO
  // code has to be enough on its own — it must not lose to a track that merely says "castellano".
  const unlabelled = pickPreferredAudioStream([
    audio(1, { Language: "spa", DisplayTitle: "Castellano" }),
    audio(2, { Language: "spa", DisplayTitle: "spa • EAC3 • 5.1 • 640 kbps - BTM DDP5.1" }),
  ]);
  if (unlabelled?.Index !== 2) fail(`expected the region-less Spanish track to beat Castellano, got ${unlabelled?.Index}`);
  else ok("a region-less Spanish track still outranks an explicitly European one");
}

console.log("\nwith no Spanish track, the file's own default is honoured");
{
  const streams = [
    audio(1, { Language: "eng" }),
    audio(2, { Language: "jpn", IsDefault: true }),
  ];
  const picked = pickPreferredAudioStream(streams);
  if (picked?.Index !== 2) fail(`expected the IsDefault track (index 2), got ${picked?.Index}`);
  else ok("falls back to IsDefault rather than forcing a language");
}

console.log("\nresolvePreferredTrackSelection turns streams into a playNow selection");
{
  const selection = resolvePreferredTrackSelection([
    { Index: 0, Type: "Video" },
    audio(1, { Language: "eng", IsDefault: true }),
    audio(2, { Language: "spa", DisplayTitle: "Español Latino" }),
    { Index: 3, Type: "Subtitle", Language: "spa" },
  ]);

  if (selection.audioStreamIndex !== 2) {
    fail(`expected audioStreamIndex 2, got ${selection.audioStreamIndex}`);
  } else {
    ok("picks the Spanish audio index, ignoring video and subtitle streams");
  }

  if (selection.subtitleStreamIndex !== SUBTITLE_OFF_INDEX) {
    fail(`expected subtitles off (${SUBTITLE_OFF_INDEX}), got ${selection.subtitleStreamIndex}`);
  } else {
    ok("switches subtitles off, matching the details modal's shipped default");
  }
}

console.log("\nno audio track means no audio index — never index 0");
{
  for (const [label, streams] of [
    ["an empty stream list", []],
    ["a video-only stream list", [{ Index: 0, Type: "Video" }]],
    ["a missing stream list", undefined],
  ]) {
    const selection = resolvePreferredTrackSelection(streams);
    if (selection.audioStreamIndex !== null) {
      fail(`${label}: expected audioStreamIndex null, got ${selection.audioStreamIndex}`);
    } else {
      ok(`${label}: reports null so playNow leaves the audio choice to Jellyfin`);
    }
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
