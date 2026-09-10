import test from 'node:test';
import assert from 'node:assert/strict';

import * as meta from '../www/src/game/meta.js';
import * as store from '../www/src/engine/storage.js';
import { SKINS, DAILY_REWARDS } from '../www/src/game/config.js';

const freshProfile = () => ({ ...store.DEFAULT_PROFILE, ownedSkins: ['aurora'], missions: [] });
const day = (n) => new Date(2026, 0, n, 12, 0, 0);

test('daily missions are rolled once per day and are distinct', () => {
  const p = freshProfile();
  assert.equal(meta.ensureDaily(p, day(1)), true);
  assert.equal(p.missions.length, 3);
  assert.equal(new Set(p.missions.map((m) => m.id)).size, 3, 'no duplicate mission types');
  const first = JSON.stringify(p.missions);

  assert.equal(meta.ensureDaily(p, day(1)), false, 'same day does not reroll');
  assert.equal(JSON.stringify(p.missions), first);

  assert.equal(meta.ensureDaily(p, day(2)), true, 'a new day rerolls');
});

test('the same date always produces the same missions', () => {
  const a = freshProfile();
  const b = freshProfile();
  meta.ensureDaily(a, day(9));
  meta.ensureDaily(b, day(9));
  assert.deepEqual(a.missions, b.missions);
});

test('the play streak counts consecutive days and resets after a gap', () => {
  const p = freshProfile();
  meta.registerPlay(p, day(1));
  assert.equal(p.streak, 1);
  meta.registerPlay(p, day(1));
  assert.equal(p.streak, 1, 'twice in one day still counts once');
  meta.registerPlay(p, day(2));
  assert.equal(p.streak, 2);
  meta.registerPlay(p, day(3));
  assert.equal(p.streak, 3);
  meta.registerPlay(p, day(6));
  assert.equal(p.streak, 1, 'a missed day resets the streak');
});

test('the daily bonus can only be claimed once a day and grows with the streak', () => {
  const p = freshProfile();
  p.streak = 1;
  assert.equal(meta.dailyRewardAvailable(p, day(1)), true);
  const first = meta.claimDailyReward(p, day(1));
  assert.equal(first, DAILY_REWARDS[0]);
  assert.equal(p.energy, DAILY_REWARDS[0]);
  assert.equal(meta.claimDailyReward(p, day(1)), 0, 'no double claim');

  p.streak = 7;
  assert.equal(meta.dailyRewardAmount(p), DAILY_REWARDS[6]);
  p.streak = 99;
  assert.equal(meta.dailyRewardAmount(p), DAILY_REWARDS[DAILY_REWARDS.length - 1], 'reward is capped');
});

test('mission progress uses peaks for peak goals and sums for cumulative ones', () => {
  const p = freshProfile();
  p.missions = [
    { id: 'rings', scope: 'run', text: '', target: 50, reward: 100, progress: 0, claimed: false },
    { id: 'orbs', scope: 'total', text: '', target: 40, reward: 100, progress: 0, claimed: false },
    { id: 'runs', scope: 'total', text: '', target: 3, reward: 80, progress: 0, claimed: false },
  ];
  meta.applyRun(p, { score: 30, orbs: 10, bestCombo: 4, perfects: 2, zoneReached: 1, countRun: true });
  assert.equal(p.missions[0].progress, 30);
  assert.equal(p.missions[1].progress, 10);
  assert.equal(p.missions[2].progress, 1);

  meta.applyRun(p, { score: 12, orbs: 5, bestCombo: 2, perfects: 1, zoneReached: 0, countRun: true });
  assert.equal(p.missions[0].progress, 30, 'a worse run does not lower a peak goal');
  assert.equal(p.missions[1].progress, 15, 'cumulative goals add up');
  assert.equal(p.missions[2].progress, 2);
});

test('a completed mission pays out exactly once', () => {
  const p = freshProfile();
  p.missions = [{ id: 'rings', scope: 'run', text: '', target: 10, reward: 120, progress: 0, claimed: false }];
  const done = meta.applyRun(p, { score: 25, orbs: 0, bestCombo: 0, perfects: 0, zoneReached: 0, countRun: true });
  assert.equal(done.length, 1);
  assert.equal(meta.claimableCount(p), 1);
  assert.equal(meta.claimMission(p, p.missions[0]), 120);
  assert.equal(p.energy, 120);
  assert.equal(meta.claimMission(p, p.missions[0]), 0, 'no double claim');
  assert.equal(meta.claimableCount(p), 0);

  const again = meta.applyRun(p, { score: 40, orbs: 0, bestCombo: 0, perfects: 0, zoneReached: 0, countRun: true });
  assert.equal(again.length, 0, 'already-complete missions do not re-fire');
});

test('a revived run is committed once, without double counting', () => {
  const p = freshProfile();
  // First death: 20 rings, 30 energy.
  meta.commitRun(p, {
    score: 20, rings: 20, energy: 30, orbs: 8, perfects: 4,
    bestCombo: 5, zoneReached: 1, timeMs: 20000, countRun: true,
  });
  // Player revives and reaches 35 rings / 55 energy in total.
  const isBest = meta.commitRun(p, {
    score: 35, rings: 15, energy: 25, orbs: 6, perfects: 3,
    bestCombo: 9, zoneReached: 2, timeMs: 15000, countRun: false,
  });
  assert.equal(isBest, true);
  assert.equal(p.runs, 1, 'one run, not two');
  assert.equal(p.totalRings, 35);
  assert.equal(p.energy, 55);
  assert.equal(p.totalEnergy, 55);
  assert.equal(p.bestScore, 35);
  assert.equal(p.bestCombo, 9);
  assert.equal(p.bestZone, 2);
  assert.equal(p.totalTimeMs, 35000);
});

test('buying a skin spends energy, equips it, and cannot be repeated', () => {
  const p = freshProfile();
  const target = SKINS.find((s) => s.cost > 0);
  p.energy = target.cost;

  assert.equal(meta.buyOrEquip(p, target.id), 'bought');
  assert.equal(p.energy, 0);
  assert.equal(p.skin, target.id);
  assert.ok(meta.ownsSkin(p, target.id));

  assert.equal(meta.buyOrEquip(p, target.id), 'noop', 'already equipped');
  assert.equal(meta.buyOrEquip(p, 'aurora'), 'equipped');
  assert.equal(meta.buyOrEquip(p, target.id), 'equipped', 'owned skins re-equip for free');
  assert.equal(p.energy, 0);
});

test('a skin the player cannot afford is refused', () => {
  const p = freshProfile();
  const target = SKINS[SKINS.length - 1];
  p.energy = target.cost - 1;
  assert.equal(meta.buyOrEquip(p, target.id), 'poor');
  assert.equal(p.energy, target.cost - 1);
  assert.equal(meta.ownsSkin(p, target.id), false);
});

test('the shop badge only lights up when something is affordable', () => {
  const p = freshProfile();
  p.energy = 0;
  assert.equal(meta.nextUnlockable(p), null);
  p.energy = SKINS[1].cost;
  assert.equal(meta.nextUnlockable(p).id, SKINS[1].id);
});
