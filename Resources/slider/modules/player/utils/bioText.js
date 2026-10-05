// Breaks an artist biography into lines at sentence ends, skipping the period of a title or
// abbreviation ("Dr. Smith", "Doç. Dr.").
//
// This used to be one regex with a lookbehind, `(?<!\b(?:Mr|…))\.`. WebKit before iOS 16.4
// rejects lookbehind when the module is parsed, which took down the entire music player on
// those devices. The abbreviation check now runs in the replacer instead.

const SENTENCE_END = /\.(\s+)(?=\p{Lu})/gu;
const ENDS_WITH_ABBREVIATION =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|Sn|St|vs|No|etc|Jr|Sr|Ltd|Inc|Co|Doç|Av|Yrd|Öğr\.?Gör|Arş\.?Gör|Bkz)$/u;

export function breakBioSentences(text) {
  return String(text ?? "").replace(SENTENCE_END, (match, _space, offset, whole) =>
    ENDS_WITH_ABBREVIATION.test(whole.slice(0, offset)) ? match : ".<br>"
  );
}
