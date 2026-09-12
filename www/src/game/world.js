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
 * Three properties make the game feel fair, and all three are structural rather
 * than tuned by hand:
 *
 * 1. Rings are parameterised by *travel*, not by time. A ring's rotation,
 *    pulse and gap drift are all functions of how far it has moved inward, so
 *    its exact state at the moment it reaches the player's orbit is known the
 *    instant it spawns — no matter how the game speed changes in between.
 *
 * 2. Collision is continuous, not a single verdict at the orbit line. A ring
 *    touches the player for a whole band of travel (the player's radial extent
 *    plus the ring's thickness), and the player has to be clear of the wall for
 *    all of it. What you see touching you is what kills you.
 *
 * 3. Because of (1) and (2), the generator can compute, per ring, both the arc
 *    the player can still reach and the narrowest gap their swept body can fit
 *    through — and refuses to emit anything tighter. There is no unwinnable
 *    ring; difficulty comes from speed, rotation, gap count and the zone
 *    hazards instead.
 */

import { RNG } from '../engine/rng.js';
import { TAU, wrap, angleDist, clamp, lerp } from '../engine/util.js';
import {
  TUNE, ZONES, OVERDRIVE_AT, difficultyAt, difficultyById, zoneIndexAt, lapAt,
} from './config.js';

export const EVT = {
  FLIP: 'flip',
  PASS: 'pass',
  PERFECT: 'perfect',
  NEAR: 'near',
  ORB: 'orb',
  POWERUP: 'powerup',
  COMBO_BREAK: 'comboBreak',
  MULTIPLIER: 'multiplier',
  OVERDRIVE: 'overdrive',
  SHIELD_BREAK: 'shieldBreak',
  HIT: 'hit',
  ZONE: 'zone',
};

// Shields are scheduled separately; these two share the spare slot.
const SPARE_POWERS = ['slow', 'double'];

/** Half the radial span over which a ring is in contact with the player. */
export const BAND_HALF = TUNE.playerRadius + TUNE.ringThickness / 2;
/** The player's half-width along its own orbit, in radians. */
export const PLAYER_HALF = TUNE.playerRadius / TUNE.playerOrbit;
/** How close an orb has to pass to be collected, in radians. */
const ORB_TOLERANCE = (TUNE.playerRadius + TUNE.orbRadius) / TUNE.playerOrbit;

/**
 * Collision is sampled at a fixed resolution in *travel*, never per frame, so
 * the verdict is identical at 60 Hz, 120 Hz or in a head-less test.
 */
const BAND_SAMPLE = 0.0025;
const EDGE_FORGIVENESS = 0.02;

let nextRingId = 1;

export class World {
  constructor(seed = 1, opts = {}) {
    this.rng = new RNG(seed);
    this.events = [];
    this.reset(seed, opts);
  }

  reset(seed = (Math.random() * 0xffffffff) >>> 0, { practice = false, difficulty } = {}) {
    this.seed = seed >>> 0;
    /** Practice: a hit costs the chain, not the run. Never scored, never saved. */
    this.practice = !!practice;
    this.practiceHits = 0;
    /** Which preset's ramp this run climbs. Geometry is unaffected — see config. */
    this.difficultyId = difficultyById(difficulty).id;
    this.ramp = difficultyById(difficulty).ramp;
    this.rng.seed(this.seed);

    this.time = 0;
    this.alive = true;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.shards = 0;
    this.orbsCollected = 0;
    this.greedOrbs = 0;
    this.safeOrbs = 0;
    this.perfects = 0;
    this.chainSaves = 0;
    this.bestMultiplier = 1;
    this.bestChain = 0;
    this.overdriveRings = 0;
    // Zone reached before the player ever picked up a shield, for the
    // "bare handed" mission and achievement.
    this.shieldTaken = false;
    this.noShieldZone = 0;
    this.zone = 0;
    this.lap = 0;

    this.player = { angle: -Math.PI / 2, dir: 1, flipAt: -99 };

    this.rings = [];
    this.spawnCount = 0;
    this.ringsSincePower = 0;
    this.powerCursor = 0;
    this.cursor = TUNE.playerOrbit + 0.40;
    this.lastTargetAngle = this.player.angle;
    this.lastTargetTravel = TUNE.playerOrbit;
    // How far off the aimed angle the player could have been when they cleared
    // the previous ring — anywhere inside its gap.
    this.lastTargetHalf = 0;

    this.shieldCharges = 0;
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
    return difficultyAt(this.score, this.ramp);
  }

  /** x8: the run is in OVERDRIVE. Purely a state to feel, never a free pass. */
  get overdrive() {
    return this.multiplier >= OVERDRIVE_AT;
  }

  /** A shield is up while it still has charges left. */
  get shield() {
    return this.shieldCharges > 0;
  }

  get multiplier() {
    return clamp(1 + Math.floor(this.combo / TUNE.comboPerMultiplier), 1, TUNE.maxMultiplier);
  }

  /**
   * Slow-motion scales the player and the rings by the same amount, so it buys
   * the player real time to react without changing any of the geometry.
   */
  get timeScale() {
    return this.slowTimer > 0 ? TUNE.slowFactor : 1;
  }

  /** How fast rings close in, before slow-motion. */
  get speedScale() {
    return 1 + this.difficulty * 0.85 + Math.min(lapAt(this.score) * 0.06, 0.2);
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

  /** The ring the player has to deal with next. */
  nextRing() {
    let best = null;
    for (const r of this.rings) {
      if (r.state !== 'live' && r.state !== 'crossing') continue;
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
   * Travel position at which this ring's radius equals `target`.
   * radius = travel + pulse(travel); the pulse slope is bounded well under 1,
   * so a few fixed-point steps converge.
   */
  static travelAtRadius(ring, target) {
    let t = target;
    for (let i = 0; i < 4; i++) t = target - World.pulseAt(ring, t);
    return t;
  }

  static crossTravel(ring) {
    return World.travelAtRadius(ring, TUNE.playerOrbit);
  }

  // ------------------------------------------------------------ spawning ---

  _spacing() {
    return lerp(TUNE.baseSpacing, TUNE.minSpacing, this.difficulty);
  }

  /**
   * The narrowest gap this ring may have. While a ring crosses the player it
   * sweeps past them: the player keeps orbiting, the ring keeps rotating, and a
   * drifting gap keeps moving. The gap has to be wide enough to contain all of
   * that plus the player's own width, or the ring would be impossible to pass
   * however well it was timed.
   */
  _minGapHalf(ring) {
    const band = 2 * BAND_HALF;
    // A pulsing ring lingers in the band; its radius falls more slowly where
    // the pulse is rising.
    const stretch = 1 / Math.max(0.4, 1 - ring.pulseAmp * ring.pulseFreq);
    const span = band * stretch;
    const seconds = span / (TUNE.ringSpeed * this.speedScale);
    const sweep = this.playerSpeed * seconds
      + Math.abs(ring.rotRate) * span
      + ring.driftAmp * ring.driftFreq * span;
    return PLAYER_HALF + sweep / 2 + TUNE.gapMargin;
  }

  _makeRing(travel, zoneIndex, opts = {}) {
    const rng = this.rng;
    const zone = ZONES[zoneIndex];
    const d = this.difficulty;
    const gapCount = opts.gapCount ?? zone.gaps(rng, d);

    let dirSign = rng.sign();
    if (zone.flags.alternate) dirSign = this.spawnCount % 2 === 0 ? 1 : -1;
    const rotPerSecond = rng.range(zone.rot[0], zone.rot[1]) * (0.85 + d * 0.30) * dirSign;

    const ring = {
      id: nextRingId++,
      spawnTravel: travel,
      travel,
      radius: travel,
      prevRadius: travel,
      rot0: rng.range(0, TAU),
      // Per unit of travel, so the ring's state at the orbit is fixed at spawn.
      rotRate: rotPerSecond / TUNE.ringSpeed,
      rot: 0,
      gaps: [],
      thickness: TUNE.ringThickness,
      orbs: [],
      zone: zoneIndex,
      state: 'live',
      ghost: !!zone.flags.ghost,
      pulseAmp: zone.flags.pulse ? 0.018 : 0,
      pulseFreq: rng.range(6, 10),
      pulsePhase: rng.range(0, TAU),
      driftAmp: zone.flags.drift ? rng.range(0.16, 0.30) : 0,
      driftFreq: rng.range(2.5, 4.5),
      driftPhase: rng.range(0, TAU),
      alpha: 0,
      hitFlash: 0,
      targetGap: 0,
      targetAngle: 0,
      slack: 0,
      collected: 0,
      power: null,
      centreBest: Infinity,
      centreDist: 0,
      centreHalf: 1,
    };

    const wanted = zone.gapHalf * lerp(1, 0.76, d) * (opts.halfScale ?? 1);
    const floor = this._minGapHalf(ring);
    const half = Math.max(floor, wanted);
    // How far off-centre an orb may sit: whatever this gap has beyond the
    // required minimum, plus half the human margin. Reaching for it always
    // costs something, and never costs everything — even on a gap that is
    // already as tight as the generator will allow.
    ring.slack = (half - floor) + TUNE.gapMargin * 0.6;

    for (let i = 0; i < gapCount; i++) {
      ring.gaps.push({ c: wrap((TAU / gapCount) * i + rng.range(-0.16, 0.16)), half });
    }
    ring.rot = World.rotAt(ring, travel);

    this._populateOrbs(ring, opts);
    return ring;
  }

  _populateOrbs(ring, opts) {
    const rng = this.rng;
    const index = this.spawnCount;

    // Shields land on a fixed schedule so the player can count on them.
    const shieldDue = index >= TUNE.shieldFirst
      && (index - TUNE.shieldFirst) % TUNE.shieldEvery === 0;
    // Every orb goes in gap 0 and `_aimRing` moves it to whichever gap the ring
    // ends up aimed at. Only the aimed gap is guaranteed to be reachable, so an
    // orb anywhere else is not a choice — it is a tax on a ring the player read
    // correctly.
    if (shieldDue && !opts.noPower) {
      this.ringsSincePower = 0;
      ring.orbs.push({ gapIndex: 0, offset: 0, type: 'shield', taken: false });
      return;
    }

    this.ringsSincePower++;
    if (this.ringsSincePower >= TUNE.powerupEvery && index > 6 && !opts.noPower) {
      this.ringsSincePower = 0;
      const type = SPARE_POWERS[this.powerCursor++ % SPARE_POWERS.length];
      ring.orbs.push({ gapIndex: 0, offset: 0, type, taken: false });
      return;
    }

    if (!rng.chance(TUNE.orbChance)) return;
    // The heart of the game: an orb is either sitting near the safe line, or
    // out where taking it costs most of your margin. Draw from the two ends
    // rather than uniformly, so most rings pose an actual question instead of
    // a shrug. `risk` is a fraction of what this gap can spare, so a tight
    // ring can never offer a greed orb it has no room for.
    const risk = rng.chance(0.45) ? rng.range(0.55, 1) : rng.range(0, 0.35);
    const offset = rng.sign() * risk * TUNE.orbReach * ring.slack;
    ring.orbs.push({
      gapIndex: 0,
      offset,
      risk,
      greed: risk >= TUNE.greedThreshold,
      type: 'shard',
      taken: false,
    });
  }

  /**
   * Rotate the ring so that one of its gaps lands on an angle the player can
   * still reach from where the previous ring left them.
   */
  _aimRing(ring) {
    const rng = this.rng;
    const gi = rng.int(0, ring.gaps.length - 1);
    const gapTravel = Math.max(0.05, ring.spawnTravel - this.lastTargetTravel);
    const budget = Math.min(Math.PI, gapTravel * this.angularBudgetPerUnit * TUNE.reachSafety);

    // The player does not leave the previous ring at the angle it was aimed
    // at — they leave from wherever inside its gap they happened to pass. The
    // new gap has to be reachable from the far edge of that gap, not just from
    // its centre, or a run can contain a hole nobody could have got to.
    const spread = Math.max(0, this.lastTargetHalf - PLAYER_HALF);
    const room = Math.max(0, budget - spread);

    // Ease the player in: the opening rings barely ask them to move.
    const warmup = clamp(this.spawnCount / 6, 0.25, 1);
    const magnitude = room * rng.range(0.15, 1.0) * warmup;
    const target = wrap(this.lastTargetAngle + rng.sign() * magnitude);

    const tc = World.crossTravel(ring);
    const gapAtCross = World.gapCenterAt(ring, gi, tc);
    const spin = ring.rotRate * (ring.spawnTravel - tc);
    ring.rot0 = wrap(target - gapAtCross - spin);
    ring.rot = World.rotAt(ring, ring.travel);
    ring.targetGap = gi;
    ring.targetAngle = target;
    // The orbs follow the aim: see `_populateOrbs`.
    for (const orb of ring.orbs) orb.gapIndex = gi;

    this.lastTargetAngle = target;
    this.lastTargetTravel = ring.spawnTravel;
    this.lastTargetHalf = ring.gaps[gi].half;
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
      const partnerTravel = travel + Math.max(0.20, this._spacing() * 0.5);
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

    const ts = this.timeScale;
    const prevAngle = this.player.angle;
    const angleDelta = this.player.dir * this.playerSpeed * ts * dt;
    this.player.angle = wrap(prevAngle + angleDelta);

    const step = TUNE.ringSpeed * this.speedScale * ts * dt;
    const outer = TUNE.playerOrbit + BAND_HALF;
    const inner = TUNE.playerOrbit - BAND_HALF;

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

      if ((r.state === 'live' || r.state === 'crossing') && r.radius <= outer) {
        this._sweepBand(r, prevTravel, prevAngle, angleDelta, outer, inner);
        if (!this.alive) return;
        if (r.state === 'crossing' && r.radius < inner) this._clearRing(r);
      }

      if (r.travel < -TUNE.despawnRadius) this.rings.splice(i, 1);
    }

    this.cursor -= step;
    this.lastTargetTravel -= step;
    this._topUpField();
  }

  /**
   * Walk the part of this step during which the ring overlapped the player,
   * sampling at a fixed resolution in travel. The player's angle is linear in
   * time within a step, so interpolating it is exact — which is what makes the
   * result independent of the frame rate.
   */
  _sweepBand(ring, prevTravel, prevAngle, angleDelta, outer, inner) {
    const enter = World.travelAtRadius(ring, outer);
    const exit = World.travelAtRadius(ring, inner);
    const hi = Math.min(prevTravel, enter);
    const lo = Math.max(ring.travel, exit);
    if (hi < lo) return;

    ring.state = 'crossing';
    const stepSpan = prevTravel - ring.travel;
    const samples = Math.max(2, Math.ceil((hi - lo) / BAND_SAMPLE) + 1);

    for (let i = 0; i < samples; i++) {
      const t = hi - ((hi - lo) * i) / (samples - 1);
      const f = stepSpan > 1e-9 ? clamp((prevTravel - t) / stepSpan, 0, 1) : 1;
      const angle = wrap(prevAngle + angleDelta * f);
      const rot = World.rotAt(ring, t);
      const rel = wrap(angle - rot);

      let clearance = -Infinity;
      let nearestDist = Infinity;
      let nearestHalf = 1;
      for (let g = 0; g < ring.gaps.length; g++) {
        const dist = angleDist(rel, World.gapCenterAt(ring, g, t));
        const half = ring.gaps[g].half;
        if (half - PLAYER_HALF - dist > clearance) clearance = half - PLAYER_HALF - dist;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestHalf = half;
        }
      }

      if (clearance < -EDGE_FORGIVENESS) {
        this._onCollision(ring, angle);
        return;
      }

      // Remember how centred the player was at the closest approach; that is
      // what a PERFECT is measured against.
      const offCentre = Math.abs(t + World.pulseAt(ring, t) - TUNE.playerOrbit);
      if (offCentre < ring.centreBest) {
        ring.centreBest = offCentre;
        ring.centreDist = nearestDist;
        ring.centreHalf = nearestHalf;
      }

      this._collectOrbs(ring, t, rot, angle);
    }
  }

  _collectOrbs(ring, travel, rot, angle) {
    for (const orb of ring.orbs) {
      if (orb.taken) continue;
      const oa = wrap(rot + World.gapCenterAt(ring, orb.gapIndex, travel) + orb.offset);
      if (angleDist(angle, oa) > ORB_TOLERANCE) continue;
      orb.taken = true;
      if (orb.type === 'shard') {
        const before = this.multiplier;
        this.orbsCollected++;
        if (orb.greed) this.greedOrbs++;
        else this.safeOrbs++;
        // A greed orb is worth two links of chain as well as double the
        // shards — it is the only fast way to x8.
        this.combo += orb.greed ? 2 : 1;
        this.bestCombo = Math.max(this.bestCombo, this.combo);
        this.bestChain = this.bestCombo;
        const gain = this.multiplier * (orb.greed ? TUNE.greedBonus : 1);
        this.shards += gain;
        ring.collected++;
        this.bestMultiplier = Math.max(this.bestMultiplier, this.multiplier);
        this.emit(EVT.ORB, {
          angle: oa, gain, combo: this.combo, multiplier: this.multiplier, greed: !!orb.greed,
        });
        this._multiplierChanged(before);
      } else {
        ring.power = orb.type;
        if (orb.type === 'shield') this.shieldTaken = true;
        this._grantPower(orb.type);
        this.emit(EVT.POWERUP, { angle: oa, kind: orb.type });
      }
    }
  }

  /** The ring is fully behind the player: score it. */
  _clearRing(ring) {
    ring.state = 'passed';
    const gained = this.doubleTimer > 0 ? 2 : 1;
    this.score += gained;
    this.zone = zoneIndexAt(this.score);
    this.lap = lapAt(this.score);

    const precision = 1 - clamp(ring.centreDist / ring.centreHalf, 0, 1);
    const isPerfect = precision >= TUNE.perfectThreshold;
    const collected = ring.collected;
    const shardOrb = ring.orbs.find((o) => o.type === 'shard');
    const hadOrb = !!shardOrb;

    // Skipping an orb costs the chain — unless the orb you let go was a GREED
    // orb and you threaded the ring dead centre instead. That is what PERFECT
    // is *for*: it turns "that one was too far out" from a flat loss into a
    // decision you can still win. A safe orb is always reachable, so letting
    // one go is nobody's fault but yours and precision does not excuse it.
    const saved = isPerfect && collected === 0 && !!shardOrb && shardOrb.greed && this.combo > 0;
    if (collected === 0 && this.combo > 0 && hadOrb && !saved) {
      const before = this.multiplier;
      const lost = this.combo;
      this.combo = 0;
      this.emit(EVT.COMBO_BREAK, { lost, from: before, zone: this.zone });
      this._multiplierChanged(before);
    }

    if (isPerfect) {
      this.perfects++;
      this.shards += 1;
      this.chainSaves += saved ? 1 : 0;
      this.emit(EVT.PERFECT, { angle: this.player.angle, precision, saved });
    } else if (precision < 0.16) {
      this.emit(EVT.NEAR, { angle: this.player.angle });
    }

    this.emit(EVT.PASS, {
      angle: this.player.angle,
      ring,
      score: this.score,
      precision,
      perfect: isPerfect,
      collected,
      power: ring.power,
    });

    if (this.overdrive) this.overdriveRings++;
    if (!this.shieldTaken) this.noShieldZone = Math.max(this.noShieldZone, this.zone);

    const zoneNow = zoneIndexAt(this.score);
    if (zoneNow !== zoneIndexAt(Math.max(0, this.score - gained))) {
      this.emit(EVT.ZONE, { zone: zoneNow, lap: lapAt(this.score) });
    }
  }

  /** Announce a multiplier change once, and OVERDRIVE the first time it lands. */
  _multiplierChanged(before) {
    const now = this.multiplier;
    if (now === before) return;
    this.emit(EVT.MULTIPLIER, { value: now, previous: before, rising: now > before });
    if (now >= OVERDRIVE_AT && before < OVERDRIVE_AT) this.emit(EVT.OVERDRIVE, { value: now });
  }

  _grantPower(kind) {
    // A fresh shield always comes with its full complement of charges.
    if (kind === 'shield') this.shieldCharges = TUNE.shieldCharges;
    else if (kind === 'slow') this.slowTimer = TUNE.slowDuration;
    else if (kind === 'double') this.doubleTimer = TUNE.doubleDuration;
  }

  _onCollision(ring, angle) {
    ring.state = 'broken';
    ring.hitFlash = 1;
    if (this.shieldTimer > 0) return;
    if (this.shieldCharges > 0) {
      this.shieldCharges--;
      this.shieldTimer = 0.85;
      this.emit(EVT.SHIELD_BREAK, { angle, remaining: this.shieldCharges });
      return;
    }
    // Practice runs cost the chain and a beat of invulnerability instead of the
    // run. Everything else about them is the real game — same generator, same
    // collision, same rings — because a practice mode that plays differently
    // teaches the wrong timing.
    if (this.practice) {
      this.practiceHits++;
      const before = this.multiplier;
      this.combo = 0;
      this.shieldTimer = 1.1;
      this.emit(EVT.HIT, { angle, score: this.score, ring, practice: true });
      this._multiplierChanged(before);
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
    this.lastTargetHalf = 0;
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
    // If clearing the danger zone emptied the field, give the player the same
    // run-up they get at the start of a run rather than nothing to aim at.
    this.cursor = this.rings.length
      ? this.rings.reduce((m, r) => Math.max(m, r.travel), 0)
      : TUNE.playerOrbit + 0.40;
    this.lastTargetAngle = this.player.angle;
    this.lastTargetTravel = TUNE.playerOrbit;
    this.lastTargetHalf = 0;
    this._topUpField();
    return this;
  }
}
