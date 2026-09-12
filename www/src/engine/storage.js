/**
 * Persistent profile.
 *
 * localStorage is the source of truth; when the game runs inside the native
 * shell we mirror to Capacitor Preferences so the save survives a WebView data
 * purge. The storage slot name is fixed for the life of the app — the schema
 * version lives *inside* the payload, so an old save is migrated rather than
 * thrown away.
 */

const KEY = 'orbital-rush/profile/v1';

export const SAVE_VERSION = 3;

export const DEFAULT_PROFILE = Object.freeze({
  version: SAVE_VERSION,

  // --- records --------------------------------------------------------------
  // `bestScore` is the best of all of them; `bests` keeps one per difficulty
  // preset, because an easy best and a hard best are not the same claim.
  bestScore: 0,
  bests: { easy: 0, normal: 0, hard: 0 },
  bestZone: 0,
  bestMultiplier: 1,
  bestChain: 0,
  bestPerfects: 0,

  // --- lifetime totals ------------------------------------------------------
  runs: 0,
  totalRings: 0,
  totalTimeMs: 0,
  totalPerfects: 0,
  totalOrbs: 0,
  totalGreedOrbs: 0,
  totalChainSaves: 0,
  noShieldZone: 0,
  dailyRuns: 0,

  // --- economy: one currency ------------------------------------------------
  shards: 0,
  totalShards: 0,

  // --- cosmetics ------------------------------------------------------------
  skin: 'flow',
  trail: 'comet',
  effect: 'zone',
  ownedSkins: ['flow'],
  ownedTrails: ['comet'],
  ownedEffects: ['zone'],

  // --- meta -----------------------------------------------------------------
  achievements: [],
  missionsDate: '',
  missions: [],
  streak: 0,
  lastPlayDate: '',
  dailyRewardDate: '',
  streakClaimed: [],

  // --- daily run ------------------------------------------------------------
  dailyDate: '',
  dailyBest: { score: 0, zone: 0, multiplier: 1, perfects: 0, orbs: 0 },
  dailyPlayed: false,

  // --- local leaderboard ----------------------------------------------------
  recent: [],

  // --- how you play ---------------------------------------------------------
  difficulty: 'normal',
  // Where this player's chain keeps breaking, indexed by zone. Informational:
  // the summary can tell them something about their own play instead of only
  // repeating the score back at them.
  chainBreaksByZone: [],

  // --- settings -------------------------------------------------------------
  sfx: true,
  music: true,
  haptics: true,
  reducedFx: false,
  colorSafe: false,
  seenTutorial: false,
  tutorialSeen: [],
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
  if (!raw) return clone(DEFAULT_PROFILE);
  try {
    return migrate(JSON.parse(raw));
  } catch {
    return clone(DEFAULT_PROFILE);
  }
}

function clone(profile) {
  return JSON.parse(JSON.stringify(profile));
}

/**
 * Version 1 kept a currency called "energy" and a chain called "bestCombo".
 * Carry both across rather than resetting anyone who already played.
 */
function upgradeV1(parsed) {
  const out = { ...parsed };
  if (typeof parsed.energy === 'number') out.shards = parsed.energy;
  if (typeof parsed.totalEnergy === 'number') out.totalShards = parsed.totalEnergy;
  if (typeof parsed.bestCombo === 'number') out.bestChain = parsed.bestCombo;
  // v1 skins were named after colours; the survivors keep their progress but
  // fall back to the starter skin, since the ids no longer exist.
  out.ownedSkins = ['flow'];
  out.ownedTrails = ['comet'];
  out.ownedEffects = ['zone'];
  out.skin = 'flow';
  return out;
}

/**
 * Version 2 had a single best score and no difficulty preset. Everyone who
 * played it was playing what is now NORMAL, so that is where their record goes.
 */
function upgradeV2(parsed) {
  return {
    ...parsed,
    difficulty: 'normal',
    bests: { easy: 0, normal: Math.max(0, parsed.bestScore | 0), hard: 0 },
  };
}

/** Merge a stored profile onto the current defaults, dropping unknown keys. */
export function migrate(parsed) {
  const out = clone(DEFAULT_PROFILE);
  if (!parsed || typeof parsed !== 'object') return out;

  let source = parsed;
  if ((source.version ?? 1) < 2) source = upgradeV1(source);
  if ((source.version ?? 1) < 3) source = upgradeV2(source);

  for (const key of Object.keys(DEFAULT_PROFILE)) {
    const v = source[key];
    if (v === undefined || v === null) continue;
    const fallback = DEFAULT_PROFILE[key];
    if (Array.isArray(fallback)) {
      if (Array.isArray(v)) out[key] = v.slice();
    } else if (fallback !== null && typeof fallback === 'object') {
      if (typeof v === 'object' && !Array.isArray(v)) out[key] = { ...fallback, ...v };
    } else if (typeof fallback === typeof v) {
      out[key] = v;
    }
  }

  // Owning nothing is impossible: the starter cosmetics are always yours.
  for (const [ownedKey, starter, equippedKey] of [
    ['ownedSkins', 'flow', 'skin'],
    ['ownedTrails', 'comet', 'trail'],
    ['ownedEffects', 'zone', 'effect'],
  ]) {
    if (!out[ownedKey].includes(starter)) out[ownedKey].push(starter);
    if (!out[ownedKey].includes(out[equippedKey])) out[equippedKey] = starter;
  }

  out.recent = out.recent.slice(0, 20);
  out.version = SAVE_VERSION;
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
    if (native.totalShards > profile.totalShards || native.bestScore > profile.bestScore) {
      return native;
    }
  } catch {
    /* ignore */
  }
  return profile;
}
