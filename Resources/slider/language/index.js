// The plugin ships two bundles: Latin American Spanish and English, with Spanish as the default.
// Spanish is the one loaded eagerly, for two reasons: getLanguageLabels() is synchronous and has
// to return a complete label set for any language not resolved yet, and it is what the majority
// of installs will actually render — loading English eagerly would ship a bundle nobody reads
// and make the default case pay for a dynamic import. English loads through LABEL_LOADERS.
// The top-level await below resolves the effective language before this module finishes
// evaluating, so consumers never observe a partially-translated state.
//
// 'spa' is an ISO 639-2 code and must stay that way: containerUtils.js compares it directly
// against MediaStream.Language to auto-select audio and subtitle tracks, and the Cinema Pre-Roll
// service maps it to a culture name. Latin American Spanish is the *content* of spa.js, not a
// separate locale identifier.
import { languageLabels as spaLabels } from './spa.js';

export const AUTO_LANGUAGE_CHANGE_EVENT = 'jms:auto-language-changed';

export const DEFAULT_LANGUAGE = 'spa';

const LABEL_CACHE = {
  spa: spaLabels
};
const LABEL_LOADERS = {
  eng: () => import('./eng.js')
};
const LABEL_LOAD_PROMISES = new Map();

let __autoLanguageSyncStarted = false;
let __autoLanguageReloadOnChange = false;
let __autoLanguageLastDetected = null;
let __autoLanguagePendingReload = false;
let __autoLanguageReloadScheduled = false;

// Anything that is not recognisably English resolves to Spanish, including the codes of the
// languages this plugin used to ship: an existing user whose stored preference is 'tur' or 'deu'
// lands on the default instead of an undefined bundle.
export function normalizeLanguageCode(lang) {
  const raw = String(lang || '').trim().toLowerCase();
  if (!raw) return DEFAULT_LANGUAGE;
  if (raw === 'auto') return detectBrowserLanguage();

  const base = raw.split(/[-_]/)[0];

  if (raw === 'eng' || base === 'en') return 'eng';

  return DEFAULT_LANGUAGE;
}

export function getLanguageLabels(lang) {
  const effective = normalizeLanguageCode(
    lang || getEffectiveLanguage?.() || detectBrowserLanguage?.() || DEFAULT_LANGUAGE
  );

  if (LABEL_CACHE[effective]) return LABEL_CACHE[effective];
  void ensureLanguageLabels(effective);
  return spaLabels;
}

export async function ensureLanguageLabels(lang) {
  const effective = normalizeLanguageCode(
    lang || getEffectiveLanguage?.() || detectBrowserLanguage?.() || DEFAULT_LANGUAGE
  );

  if (LABEL_CACHE[effective]) return LABEL_CACHE[effective];

  const loader = LABEL_LOADERS[effective];
  if (!loader) return spaLabels;

  if (!LABEL_LOAD_PROMISES.has(effective)) {
    LABEL_LOAD_PROMISES.set(
      effective,
      loader()
        .then((mod) => {
          const labels = mod?.languageLabels || spaLabels;
          LABEL_CACHE[effective] = labels;
          return labels;
        })
        .catch(() => spaLabels)
        .finally(() => LABEL_LOAD_PROMISES.delete(effective))
    );
  }

  return LABEL_LOAD_PROMISES.get(effective);
}

export function detectBrowserLanguage() {
  const candidates = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language || navigator.userLanguage || ''];
  for (const raw of candidates) {
    const code = (raw || '').toLowerCase();
    const base = code.split('-')[0];
    if (code.startsWith('es') || base === 'es') return 'spa';
    if (code.startsWith('en') || base === 'en') return 'eng';
  }
  return DEFAULT_LANGUAGE;
}

export function getStoredLanguagePreference() {
  return localStorage.getItem('defaultLanguage');
}

export function getEffectiveLanguage() {
  const pref = getStoredLanguagePreference();
  if (!pref || pref === 'auto') return detectBrowserLanguage();
  return normalizeLanguageCode(pref);
}

export function getDefaultLanguage() {
  return getEffectiveLanguage();
}

try {
  await ensureLanguageLabels(getDefaultLanguage());
} catch {}

export function setLanguagePreference(value) {
  if (!value || value === 'auto') {
    localStorage.setItem('defaultLanguage', 'auto');
  } else {
    localStorage.setItem('defaultLanguage', value);
  }
}

function isAutomaticLanguagePreference(pref = getStoredLanguagePreference()) {
  return !pref || pref === 'auto';
}

function scheduleAutoLanguageReload() {
  if (
    !__autoLanguageReloadOnChange ||
    __autoLanguageReloadScheduled ||
    typeof window === 'undefined'
  ) {
    return;
  }

  __autoLanguageReloadScheduled = true;
  setTimeout(() => {
    window.location.reload();
  }, 0);
}

function queueAutoLanguageReloadIfNeeded() {
  if (!__autoLanguageReloadOnChange || typeof document === 'undefined') return;

  if (document.visibilityState === 'visible') {
    __autoLanguagePendingReload = false;
    scheduleAutoLanguageReload();
    return;
  }

  __autoLanguagePendingReload = true;
}

function dispatchAutoLanguageChanged(previousLanguage, nextLanguage) {
  if (typeof window === 'undefined') return;

  try {
    window.dispatchEvent(new CustomEvent(AUTO_LANGUAGE_CHANGE_EVENT, {
      detail: {
        preference: 'auto',
        previousLanguage,
        nextLanguage
      }
    }));
  } catch {}
}

function syncAutomaticLanguageState() {
  if (!isAutomaticLanguagePreference()) {
    __autoLanguageLastDetected = null;
    __autoLanguagePendingReload = false;
    return;
  }

  const detectedLanguage = detectBrowserLanguage();
  if (!__autoLanguageLastDetected) {
    __autoLanguageLastDetected = detectedLanguage;
    return;
  }

  if (detectedLanguage === __autoLanguageLastDetected) return;

  const previousLanguage = __autoLanguageLastDetected;
  __autoLanguageLastDetected = detectedLanguage;

  dispatchAutoLanguageChanged(previousLanguage, detectedLanguage);
  queueAutoLanguageReloadIfNeeded();
}

function handleAutoLanguageVisibilityChange() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;

  if (__autoLanguagePendingReload) {
    __autoLanguagePendingReload = false;
    scheduleAutoLanguageReload();
    return;
  }

  syncAutomaticLanguageState();
}

export function ensureAutoLanguageSync({ reloadOnChange = false } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  __autoLanguageReloadOnChange = __autoLanguageReloadOnChange || reloadOnChange === true;
  __autoLanguageLastDetected = isAutomaticLanguagePreference()
    ? detectBrowserLanguage()
    : null;

  if (__autoLanguageSyncStarted) return;
  __autoLanguageSyncStarted = true;

  window.addEventListener('languagechange', syncAutomaticLanguageState, { passive: true });
  window.addEventListener('focus', syncAutomaticLanguageState, { passive: true });
  document.addEventListener('visibilitychange', handleAutoLanguageVisibilityChange, { passive: true });
}
