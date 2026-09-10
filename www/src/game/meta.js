/**
 * Meta progression: daily missions, streak, achievements payouts and the
 * cosmetics economy. Pure functions over a profile object, so all of it runs
 * head-less in tests and nothing depends on the DOM.
 *
 * One currency: SHARDS. Earned by playing, spent on cosmetics and revives.
 */

import { RNG, hashString } from '../engine/rng.js';
import { todayKey, daysBetween } from '../engine/util.js';
import {
  MISSION_TEMPLATES, DAILY_REWARDS, STREAK_MILESTONES, COSMETIC_KINDS,
} from './config.js';
import { isUnlocked } from './achievements.js';

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
  grantShards(profile, amount);
  return amount;
}

/**
 * Streak milestones: a bonus for coming back, never a punishment for not.
 * Returns the milestones that became claimable and pays them out.
 */
export function claimStreakMilestones(profile) {
  const claimed = profile.streakClaimed || (profile.streakClaimed = []);
  const paid = [];
  for (const milestone of STREAK_MILESTONES) {
    if (claimed.includes(milestone.days)) continue;
    if ((profile.streak || 0) < milestone.days) continue;
    claimed.push(milestone.days);
    grantShards(profile, milestone.reward);
    paid.push(milestone);
  }
  return paid;
}

export function nextStreakMilestone(profile) {
  return STREAK_MILESTONES.find((m) => m.days > (profile.streak || 0)) || null;
}

export function isComplete(mission) {
  return mission.progress >= mission.target;
}

/**
 * Fold a finished run into the daily missions.
 *
 * Accumulating fields (orbs, greed orbs, runs) are passed as deltas so that a
 * revived run can be committed twice without double-counting; peak fields
 * (score, chain, multiplier, zone) are absolute because max() is idempotent.
 */
export function applyRun(profile, run) {
  const newlyDone = [];
  for (const m of profile.missions || []) {
    const before = isComplete(m);
    switch (m.id) {
      case 'rings': m.progress = Math.max(m.progress, run.score); break;
      case 'perfect_run': m.progress = Math.max(m.progress, run.perfects); break;
      case 'greed': m.progress += run.greedOrbs; break;
      case 'chain': m.progress = Math.max(m.progress, run.bestChain); break;
      case 'combo': m.progress = Math.max(m.progress, run.bestMultiplier); break;
      case 'no_shield': m.progress = Math.max(m.progress, run.noShieldZone + 1); break;
      case 'zone': m.progress = Math.max(m.progress, run.zoneReached + 1); break;
      case 'orbs': m.progress += run.orbs; break;
      case 'beat_best': if (run.isBest) m.progress = 1; break;
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
  grantShards(profile, mission.reward);
  return mission.reward;
}

export function claimableCount(profile) {
  return (profile.missions || []).filter((m) => isComplete(m) && !m.claimed).length;
}

// ------------------------------------------------------------------ economy ---

export function grantShards(profile, amount) {
  const n = Math.max(0, Math.round(amount));
  profile.shards += n;
  profile.totalShards += n;
  return n;
}

export function spendShards(profile, amount) {
  if (profile.shards < amount) return false;
  profile.shards -= amount;
  return true;
}

// ---------------------------------------------------------------- cosmetics ---

export function kindOf(kind) {
  return COSMETIC_KINDS.find((k) => k.id === kind) || COSMETIC_KINDS[0];
}

export function itemOf(kind, id) {
  return kindOf(kind).items.find((i) => i.id === id) || kindOf(kind).items[0];
}

export function owns(profile, kind, id) {
  return (profile[kindOf(kind).owned] || []).includes(id);
}

export function isEquipped(profile, kind, id) {
  return profile[kindOf(kind).equipped] === id;
}

export function canAfford(profile, kind, id) {
  const item = itemOf(kind, id);
  return item.unlock === 'shards' && profile.shards >= item.cost;
}

/**
 * What the shop should show for an item:
 *   equipped | owned | buyable | tooPoor | achievement | premium
 */
export function unlockState(profile, kind, id) {
  const item = itemOf(kind, id);
  if (isEquipped(profile, kind, id)) return 'equipped';
  if (owns(profile, kind, id)) return 'owned';
  if (item.unlock === 'achievement') return 'achievement';
  if (item.unlock === 'premium') return 'premium';
  return profile.shards >= item.cost ? 'buyable' : 'tooPoor';
}

export function grantCosmetic(profile, kind, id) {
  const list = profile[kindOf(kind).owned];
  if (!list.includes(id)) list.push(id);
}

export function equipCosmetic(profile, kind, id) {
  if (!owns(profile, kind, id)) return false;
  profile[kindOf(kind).equipped] = id;
  return true;
}

/**
 * Returns 'bought' | 'equipped' | 'noop' | 'poor' | 'achievement' | 'premium'.
 * Premium items are never granted here — that is PurchaseService's job.
 */
export function buyOrEquip(profile, kind, id) {
  if (owns(profile, kind, id)) {
    if (isEquipped(profile, kind, id)) return 'noop';
    equipCosmetic(profile, kind, id);
    return 'equipped';
  }
  const item = itemOf(kind, id);
  if (item.unlock === 'achievement') return 'achievement';
  if (item.unlock === 'premium') return 'premium';
  if (!spendShards(profile, item.cost)) return 'poor';
  grantCosmetic(profile, kind, id);
  equipCosmetic(profile, kind, id);
  return 'bought';
}

/** Hand over any cosmetic whose achievement has since been earned. */
export function syncAchievementCosmetics(profile) {
  const granted = [];
  for (const kind of COSMETIC_KINDS) {
    for (const item of kind.items) {
      if (item.unlock !== 'achievement') continue;
      if (owns(profile, kind.id, item.id)) continue;
      if (!isUnlocked(profile, item.achievement)) continue;
      grantCosmetic(profile, kind.id, item.id);
      granted.push({ kind: kind.id, item });
    }
  }
  return granted;
}

/** The cheapest thing the player could buy right now, for the shop badge. */
export function nextUnlockable(profile) {
  const buyable = [];
  for (const kind of COSMETIC_KINDS) {
    for (const item of kind.items) {
      if (item.unlock !== 'shards' || owns(profile, kind.id, item.id)) continue;
      if (profile.shards >= item.cost) buyable.push({ kind: kind.id, item });
    }
  }
  buyable.sort((a, b) => a.item.cost - b.item.cost);
  return buyable[0] || null;
}

export function collectionProgress(profile) {
  let owned = 0;
  let total = 0;
  for (const kind of COSMETIC_KINDS) {
    total += kind.items.length;
    owned += kind.items.filter((i) => owns(profile, kind.id, i.id)).length;
  }
  return { owned, total };
}

// --------------------------------------------------------------- lifetime ---

/** Fold a finished run into the lifetime stats. Returns true on a new best. */
export function commitRun(profile, run) {
  if (run.countRun) profile.runs += 1;
  profile.totalRings += run.rings;
  profile.totalTimeMs += run.timeMs;
  profile.totalPerfects += run.perfects;
  profile.totalOrbs += run.orbs;
  profile.totalGreedOrbs += run.greedOrbs;
  grantShards(profile, run.shards);

  const isBest = run.score > profile.bestScore;
  if (isBest) profile.bestScore = run.score;
  if (run.bestChain > profile.bestChain) profile.bestChain = run.bestChain;
  if (run.bestMultiplier > profile.bestMultiplier) profile.bestMultiplier = run.bestMultiplier;
  if (run.zoneReached > profile.bestZone) profile.bestZone = run.zoneReached;
  if (run.perfects > profile.bestPerfects) profile.bestPerfects = run.perfects;
  if (run.noShieldZone > profile.noShieldZone) profile.noShieldZone = run.noShieldZone;
  return isBest;
}
