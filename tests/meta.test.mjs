import test from 'node:test';
import assert from 'node:assert/strict';

import * as meta from '../www/src/game/meta.js';
import * as store from '../www/src/engine/storage.js';
import * as achievements from '../www/src/game/achievements.js';
import { SKINS, TRAILS, DAILY_REWARDS, STREAK_MILESTONES } from '../www/src/game/config.js';

const freshProfile = () => store.migrate(null);
const day = (n) => new Date(2026, 0, n, 12, 0, 0);

const RUN = (over = {}) => ({
  score: 0, rings: 0, shards: 0, orbs: 0, greedOrbs: 0, perfects: 0,
  bestChain: 0, bestMultiplier: 1, zoneReached: 0, noShieldZone: 0,
  timeMs: 0, countRun: true, isBest: false, ...over,
});

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
  meta.registerPlay(p, day(3));
  assert.equal(p.streak, 3);
  meta.registerPlay(p, day(6));
  assert.equal(p.streak, 1, 'a missed day resets the streak');
});

test('streak milestones pay out once each, in order', () => {
  const p = freshProfile();
  p.streak = 3;
  const first = meta.claimStreakMilestones(p);
  assert.equal(first.length, 1);
  assert.equal(first[0].days, 3);
  assert.equal(p.shards, STREAK_MILESTONES[0].reward);
  assert.equal(meta.claimStreakMilestones(p).length, 0, 'no double payout');

  p.streak = 7;
  const second = meta.claimStreakMilestones(p);
  assert.equal(second.length, 1);
  assert.equal(second[0].days, 7);
  assert.equal(meta.nextStreakMilestone(p).days, 14);
});

test('the daily bonus can only be claimed once a day and grows with the streak', () => {
  const p = freshProfile();
  p.streak = 1;
  assert.equal(meta.dailyRewardAvailable(p, day(1)), true);
  assert.equal(meta.claimDailyReward(p, day(1)), DAILY_REWARDS[0]);
  assert.equal(p.shards, DAILY_REWARDS[0]);
  assert.equal(meta.claimDailyReward(p, day(1)), 0, 'no double claim');

  p.streak = 99;
  assert.equal(meta.dailyRewardAmount(p), DAILY_REWARDS[DAILY_REWARDS.length - 1], 'reward is capped');
});

test('mission progress uses peaks for peak goals and sums for cumulative ones', () => {
  const p = freshProfile();
  p.missions = [
    { id: 'rings', scope: 'run', text: '', target: 50, reward: 100, progress: 0, claimed: false },
    { id: 'greed', scope: 'total', text: '', target: 40, reward: 100, progress: 0, claimed: false },
    { id: 'perfect_run', scope: 'run', text: '', target: 20, reward: 100, progress: 0, claimed: false },
  ];
  meta.applyRun(p, RUN({ score: 30, greedOrbs: 10, perfects: 7 }));
  assert.equal(p.missions[0].progress, 30);
  assert.equal(p.missions[1].progress, 10);
  assert.equal(p.missions[2].progress, 7);

  meta.applyRun(p, RUN({ score: 12, greedOrbs: 5, perfects: 3 }));
  assert.equal(p.missions[0].progress, 30, 'a worse run does not lower a peak goal');
  assert.equal(p.missions[1].progress, 15, 'cumulative goals add up');
  assert.equal(p.missions[2].progress, 7);
});

test('the beat-your-best mission only fires on an actual record', () => {
  const p = freshProfile();
  p.missions = [{ id: 'beat_best', scope: 'run', text: '', target: 1, reward: 250, progress: 0, claimed: false }];
  meta.applyRun(p, RUN({ score: 40, isBest: false }));
  assert.equal(p.missions[0].progress, 0);
  meta.applyRun(p, RUN({ score: 40, isBest: true }));
  assert.equal(p.missions[0].progress, 1);
});

test('a completed mission pays out exactly once', () => {
  const p = freshProfile();
  p.missions = [{ id: 'rings', scope: 'run', text: '', target: 10, reward: 120, progress: 0, claimed: false }];
  const done = meta.applyRun(p, RUN({ score: 25 }));
  assert.equal(done.length, 1);
  assert.equal(meta.claimableCount(p), 1);
  assert.equal(meta.claimMission(p, p.missions[0]), 120);
  assert.equal(p.shards, 120);
  assert.equal(meta.claimMission(p, p.missions[0]), 0, 'no double claim');
  assert.equal(meta.applyRun(p, RUN({ score: 40 })).length, 0, 'already-complete missions do not re-fire');
});

test('a revived run is committed once, without double counting', () => {
  const p = freshProfile();
  meta.commitRun(p, RUN({
    score: 20, rings: 20, shards: 30, orbs: 8, greedOrbs: 3, perfects: 4,
    bestChain: 5, bestMultiplier: 2, zoneReached: 1, timeMs: 20000, countRun: true,
  }));
  const isBest = meta.commitRun(p, RUN({
    score: 35, rings: 15, shards: 25, orbs: 6, greedOrbs: 2, perfects: 3,
    bestChain: 9, bestMultiplier: 3, zoneReached: 2, timeMs: 15000, countRun: false,
  }));
  assert.equal(isBest, true);
  assert.equal(p.runs, 1, 'one run, not two');
  assert.equal(p.totalRings, 35);
  assert.equal(p.shards, 55);
  assert.equal(p.totalShards, 55);
  assert.equal(p.totalOrbs, 14);
  assert.equal(p.totalGreedOrbs, 5);
  assert.equal(p.totalPerfects, 7);
  assert.equal(p.bestScore, 35);
  assert.equal(p.bestChain, 9);
  assert.equal(p.bestMultiplier, 3);
  assert.equal(p.bestZone, 2);
  assert.equal(p.totalTimeMs, 35000);
});

test('buying a cosmetic spends shards, equips it, and cannot be repeated', () => {
  const p = freshProfile();
  const target = SKINS.find((s) => s.unlock === 'shards');
  p.shards = target.cost;

  assert.equal(meta.buyOrEquip(p, 'skin', target.id), 'bought');
  assert.equal(p.shards, 0);
  assert.equal(p.skin, target.id);
  assert.ok(meta.owns(p, 'skin', target.id));

  assert.equal(meta.buyOrEquip(p, 'skin', target.id), 'noop', 'already equipped');
  assert.equal(meta.buyOrEquip(p, 'skin', 'flow'), 'equipped');
  assert.equal(meta.buyOrEquip(p, 'skin', target.id), 'equipped', 'owned cosmetics re-equip for free');
  assert.equal(p.shards, 0);
});

test('trails and effects are their own independent slots', () => {
  const p = freshProfile();
  const trail = TRAILS.find((t) => t.unlock === 'shards');
  p.shards = trail.cost;
  assert.equal(meta.buyOrEquip(p, 'trail', trail.id), 'bought');
  assert.equal(p.trail, trail.id);
  assert.equal(p.skin, 'flow', 'buying a trail does not touch the skin');
  assert.equal(p.effect, 'zone');
});

test('a cosmetic the player cannot afford or has not earned is refused', () => {
  const p = freshProfile();
  const priced = SKINS.filter((s) => s.unlock === 'shards').pop();
  p.shards = priced.cost - 1;
  assert.equal(meta.buyOrEquip(p, 'skin', priced.id), 'poor');
  assert.equal(p.shards, priced.cost - 1);

  const earned = SKINS.find((s) => s.unlock === 'achievement');
  assert.equal(meta.buyOrEquip(p, 'skin', earned.id), 'achievement', 'never for sale');
  const premium = SKINS.find((s) => s.unlock === 'premium');
  assert.equal(meta.buyOrEquip(p, 'skin', premium.id), 'premium', 'routed to the purchase service');
  assert.equal(meta.owns(p, 'skin', premium.id), false, 'and never granted for free');
});

test('earning an achievement hands over the cosmetic it gates', () => {
  const p = freshProfile();
  const gated = SKINS.find((s) => s.unlock === 'achievement');
  assert.equal(meta.owns(p, 'skin', gated.id), false);

  p.bestZone = 99;
  p.bestMultiplier = 99;
  p.totalPerfects = 1000;
  const earned = achievements.evaluate(p);
  assert.ok(earned.length > 0, 'achievements fired');
  meta.syncAchievementCosmetics(p);
  assert.equal(meta.owns(p, 'skin', gated.id), true);
  assert.ok(p.shards > 0, 'achievements pay shards');

  assert.equal(achievements.evaluate(p).length, 0, 'achievements never fire twice');
});

test('the shop badge only lights up when something is affordable', () => {
  const p = freshProfile();
  p.shards = 0;
  assert.equal(meta.nextUnlockable(p), null);
  const cheapest = [...SKINS, ...TRAILS].filter((i) => i.unlock === 'shards')
    .sort((a, b) => a.cost - b.cost)[0];
  p.shards = cheapest.cost;
  assert.equal(meta.nextUnlockable(p).item.id, cheapest.id);
});

test('the collection reports honest progress', () => {
  const p = freshProfile();
  const start = meta.collectionProgress(p);
  assert.equal(start.owned, 3, 'one starter per category');
  assert.ok(start.total >= 20);
});

test('a build with no store does not count what it cannot sell', () => {
  // Premium skins need a billing bridge. Without one they are not "locked",
  // they are unreachable, and a collection stuck two short of full forever is
  // a worse experience than one that is honest about what this build contains.
  const profile = store.migrate(null);
  const withStore = meta.collectionProgress(profile);
  const without = meta.collectionProgress(profile, { premium: false });
  const premiumCount = SKINS.filter((s) => s.unlock === 'premium').length;

  assert.ok(premiumCount > 0, 'there are premium skins to hide');
  assert.equal(withStore.total - without.total, premiumCount);
  assert.equal(withStore.owned, without.owned, 'nobody owns a premium skin yet');

  const shown = meta.visibleItems('skin', { premium: false });
  assert.ok(shown.every((i) => i.unlock !== 'premium'));
  assert.equal(meta.visibleItems('skin').length, SKINS.length);
});
