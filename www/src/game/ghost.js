/**
 * Personal-best ghost.
 *
 * A run is recorded as the player's orbit angle and score on a fixed time
 * grid — no wall-clock, no frame dependence — so replaying it is deterministic
 * and costs nothing at draw time. The ghost never touches collision; it is a
 * pace car, not an obstacle.
 *
 * The stored shape is deliberately transport-agnostic: swapping the local
 * personal best for a daily or a friend's ghost later means handing
 * `GhostPlayer` the same object from somewhere else.
 */

import { TUNE } from './config.js';
import { TAU } from '../engine/util.js';

const ANGLE_SCALE = 1024 / TAU; // ~0.35° of resolution, 4 characters of JSON

export class GhostRecorder {
  constructor(hz = TUNE.ghostHz, maxSamples = TUNE.ghostMaxSamples) {
    this.interval = 1 / hz;
    this.hz = hz;
    this.max = maxSamples;
    this.reset();
  }

  reset() {
    this.angles = [];
    this.scores = [];
    this.next = 0;
    this.full = false;
  }

  /** Call once per fixed simulation step, before or after update — consistently. */
  sample(world) {
    if (this.full) return;
    while (world.time >= this.next && this.angles.length < this.max) {
      this.angles.push(Math.round(world.player.angle * ANGLE_SCALE));
      this.scores.push(world.score);
      this.next += this.interval;
    }
    if (this.angles.length >= this.max) this.full = true;
  }

  /** Freeze what was recorded into a storable object, or null if too short. */
  toData(meta = {}) {
    if (this.angles.length < this.hz) return null; // under a second is not a run
    return {
      v: 1,
      hz: this.hz,
      score: meta.score | 0,
      seed: meta.seed >>> 0,
      mode: meta.mode || 'endless',
      angles: this.angles.slice(),
      scores: this.scores.slice(),
    };
  }
}

export class GhostPlayer {
  constructor(data) {
    this.data = isUsable(data) ? data : null;
  }

  get available() {
    return this.data !== null;
  }

  get score() {
    return this.data ? this.data.score : 0;
  }

  get duration() {
    return this.data ? (this.data.angles.length - 1) / this.data.hz : 0;
  }

  /** Orbit angle at `time`, linearly interpolated. null once the ghost is done. */
  angleAt(time) {
    const d = this.data;
    if (!d || time < 0) return null;
    const pos = time * d.hz;
    const i = Math.floor(pos);
    if (i >= d.angles.length - 1) return null;
    const a0 = d.angles[i] / ANGLE_SCALE;
    let a1 = d.angles[i + 1] / ANGLE_SCALE;
    // Take the short way round so a wrap does not sling the ghost backwards.
    let delta = a1 - a0;
    if (delta > Math.PI) delta -= TAU;
    if (delta < -Math.PI) delta += TAU;
    a1 = a0 + delta;
    return a0 + (a1 - a0) * (pos - i);
  }

  /** What the ghost had scored by `time` — used to say who is ahead. */
  scoreAt(time) {
    const d = this.data;
    if (!d || time < 0) return 0;
    const i = Math.min(d.scores.length - 1, Math.floor(time * d.hz));
    return d.scores[i] || 0;
  }
}

function isUsable(data) {
  return !!data
    && Array.isArray(data.angles)
    && Array.isArray(data.scores)
    && data.angles.length > 1
    && data.angles.length === data.scores.length
    && typeof data.hz === 'number'
    && data.hz > 0;
}

/** Keep the better of two ghosts, by score. */
export function bestGhost(current, candidate) {
  if (!isUsable(candidate)) return current;
  if (!isUsable(current)) return candidate;
  return candidate.score > current.score ? candidate : current;
}
