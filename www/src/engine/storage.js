/**
 * Persistent profile. localStorage is the source of truth; when the game runs
 * inside the native shell we mirror to Capacitor Preferences so the save
 * survives a WebView data purge.
 */

const KEY = 'orbital-rush/profile/v1';

export const DEFAULT_PROFILE = Object.freeze({
  version: 1,
  bestScore: 0,
  bestCombo: 0,
  bestZone: 0,
  energy: 0,
  totalEnergy: 0,
  runs: 0,
  totalRings: 0,
  totalTimeMs: 0,
  skin: 'aurora',
  ownedSkins: ['aurora'],
  sfx: true,
  music: true,
  haptics: true,
  reducedFx: false,
  leftHanded: false,
  seenTutorial: false,
  missionsDate: '',
  missions: [],
  streak: 0,
  lastPlayDate: '',
  dailyRewardDate: '',
});

function nativePrefs() {
  const cap = globalThis.Capacitor;
  return cap && cap.Plugins && cap.Plugins.Preferences ? cap.Plugins.Preferences : null;
}

export function load() {
  let raw = null;
  try {
    raw = globalThis.localStorage ? localStorage.getItem(KEY) : null;
  } catch {
    raw = null;
  }
  if (!raw) return { ...DEFAULT_PROFILE };
  try {
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

/** Merge a stored profile onto the current defaults, dropping unknown keys. */
export function migrate(parsed) {
  const out = { ...DEFAULT_PROFILE };
  if (!parsed || typeof parsed !== 'object') return out;
  for (const key of Object.keys(DEFAULT_PROFILE)) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(DEFAULT_PROFILE[key])) {
      if (Array.isArray(v)) out[key] = v.slice();
    } else if (typeof DEFAULT_PROFILE[key] === typeof v) {
      out[key] = v;
    }
  }
  if (!out.ownedSkins.includes('aurora')) out.ownedSkins.push('aurora');
  if (!out.ownedSkins.includes(out.skin)) out.skin = 'aurora';
  out.version = DEFAULT_PROFILE.version;
  return out;
}

let saveTimer = null;

export function save(profile) {
  const json = JSON.stringify(profile);
  try {
    if (globalThis.localStorage) localStorage.setItem(KEY, json);
  } catch {
    /* private mode or quota — the run still works, it just won't persist */
  }
  const prefs = nativePrefs();
  if (prefs) prefs.set({ key: KEY, value: json }).catch(() => {});
}

/** Coalesce bursts of writes into one, so we never save mid-frame. */
export function saveSoon(profile, delay = 400) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save(profile);
  }, delay);
}

export function flush(profile) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  save(profile);
}

/** Pull the native mirror if localStorage came up empty (fresh WebView). */
export async function hydrateFromNative(profile) {
  const prefs = nativePrefs();
  if (!prefs) return profile;
  try {
    const { value } = await prefs.get({ key: KEY });
    if (!value) return profile;
    const native = migrate(JSON.parse(value));
    // Whichever copy has more progress wins — never silently lose a best score.
    if (native.totalEnergy > profile.totalEnergy || native.bestScore > profile.bestScore) {
      return native;
    }
  } catch {
    /* ignore */
  }
  return profile;
}
