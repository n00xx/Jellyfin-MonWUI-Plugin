// English is the only bundle loaded eagerly: getLanguageLabels() is synchronous and falls back
// to it for any language that is not resolved yet, so one label set has to be present up front.
// Every other language — Turkish included — loads through LABEL_LOADERS. The top-level await
// below resolves the effective language before this module finishes evaluating, so consumers
// still never observe a partially-translated state.
import { languageLabels as engLabels } from './eng.js';

export const AUTO_LANGUAGE_CHANGE_EVENT = 'jms:auto-language-changed';

const LABEL_CACHE = {
  eng: engLabels
};
const LABEL_LOADERS = {
  tur: () => import('./tur.js'),
  deu: () => import('./deu.js'),
  fre: () => import('./fre.js'),
  rus: () => import('./rus.js'),
  spa: () => import('./spa.js'),
  ita: () => import('./ita.js'),
  jpn: () => import('./jpn.js'),
  por: () => import('./por.js')
};
const LABEL_LOAD_PROMISES = new Map();

let __autoLanguageSyncStarted = false;
let __autoLanguageReloadOnChange = false;
let __autoLanguageLastDetected = null;
let __autoLanguagePendingReload = false;
let __autoLanguageReloadScheduled = false;

export function normalizeLanguageCode(lang) {
  const raw = String(lang || '').trim().toLowerCase();
  if (!raw) return 'eng';
  if (raw === 'auto') return detectBrowserLanguage();

  const base = raw.split(/[-_]/)[0];

  if (raw === 'tur' || base === 'tr') return 'tur';
  if (raw === 'eng' || base === 'en') return 'eng';
  if (raw === 'deu' || base === 'de') return 'deu';
  if (raw === 'fre' || raw === 'fra' || base === 'fr') return 'fre';
  if (raw === 'rus' || base === 'ru') return 'rus';
  if (raw === 'spa' || base === 'es') return 'spa';
  if (raw === 'ita' || base === 'it') return 'ita';
  if (raw === 'jpn' || raw === 'jp' || base === 'ja') return 'jpn';
  if (raw === 'por' || base === 'pt') return 'por';

  return 'eng';
}

export function getLanguageLabels(lang) {
  const effective = normalizeLanguageCode(
    lang || getEffectiveLanguage?.() || detectBrowserLanguage?.() || 'eng'
  );

  if (LABEL_CACHE[effective]) return LABEL_CACHE[effective];
  void ensureLanguageLabels(effective);
  return engLabels;
}

export async function ensureLanguageLabels(lang) {
  const effective = normalizeLanguageCode(
    lang || getEffectiveLanguage?.() || detectBrowserLanguage?.() || 'eng'
  );

  if (LABEL_CACHE[effective]) return LABEL_CACHE[effective];

  const loader = LABEL_LOADERS[effective];
  if (!loader) return engLabels;

  if (!LABEL_LOAD_PROMISES.has(effective)) {
    LABEL_LOAD_PROMISES.set(
      effective,
      loader()
        .then((mod) => {
          const labels = mod?.languageLabels || engLabels;
          LABEL_CACHE[effective] = labels;
          return labels;
        })
        .catch(() => engLabels)
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
    if (code.startsWith('tr') || base === 'tr') return 'tur';
    if (code.startsWith('en') || base === 'en') return 'eng';
    if (code.startsWith('de') || base === 'de') return 'deu';
    if (code.startsWith('fr') || base === 'fr') return 'fre';
    if (code.startsWith('ru') || base === 'ru') return 'rus';
    if (code.startsWith('es') || base === 'es') return 'spa';
    if (code.startsWith('it') || base === 'it') return 'ita';
    if (code.startsWith('ja') || base === 'ja') return 'jpn';
    if (code.startsWith('pt') || base === 'pt') return 'por';
  }
  return 'eng';
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
