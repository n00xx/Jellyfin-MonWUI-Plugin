/**
 * Preferred audio/subtitle selection, shared by every surface that starts playback.
 *
 * The details modal resolves this from the picker above its Play Now button; the home slider and
 * the row cards have no picker at all, so they rely on the same rules being applied for them
 * inside playNow. Keeping the rules in one module is what stops the two paths from drifting into
 * "Play Now starts in Spanish but the slider starts in English".
 */

// --- Spanish audio preference -----------------------------------------------------------------
// Two passes, because the two facts live in different fields: the ISO code says the track is
// Spanish, and only the title distinguishes Latin American from European Spanish. A track
// labelled "spa • EAC3 • BTM DDP5.1" carries no region at all, so the code has to be enough on
// its own, with the title used to break ties when several Spanish tracks exist.
const SPANISH_CODES = new Set(["spa", "es", "esp", "es-419", "es-mx", "es-la"]);
const LATAM_HINTS = /latino|latinoam|latin\s*america|americ[aá]\s*latina|\bmx\b|m[eé]xic/i;
const EUROPEAN_HINTS = /castellano|european|espa[nñ]a|iberic|\bes-es\b/i;

/** Jellyfin takes -1 as "no subtitles". */
export const SUBTITLE_OFF_INDEX = -1;

function streamSearchText(stream) {
  return [stream?.DisplayTitle, stream?.Title, stream?.Language, stream?.LocalizedTitle]
    .filter(Boolean)
    .join(" ");
}

export function isSpanishStream(stream) {
  const code = String(stream?.Language || "").trim().toLowerCase();
  if (SPANISH_CODES.has(code)) return true;
  return /espa[nñ]ol|spanish|latino/i.test(streamSearchText(stream));
}

// Highest score wins: an explicitly Latin American track beats a generic Spanish one, which beats
// a track flagged as European Spanish.
function spanishPreferenceScore(stream) {
  const text = streamSearchText(stream);
  if (LATAM_HINTS.test(text)) return 3;
  if (EUROPEAN_HINTS.test(text)) return 1;
  return 2;
}

export function pickPreferredAudioStream(streams = []) {
  if (!Array.isArray(streams) || !streams.length) return null;
  const spanish = streams.filter(isSpanishStream);
  if (spanish.length) {
    return spanish.reduce((best, stream) =>
      spanishPreferenceScore(stream) > spanishPreferenceScore(best) ? stream : best);
  }
  return streams.find((stream) => stream?.IsDefault) || streams[0] || null;
}

/**
 * Turns a raw MediaStreams array into the { audioStreamIndex, subtitleStreamIndex } shape playNow
 * expects. Subtitles are always switched off — that is the details modal's shipped default and the
 * behaviour the other surfaces are matching. `audioStreamIndex` stays null when no audio track can
 * be identified, which leaves the audio choice to Jellyfin rather than pinning a bogus index.
 */
export function resolvePreferredTrackSelection(mediaStreams = []) {
  const streams = Array.isArray(mediaStreams) ? mediaStreams : [];
  const audio = pickPreferredAudioStream(streams.filter((stream) => stream?.Type === "Audio"));
  const audioIndex = Number(audio?.Index);

  return {
    audioStreamIndex: Number.isFinite(audioIndex) ? audioIndex : null,
    subtitleStreamIndex: SUBTITLE_OFF_INDEX,
  };
}
