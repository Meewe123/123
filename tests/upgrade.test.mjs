import test from 'node:test';
import assert from 'node:assert/strict';

import { World, EVT, PLAYER_HALF } from '../www/src/game/world.js';
import { TUNE, OVERDRIVE_AT, ZONES, SKINS, SHIELD } from '../www/src/game/config.js';
import { adjustPalette, rgbToHsl, hexToRgb, hueDistance } from '../www/src/game/palette.js';
import { resolvePerfectEffect, EFFECT_IDS } from '../www/src/game/effects.js';
import { createAutopilot, stepAutopilot } from '../www/src/game/autopilot.js';
import * as daily from '../www/src/game/daily.js';
import * as store from '../www/src/engine/storage.js';
import { encodeChallenge, decodeChallenge } from '../www/src/services/challenge.js';
import { LocalStore, LeaderboardService, DailyLeaderboardService } from '../www/src/services/leaderboard.js';
import { PurchaseService } from '../www/src/services/purchase.js';

const DT = 1 / 120;

/** Walk a world with the reference player, collecting every ring it generates. */
function harvestRings(seed, seconds = 90, opts = {}) {
  const w = new World(seed);
  const bot = createAutopilot({ greedy: true, ...opts });
  const seen = new Map();
  const record = () => {
    for (const ring of w.rings) if (!seen.has(ring.id)) seen.set(ring.id, { ring, floor: w._minGapHalf(ring) });
  };
  record();
  for (let i = 0; i < 120 * seconds && w.alive; i++) {
    stepAutopilot(w, bot);
    w.update(DT);
    w.events.length = 0;
    record();
  }
  return { world: w, rings: [...seen.values()] };
}

// ------------------------------------------------------------ safe vs greed ---

test('every orb — greed included — can be taken with a clean pass', () => {
  // This is the invariant that keeps the risk honest. Centring the swept body
  // on the orb must still fit inside the gap, or the game would be offering a
  // reward it does not actually allow you to take.
  let checked = 0;
  for (const seed of [1, 2, 3, 4]) {
    for (const { ring, floor } of harvestRings(seed).rings) {
      const half = ring.gaps[0].half;
      // floor = PLAYER_HALF + sweep/2 + gapMargin, so the room left for an
      // orb once the swept body is accounted for is (half - floor) + margin.
      const room = (half - floor) + TUNE.gapMargin;
      for (const orb of ring.orbs) {
        if (orb.type !== 'shard') continue;
        assert.ok(Math.abs(orb.offset) <= room + 1e-9,
          `seed ${seed} ring ${ring.id}: orb at ${orb.offset.toFixed(3)} needs ${room.toFixed(3)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `only checked ${checked} orbs`);
});

test('rings offer a real decision: both safe and greed orbs show up', () => {
  let safe = 0;
  let greed = 0;
  for (const seed of [11, 12, 13]) {
    for (const { ring } of harvestRings(seed).rings) {
      for (const orb of ring.orbs) {
        if (orb.type !== 'shard') continue;
        if (orb.greed) greed++;
        else safe++;
      }
    }
  }
  assert.ok(safe > 20 && greed > 20, `safe=${safe} greed=${greed}`);
  const share = greed / (safe + greed);
  assert.ok(share > 0.25 && share < 0.65, `greed orbs are ${(share * 100).toFixed(0)}% of the total`);
});

test('a greed orb is worth double and advances the chain twice as fast', () => {
  const make = (greed) => {
    const w = new World(7);
    const ring = w.rings[0];
    ring.orbs = [{ gapIndex: 0, offset: 0, risk: greed ? 0.9 : 0.1, greed, type: 'shard', taken: false }];
    const rot = ring.rot;
    const angle = rot + World.gapCenterAt(ring, 0, ring.travel);
    w._collectOrbs(ring, ring.travel, rot, angle);
    return w;
  };
  const safe = make(false);
  const greedy = make(true);

  assert.equal(safe.combo, 1);
  assert.equal(greedy.combo, 2, 'greed is two links of chain');
  assert.equal(greedy.shards, safe.shards * TUNE.greedBonus);
  assert.equal(greedy.greedOrbs, 1);
  assert.equal(safe.safeOrbs, 1);
});

// ---------------------------------------------------------------- overdrive ---

test('OVERDRIVE announces itself once, when the multiplier tops out', () => {
  const w = new World(5);
  const events = [];
  const drain = () => w.drainEvents((e) => events.push(e));

  w.combo = 0;
  const ring = w.rings[0];
  // Feed the chain one orb at a time until it caps out.
  for (let i = 0; i < 40; i++) {
    ring.orbs = [{ gapIndex: 0, offset: 0, risk: 0, greed: false, type: 'shard', taken: false }];
    const rot = ring.rot;
    w._collectOrbs(ring, ring.travel, rot, rot + World.gapCenterAt(ring, 0, ring.travel));
    drain();
  }

  const overdrives = events.filter((e) => e.type === EVT.OVERDRIVE);
  assert.equal(overdrives.length, 1, 'fires exactly once');
  assert.equal(overdrives[0].value, OVERDRIVE_AT);
  assert.equal(w.overdrive, true);
  assert.ok(events.filter((e) => e.type === EVT.MULTIPLIER).length >= OVERDRIVE_AT - 1);

  w.combo = 0;
  assert.equal(w.overdrive, false, 'losing the chain leaves OVERDRIVE');
});

test('a broken chain reports what was lost', () => {
  const w = new World(55);
  w.combo = 9;
  const ring = w.rings[0];
  ring.orbs = [{ gapIndex: 0, offset: 0, risk: 0, greed: false, type: 'shard', taken: false }];
  ring.collected = 0;
  ring.centreDist = 0.5;
  ring.centreHalf = 1;
  w._clearRing(ring);
  const broken = w.events.find((e) => e.type === EVT.COMBO_BREAK);
  assert.ok(broken, 'the break is announced');
  assert.equal(broken.lost, 9);
  assert.ok(broken.from > 1);
});

// -------------------------------------------------------------------- daily ---

test('the daily seed is fixed by the date and differs day to day', () => {
  assert.equal(daily.dailySeed('2026-09-10'), daily.dailySeed('2026-09-10'));
  assert.notEqual(daily.dailySeed('2026-09-10'), daily.dailySeed('2026-09-11'));
  assert.match(daily.dailyLabel('2026-09-10'), /^#\d{5}$/);
  assert.equal(daily.dailyLabel('2026-09-10'), daily.dailyLabel('2026-09-10'));
});

test('the same daily seed produces the same run for everybody', () => {
  const play = () => {
    const w = new World(daily.dailySeed('2026-09-10'));
    const bot = createAutopilot({ greedy: false });
    for (let i = 0; i < 120 * 25 && w.alive; i++) {
      stepAutopilot(w, bot);
      w.update(DT);
      w.events.length = 0;
    }
    return {
      score: w.score, shards: w.shards, orbs: w.orbsCollected,
      greed: w.greedOrbs, perfects: w.perfects, time: w.time,
    };
  };
  assert.deepEqual(play(), play());
});

test('the daily rolls over and records one attempt a day', () => {
  const p = store.migrate(null);
  const monday = new Date(2026, 0, 5, 12);
  const tuesday = new Date(2026, 0, 6, 12);

  assert.equal(daily.ensureDaily(p, monday), true);
  assert.equal(daily.ensureDaily(p, monday), false, 'the same day does not roll');
  assert.equal(daily.dailyAvailable(p, monday), true);

  daily.recordDaily(p, { score: 120, zoneReached: 3, bestMultiplier: 5, perfects: 9, orbs: 20 }, monday);
  assert.equal(p.dailyBest.score, 120);
  assert.equal(p.dailyRuns, 1);
  assert.equal(daily.dailyAvailable(p, monday), false, "today's attempt is spent");

  daily.recordDaily(p, { score: 80, zoneReached: 1, bestMultiplier: 2, perfects: 1, orbs: 4 }, monday);
  assert.equal(p.dailyBest.score, 120, 'a worse replay does not lower the record');
  assert.equal(p.dailyBest.zone, 3);
  assert.equal(p.dailyRuns, 1, 'and does not count as a second attempt');

  daily.recordDaily(p, { score: 200, zoneReached: 5, bestMultiplier: 8, perfects: 30, orbs: 40 }, monday);
  assert.equal(p.dailyBest.score, 200, 'a better replay still improves your own record');

  assert.equal(daily.ensureDaily(p, tuesday), true);
  assert.equal(p.dailyBest.score, 0, 'a new day starts clean');
  assert.equal(daily.dailyAvailable(p, tuesday), true);
  assert.equal(p.dailyRuns, 1, 'lifetime daily count is not reset');
});

// ----------------------------------------------------------------- services ---

test('challenge codes survive a round trip and reject junk', () => {
  for (const c of [
    { mode: 'endless', seed: 0, score: 0 },
    { mode: 'daily', seed: 4294967295, score: 999999 },
    { mode: 'endless', seed: 12345, score: 678 },
  ]) {
    assert.deepEqual(decodeChallenge(encodeChallenge(c)), c);
  }
  for (const junk of ['', 'nope', '9-e-1-1', '1-x-1-1', '1-e-!!-1', null, undefined, 42]) {
    assert.equal(decodeChallenge(junk), null, `accepted junk: ${junk}`);
  }
});

test('the leaderboard is local, says so, and keeps modes apart', async () => {
  const p = store.migrate(null);
  const store_ = new LocalStore(p);
  const endless = new LeaderboardService(store_);
  const today = new DailyLeaderboardService(store_, '2026-09-10');

  assert.equal(endless.isGlobal, false, 'never claim a global board without one');
  assert.equal(today.isGlobal, false);

  await endless.submit({ score: 100, zone: 1 });
  await endless.submit({ score: 300, zone: 4 });
  await today.submit({ score: 250, zone: 3 });

  const endlessTop = await endless.top();
  assert.equal(endlessTop.length, 2);
  assert.equal(endlessTop[0].score, 300, 'sorted by score');
  assert.equal((await today.top()).length, 1, 'daily runs stay in the daily board');
  assert.equal((await today.personalBest()).score, 250);
});

test('purchases refuse honestly when there is no billing bridge', async () => {
  const service = new PurchaseService(null);
  assert.equal(service.available, false);
  const result = await service.purchase('cosmetic.nebula');
  assert.equal(result.ok, false, 'never a fake success');
  assert.deepEqual(await service.products(['x']), []);
  assert.deepEqual(await service.restore(), []);
});

// ------------------------------------------------------------------- saving ---

test('the upgraded save keeps the new state and survives a round trip', () => {
  const p = store.migrate(null);
  assert.equal(p.version, store.SAVE_VERSION);
  assert.equal(p.shards, 0);
  assert.deepEqual(p.achievements, []);
  assert.equal(p.dailyBest.score, 0);

  p.shards = 900;
  p.achievements = ['first_perfect'];
  p.recent = new Array(50).fill({ score: 1 });

  const round = store.migrate(JSON.parse(JSON.stringify(p)));
  assert.equal(round.shards, 900);
  assert.deepEqual(round.achievements, ['first_perfect']);
  assert.equal(round.recent.length, 20, 'the local history stays bounded');
});

// -------------------------------------------------------- regression tests ---

test('an orb never lands on the player, the ring, or the shield blue', () => {
  // Satisfying these one at a time silently undoes the earlier push; this is
  // the whole point of solving them together.
  const chroma = (hex) => {
    const [h, s, l] = rgbToHsl(hexToRgb(hex));
    return { h, c: s * (1 - Math.abs(2 * l - 1)) };
  };
  const shieldHue = chroma(SHIELD.core).h;
  let worst = Infinity;
  let where = '';
  for (const zone of ZONES) {
    for (const skin of SKINS) {
      const pal = adjustPalette(zone.palette, skin);
      const orb = chroma(pal.orb);
      if (orb.c < 0.2) continue; // a near-grey orb cannot clash with a hue
      const others = [
        ['skin', chroma(skin.glow)],
        ['ring', chroma(pal.ring)],
        ['shield', { h: shieldHue, c: 1 }],
      ];
      for (const [name, other] of others) {
        if (other.c < 0.2) continue;
        const d = hueDistance(orb.h, other.h);
        if (d < worst) {
          worst = d;
          where = `${zone.id}/${skin.id}: orb vs ${name}`;
        }
      }
    }
  }
  assert.ok(worst >= 30, `${where} are only ${worst.toFixed(0)}° apart`);
});

test('no skin competes with the colour reserved for the shield', () => {
  const chroma = (hex) => {
    const [h, s, l] = rgbToHsl(hexToRgb(hex));
    return { h, c: s * (1 - Math.abs(2 * l - 1)) };
  };
  const shieldHue = chroma(SHIELD.core).h;
  for (const skin of SKINS) {
    const g = chroma(skin.glow);
    if (g.c < 0.25) continue; // desaturated skins read as white, not as blue
    assert.ok(hueDistance(g.h, shieldHue) >= 40,
      `${skin.id} sits ${hueDistance(g.h, shieldHue).toFixed(0)}° from the shield`);
  }
});

test('a revived run files one score, not one per death', async () => {
  const p = store.migrate(null);
  const board = new LeaderboardService(new LocalStore(p));
  await board.submit({ id: 'run-1', score: 120, zone: 2 });
  await board.submit({ id: 'run-1', score: 260, zone: 4 });
  await board.submit({ id: 'run-2', score: 90, zone: 1 });

  const top = await board.top();
  assert.equal(top.length, 2, 'the revived run is one entry');
  assert.equal(top[0].score, 260, 'and it is the final score that stands');
});

test('the daily board resolves its date when it is used', async () => {
  const p = store.migrate(null);
  let today = '2026-09-10';
  const board = new DailyLeaderboardService(new LocalStore(p), () => today);
  await board.submit({ score: 100 });
  assert.equal((await board.top()).length, 1);

  today = '2026-09-11'; // a session that outlived midnight
  assert.equal(board.dateKey, '2026-09-11');
  assert.equal((await board.top()).length, 0, "yesterday's runs are not today's");
  await board.submit({ score: 50 });
  assert.equal((await board.top())[0].score, 50);
});

test('a PERFECT effect falls back through cosmetic, skin, then zone', () => {
  const zone = ZONES.find((z) => z.fx.perfect === 'shatter');
  const plainSkin = SKINS.find((s) => s.effect === 'zone');
  const signatureSkin = SKINS.find((s) => s.effect && s.effect !== 'zone');

  assert.equal(resolvePerfectEffect('zone', plainSkin, zone), zone.fx.perfect,
    'nothing equipped and a plain skin: the zone decides');
  assert.equal(resolvePerfectEffect('zone', signatureSkin, zone), signatureSkin.effect,
    'a skin with its own signature uses it');
  assert.equal(resolvePerfectEffect('shockwave', signatureSkin, zone), 'shockwave',
    'an equipped effect beats everything');
  assert.ok(EFFECT_IDS.includes(resolvePerfectEffect('zone', signatureSkin, zone)),
    'and whatever it resolves to has a recipe');
});
