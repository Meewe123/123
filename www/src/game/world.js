/**
 * The simulation.
 *
 * Deliberately free of any DOM/canvas reference: the whole game state advances
 * from (seed, taps, dt) alone, so it can be replayed, unit-tested and
 * fast-forwarded head-less in Node.
 *
 * Geometry
 * --------
 * The player orbits the centre at a fixed radius and can only reverse
 * direction. Rings close in from outside; each carries one or more gaps.
 *
 * Two properties make the game feel fair, and both are structural rather than
 * tuned by hand:
 *
 * 1. Rings are parameterised by *travel*, not by time. A ring's rotation,
 *    pulse and gap drift are all functions of how far it has moved inward, so
 *    its exact state at the moment it reaches the player's orbit is known the
 *    instant it spawns — no matter how the game speed changes in between.
 *
 * 2. Because of (1), the generator can place every gap inside the arc the
 *    player can actually reach from the previous gap. There is no such thing
 *    as an unwinnable ring; difficulty comes from narrower gaps, faster spin
 *    and tighter timing instead.
 */

import { RNG } from '../engine/rng.js';
import { TAU, wrap, angleDist, clamp, lerp } from '../engine/util.js';
import { TUNE, ZONES, difficultyAt, zoneIndexAt, lapAt } from './config.js';

export const EVT = {
  FLIP: 'flip',
  PASS: 'pass',
  PERFECT: 'perfect',
  NEAR: 'near',
  ORB: 'orb',
  POWERUP: 'powerup',
  COMBO_BREAK: 'comboBreak',
  SHIELD_BREAK: 'shieldBreak',
  HIT: 'hit',
  ZONE: 'zone',
};

const POWER_ORDER = ['shield', 'slow', 'double'];
const FORGIVENESS = 0.055;   // radians of "close enough" on a gap edge
const REACH_SAFETY = 0.72;   // fraction of the reachable arc the generator uses

let nextRingId = 1;

export class World {
  constructor(seed = 1) {
    this.rng = new RNG(seed);
    this.events = [];
    this.reset(seed);
  }

  reset(seed = (Math.random() * 0xffffffff) >>> 0) {
    this.seed = seed >>> 0;
    this.rng.seed(this.seed);

    this.time = 0;
    this.alive = true;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.energy = 0;
    this.orbsCollected = 0;
    this.perfects = 0;
    this.zone = 0;
    this.lap = 0;

    this.player = { angle: -Math.PI / 2, dir: 1, flipAt: -99 };

    this.rings = [];
    this.spawnCount = 0;
    this.ringsSincePower = 0;
    this.cursor = TUNE.playerOrbit + 0.40; // travel position of the last spawn
    this.lastTargetAngle = this.player.angle;
    this.lastTargetTravel = TUNE.playerOrbit;

    this.shield = false;
    this.shieldTimer = 0;
    this.slowTimer = 0;
    this.doubleTimer = 0;
    this.revivesUsed = 0;

    this.events.length = 0;
    this._topUpField();
    return this;
  }

  // ------------------------------------------------------------- getters ---

  get difficulty() {
    return difficultyAt(this.score);
  }

  get multiplier() {
    return clamp(1 + Math.floor(this.combo / TUNE.comboPerMultiplier), 1, TUNE.maxMultiplier);
  }

  /** How fast rings close in, including the lap bonus and slow-mo. */
  get speedScale() {
    const base = 1 + this.difficulty * 0.85 + Math.min(lapAt(this.score) * 0.06, 0.2);
    return this.slowTimer > 0 ? base * TUNE.slowFactor : base;
  }

  get playerSpeed() {
    return TUNE.playerAngularSpeed * (1 + this.difficulty * 0.22);
  }

  /** Radians of orbit the player can cover per unit of ring travel. */
  get angularBudgetPerUnit() {
    return this.playerSpeed / (TUNE.ringSpeed * this.speedScale);
  }

  get visualZone() {
    const next = this.nextRing();
    return next ? next.zone : zoneIndexAt(this.score);
  }

  nextRing() {
    let best = null;
    for (const r of this.rings) {
      if (r.state !== 'live' || r.travel < TUNE.playerOrbit) continue;
      if (!best || r.travel < best.travel) best = r;
    }
    return best;
  }

  emit(type, data) {
    this.events.push(data ? { type, ...data } : { type });
  }

  drainEvents(fn) {
    for (let i = 0; i < this.events.length; i++) fn(this.events[i]);
    this.events.length = 0;
  }

  // -------------------------------------------------------------- input ---

  flip() {
    if (!this.alive) return false;
    this.player.dir *= -1;
    this.player.flipAt = this.time;
    this.emit(EVT.FLIP, { dir: this.player.dir });
    return true;
  }

  // ------------------------------------------------- ring state helpers ---

  /** Pulse offset applied to a ring's radius at a given travel position. */
  static pulseAt(ring, travel) {
    if (!ring.pulseAmp) return 0;
    return Math.sin((ring.spawnTravel - travel) * ring.pulseFreq + ring.pulsePhase) * ring.pulseAmp;
  }

  static rotAt(ring, travel) {
    return ring.rot0 + ring.rotRate * (ring.spawnTravel - travel);
  }

  static gapCenterAt(ring, index, travel) {
    const g = ring.gaps[index];
    if (!ring.driftAmp) return g.c;
    const phase = (ring.spawnTravel - travel) * ring.driftFreq + ring.driftPhase + index;
    return g.c + Math.sin(phase) * ring.driftAmp;
  }

  /**
   * Travel position at which this ring's radius equals the player's orbit.
   * radius = travel + pulse(travel); two fixed-point steps are plenty because
   * |d(pulse)/d(travel)| stays well under 1.
   */
  static crossTravel(ring) {
    let t = TUNE.playerOrbit;
    for (let i = 0; i < 3; i++) t = TUNE.playerOrbit - World.pulseAt(ring, t);
    return t;
  }

  // ------------------------------------------------------------ spawning ---

  _spacing() {
    return lerp(TUNE.baseSpacing, TUNE.minSpacing, this.difficulty);
  }

  _makeRing(travel, zoneIndex, opts = {}) {
    const rng = this.rng;
    const zone = ZONES[zoneIndex];
    const d = this.difficulty;
    const gapCount = opts.gapCount ?? zone.gaps(rng, d);
    const half = Math.max(0.22, zone.gapHalf * lerp(1, 0.76, d) * (opts.halfScale ?? 1));

    const gaps = [];
    for (let i = 0; i < gapCount; i++) {
      gaps.push({ c: wrap((TAU / gapCount) * i + rng.range(-0.16, 0.16)), half });
    }

    let dirSign = rng.sign();
    if (zone.flags.alternate) dirSign = this.spawnCount % 2 === 0 ? 1 : -1;
    const rotPerSecond = rng.range(zone.rot[0], zone.rot[1]) * (0.85 + d * 0.45) * dirSign;

    const ring = {
      id: nextRingId++,
      spawnTravel: travel,
      travel,
      radius: travel,
      prevRadius: travel,
      rot0: rng.range(0, TAU),
      // Expressed per unit of travel so the ring's state at the orbit is fixed.
      rotRate: rotPerSecond / TUNE.ringSpeed,
      rot: 0,
      gaps,
      thickness: TUNE.ringThickness,
      orbs: [],
      zone: zoneIndex,
      state: 'live',
      ghost: !!zone.flags.ghost,
      pulseAmp: zone.flags.pulse ? 0.032 : 0,
      pulseFreq: rng.range(9, 15),
      pulsePhase: rng.range(0, TAU),
      driftAmp: zone.flags.drift ? rng.range(0.16, 0.30) : 0,
      driftFreq: rng.range(2.5, 4.5),
      driftPhase: rng.range(0, TAU),
      alpha: 0,
      hitFlash: 0,
      targetGap: 0,
      targetAngle: 0,
    };
    ring.rot = World.rotAt(ring, travel);

    this._populateOrbs(ring, opts);
    return ring;
  }

  _populateOrbs(ring, opts) {
    const rng = this.rng;
    this.ringsSincePower++;

    if (this.ringsSincePower >= TUNE.powerupEvery && this.spawnCount > 6 && !opts.noPower) {
      this.ringsSincePower = 0;
      const type = POWER_ORDER[Math.floor(this.spawnCount / TUNE.powerupEvery) % POWER_ORDER.length];
      ring.orbs.push({ gapIndex: rng.int(0, ring.gaps.length - 1), offset: 0, type, taken: false });
      return;
    }

    if (!rng.chance(TUNE.orbChance)) return;
    const gi = rng.int(0, ring.gaps.length - 1);
    // Off-centre, so collecting energy costs precision rather than being free.
    const offset = rng.range(-0.55, 0.55) * ring.gaps[gi].half;
    ring.orbs.push({ gapIndex: gi, offset, type: 'energy', taken: false });
  }

  /**
   * Rotate the ring so that one of its gaps lands on an angle the player can
   * still reach from where the previous ring left them.
   */
  _aimRing(ring) {
    const rng = this.rng;
    const gi = rng.int(0, ring.gaps.length - 1);
    const gapTravel = Math.max(0.05, ring.spawnTravel - this.lastTargetTravel);
    const budget = Math.min(Math.PI, gapTravel * this.angularBudgetPerUnit * REACH_SAFETY);

    // Ease the player in: the opening rings barely ask them to move.
    const warmup = clamp(this.spawnCount / 6, 0.25, 1);
    const magnitude = budget * rng.range(0.15, 1.0) * warmup;
    const target = wrap(this.lastTargetAngle + rng.sign() * magnitude);

    const tc = World.crossTravel(ring);
    const gapAtCross = World.gapCenterAt(ring, gi, tc);
    const spin = ring.rotRate * (ring.spawnTravel - tc);
    ring.rot0 = wrap(target - gapAtCross - spin);
    ring.rot = World.rotAt(ring, ring.travel);
    ring.targetGap = gi;
    ring.targetAngle = target;

    this.lastTargetAngle = target;
    this.lastTargetTravel = ring.spawnTravel;
    return ring;
  }

  _spawnAt(travel) {
    const zoneIndex = Math.floor(this.spawnCount / TUNE.zoneLength) % ZONES.length;
    const zone = ZONES[zoneIndex];

    const ring = this._aimRing(this._makeRing(travel, zoneIndex));
    this.rings.push(ring);
    this.spawnCount++;
    this.cursor = travel;

    // Twin zone: a second ring hard on the heels of the first.
    if (zone.flags.twin && this.spawnCount % 3 === 0) {
      const partnerTravel = travel + Math.max(0.16, this._spacing() * 0.42);
      const partner = this._aimRing(
        this._makeRing(partnerTravel, zoneIndex, { gapCount: 1, noPower: true }),
      );
      this.rings.push(partner);
      this.spawnCount++;
      this.cursor = partnerTravel;
    }
  }

  _topUpField() {
    let guard = 0;
    while (this.cursor <= TUNE.spawnRadius - this._spacing() && guard++ < 48) {
      this._spawnAt(this.cursor + this._spacing());
    }
  }

  // -------------------------------------------------------------- update ---

  update(dt) {
    if (!this.alive || dt <= 0) return;
    this.time += dt;

    if (this.shieldTimer > 0) this.shieldTimer = Math.max(0, this.shieldTimer - dt);
    if (this.slowTimer > 0) this.slowTimer = Math.max(0, this.slowTimer - dt);
    if (this.doubleTimer > 0) this.doubleTimer = Math.max(0, this.doubleTimer - dt);

    const pSpeed = this.playerSpeed;
    this.player.angle = wrap(this.player.angle + this.player.dir * pSpeed * dt);

    const step = TUNE.ringSpeed * this.speedScale * dt;

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const prevTravel = r.travel;
      r.prevRadius = r.radius;
      r.travel -= step;
      r.rot = World.rotAt(r, r.travel);
      r.radius = r.travel + World.pulseAt(r, r.travel);
      if (r.hitFlash > 0) r.hitFlash = Math.max(0, r.hitFlash - dt * 3);

      r.alpha = r.ghost
        ? clamp((0.88 - r.travel) / 0.15, 0, 1)
        : clamp((TUNE.spawnRadius + 0.08 - r.travel) / 0.18, 0, 1);

      if (r.state === 'live' && r.prevRadius > TUNE.playerOrbit && r.radius <= TUNE.playerOrbit) {
        this._resolveCrossing(r, prevTravel, dt, pSpeed);
        if (!this.alive) return;
      }

      if (r.travel < -TUNE.despawnRadius) this.rings.splice(i, 1);
    }

    this.cursor -= step;
    this.lastTargetTravel -= step;
    this._topUpField();
  }

  /**
   * Solve the exact instant the ring's radius met the orbit, rewind both the
   * ring and the player to that instant, then judge the pass.
   */
  _resolveCrossing(ring, prevTravel, dt, pSpeed) {
    const span = ring.prevRadius - ring.radius;
    const f = span > 1e-9 ? clamp((ring.prevRadius - TUNE.playerOrbit) / span, 0, 1) : 1;
    const back = (1 - f) * dt;

    const travelAt = lerp(prevTravel, ring.travel, f);
    const ringRot = World.rotAt(ring, travelAt);
    const pAngle = wrap(this.player.angle - this.player.dir * pSpeed * back);
    const rel = wrap(pAngle - ringRot);

    let bestDist = Infinity;
    let bestHalf = 1;
    for (let i = 0; i < ring.gaps.length; i++) {
      const d = angleDist(rel, World.gapCenterAt(ring, i, travelAt));
      if (d < bestDist) {
        bestDist = d;
        bestHalf = ring.gaps[i].half;
      }
    }

    if (bestDist > bestHalf + FORGIVENESS) {
      this._onCollision(ring, pAngle);
      return;
    }

    ring.state = 'passed';
    const gained = this.doubleTimer > 0 ? 2 : 1;
    this.score += gained;
    this.zone = zoneIndexAt(this.score);
    this.lap = lapAt(this.score);

    const precision = 1 - clamp(bestDist / bestHalf, 0, 1);
    const isPerfect = precision >= TUNE.perfectThreshold;

    let collected = 0;
    let powerTaken = null;
    const tol = (TUNE.playerRadius + TUNE.orbRadius) / TUNE.playerOrbit;
    for (const orb of ring.orbs) {
      if (orb.taken) continue;
      const oa = wrap(ringRot + World.gapCenterAt(ring, orb.gapIndex, travelAt) + orb.offset);
      if (angleDist(pAngle, oa) > tol) continue;
      orb.taken = true;
      if (orb.type === 'energy') {
        collected++;
        this.orbsCollected++;
        this.combo++;
        this.bestCombo = Math.max(this.bestCombo, this.combo);
        const gain = this.multiplier;
        this.energy += gain;
        this.emit(EVT.ORB, { angle: oa, gain, combo: this.combo, multiplier: this.multiplier });
      } else {
        powerTaken = orb.type;
        this._grantPower(orb.type);
        this.emit(EVT.POWERUP, { angle: oa, kind: orb.type });
      }
    }

    if (collected === 0 && this.combo > 0 && ring.orbs.some((o) => o.type === 'energy')) {
      this.combo = 0;
      this.emit(EVT.COMBO_BREAK);
    }

    if (isPerfect) {
      this.perfects++;
      this.energy += 1;
      this.emit(EVT.PERFECT, { angle: pAngle, precision });
    } else if (precision < 0.16) {
      this.emit(EVT.NEAR, { angle: pAngle });
    }

    this.emit(EVT.PASS, {
      angle: pAngle,
      ring,
      score: this.score,
      precision,
      perfect: isPerfect,
      collected,
      power: powerTaken,
    });

    const zoneNow = zoneIndexAt(this.score);
    if (zoneNow !== zoneIndexAt(Math.max(0, this.score - gained))) {
      this.emit(EVT.ZONE, { zone: zoneNow, lap: lapAt(this.score) });
    }
  }

  _grantPower(kind) {
    if (kind === 'shield') this.shield = true;
    else if (kind === 'slow') this.slowTimer = TUNE.slowDuration;
    else if (kind === 'double') this.doubleTimer = TUNE.doubleDuration;
  }

  _onCollision(ring, angle) {
    ring.state = 'broken';
    ring.hitFlash = 1;
    if (this.shieldTimer > 0) return;
    if (this.shield) {
      this.shield = false;
      this.shieldTimer = 0.85;
      this.emit(EVT.SHIELD_BREAK, { angle });
      return;
    }
    this.alive = false;
    this.emit(EVT.HIT, { angle, score: this.score, ring });
  }

  /**
   * Jump the run straight to a given score, rebuilding the field in the zone
   * that belongs to it. Used by QA and by the store-screenshot tool to reach a
   * late zone without playing there first.
   */
  jumpTo(score) {
    this.score = Math.max(0, Math.round(score));
    this.zone = zoneIndexAt(this.score);
    this.lap = lapAt(this.score);
    this.spawnCount = Math.floor(this.score / TUNE.zoneLength) * TUNE.zoneLength;
    this.rings.length = 0;
    this.cursor = TUNE.playerOrbit + 0.40;
    this.lastTargetAngle = this.player.angle;
    this.lastTargetTravel = TUNE.playerOrbit;
    this._topUpField();
    return this;
  }

  /** Second chance: clear the danger zone and hand back a brief invulnerability. */
  revive() {
    this.revivesUsed++;
    this.alive = true;
    this.combo = 0;
    this.shieldTimer = TUNE.reviveShield;
    this.rings = this.rings.filter((r) => r.travel > 0.95);
    this.cursor = this.rings.reduce((m, r) => Math.max(m, r.travel), 0.95);
    this.lastTargetAngle = this.player.angle;
    this.lastTargetTravel = TUNE.playerOrbit;
    this._topUpField();
    return this;
  }
}
