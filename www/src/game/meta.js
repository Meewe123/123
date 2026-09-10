/**
 * Meta progression: daily missions, login streak and the cosmetics economy.
 * Pure functions over a profile object so it can be unit-tested without a DOM.
 */

import { RNG, hashString } from '../engine/rng.js';
import { todayKey, daysBetween } from '../engine/util.js';
import { MISSION_TEMPLATES, DAILY_REWARDS, SKINS, skinById } from './config.js';

const MISSIONS_PER_DAY = 3;

export function rollMissions(profile, rng) {
  const pool = MISSION_TEMPLATES.slice();
  const picked = [];
  while (picked.length < MISSIONS_PER_DAY && pool.length) {
    const idx = rng.int(0, pool.length - 1);
    const tpl = pool.splice(idx, 1)[0];
    const spec = tpl.make(rng, profile.bestScore || 0);
    picked.push({
      id: tpl.id,
      scope: tpl.scope,
      text: spec.text,
      target: spec.target,
      reward: spec.reward,
      progress: 0,
      claimed: false,
    });
  }
  return picked;
}

/** Roll a fresh set of missions when the date changes. Returns true if it did. */
export function ensureDaily(profile, now = new Date()) {
  const today = todayKey(now);
  if (profile.missionsDate === today && Array.isArray(profile.missions) && profile.missions.length) {
    return false;
  }
  profile.missionsDate = today;
  profile.missions = rollMissions(profile, new RNG(hashString(`${today}|${profile.bestScore | 0}`)));
  return true;
}

/** Called when a run starts: maintains the consecutive-days streak. */
export function registerPlay(profile, now = new Date()) {
  const today = todayKey(now);
  if (profile.lastPlayDate === today) return false;
  const gap = profile.lastPlayDate ? daysBetween(profile.lastPlayDate, today) : Infinity;
  profile.streak = gap === 1 ? (profile.streak || 0) + 1 : 1;
  profile.lastPlayDate = today;
  return true;
}

export function dailyRewardAvailable(profile, now = new Date()) {
  return profile.dailyRewardDate !== todayKey(now);
}

export function dailyRewardAmount(profile) {
  const day = Math.max(1, profile.streak || 1);
  return DAILY_REWARDS[Math.min(day - 1, DAILY_REWARDS.length - 1)];
}

export function claimDailyReward(profile, now = new Date()) {
  if (!dailyRewardAvailable(profile, now)) return 0;
  const amount = dailyRewardAmount(profile);
  profile.dailyRewardDate = todayKey(now);
  profile.energy += amount;
  profile.totalEnergy += amount;
  return amount;
}

export function isComplete(mission) {
  return mission.progress >= mission.target;
}

/**
 * Fold a finished run into the daily missions.
 *
 * Accumulating fields (orbs, perfects, runs) are passed as deltas so that a
 * revived run can be committed twice without double-counting; peak fields
 * (score, combo, zone) are absolute because max() is idempotent.
 */
export function applyRun(profile, run) {
  const newlyDone = [];
  for (const m of profile.missions || []) {
    const before = isComplete(m);
    switch (m.id) {
      case 'rings': m.progress = Math.max(m.progress, run.score); break;
      case 'orbs': m.progress += run.orbs; break;
      case 'combo': m.progress = Math.max(m.progress, run.bestCombo); break;
      case 'runs': if (run.countRun) m.progress += 1; break;
      case 'zone': m.progress = Math.max(m.progress, run.zoneReached + 1); break;
      case 'perfect': m.progress += run.perfects; break;
      default: break;
    }
    m.progress = Math.min(m.progress, m.target);
    if (!before && isComplete(m)) newlyDone.push(m);
  }
  return newlyDone;
}

export function claimMission(profile, mission) {
  if (!isComplete(mission) || mission.claimed) return 0;
  mission.claimed = true;
  profile.energy += mission.reward;
  profile.totalEnergy += mission.reward;
  return mission.reward;
}

export function claimableCount(profile) {
  return (profile.missions || []).filter((m) => isComplete(m) && !m.claimed).length;
}

// ------------------------------------------------------------------ shop ---

export function ownsSkin(profile, id) {
  return profile.ownedSkins.includes(id);
}

export function canAfford(profile, id) {
  return profile.energy >= skinById(id).cost;
}

/** Returns 'bought' | 'equipped' | 'poor' | 'noop'. */
export function buyOrEquip(profile, id) {
  const skin = skinById(id);
  if (!ownsSkin(profile, id)) {
    if (profile.energy < skin.cost) return 'poor';
    profile.energy -= skin.cost;
    profile.ownedSkins.push(id);
    profile.skin = id;
    return 'bought';
  }
  if (profile.skin === id) return 'noop';
  profile.skin = id;
  return 'equipped';
}

/** The cheapest skin the player could buy right now, for the shop badge. */
export function nextUnlockable(profile) {
  return SKINS
    .filter((s) => !ownsSkin(profile, s.id))
    .sort((a, b) => a.cost - b.cost)
    .find((s) => profile.energy >= s.cost) || null;
}

/** Fold a finished run into the lifetime stats on the profile. */
export function commitRun(profile, run) {
  if (run.countRun) profile.runs += 1;
  profile.totalRings += run.rings;
  profile.totalTimeMs += run.timeMs;
  profile.energy += run.energy;
  profile.totalEnergy += run.energy;
  const isBest = run.score > profile.bestScore;
  if (isBest) profile.bestScore = run.score;
  if (run.bestCombo > profile.bestCombo) profile.bestCombo = run.bestCombo;
  if (run.zoneReached > profile.bestZone) profile.bestZone = run.zoneReached;
  return isBest;
}
