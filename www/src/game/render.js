/**
 * Canvas renderer. Everything is drawn in "playfield units" (1.0 == half the
 * shorter screen side) so the composition is identical on every device.
 *
 * Glow is done with layered strokes rather than shadowBlur — it looks the same
 * and costs a fraction of the fill rate, which is what keeps older phones at 60.
 */

import { TAU, clamp, lerp, wrap } from '../engine/util.js';
import { FONT } from '../engine/fx.js';
import { World } from './world.js';
import {
  TUNE, ZONES, SKINS, OVERDRIVE_AT, zoneByIndex, skinById, trailById, POWERUPS,
} from './config.js';
import { adjustPalette, skinTones } from './palette.js';
import { SHIELD } from './config.js';

const STAR_COUNT = 130;
/** Half-width of the PERFECT window, as a fraction of a gap's half-width. */
const PERFECT_BAND = 1 - TUNE.perfectThreshold;
const TRAIL_LEN = 26;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function mixInto(cur, target, t) {
  cur[0] = lerp(cur[0], target[0], t);
  cur[1] = lerp(cur[1], target[1], t);
  cur[2] = lerp(cur[2], target[2], t);
}

const PALETTE_KEYS = ['bg0', 'bg1', 'ring', 'ringDim', 'accent', 'orb', 'grid'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.cx = 0;
    this.cy = 0;
    this.unit = 1;
    this.reduced = false;
    this.colorSafe = false;

    this.pal = {};
    this._targetRgb = {};
    this._targetHex = adjustPalette(ZONES[0].palette, SKINS[0]);
    this._paletteKey = '';
    for (const k of PALETTE_KEYS) {
      this._targetRgb[k] = hexToRgb(this._targetHex[k]);
      this.pal[k] = this._targetRgb[k].slice();
    }

    this.stars = [];
    this._moteBuckets = Array.from({ length: 6 }, () => []);
    this._gapScratch = Array.from({ length: 8 }, () => ({ c: 0, half: 0 }));
    this._haloCache = new Map();
    this._toneCache = new Map();
    this.trail = [];
    this._skyGradient = null;
    this._skyKey = '';
    this._vignette = null;
    // 0..1 ramp driven by the multiplier: everything glows a little harder as
    // the chain grows, and peaks at OVERDRIVE.
    this.heat = 0;
    this.overdrive = 0;
    this.zoneFx = ZONES[0].fx;
    this.stormNext = 1.4;
    this.stormFlash = 0;
    this.clock = 0;
    this.corePulse = 0;
    this.coreSpin = 0;
    this.skyRot = 0;
    this.zoneFlash = 0;
    this.resize();
  }

  setReduced(on) {
    this.reduced = !!on;
  }

  /**
   * Colour-safe mode does not try to simulate a colour-vision deficiency and
   * remap hues — that guesses at a deficiency it cannot know. It adds the thing
   * that helps whatever the deficiency is: a hard dark edge on every pickup and
   * a brighter core on every ring, so the separation survives without hue.
   */
  setColorSafe(on) {
    this.colorSafe = !!on;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || window.innerWidth);
    const cssH = Math.max(1, rect.height || window.innerHeight);
    // Cap the device pixel ratio: beyond ~2.2 the extra pixels are invisible
    // on a phone but cost real frame time.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.25);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.w = cssW;
    this.h = cssH;
    this.cx = cssW / 2;
    this.cy = cssH / 2;
    // viewScale is the whole camera: raise it and the field comes closer,
    // because every world unit is drawn larger while none of them changes.
    this.unit = (Math.min(cssW, cssH) / 2) * TUNE.viewScale;
    this._skyGradient = null;
    this._skyKey = '';
    this._vignette = null;
    this._vignetteDark = -1;
    this._haloCache.clear();
    this._buildStars();
  }

  _buildStars() {
    this.stars.length = 0;
    const reach = Math.hypot(this.w, this.h) / 2;
    for (let i = 0; i < STAR_COUNT; i++) {
      const depth = 0.25 + Math.random() * 0.75;
      this.stars.push({
        a: Math.random() * TAU,
        r: (0.15 + Math.random() * 0.95) * reach,
        depth,
        size: 0.4 + depth * 1.7,
        tw: Math.random() * TAU,
      });
    }
  }

  onPass(strength = 1) {
    this.corePulse = Math.min(1.6, this.corePulse + 0.5 * strength);
  }

  onZone() {
    this.zoneFlash = 1;
  }

  resetRun() {
    this.trail.length = 0;
    this.corePulse = 0;
    this.zoneFlash = 0;
  }

  /**
   * Blend the live palette toward the zone the player is about to enter,
   * after nudging that zone's hues clear of the equipped skin.
   */
  _mixPalette(zoneIndex, skinId, dt) {
    const key = `${zoneIndex}|${skinId}`;
    if (key !== this._paletteKey) {
      this._paletteKey = key;
      this._targetHex = adjustPalette(ZONES[zoneIndex % ZONES.length].palette, skinById(skinId));
      // Parse once per zone change, not seven times per frame.
      for (const k of PALETTE_KEYS) this._targetRgb[k] = hexToRgb(this._targetHex[k]);
    }
    const t = 1 - Math.exp(-3.2 * dt);
    for (const k of PALETTE_KEYS) mixInto(this.pal[k], this._targetRgb[k], t);
  }

  /** The shield's colour is fixed by design — see SHIELD in config.js. */
  get shieldColor() {
    return SHIELD.core;
  }

  /** The live palette as hex strings — for anything drawing outside the game. */
  get paletteHex() {
    return this._targetHex;
  }

  // ---------------------------------------------------------------- draw ---

  draw(world, opts) {
    const { fx, dt, skinId, trailId = 'comet', intensity = 1 } = opts;
    const ctx = this.ctx;
    const zone = zoneByIndex(world.visualZone);
    this.zoneFx = zone.fx;
    this.clock += dt;
    this.frameDt = dt;

    // Multiplier ramp. Damped, never instant, so it reads as the run heating
    // up rather than as a light switch.
    const target = (world.multiplier - 1) / (OVERDRIVE_AT - 1);
    this.heat += (target - this.heat) * (1 - Math.exp(-4 * dt));
    const odTarget = world.overdrive ? 1 : 0;
    this.overdrive += (odTarget - this.overdrive) * (1 - Math.exp(-3.5 * dt));

    this.corePulse = Math.max(0, this.corePulse - this.corePulse * 5 * dt - 0.2 * dt);
    this.zoneFlash = Math.max(0, this.zoneFlash - dt * 1.6);
    this.coreSpin += dt * (0.25 + this.corePulse * 0.8);
    this.skyRot += dt * (this.reduced ? 0.004 : 0.012) * (1 + world.speedScale * 0.35);
    this._mixPalette(world.visualZone, skinId, dt);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(fx.shakeX, fx.shakeY);

    this._drawSky(ctx, intensity);
    this._drawGrid(ctx);
    this._drawCore(ctx, world);
    this._drawOrbitGuide(ctx);
    this._drawRings(ctx, world);
    this._drawPlayer(ctx, world, skinById(skinId), trailById(trailId));
    fx.draw(ctx);
    ctx.restore();

    this._drawOverlays(ctx, fx);
  }

  _drawSky(ctx, intensity) {
    const p = this.pal;
    // The background is a full-screen gradient fill, the single most expensive
    // thing on the frame. Rebuild the gradient object only when the palette has
    // actually moved a visible amount, and keep the starfield down to one
    // fillStyle for the whole loop.
    const key = `${p.bg0[0] | 0},${p.bg0[1] | 0},${p.bg0[2] | 0},${p.bg1[0] | 0},${p.bg1[1] | 0},${p.bg1[2] | 0}`;
    if (key !== this._skyKey || !this._skyGradient) {
      this._skyKey = key;
      const g = ctx.createRadialGradient(
        this.cx, this.cy, this.unit * 0.05,
        this.cx, this.cy, Math.hypot(this.w, this.h) * 0.62,
      );
      g.addColorStop(0, rgba(p.bg1, 1));
      g.addColorStop(0.55, rgba(p.bg0, 1));
      g.addColorStop(1, `rgb(${(p.bg0[0] * 0.45) | 0},${(p.bg0[1] * 0.45) | 0},${(p.bg0[2] * 0.45) | 0})`);
      this._skyGradient = g;
    }
    ctx.fillStyle = this._skyGradient;
    ctx.fillRect(0, 0, this.w, this.h);

    this._drawMotes(ctx, intensity);
    this._drawSkyOverlay(ctx, this.frameDt);
  }

  /**
   * The ambient layer. Same star pool in every zone — only the motion, shape
   * and brightness change, so a new atmosphere costs no extra allocation.
   */
  _drawMotes(ctx, intensity) {
    const style = this.zoneFx.motes;
    if (style === 'none') return;
    const t = this.clock;

    // Bucket by brightness and emit one path per bucket: six fills instead of
    // a hundred and thirty, which is what a software rasteriser actually feels.
    const buckets = this._moteBuckets;
    for (const bucket of buckets) bucket.length = 0;

    for (const s of this.stars) {
      let a = s.a + this.skyRot * s.depth;
      let radius = s.r;
      let size = s.size;
      let alpha = 0.10 + 0.30 * s.depth;
      let tall = 1;

      switch (style) {
        case 'spark': {
          // VOLTAGE: hard on/off flicker instead of a gentle twinkle.
          const f = Math.sin(t * 11 + s.tw * 7);
          alpha *= f > 0.72 ? 2.4 : 0.35;
          break;
        }
        case 'ember':
          // INFERNO: embers rise away from the core and fade as they go.
          radius += ((t * 26 * s.depth) + s.tw * 90) % 220;
          alpha *= Math.max(0, 1 - ((radius - s.r) / 220)) * 1.4;
          size *= 1.2;
          break;
        case 'frost':
          // FROZEN: still, cold flecks that barely breathe.
          alpha *= 0.55 + 0.45 * Math.sin(t * 1.6 + s.tw);
          size *= 0.85;
          break;
        case 'wisp':
          // GHOST: slow lateral smear.
          a += Math.sin(t * 0.7 + s.tw) * 0.09;
          alpha *= 0.5 + 0.5 * Math.sin(t * 1.1 + s.tw * 3);
          size *= 1.6;
          tall = 2.4;
          break;
        case 'pulse': {
          // PULSAR: brightness travels outward as a band, on the beat.
          const band = Math.sin(t * 3.4 - s.r * 0.022 + s.tw * 0.4);
          alpha *= 0.45 + 1.9 * Math.max(0, band) ** 3;
          size *= 1.1;
          break;
        }
        case 'fall':
          // SINGULARITY: matter drifting in, brighter the closer it gets.
          radius = s.r - ((t * 54 * s.depth + s.tw * 140) % 300);
          if (radius < 0) radius += 300;
          alpha *= 0.5 + 0.9 * (1 - radius / (s.r || 1));
          size *= 0.9;
          tall = 1.8;
          break;
        case 'rain':
          // STORM: streaks driven inward, fast.
          radius = s.r - ((t * 320 * s.depth + s.tw * 200) % 360);
          if (radius < 0) radius += 360;
          size *= 0.8;
          alpha *= 1.3;
          tall = 4;
          break;
        default:
          alpha *= 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.skyRot * 9 + s.tw));
          break;
      }

      alpha = Math.min(0.85, alpha * intensity);
      if (alpha <= 0.02) continue;
      const bucket = buckets[Math.min(buckets.length - 1, (alpha * buckets.length) | 0)];
      bucket.push(
        this.cx + Math.cos(a) * radius,
        this.cy + Math.sin(a) * radius,
        size,
        size * tall,
      );
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba(this.pal.accent, 1);
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      if (!bucket.length) continue;
      ctx.globalAlpha = ((b + 0.5) / buckets.length) * 0.85;
      for (let i = 0; i < bucket.length; i += 4) {
        ctx.fillRect(bucket[i], bucket[i + 1], bucket[i + 2], bucket[i + 3]);
      }
    }
    ctx.restore();
  }

  /** One extra pass per zone, at most. Never over the play area's mid-band. */
  _drawSkyOverlay(ctx, dt) {
    const style = this.zoneFx.sky;
    // GHOST and VOID want the whole frame pulled down. That is the vignette's
    // job — folding it in there costs nothing instead of a second full-screen
    // fill every frame.
    this.zoneDark = style === 'void' ? 0.22
      : style === 'event' ? 0.16
      : style === 'ghost' ? 0.12
      : 0;
    if (this.reduced || style === 'calm') return;
    const t = this.clock;

    if (style === 'storm') {
      // Lightning: a brief wash across the whole frame, well under the
      // brightness of a ring so nothing is ever hidden behind it.
      this.stormNext -= dt;
      if (this.stormNext <= 0) {
        this.stormFlash = 0.13;
        this.stormNext = 1.1 + (Math.sin(t * 7.3) * 0.5 + 0.5) * 2.2;
      }
      if (this.stormFlash > 0) {
        this.stormFlash = Math.max(0, this.stormFlash - dt);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = this.stormFlash * 0.55;
        ctx.fillStyle = rgba(this.pal.ring, 1);
        ctx.fillRect(0, 0, this.w, this.h);
        ctx.restore();
      }
      return;
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (style === 'volt') {
      // A scanline that jitters down the screen.
      const y = ((t * 140) % (this.h + 120)) - 60;
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = rgba(this.pal.ring, 1);
      ctx.fillRect(0, y, this.w, 2);
    } else if (style === 'heat') {
      ctx.globalAlpha = 0.05 + 0.03 * Math.sin(t * 2.1);
      ctx.fillStyle = rgba(this.pal.ring, 1);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.unit * (0.9 + 0.08 * Math.sin(t * 1.7)), 0, TAU);
      ctx.fill();
    } else if (style === 'glass') {
      // Faint facets, drawn outside the play area only.
      ctx.globalAlpha = 0.10;
      ctx.strokeStyle = rgba(this.pal.ring, 1);
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const a = t * 0.05 + (TAU / 6) * i;
        ctx.beginPath();
        ctx.moveTo(this.cx + Math.cos(a) * this.unit * 1.05, this.cy + Math.sin(a) * this.unit * 1.05);
        ctx.lineTo(this.cx + Math.cos(a + 0.5) * this.unit * 1.9, this.cy + Math.sin(a + 0.5) * this.unit * 1.9);
        ctx.stroke();
      }
    } else if (style === 'pulse') {
      // PULSAR: a beacon sweeping outward, never inside the play area.
      const phase = (t * 0.55) % 1;
      ctx.globalAlpha = 0.11 * (1 - phase);
      ctx.strokeStyle = rgba(this.pal.ring, 1);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.unit * (1.08 + phase * 1.1), 0, TAU);
      ctx.stroke();
    } else if (style === 'event') {
      // SINGULARITY: the horizon itself — one bright rim outside the rings,
      // breathing. The darkening is folded into the vignette above.
      ctx.globalAlpha = 0.13;
      ctx.strokeStyle = rgba(this.pal.accent, 1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.unit * (1.12 + 0.035 * Math.sin(t * 1.9)), 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.05;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.unit * (1.2 + 0.05 * Math.sin(t * 1.9 + 0.6)), 0, TAU);
      ctx.stroke();
    } else if (style === 'warp') {
      ctx.globalAlpha = 0.06;
      ctx.strokeStyle = rgba(this.pal.accent, 1);
      ctx.lineWidth = 1.5;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.ellipse(
          this.cx, this.cy,
          this.unit * (0.95 + i * 0.22) * (1 + 0.05 * Math.sin(t * 1.3 + i)),
          this.unit * (0.95 + i * 0.22) * (1 - 0.05 * Math.sin(t * 1.3 + i)),
          t * 0.12, 0, TAU,
        );
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawGrid(ctx) {
    if (this.reduced) return;
    const p = this.pal;
    ctx.save();
    ctx.lineWidth = 1;
    // Dashed and very faint, so the static grid is never mistaken for a ring.
    ctx.setLineDash([this.unit * 0.02, this.unit * 0.03]);
    for (let i = 1; i <= 4; i++) {
      const r = this.unit * (0.42 + i * 0.26);
      ctx.strokeStyle = rgba(p.grid, 0.11);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, r, 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Slow radial rays: cheap, and they sell the sense of rotation.
    const rays = 20;
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = rgba(p.grid, 1);
    for (let i = 0; i < rays; i++) {
      const a = this.skyRot * 0.6 + (TAU / rays) * i;
      ctx.beginPath();
      ctx.moveTo(this.cx + Math.cos(a) * this.unit * 0.34, this.cy + Math.sin(a) * this.unit * 0.34);
      ctx.lineTo(this.cx + Math.cos(a) * this.unit * 1.6, this.cy + Math.sin(a) * this.unit * 1.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawCore(ctx, world) {
    const p = this.pal;
    // The core is the star you orbit, not a character. It used to be drawn
    // larger and brighter than the player, which made the eye read the wrong
    // object as "me". It is a landmark now: smaller, dimmer, still the anchor.
    const base = this.unit * 0.052;
    const pulse = 1 + this.corePulse * 0.28 + Math.sin(this.coreSpin * 2.2) * 0.035;
    const r = base * pulse;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(this.cx, this.cy, r * 0.2, this.cx, this.cy, r * 5.8);
    halo.addColorStop(0, rgba(p.ring, 0.42));
    halo.addColorStop(0.35, rgba(p.ring, 0.12));
    halo.addColorStop(1, rgba(p.ring, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, r * 5.8, 0, TAU);
    ctx.fill();
    ctx.restore();

    const body = ctx.createRadialGradient(
      this.cx - r * 0.3, this.cy - r * 0.35, r * 0.1,
      this.cx, this.cy, r,
    );
    body.addColorStop(0, rgba(p.accent, 0.9));
    body.addColorStop(0.6, rgba(p.ring, 0.78));
    body.addColorStop(1, rgba(p.ringDim, 0.68));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, r, 0, TAU);
    ctx.fill();

    // Three orbiting slivers give the core a mechanical, alive quality.
    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.rotate(this.coreSpin);
    ctx.strokeStyle = rgba(p.accent, 0.5);
    ctx.lineWidth = Math.max(1, this.unit * 0.006);
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.45, (TAU / 3) * i, (TAU / 3) * i + 0.9);
      ctx.stroke();
    }
    ctx.restore();

    if (world.doubleTimer > 0) {
      ctx.save();
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(world.time * 12);
      ctx.strokeStyle = POWERUPS.double.color;
      ctx.lineWidth = Math.max(1.5, this.unit * 0.008);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, r * 1.9, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawOrbitGuide(ctx) {
    const r = TUNE.playerOrbit * this.unit;
    ctx.save();
    ctx.setLineDash([this.unit * 0.012, this.unit * 0.022]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = rgba(this.pal.grid, 0.55);
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, r, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  _drawRings(ctx, world) {
    const p = this.pal;
    const u = this.unit;
    const rings = world.rings;

    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      const radius = ring.radius * u;
      if (radius < u * 0.02) continue;

      let alpha = ring.alpha;
      if (ring.travel < TUNE.playerOrbit) {
        alpha *= clamp(ring.travel / TUNE.playerOrbit, 0, 1) * 0.85;
      }
      if (alpha <= 0.01) continue;

      const thick = Math.max(2, ring.thickness * u);
      const rot = ring.rot;

      // Solid arcs are the complement of the gaps. Rings carry at most three
      // gaps, so this fills a reused buffer and insertion-sorts it in place
      // rather than allocating an array and a comparator every frame.
      const gaps = this._gapScratch;
      const gapCount = ring.gaps.length;
      for (let g = 0; g < gapCount; g++) {
        const c = wrap(World.gapCenterAt(ring, g, ring.travel));
        const half = ring.gaps[g].half;
        let i = g - 1;
        while (i >= 0 && gaps[i].c > c) {
          gaps[i + 1].c = gaps[i].c;
          gaps[i + 1].half = gaps[i].half;
          i--;
        }
        gaps[i + 1].c = c;
        gaps[i + 1].half = half;
      }

      const flash = ring.hitFlash;
      const bright = flash > 0
        ? [lerp(p.ring[0], 255, flash), lerp(p.ring[1], 255, flash), lerp(p.ring[2], 255, flash)]
        : p.ring;

      ctx.lineCap = 'round';
      for (let g = 0; g < gapCount; g++) {
        const from = gaps[g].c + gaps[g].half;
        const next = gaps[(g + 1) % gapCount];
        let to = next.c - next.half;
        if (to < from) to += TAU;
        if (to - from < 0.02) continue;

        const a0 = rot + from;
        const a1 = rot + to;

        if (!this.reduced) {
          // The soft casing around each ring. This is what turns a bright line
          // into a tube with depth, and it is the widest stroke on the frame —
          // so it is also the one place where a wider ring costs real fill
          // time. 2.4x is where it still reads as a tube on a phone.
          ctx.strokeStyle = rgba(p.ringDim, alpha * 0.44);
          ctx.lineWidth = thick * 2.4;
          ctx.beginPath();
          ctx.arc(this.cx, this.cy, radius, a0, a1);
          ctx.stroke();
        }

        ctx.strokeStyle = rgba(bright, alpha * 0.95);
        ctx.lineWidth = thick;
        ctx.beginPath();
        ctx.arc(this.cx, this.cy, radius, a0, a1);
        ctx.stroke();

        ctx.strokeStyle = rgba([255, 255, 255], alpha * 0.5);
        ctx.lineWidth = Math.max(1, thick * 0.28);
        ctx.beginPath();
        ctx.arc(this.cx, this.cy, radius, a0, a1);
        ctx.stroke();
      }

      this._drawPerfectBands(ctx, ring, radius, thick, rot, alpha);
      this._drawOrbs(ctx, ring, radius, alpha, world);
    }
  }

  /**
   * The PERFECT window, drawn inside the gap it belongs to.
   *
   * PERFECT is the only rule in the game a player cannot deduce from watching
   * the screen, so it is drawn: a bar across the middle of each opening and a
   * tick at dead centre. Pass inside the bar and the ring scores PERFECT. The
   * marks fade in as the ring closes so the far field stays clean, and they sit
   * in empty space, so they never hide a wall or an orb.
   */
  _drawPerfectBands(ctx, ring, radius, thick, rot, alpha) {
    // Only while the ring is still coming at you and still live. Once it is
    // behind you or broken, the question is answered and a mark you can no
    // longer act on is just clutter.
    if (ring.state !== 'live' && ring.state !== 'crossing') return;
    if (ring.travel < TUNE.playerOrbit * 0.92) return;
    const near = clamp((1.02 - ring.travel) / 0.42, 0, 1);
    if (near <= 0.02) return;
    const gaps = this._gapScratch;
    const a = alpha * near;

    // A filled window across the opening, with a bright line down its middle.
    // A filled area reads as "aim here" at a glance where three loose ticks read
    // as debris, and it needs no colour of its own — it lives in empty space, so
    // white at low alpha cannot be mistaken for a wall or an orb.
    const inner = radius - thick * 1.5;
    const outer = radius + thick * 1.5;

    ctx.lineCap = 'butt';
    for (let g = 0; g < ring.gaps.length; g++) {
      const band = gaps[g].half * PERFECT_BAND;
      const c = rot + gaps[g].c;

      ctx.fillStyle = rgba([255, 255, 255], a * 0.16);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, outer, c - band, c + band);
      ctx.arc(this.cx, this.cy, inner, c + band, c - band, true);
      ctx.closePath();
      ctx.fill();

      const cos = Math.cos(c);
      const sin = Math.sin(c);
      ctx.strokeStyle = rgba([255, 255, 255], a);
      ctx.lineWidth = Math.max(1.2, thick * 0.32);
      ctx.beginPath();
      ctx.moveTo(this.cx + cos * inner, this.cy + sin * inner);
      ctx.lineTo(this.cx + cos * outer, this.cy + sin * outer);
      ctx.stroke();
    }
    ctx.lineCap = 'round';
  }

  _drawOrbs(ctx, ring, radius, alpha, world) {
    if (!ring.orbs.length) return;
    const u = this.unit;
    for (const orb of ring.orbs) {
      if (orb.taken) continue;
      const a = ring.rot + World.gapCenterAt(ring, orb.gapIndex, ring.travel) + orb.offset;
      const x = this.cx + Math.cos(a) * radius;
      const y = this.cy + Math.sin(a) * radius;
      const isPower = orb.type !== 'shard';
      const color = isPower
        ? (orb.type === 'shield' ? this.shieldColor : POWERUPS[orb.type].color)
        : `rgb(${this.pal.orb.join(',')})`;
      const r = (isPower ? TUNE.orbRadius * 1.5 : TUNE.orbRadius) * u;
      const bob = 1 + Math.sin(world.time * 7 + ring.id) * 0.10;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * 0.55;
      ctx.translate(x, y);
      ctx.fillStyle = this._orbHalo(ctx, color, r * 3.1);
      ctx.beginPath();
      ctx.arc(0, 0, r * 3.1, 0, TAU);
      ctx.fill();
      ctx.restore();

      // Every pickup has its own silhouette as well as its own colour, so the
      // four of them can be told apart with no colour vision at all: a shard is
      // a disc, a shield a hexagon, slow-mo a square, double-score a diamond.
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, y);
      ctx.rotate(a + Math.PI / 2);
      const size = r * bob;

      if (this.colorSafe) {
        // A dark ink line under every pickup: when hues collapse, the edge is
        // what separates an orb from the ring it is sitting on.
        ctx.strokeStyle = 'rgba(4,7,14,0.95)';
        ctx.lineWidth = Math.max(2, size * 0.42);
        this._pickupPath(ctx, orb.type, size);
        ctx.stroke();
      }

      ctx.fillStyle = color;
      this._pickupPath(ctx, orb.type, size);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(-size * 0.22, -size * 0.26, size * 0.32, 0, TAU);
      ctx.fill();
      ctx.restore();

      if (isPower) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = Math.max(1.2, r * 0.16);
        ctx.beginPath();
        ctx.arc(x, y, r * 1.55, world.time * 3, world.time * 3 + 4.4);
        ctx.stroke();
        ctx.fillStyle = 'rgba(10,12,20,0.92)';
        ctx.font = `800 ${Math.round(r * 1.05)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(orb.type === 'shield' ? 'S' : orb.type === 'slow' ? '~' : '2', x, y + r * 0.04);
        ctx.restore();
      }
    }
  }

  /**
   * Orb haloes are the same gradient over and over, so build each one once at
   * the origin and move the canvas to it instead of rebuilding per orb, per
   * frame.
   */
  _orbHalo(ctx, color, radius) {
    const key = `${color}|${Math.round(radius)}`;
    let halo = this._haloCache.get(key);
    if (!halo) {
      halo = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      halo.addColorStop(0, color);
      halo.addColorStop(0.28, color);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      if (this._haloCache.size > 24) this._haloCache.clear();
      this._haloCache.set(key, halo);
    }
    return halo;
  }

  /** `skinTones` is pure and cheap, but it is per-frame work for no reason. */
  _skinTones(skin) {
    let tones = this._toneCache.get(skin.id);
    if (!tones) {
      tones = skinTones(skin);
      this._toneCache.set(skin.id, tones);
    }
    return tones;
  }

  _drawPlayer(ctx, world, skin, trail) {
    const u = this.unit;
    const orbit = TUNE.playerOrbit * u;
    const a = world.player.angle;
    const x = this.cx + Math.cos(a) * orbit;
    const y = this.cy + Math.sin(a) * orbit;
    // The body is drawn at exactly its collision size: one circle, the same
    // radius the simulation sweeps. What touches a ring is what the
    // simulation tests, on every axis.
    const r = TUNE.playerRadius * u;

    this.trail.push({ x, y });
    while (this.trail.length > TRAIL_LEN) this.trail.shift();

    if (!this.reduced && this.trail.length > 2) {
      this._drawTrail(ctx, trail.style, skin, r);
    }

    // The arm back to the core makes the player's angle instantly readable.
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = skin.glow;
    ctx.lineWidth = Math.max(1, u * 0.004);
    ctx.beginPath();
    ctx.moveTo(this.cx, this.cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();

    // A flip gives the ball a short elastic pop. The two axes are reciprocal,
    // so its area never changes and its silhouette never flattens into a disc.
    const sinceFlip = world.time - world.player.flipAt;
    const pop = 1 + Math.exp(-sinceFlip * 14) * 0.15;

    // The halo grows with the chain: at x1 it is a soft edge, at OVERDRIVE it
    // is the brightest thing on screen that is not a ring.
    // Tied to the body radius, but reaching much further than it: the player is
    // the smallest object on screen and has to be the one your eye lands on.
    const halo = r * (4.8 + this.heat * 2.5);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, halo);
    g.addColorStop(0, skin.glow);
    g.addColorStop(0.22, skin.glow);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.45 + this.heat * 0.28;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, halo, 0, TAU);
    ctx.fill();
    ctx.restore();

    // OVERDRIVE: a counter-rotating pair of arcs, and nothing else. It has to
    // read at a glance without competing with the rings for attention.
    if (this.overdrive > 0.02) {
      ctx.save();
      ctx.translate(x, y);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this.overdrive * 0.85;
      ctx.strokeStyle = skin.core;
      ctx.lineWidth = Math.max(1.2, r * 0.14);
      ctx.lineCap = 'round';
      for (let i = 0; i < 2; i++) {
        const spin = this.clock * (i ? -3.4 : 4.2) + i * Math.PI;
        ctx.beginPath();
        ctx.arc(0, 0, r * (3.0 + i * 0.75), spin, spin + 1.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    // Local x runs along the orbit; local +y points at the core, which is where
    // the light comes from and where the highlight has to sit.
    ctx.scale(pop, 1 / pop);

    // A cartoon ball, not a rendered sphere: flat colour, one bold ink line,
    // one clean shine. At fifteen pixels across, solid shapes read and soft
    // shading does not — and the ink is also what stops the body dissolving
    // into a bright ring passing behind it.
    //
    // The ink is stroked on the collision circle and the fill covers its inner
    // half, so the colour ends exactly where the hitbox ends and the line sits
    // outside it. Every skin is the same circle for the same reason: drawing
    // one larger than another would be a lie about where the walls are.
    const tones = this._skinTones(skin);

    ctx.lineJoin = 'round';
    ctx.strokeStyle = tones.ink;
    ctx.lineWidth = Math.max(2, r * 0.30);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();

    ctx.fillStyle = skin.glow;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();

    // A darker crescent along the edge facing away from the core. Two flat
    // tones instead of a gradient: it is the cheapest thing that says "ball"
    // rather than "disc", and it works on a white body as well as a dark one.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = tones.shade;
    ctx.beginPath();
    ctx.arc(r * 0.24, -r * 0.97, r * 1.2, 0, TAU);
    ctx.fill();
    ctx.restore();

    // The skin's mark: flat, centred, inked like everything else. The ink is
    // what makes a white mark readable on a white body, so a skin is never
    // reduced to a plain disc. `tests/content.test.mjs` holds the rule.
    ctx.strokeStyle = tones.ink;
    ctx.lineWidth = Math.max(1, r * 0.10);
    this._shapePath(ctx, skin.shape, r * 0.40);
    ctx.stroke();
    ctx.fillStyle = skin.core;
    this._shapePath(ctx, skin.shape, r * 0.40);
    ctx.fill();

    // One shine, out near the ink on the lit side.
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-r * 0.30, r * 0.66, r * 0.13, 0, TAU);
    ctx.fill();
    ctx.restore();

    // The shield is the only thing on screen that means "you can survive a
    // mistake", so it gets its own colour and its own construction: a dark
    // rim, a tinted interior, a bright shell and a highlight that travels
    // around it. One shell per remaining charge.
    const charges = world.shieldCharges || 0;
    const flashing = world.shieldTimer > 0 && charges === 0;
    if (charges > 0 || flashing) {
      const breathe = flashing
        ? 0.35 + 0.65 * Math.abs(Math.sin(world.time * 22))
        : 0.82 + 0.18 * Math.sin(world.time * 3.4);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a + Math.PI / 2);

      for (let i = Math.max(1, charges) - 1; i >= 0; i--) {
        const rr = r * (1.95 + i * 0.62);
        const outer = i > 0;
        const alpha = breathe * (outer ? 0.5 : 1);

        // Rim first, so the shell never merges into a bright ring behind it.
        ctx.globalAlpha = alpha * 0.75;
        ctx.strokeStyle = SHIELD.rim;
        ctx.lineWidth = Math.max(2.4, r * 0.26);
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, TAU);
        ctx.stroke();

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = flashing ? '#ffffff' : SHIELD.core;
        ctx.lineWidth = Math.max(1.4, r * 0.15);
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, TAU);
        ctx.stroke();

        if (!outer) {
          // Interior tint — enough to read as a bubble, light enough that the
          // player inside it stays the brightest thing.
          ctx.globalAlpha = alpha * 0.16;
          ctx.fillStyle = SHIELD.core;
          ctx.beginPath();
          ctx.arc(0, 0, rr, 0, TAU);
          ctx.fill();

          // A highlight travelling around the shell.
          ctx.globalAlpha = alpha * 0.9;
          ctx.strokeStyle = SHIELD.bright;
          ctx.lineWidth = Math.max(1, r * 0.11);
          ctx.lineCap = 'round';
          const sweep = world.time * 2.1;
          ctx.beginPath();
          ctx.arc(0, 0, rr, sweep, sweep + 0.85);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, 0, rr, sweep + Math.PI, sweep + Math.PI + 0.45);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  /**
   * Trail cosmetics. Every style walks the same recorded points, so they all
   * cost the same and none of them allocates.
   */
  _drawTrail(ctx, style, skin, width) {
    const pts = this.trail;
    const boost = 1 + this.heat * 0.5;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const stroke = (color, alpha, w, offset = 0) => {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[Math.min(i + 1, pts.length - 1)];
        const nx = offset ? -(q.y - p.y) : 0;
        const ny = offset ? (q.x - p.x) : 0;
        const len = offset ? Math.hypot(nx, ny) || 1 : 1;
        const px = p.x + (nx / len) * offset;
        const py = p.y + (ny / len) * offset;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(0.8, w);
      ctx.stroke();
    };

    switch (style) {
      case 'ribbon':
        stroke(skin.trail, 0.55 * boost, width * 0.7);
        break;
      case 'sparks':
        ctx.globalAlpha = 1;
        ctx.fillStyle = skin.trail;
        for (let i = pts.length - 1; i >= 0; i -= 2) {
          const k = i / pts.length;
          ctx.globalAlpha = k * 0.6 * boost;
          const sz = width * 0.5 * k;
          ctx.fillRect(pts[i].x - sz / 2, pts[i].y - sz / 2, sz, sz);
        }
        break;
      case 'prism':
        stroke(skin.trail, 0.30 * boost, width * 0.6, width * 0.9);
        stroke(skin.glow, 0.30 * boost, width * 0.6, -width * 0.9);
        stroke(skin.core, 0.40 * boost, width * 0.45);
        break;
      case 'pulse': {
        const beat = 0.75 + 0.25 * Math.sin(this.clock * (6 + this.heat * 10));
        stroke(skin.trail, 0.16 * boost, width * 2.1 * beat);
        stroke(skin.core, 0.42 * boost, width * 0.7 * beat);
        break;
      }
      case 'voidline':
        ctx.globalCompositeOperation = 'source-over';
        stroke('#05070e', 0.85, width * 1.5);
        ctx.globalCompositeOperation = 'lighter';
        stroke(skin.glow, 0.45 * boost, width * 0.35);
        break;
      default: // comet
        stroke(skin.trail, 0.13 * boost, width * 2.0);
        stroke(skin.trail, 0.32 * boost, width * 0.8);
        break;
    }
    ctx.restore();
  }

  /** One silhouette per pickup type, drawn around the origin. */
  _pickupPath(ctx, type, r) {
    ctx.beginPath();
    if (type === 'shield') {
      for (let i = 0; i < 6; i++) {
        const ang = -Math.PI / 2 + (TAU / 6) * i;
        const px = Math.cos(ang) * r * 1.12;
        const py = Math.sin(ang) * r * 1.12;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else if (type === 'slow') {
      ctx.rect(-r * 0.92, -r * 0.92, r * 1.84, r * 1.84);
    } else if (type === 'double') {
      ctx.moveTo(0, -r * 1.24);
      ctx.lineTo(r * 1.0, 0);
      ctx.lineTo(0, r * 1.24);
      ctx.lineTo(-r * 1.0, 0);
      ctx.closePath();
    } else {
      ctx.arc(0, 0, r, 0, TAU);
    }
  }

  _shapePath(ctx, shape, r) {
    ctx.beginPath();
    if (shape === 'square') {
      ctx.rect(-r * 0.86, -r * 0.86, r * 1.72, r * 1.72);
    } else if (shape === 'diamond') {
      ctx.moveTo(0, -r * 1.15);
      ctx.lineTo(r * 0.92, 0);
      ctx.lineTo(0, r * 1.15);
      ctx.lineTo(-r * 0.92, 0);
      ctx.closePath();
    } else if (shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? r * 1.25 : r * 0.55;
        const ang = -Math.PI / 2 + (Math.PI / 5) * i;
        const px = Math.cos(ang) * rad;
        const py = Math.sin(ang) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(0, 0, r, 0, TAU);
    }
  }

  _drawOverlays(ctx, fx) {
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    if (this.zoneFlash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this.zoneFlash * 0.16;
      ctx.fillStyle = rgba(this.pal.accent, 1);
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalCompositeOperation = 'source-over';
    }

    if (fx.flash > 0.01) {
      ctx.globalAlpha = Math.min(0.85, fx.flash);
      ctx.fillStyle = fx.flashColor;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    ctx.globalAlpha = 1;
    const dark = this.zoneDark || 0;
    if (!this._vignette || this._vignetteDark !== dark) {
      this._vignetteDark = dark;
      const v = ctx.createRadialGradient(
        this.cx, this.cy, this.unit * 0.55,
        this.cx, this.cy, Math.hypot(this.w, this.h) * 0.58,
      );
      v.addColorStop(0, `rgba(0,0,0,${dark})`);
      v.addColorStop(1, `rgba(0,0,0,${(0.55 + dark).toFixed(3)})`);
      this._vignette = v;
    }
    ctx.fillStyle = this._vignette;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }

  /**
   * An orbit point pulled back inside the canvas, so a label centred on it is
   * not half off the screen when the player happens to be at the left or right
   * extreme of their orbit.
   */
  labelPoint(angle, radiusUnits, text, size) {
    const p = this.orbitPoint(angle, radiusUnits);
    const pad = Math.min(text.length * size * 0.30, this.w * 0.45);
    return { x: clamp(p.x, pad, this.w - pad), y: clamp(p.y, size, this.h - size) };
  }

  /** Screen position of a point on the player's orbit — used to place FX. */
  orbitPoint(angle, radiusUnits = TUNE.playerOrbit) {
    return {
      x: this.cx + Math.cos(angle) * radiusUnits * this.unit,
      y: this.cy + Math.sin(angle) * radiusUnits * this.unit,
    };
  }
}
