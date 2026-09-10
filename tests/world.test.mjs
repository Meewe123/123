import test from 'node:test';
import assert from 'node:assert/strict';

import { World, EVT } from '../www/src/game/world.js';
import { TUNE, ZONES, difficultyAt, zoneIndexAt } from '../www/src/game/config.js';
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

test('an aimed gap always sits inside the arc the player can still cover', () => {
  // Every ring the generator emits must be reachable from the previous one,
  // otherwise the run contains a wall the player cannot pass by any input.
  let checked = 0;
  for (const seed of [99, 100, 101]) {
    const w = new World(seed);
    const bot = createAutopilot({ greedy: false });
    const seen = new Set(w.rings.map((r) => r.id));
    // Mirror the world's own spawn bookkeeping: the reference point drifts
    // inward with the field, exactly like the previous ring does.
    const previous = { angle: w.lastTargetAngle, travel: w.lastTargetTravel };
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
        const needed = angleDist(ring.targetAngle, previous.angle);
        assert.ok(needed <= budget + 1e-6,
          `seed ${seed} ring ${ring.id}: needs ${needed.toFixed(3)} rad, only ${budget.toFixed(3)} reachable`);
        previous.angle = ring.targetAngle;
        previous.travel = ring.spawnTravel;
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `only checked ${checked} rings`);
});

test('flipping reverses the orbit and is reported as an event', () => {
  const w = new World(5);
  const dir = w.player.dir;
  w.flip();
  assert.equal(w.player.dir, -dir);
  assert.ok(w.events.some((e) => e.type === EVT.FLIP));
});

test('a shield absorbs exactly one hit', () => {
  const w = new World(21);
  w._grantPower('shield');
  assert.equal(w.shield, true);
  w._onCollision(w.rings[0], w.player.angle);
  assert.equal(w.alive, true, 'shield saved the run');
  assert.equal(w.shield, false, 'shield was consumed');
  assert.ok(w.events.some((e) => e.type === EVT.SHIELD_BREAK));

  w.shieldTimer = 0;
  w.events.length = 0;
  w._onCollision(w.rings[1] || w.rings[0], w.player.angle);
  assert.equal(w.alive, false, 'the second hit ends the run');
});

test('slow-mo reduces ring speed while it lasts', () => {
  const w = new World(31);
  const normal = w.speedScale;
  w._grantPower('slow');
  assert.equal(w.slowTimer, TUNE.slowDuration);
  assert.ok(w.speedScale < normal * 0.7, 'rings slow down');

  for (let i = 0; i < 12; i++) w.update(DT);
  assert.ok(w.slowTimer < TUNE.slowDuration, 'the timer runs down');

  w.slowTimer = 0;
  assert.ok(Math.abs(w.speedScale - normal) < 1e-9, 'speed returns to normal when it expires');
});

test('double score awards two points per ring', () => {
  const w = new World(77);
  w._grantPower('double');
  const before = w.score;
  const ring = w.rings[0];
  // Park the player exactly on the aimed gap so the pass is guaranteed.
  ring.state = 'live';
  w.player.angle = ring.targetAngle;
  ring.prevRadius = TUNE.playerOrbit + 0.01;
  ring.radius = TUNE.playerOrbit - 0.01;
  ring.travel = TUNE.playerOrbit - 0.01;
  w._resolveCrossing(ring, TUNE.playerOrbit + 0.01, DT, w.playerSpeed);
  assert.equal(w.score, before + 2);
});

test('the energy chain breaks when an orb on a ring is missed', () => {
  const w = new World(55);
  w.combo = 6;
  const ring = w.rings.find((r) => r.orbs.some((o) => o.type === 'energy')) || w.rings[0];
  ring.orbs = [{ gapIndex: 0, offset: 0, type: 'energy', taken: false }];
  ring.state = 'live';
  // Aim at the gap but far enough from the orb to miss it.
  const centre = ring.targetAngle;
  w.player.angle = wrap(centre + ring.gaps[ring.targetGap].half * 0.95);
  ring.prevRadius = TUNE.playerOrbit + 0.01;
  ring.radius = TUNE.playerOrbit - 0.01;
  ring.travel = TUNE.playerOrbit - 0.01;
  w._resolveCrossing(ring, TUNE.playerOrbit + 0.01, DT, w.playerSpeed);
  assert.equal(w.combo, 0, 'chain resets');
  assert.ok(w.events.some((e) => e.type === EVT.COMBO_BREAK));
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
