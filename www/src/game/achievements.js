/**
 * Achievements are pure functions of the persisted profile, evaluated once
 * after a run is committed. Nothing in the UI can grant one.
 */

import { ACHIEVEMENTS, achievementById, achievementAt } from './config.js';

export function isUnlocked(profile, id) {
  return (profile.achievements || []).includes(id);
}

/**
 * Unlock everything the profile now qualifies for, pay out the shards, and
 * return the achievements that fired this time.
 */
export function evaluate(profile) {
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (isUnlocked(profile, a.id)) continue;
    let passed = false;
    try {
      passed = !!a.test(profile);
    } catch {
      passed = false;
    }
    if (!passed) continue;
    profile.achievements.push(a.id);
    profile.shards += a.reward;
    profile.totalShards += a.reward;
    unlocked.push(a);
  }
  return unlocked;
}

export function progress(profile) {
  return { unlocked: (profile.achievements || []).length, total: ACHIEVEMENTS.length };
}

/**
 * Achievements listed for the profile screen. Each carries how far along it
 * is, so a target like "500 PERFECTs" reads as a distance rather than a wall.
 */
export function listed(profile) {
  return ACHIEVEMENTS.map((a) => ({
    ...a,
    unlocked: isUnlocked(profile, a.id),
    at: achievementAt(a, profile),
  }));
}
