/**
 * Daily Run: one seed, one run, the same sequence for everybody on a date.
 *
 * The seed is derived from the calendar date alone, so it needs no server and
 * will match a server-issued seed later as long as the date string agrees.
 */

import { hashString } from '../engine/rng.js';
import { todayKey } from '../engine/util.js';

const SEED_NAMESPACE = 'orbital-rush/daily/';

/** Deterministic seed for a YYYY-MM-DD date key. */
export function dailySeed(dateKey) {
  return hashString(SEED_NAMESPACE + dateKey) >>> 0;
}

export function dailySeedFor(now = new Date()) {
  return dailySeed(todayKey(now));
}

/** A short human label — the same seed always reads the same. */
export function dailyLabel(dateKey) {
  return `#${(dailySeed(dateKey) % 100000).toString().padStart(5, '0')}`;
}

const emptyBest = () => ({ score: 0, zone: 0, multiplier: 1, perfects: 0, orbs: 0 });

/**
 * Roll the daily over when the date changes. Returns true if it rolled, so the
 * caller knows to persist.
 */
export function ensureDaily(profile, now = new Date()) {
  const key = todayKey(now);
  if (profile.dailyDate === key) return false;
  profile.dailyDate = key;
  profile.dailyBest = emptyBest();
  profile.dailyPlayed = false;
  return true;
}

export function dailyAvailable(profile, now = new Date()) {
  ensureDaily(profile, now);
  return !profile.dailyPlayed;
}

/**
 * Fold a finished daily run into the profile. One run per day counts, but a
 * player who revives or replays can still improve their own record — the
 * "played" flag is what the UI uses to say the day's attempt is spent.
 */
export function recordDaily(profile, run, now = new Date()) {
  ensureDaily(profile, now);
  const best = profile.dailyBest || emptyBest();
  const improved = run.score > best.score;
  profile.dailyBest = {
    score: Math.max(best.score, run.score),
    zone: Math.max(best.zone, run.zoneReached),
    multiplier: Math.max(best.multiplier, run.bestMultiplier),
    perfects: Math.max(best.perfects, run.perfects),
    orbs: Math.max(best.orbs, run.orbs),
  };
  if (!profile.dailyPlayed) {
    profile.dailyPlayed = true;
    profile.dailyRuns = (profile.dailyRuns || 0) + 1;
  }
  return improved;
}
