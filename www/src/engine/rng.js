/**
 * Deterministic PRNG (mulberry32). A seeded generator keeps runs reproducible,
 * which is what makes the simulation testable and daily challenges possible.
 */
export class RNG {
  constructor(seed = 1) {
    this.seed(seed);
  }

  seed(seed) {
    this.s = (seed >>> 0) || 1;
    return this;
  }

  /** Float in [0, 1). */
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [lo, hi). */
  range(lo, hi) {
    return lo + this.next() * (hi - lo);
  }

  /** Integer in [lo, hi]. */
  int(lo, hi) {
    return Math.floor(this.range(lo, hi + 1));
  }

  /** true with probability p. */
  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** -1 or 1. */
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
}

/** Stable 32-bit hash, used to turn a date string into a daily seed. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
