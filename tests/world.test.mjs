import test from 'node:test';
import assert from 'node:assert/strict';

import { World, EVT, BAND_HALF, PLAYER_HALF } from '../www/src/game/world.js';
import {
  TUNE, ZONES, difficultyAt, zoneIndexAt, DIFFICULTIES,
} from '../www/src/game/config.js';
import { angleDist, wrap } from '../www/src/engine/util.js';
import { createAutopilot, stepAutopilot } from '../www/src/game/autopilot.js';
import { playRun } from './bot.mjs';

const DT = 1 / 120;

function advance(world, seconds, dt = DT) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps && world.alive; i++) world.update(dt);
  return world;
}

test('a fresh world starts alive with rings already in the field', () => {
  const w = new World(42);
  assert.equal(w.alive, true);
  assert.equal(w.score, 0);
  assert.ok(w.rings.length >= 1, 'field is primed');
  assert.ok(w.rings.every((r) => r.travel > TUNE.playerOrbit), 'no ring starts inside the orbit');
});

test('the first ring gives the player time to read the screen', () => {
  const w = new World(7);
  const nearest = w.rings.reduce((m, r) => Math.min(m, r.travel), Infinity);
  const seconds = (nearest - TUNE.playerOrbit) / (TUNE.ringSpeed * w.speedScale);
  assert.ok(seconds > 1.4, `first ring arrives after ${seconds.toFixed(2)}s`);
});

test('a player who never taps eventually crashes', () => {
  const w = new World(3);
  advance(w, 60);
  assert.equal(w.alive, false);
});

test('the simulation is deterministic for a given seed', () => {
  const run = () => {
    const w = new World(1234);
    for (let i = 0; i < 120 * 20; i++) {
      if (i % 97 === 0) w.flip();
      w.update(DT);
      w.events.length = 0;
    }
    return { score: w.score, energy: w.energy, angle: w.player.angle, time: w.time, alive: w.alive };
  };
  assert.deepEqual(run(), run());
});

test('ring judging does not depend on the frame rate', () => {
  for (const seed of [11, 12, 13]) {
    const coarse = advance(new World(seed), 25, 1 / 60);
    const fine = advance(new World(seed), 25, 1 / 240);
    assert.equal(coarse.score, fine.score, `seed ${seed}: score differs across timesteps`);
    assert.ok(Math.abs(coarse.time - fine.time) < 0.05,
      `seed ${seed}: death time differs by ${Math.abs(coarse.time - fine.time)}`);
  }
});

test('every generated ring is reachable — the reference player survives', () => {
  const scores = [];
  for (let seed = 1; seed <= 12; seed++) {
    const { world } = playRun(seed, { steps: 120 * 90 });
    scores.push(world.score);
  }
  const min = Math.min(...scores);
  const sorted = scores.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(min >= 40, `worst seed only reached ${min} rings (${scores.join(', ')})`);
  assert.ok(median >= 120, `median run was only ${median} rings`);
});

test('an aimed gap is reachable from anywhere inside the previous gap', () => {
  // Every ring the generator emits must be reachable from the previous one,
  // otherwise the run contains a wall the player cannot pass by any input.
  let checked = 0;
  const reachZones = new Set();
  for (const seed of [99, 100, 101]) {
    const w = new World(seed);
    const bot = createAutopilot({ greedy: false });
    const seen = new Set(w.rings.map((r) => r.id));
    // Mirror the world's own spawn bookkeeping: the reference point drifts
    // inward with the field, exactly like the previous ring does.
    const previous = { angle: w.lastTargetAngle, travel: w.lastTargetTravel, half: w.lastTargetHalf };
    for (let i = 0; i < 120 * 90 && w.alive; i++) {
      const budgetPerUnit = w.angularBudgetPerUnit;
      const step = TUNE.ringSpeed * w.speedScale * DT;
      stepAutopilot(w, bot);
      w.update(DT);
      w.events.length = 0;
      previous.travel -= step;
      for (const ring of w.rings) {
        if (seen.has(ring.id)) continue;
        seen.add(ring.id);
        const separation = ring.spawnTravel - previous.travel;
        const budget = Math.min(Math.PI, Math.max(separation, 0) * budgetPerUnit);
        // The player leaves the previous ring from anywhere inside its gap, so
        // the new gap has to be reachable from that gap's far edge — not just
        // from the angle it was aimed at.
        const spread = Math.max(0, previous.half - PLAYER_HALF);
        const needed = angleDist(ring.targetAngle, previous.angle) + spread;
        assert.ok(needed <= budget + 1e-6,
          `seed ${seed} ring ${ring.id}: needs ${needed.toFixed(3)} rad from the gap edge, `
          + `only ${budget.toFixed(3)} reachable`);
        previous.angle = ring.targetAngle;
        previous.travel = ring.spawnTravel;
        previous.half = ring.gaps[ring.targetGap].half;
        reachZones.add(ring.zone);
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `only checked ${checked} rings`);
  assert.equal(reachZones.size, ZONES.length,
    `reachability was never checked in zones ${ZONES.map((z, i) => i).filter((i) => !reachZones.has(i)).join(',')}`);
});

test('flipping reverses the orbit and is reported as an event', () => {
  const w = new World(5);
  const dir = w.player.dir;
  w.flip();
  assert.equal(w.player.dir, -dir);
  assert.ok(w.events.some((e) => e.type === EVT.FLIP));
});

test('a shield always takes two rings before it breaks', () => {
  const w = new World(21);
  w._grantPower('shield');
  assert.equal(w.shieldCharges, TUNE.shieldCharges);
  assert.equal(w.shieldCharges, 2, 'a shield is worth two rings');
  assert.equal(w.shield, true);

  w._onCollision(w.rings[0], w.player.angle);
  assert.equal(w.alive, true, 'the first hit is absorbed');
  assert.equal(w.shieldCharges, 1);
  const first = w.events.find((e) => e.type === EVT.SHIELD_BREAK);
  assert.equal(first.remaining, 1, 'the event reports what is left');

  w.shieldTimer = 0;
  w.events.length = 0;
  w._onCollision(w.rings[1] || w.rings[0], w.player.angle);
  assert.equal(w.alive, true, 'the second hit is absorbed too');
  assert.equal(w.shieldCharges, 0);
  assert.equal(w.shield, false);

  w.shieldTimer = 0;
  w.events.length = 0;
  w._onCollision(w.rings[0], w.player.angle);
  assert.equal(w.alive, false, 'the third hit ends the run');
});

test('shields arrive on a schedule the player can count on', () => {
  const w = new World(3);
  const scheduled = [];
  const seen = new Set();
  const collect = () => {
    for (const ring of w.rings) {
      if (seen.has(ring.id)) continue;
      seen.add(ring.id);
      if (ring.orbs.some((o) => o.type === 'shield')) scheduled.push(seen.size - 1);
    }
  };
  collect();
  const bot = createAutopilot({ greedy: false });
  for (let i = 0; i < 120 * 200 && seen.size < 60; i++) {
    stepAutopilot(w, bot);
    w.update(DT);
    w.events.length = 0;
    collect();
    if (!w.alive) w.reset(3);
  }
  assert.ok(scheduled.length >= 3, `only ${scheduled.length} shields in the first 60 rings`);
  assert.equal(scheduled[0], TUNE.shieldFirst, `first shield at ring ${scheduled[0]}`);
  for (let i = 1; i < scheduled.length; i++) {
    assert.equal(scheduled[i] - scheduled[i - 1], TUNE.shieldEvery,
      `shields ${scheduled[i - 1]} -> ${scheduled[i]} are not ${TUNE.shieldEvery} apart`);
  }
});

test('slow-motion slows the whole world, leaving the geometry unchanged', () => {
  const w = new World(31);
  const geometry = w.angularBudgetPerUnit;
  assert.equal(w.timeScale, 1);

  w._grantPower('slow');
  assert.equal(w.slowTimer, TUNE.slowDuration);
  assert.equal(w.timeScale, TUNE.slowFactor);
  assert.ok(Math.abs(w.angularBudgetPerUnit - geometry) < 1e-9,
    'slow-motion must not change how far the player can reach per ring');

  for (let i = 0; i < 12; i++) w.update(DT);
  assert.ok(w.slowTimer < TUNE.slowDuration, 'the timer runs down');

  w.slowTimer = 0;
  assert.equal(w.timeScale, 1, 'speed returns to normal when it expires');
});

test('double score awards two points per ring', () => {
  const w = new World(77);
  const bot = createAutopilot({ greedy: false });
  w._grantPower('double');
  const before = w.score;
  let gained = -1;
  for (let i = 0; i < 120 * 20 && w.alive; i++) {
    stepAutopilot(w, bot);
    w.update(DT);
    let passed = false;
    w.drainEvents((e) => { if (e.type === EVT.PASS) passed = true; });
    if (passed) { gained = w.score - before; break; }
  }
  assert.equal(gained, 2);
});

test('the chain survives a collected orb and breaks on a missed one', () => {
  const missed = new World(55);
  missed.combo = 6;
  const a = missed.rings[0];
  a.orbs = [{ gapIndex: 0, offset: 0, type: 'shard', taken: false }];
  a.collected = 0;
  a.centreDist = 0.5;
  a.centreHalf = 1;
  missed._clearRing(a);
  assert.equal(missed.combo, 0, 'missing the orb resets the chain');
  assert.ok(missed.events.some((e) => e.type === EVT.COMBO_BREAK));

  const kept = new World(55);
  kept.combo = 6;
  const b = kept.rings[0];
  b.orbs = [{ gapIndex: 0, offset: 0, type: 'shard', taken: false }];
  b.collected = 1;
  b.centreDist = 0.5;
  b.centreHalf = 1;
  kept._clearRing(b);
  assert.equal(kept.combo, 6, 'collecting keeps the chain');

  const bare = new World(55);
  bare.combo = 6;
  const c = bare.rings[0];
  c.orbs = [];
  c.collected = 0;
  c.centreDist = 0.5;
  c.centreHalf = 1;
  bare._clearRing(c);
  assert.equal(bare.combo, 6, 'a ring with no orb cannot break the chain');
});

test('the multiplier climbs with the chain and is capped', () => {
  const w = new World(8);
  assert.equal(w.multiplier, 1);
  w.combo = TUNE.comboPerMultiplier;
  assert.equal(w.multiplier, 2);
  w.combo = 1000;
  assert.equal(w.multiplier, TUNE.maxMultiplier);
});

test('reviving clears the danger zone and grants invulnerability', () => {
  const w = new World(64);
  advance(w, 40);
  w.alive = false;
  w.revive();
  assert.equal(w.alive, true);
  assert.ok(w.shieldTimer > 0, 'invulnerable after revive');
  assert.equal(w.revivesUsed, 1);
  assert.ok(w.rings.every((r) => r.travel > 0.9), 'nothing is about to hit the player');
  assert.ok(w.rings.length > 0, 'the field is refilled');
});

test('zones cycle and the difficulty ramp stays inside its bounds', () => {
  assert.equal(zoneIndexAt(0), 0);
  assert.equal(zoneIndexAt(TUNE.zoneLength), 1);
  assert.equal(zoneIndexAt(TUNE.zoneLength * ZONES.length), 0, 'zones wrap around');
  assert.equal(difficultyAt(0), 0);
  assert.ok(difficultyAt(1e6) < 1.0000001);
  for (let s = 0; s < 500; s += 7) {
    const d = difficultyAt(s);
    assert.ok(d >= 0 && d <= 1, `difficulty out of range at score ${s}`);
  }
});

test('ring cadence stays inside playable limits across the whole ramp', () => {
  for (const score of [0, 25, 60, 120, 250, 600, 2000]) {
    const w = new World(1);
    w.score = score;
    const spacing = TUNE.baseSpacing + (TUNE.minSpacing - TUNE.baseSpacing) * w.difficulty;
    const gap = spacing / (TUNE.ringSpeed * w.speedScale);
    assert.ok(gap > 0.3, `rings arrive every ${gap.toFixed(2)}s at score ${score} — too fast`);
    assert.ok(gap <= 1.05, `rings arrive every ${gap.toFixed(2)}s at score ${score} — too slow`);
  }
});

test('rings are recycled rather than accumulating forever', () => {
  const { world } = playRun(4, { steps: 120 * 120 });
  assert.ok(world.rings.length < 12, `${world.rings.length} rings still alive`);
});

test('jumping to a score rebuilds the field in the matching zone', () => {
  const w = new World(17);
  for (let zone = 0; zone < ZONES.length; zone++) {
    w.jumpTo(zone * TUNE.zoneLength + 3);
    assert.equal(w.zone, zone, `score maps to zone ${zone}`);
    assert.ok(w.rings.length > 0, 'the field is rebuilt');
    assert.ok(w.rings.every((r) => r.zone === zone), 'every ring belongs to the new zone');
    assert.ok(w.rings.every((r) => r.travel > TUNE.playerOrbit), 'nothing spawns on top of the player');
  }
});


test('the player never survives touching a wall', () => {
  // The regression test for the bug this game was reported with: the body that
  // is drawn is the body that collides, so if any part of it overlaps a solid
  // arc the run has to be over. Anything else looks like passing through walls.
  const tolerance = 0.03; // the simulation's own edge forgiveness, plus a hair
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const w = new World(seed);
    const bot = createAutopilot({ greedy: true });
    for (let i = 0; i < 120 * 90 && w.alive; i++) {
      stepAutopilot(w, bot);
      w.update(DT);
      w.events.length = 0;
      if (!w.alive) break;
      for (const ring of w.rings) {
        if (ring.state !== 'live' && ring.state !== 'crossing') continue;
        if (Math.abs(ring.radius - TUNE.playerOrbit) > BAND_HALF) continue;
        let depth = Infinity;
        const rel = wrap(w.player.angle - ring.rot);
        for (let g = 0; g < ring.gaps.length; g++) {
          const dist = angleDist(rel, World.gapCenterAt(ring, g, ring.travel));
          depth = Math.min(depth, dist + PLAYER_HALF - ring.gaps[g].half);
        }
        assert.ok(depth <= tolerance,
          `seed ${seed}: still alive ${depth.toFixed(3)} rad inside a wall`);
      }
    }
  }
});

test('no ring is narrower than the player can sweep through', () => {
  // A gap has to hold the player's width plus everything that moves past them
  // while the ring is in contact, or it would be impossible however well timed.
  // Every zone has to be inspected, not just the early ones: a new zone whose
  // flags widen the sweep must still satisfy the floor.
  const zonesSeen = new Set();
  for (const seed of [11, 22, 33]) {
    const w = new World(seed);
    const bot = createAutopilot({ greedy: false });
    const seen = new Set();
    for (let i = 0; i < 120 * 120 && w.alive; i++) {
      stepAutopilot(w, bot);
      w.update(DT);
      w.events.length = 0;
      for (const ring of w.rings) {
        if (seen.has(ring.id)) continue;
        seen.add(ring.id);
        zonesSeen.add(ring.zone);
        const floor = w._minGapHalf(ring);
        for (const gap of ring.gaps) {
          assert.ok(gap.half >= floor - 1e-9,
            `seed ${seed} ring ${ring.id}: gap ${gap.half.toFixed(3)} < required ${floor.toFixed(3)}`);
        }
      }
    }
    assert.ok(seen.size > 40, `only inspected ${seen.size} rings`);
  }
  assert.equal(zonesSeen.size, ZONES.length,
    `the gap floor was never checked in every zone — saw ${zonesSeen.size}`);
});

test('the player is a ball: both collision extents come from one radius', () => {
  // The drawn body and the swept body are the same circle. If anyone re-splits
  // the player into a lens, one axis becomes secretly kinder than the other and
  // "I went through the wall" comes back.
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  close(BAND_HALF - TUNE.ringThickness / 2, TUNE.playerRadius);
  close(PLAYER_HALF * TUNE.playerOrbit, TUNE.playerRadius);
});

test('the ring you must clear next is already fully on screen', () => {
  // The camera shows a radius of 1 / viewScale across the shorter screen side.
  // The moment you clear a ring, the next one sits at playerOrbit + spacing —
  // and it has to be visible all the way round, because its gap can be at any
  // angle, including the one the screen would clip. The 2% on top is because a
  // ring sitting exactly on the screen edge is only as visible as its own
  // anti-aliasing, which is not visible enough to aim at.
  const visible = 1 / TUNE.viewScale;
  for (const spacing of [TUNE.baseSpacing, TUNE.minSpacing]) {
    const next = TUNE.playerOrbit + spacing;
    assert.ok(next * 1.02 <= visible,
      `next ring at ${next.toFixed(3)} is outside the visible radius ${visible.toFixed(3)}`);
  }
});

/** A ring already scored down to what `_clearRing` reads, so the rule can be
 *  tested on its own rather than through a whole run. */
function scoredRing({ dist = 0, half = 1, collected = 0, orb = null }) {
  return {
    state: 'crossing',
    centreDist: dist,
    centreHalf: half,
    collected,
    orbs: orb ? [{ type: 'shard', greed: orb === 'greed', taken: collected > 0 }] : [],
    power: null,
  };
}

test('threading the centre holds a chain a greed orb would have broken', () => {
  const w = new World(5);
  w.combo = 8;
  w._clearRing(scoredRing({ dist: 0, orb: 'greed' }));
  assert.equal(w.combo, 8, 'a PERFECT pass holds the chain');
  assert.equal(w.chainSaves, 1, 'and the run counts the save');

  w.combo = 8;
  w._clearRing(scoredRing({ dist: 0.9, orb: 'greed' }));
  assert.equal(w.combo, 0, 'scraping past the same orb still costs the chain');
  assert.equal(w.chainSaves, 1, 'a scrape is not a save');
});

test('a safe orb you skipped costs the chain however well you passed', () => {
  // Safe orbs are always reachable, so precision does not excuse leaving one.
  const w = new World(5);
  w.combo = 6;
  w._clearRing(scoredRing({ dist: 0, orb: 'safe' }));
  assert.equal(w.combo, 0);
  assert.equal(w.chainSaves, 0);
});

test('a PERFECT never grants chain on its own', () => {
  // The save is a rescue, not a reward: an empty ring threaded dead centre
  // leaves the multiplier exactly where it was.
  const w = new World(5);
  w.combo = 5;
  w._clearRing(scoredRing({ dist: 0 }));
  assert.equal(w.combo, 5);
  assert.equal(w.perfects, 1);
});

test('every orb sits in the gap the ring is aimed at', () => {
  // Only the aimed gap is guaranteed reachable. An orb in any other opening is
  // a chain the player loses through no fault of their own.
  for (const seed of [4, 19, 44, 77]) {
    const w = new World(seed);
    const bot = createAutopilot({ greedy: true });
    const seen = new Set();
    let checked = 0;
    for (let i = 0; i < 120 * 120 && w.alive; i++) {
      stepAutopilot(w, bot);
      w.update(DT);
      w.events.length = 0;
      for (const ring of w.rings) {
        if (seen.has(ring.id)) continue;
        seen.add(ring.id);
        for (const orb of ring.orbs) {
          assert.equal(orb.gapIndex, ring.targetGap,
            `seed ${seed} ring ${ring.id}: orb parked in gap ${orb.gapIndex}, aim is ${ring.targetGap}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 20, `only inspected ${checked} orbs`);
  }
});

test('greed and dead centre are different lines', () => {
  // If every greed orb sat inside the PERFECT window, reaching for greed would
  // cost nothing and the choice the game is built on would not exist.
  let greed = 0;
  let outside = 0;
  for (const seed of [6, 23, 51]) {
    const w = new World(seed);
    const bot = createAutopilot({ greedy: false });
    const seen = new Set();
    for (let i = 0; i < 120 * 120 && w.alive; i++) {
      stepAutopilot(w, bot);
      w.update(DT);
      w.events.length = 0;
      for (const ring of w.rings) {
        if (seen.has(ring.id)) continue;
        seen.add(ring.id);
        for (const orb of ring.orbs) {
          if (orb.type !== 'shard') continue;
          const window = ring.gaps[orb.gapIndex].half * (1 - TUNE.perfectThreshold);
          if (!orb.greed) {
            assert.ok(Math.abs(orb.offset) <= window,
              `a safe orb at ${orb.offset.toFixed(3)} sits outside the PERFECT window ${window.toFixed(3)}`);
            continue;
          }
          greed++;
          if (Math.abs(orb.offset) > window) outside++;
        }
      }
    }
  }
  assert.ok(greed > 40, `only sampled ${greed} greed orbs`);
  const share = outside / greed;
  assert.ok(share > 0.25 && share < 0.75,
    `${(share * 100).toFixed(0)}% of greed orbs force the choice — the tension is ${share <= 0.25 ? 'gone' : 'constant'}`);
});

test('a difficulty preset changes the pace, never the fairness', () => {
  // The whole claim behind presets: they scale the ramp, and the gap floor and
  // the reachable arc are computed from whatever difficulty is live at that
  // moment. So an easier game has to be exactly as honest as a harder one, and
  // that is worth proving rather than asserting.
  for (const preset of DIFFICULTIES) {
    const w = new World(88);
    w.reset(88, { difficulty: preset.id });
    const bot = createAutopilot({ greedy: false });
    const seen = new Set();
    let rings = 0;
    for (let i = 0; i < 120 * 150 && w.alive; i++) {
      stepAutopilot(w, bot);
      w.update(DT);
      w.events.length = 0;
      for (const ring of w.rings) {
        if (seen.has(ring.id)) continue;
        seen.add(ring.id);
        rings++;
        const floor = w._minGapHalf(ring);
        for (const gap of ring.gaps) {
          assert.ok(gap.half >= floor - 1e-9,
            `${preset.id}: gap ${gap.half.toFixed(3)} under the floor ${floor.toFixed(3)}`);
        }
        for (const orb of ring.orbs) {
          assert.equal(orb.gapIndex, ring.targetGap, `${preset.id}: orb outside the aimed gap`);
        }
      }
    }
    assert.ok(rings > 40, `${preset.id}: only inspected ${rings} rings`);
  }
});

test('a world built with options honours them without a second reset', () => {
  // The constructor used to drop its options on the floor: `new World(seed,
  // { difficulty: 'hard' })` quietly played NORMAL, and only an explicit
  // `reset` applied the preset. Nothing in the game hit it, and a measurement
  // script did.
  const hard = new World(5, { difficulty: 'hard' });
  assert.equal(hard.difficultyId, 'hard');
  assert.equal(hard.ramp, DIFFICULTIES[2].ramp);
  assert.ok(new World(5, { practice: true }).practice, 'practice is ignored too');
  assert.equal(new World(5).difficultyId, 'normal', 'and the default is unchanged');
});

test('easy really is easier and hard really is harder', () => {
  // A preset that does not move the curve is a placebo, and one that moves it
  // the wrong way is a bug. Compare the ramp at the same score.
  const [easy, normal, hard] = DIFFICULTIES;
  for (const score of [20, 60, 150]) {
    assert.ok(difficultyAt(score, easy.ramp) < difficultyAt(score, normal.ramp),
      `easy is not gentler at ${score}`);
    assert.ok(difficultyAt(score, hard.ramp) > difficultyAt(score, normal.ramp),
      `hard is not steeper at ${score}`);
  }
  // Same ceiling in all three: a preset changes when, not whether.
  for (const preset of DIFFICULTIES) {
    assert.ok(difficultyAt(1e6, preset.ramp) > 0.999, `${preset.id} never gets there`);
  }
});
