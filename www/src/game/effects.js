/**
 * PERFECT effects, one per zone.
 *
 * Each is a short recipe over the existing pooled effects system — no new
 * allocation paths, no shadowBlur, everything with a lifetime. They differ in
 * shape and rhythm so that landing a PERFECT in FROZEN feels different from
 * landing one in STORM, without any of them covering a ring, a gap or an orb:
 * the effects fire *behind* and *outward* from the player, never across the
 * approach.
 */

import { TAU } from '../engine/util.js';
import { TUNE } from './config.js';

/** The renderer supplies geometry; this only needs a few numbers from it. */
function at(r, angle, radiusUnits) {
  return r.orbitPoint(angle, radiusUnits);
}

const RECIPES = {
  /** FLOW — a soft ring that breathes outward. */
  pulse(fx, r, o) {
    fx.wave(o.x, o.y, r.unit * 0.02, r.unit * 0.34, { color: o.color, width: 3, life: 0.5 });
    fx.burst(o.x, o.y, 12, {
      color: [o.color, '#ffffff'], speed: 150, size: r.unit * 0.008, life: 0.55,
    });
  },

  /** VOLTAGE — a jagged arc that snaps outward along the orbit. */
  arc(fx, r, o) {
    for (let i = 0; i < 5; i++) {
      const a = o.angle + (i - 2) * 0.18;
      const p = at(r, a, TUNE.playerOrbit + 0.03 * i);
      fx.burst(p.x, p.y, 3, {
        color: [o.color, '#ffffff'], speed: 260, size: r.unit * 0.006, life: 0.22,
        shape: 'spark', angle: a + Math.PI / 2, spread: 0.7,
      });
    }
    fx.addFlash(0.10, o.color);
  },

  /** INFERNO — an outward blast of embers that fall away. */
  burst(fx, r, o) {
    fx.burst(o.x, o.y, 22, {
      color: [o.color, '#ffd166', '#ffffff'], speed: 300, size: r.unit * 0.010, life: 0.7,
      shape: 'spark', angle: o.outward, spread: 1.9, gravity: r.unit * 0.35, drag: 1.6,
    });
    fx.wave(o.x, o.y, r.unit * 0.02, r.unit * 0.22, { color: o.color, width: 5, life: 0.34 });
  },

  /** FROZEN — the impact splinters into shards. */
  shatter(fx, r, o) {
    fx.burst(o.x, o.y, 16, {
      color: ['#ffffff', o.color], speed: 220, size: r.unit * 0.013, life: 0.75,
      shape: 'shard', angle: o.outward, spread: 2.4, drag: 3.2,
    });
    fx.wave(o.x, o.y, r.unit * 0.03, r.unit * 0.16, { color: '#ffffff', width: 2, life: 0.28 });
  },

  /** DRIFT — space folds twice around the pass. */
  warp(fx, r, o) {
    for (let i = 0; i < 2; i++) {
      fx.wave(o.x, o.y, r.unit * (0.04 + i * 0.05), r.unit * (0.30 + i * 0.16), {
        color: o.color, width: 2.5 - i, life: 0.55 + i * 0.2,
      });
    }
    fx.burst(o.x, o.y, 10, {
      color: [o.color, o.accent], speed: 90, size: r.unit * 0.009, life: 0.8, drag: 0.8,
    });
  },

  /** GHOST — an echo of the player, left behind and fading. */
  echo(fx, r, o) {
    for (let i = 1; i <= 3; i++) {
      const p = at(r, o.angle - o.dir * 0.16 * i, TUNE.playerOrbit);
      fx.spawn({
        x: p.x, y: p.y, life: 0.28 + i * 0.16, size: r.unit * 0.028 * (1 - i * 0.16),
        color: o.color, drag: 6, glow: 0.5 - i * 0.1,
      });
    }
    fx.wave(o.x, o.y, r.unit * 0.02, r.unit * 0.26, { color: o.color, width: 2, life: 0.6 });
  },

  /** STORM — one hard strike, then the thunder. */
  lightning(fx, r, o) {
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const a = o.angle + (Math.random() - 0.5) * 0.5 * t;
      const p = at(r, a, TUNE.playerOrbit + 0.12 * t + 0.02);
      fx.burst(p.x, p.y, 2, {
        color: ['#ffffff', o.color], speed: 200, size: r.unit * 0.007, life: 0.18,
        shape: 'spark', angle: a, spread: 0.5,
      });
    }
    fx.addFlash(0.16, '#ffffff');
    fx.addShake(5);
  },

  /** VOID — almost nothing, and it lands harder for it. */
  void: (fx, r, o) => {
    fx.wave(o.x, o.y, r.unit * 0.01, r.unit * 0.46, { color: '#ffffff', width: 1.5, life: 0.7 });
    fx.burst(o.x, o.y, 6, { color: ['#ffffff'], speed: 70, size: r.unit * 0.006, life: 0.9, drag: 1 });
  },

  /** PULSAR — concentric ripples leaving on the beat. */
  ripple(fx, r, o) {
    // All three start together; the differing ranges and lifetimes mean they
    // are always at different radii, so the eye reads one travelling ripple.
    for (let i = 0; i < 3; i++) {
      fx.wave(o.x, o.y, r.unit * (0.02 + i * 0.07), r.unit * (0.20 + i * 0.14), {
        color: i === 1 ? o.accent : o.color,
        width: 3.5 - i * 0.8,
        life: 0.30 + i * 0.18,
      });
    }
    fx.burst(o.x, o.y, 8, {
      color: [o.color, o.accent], speed: 130, size: r.unit * 0.007, life: 0.5,
      shape: 'dot', angle: o.outward, spread: 1.4, drag: 2.8,
    });
  },

  /** SINGULARITY — the flourish falls inward instead of out. */
  collapse(fx, r, o) {
    // Spawned just outside the orbit and aimed at the core, so the debris
    // crosses the empty middle rather than the incoming rings.
    for (let i = 0; i < 7; i++) {
      const a = o.angle + (i - 3) * 0.11;
      const p = at(r, a, TUNE.playerOrbit + 0.05);
      fx.burst(p.x, p.y, 2, {
        color: [o.color, o.accent], speed: 210, size: r.unit * 0.008, life: 0.55,
        shape: 'spark', angle: a + Math.PI, spread: 0.26, drag: 0.9,
      });
    }
    // A wave that closes instead of opening.
    fx.wave(o.x, o.y, r.unit * 0.34, r.unit * 0.02, { color: o.color, width: 2.5, life: 0.5 });
    fx.addFlash(0.09, o.accent);
  },

  // ---- cosmetic overrides, available in every zone ----------------------

  ring(fx, r, o) {
    fx.wave(o.x, o.y, r.unit * 0.02, r.unit * 0.30, { color: o.color, width: 4, life: 0.42 });
  },

  starburst(fx, r, o) {
    for (let i = 0; i < 8; i++) {
      const a = o.angle + (TAU / 8) * i;
      fx.burst(o.x, o.y, 2, {
        color: [o.color, '#ffffff'], speed: 300, size: r.unit * 0.007, life: 0.4,
        shape: 'spark', angle: a, spread: 0.12,
      });
    }
  },

  shockwave(fx, r, o) {
    fx.wave(o.x, o.y, r.unit * 0.02, r.unit * 0.24, { color: '#ffffff', width: 5, life: 0.26 });
    fx.wave(o.x, o.y, r.unit * 0.02, r.unit * 0.40, { color: o.color, width: 2, life: 0.5 });
    fx.addShake(4);
  },

  bloom(fx, r, o) {
    for (let i = 0; i < 5; i++) {
      const a = o.outward + (i - 2) * 0.32;
      fx.burst(o.x, o.y, 3, {
        color: [o.color, o.accent], speed: 120, size: r.unit * 0.011, life: 0.85,
        shape: 'dot', angle: a, spread: 0.2, drag: 1.4,
      });
    }
  },

  novaburst(fx, r, o) {
    fx.burst(o.x, o.y, 18, {
      color: [o.color, '#ffffff'], speed: 340, size: r.unit * 0.009, life: 0.5,
      shape: 'spark', angle: o.outward, spread: TAU,
    });
    fx.wave(o.x, o.y, r.unit * 0.30, r.unit * 0.02, { color: '#ffffff', width: 3, life: 0.45 });
  },
};

export const EFFECT_IDS = Object.keys(RECIPES);

/**
 * Which PERFECT effect to play: the equipped effect cosmetic wins, then the
 * skin's own signature, then the zone's. Pure, so the rule is testable rather
 * than buried in an event handler.
 */
export function resolvePerfectEffect(equippedEffectId, skin, zone) {
  if (equippedEffectId && equippedEffectId !== 'zone') return equippedEffectId;
  if (skin && skin.effect && skin.effect !== 'zone') return skin.effect;
  return zone.fx.perfect;
}

/**
 * Play a PERFECT. `kind` is the zone's own effect unless a cosmetic overrides
 * it. Reduced-effects mode gets the cheapest recipe in every zone.
 */
export function playPerfect(fx, renderer, opts) {
  const kind = fx.reduced ? 'ring' : (RECIPES[opts.kind] ? opts.kind : 'pulse');
  const point = at(renderer, opts.angle, TUNE.playerOrbit);
  RECIPES[kind](fx, renderer, {
    kind,
    angle: opts.angle,
    dir: opts.dir || 1,
    // Outward from the core, so nothing sprays across the incoming rings.
    outward: opts.angle,
    color: opts.color,
    accent: opts.accent || '#ffffff',
    x: point.x,
    y: point.y,
  });
}

/** The one-off flourish when the run first reaches x8. */
export function playOverdrive(fx, renderer, color) {
  fx.wave(renderer.cx, renderer.cy, renderer.unit * 0.1, renderer.unit * 1.3, {
    color, width: 3, life: 0.7,
  });
  if (fx.reduced) return;
  for (let i = 0; i < 3; i++) {
    fx.wave(renderer.cx, renderer.cy, renderer.unit * (0.44 + i * 0.06), renderer.unit * 0.9, {
      color: i % 2 ? '#ffffff' : color, width: 2, life: 0.5 + i * 0.15,
    });
  }
  fx.addFlash(0.14, color);
}
