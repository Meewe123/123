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
import { TUNE, ZONES, skinById, POWERUPS } from './config.js';

const STAR_COUNT = 130;
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

    this.pal = {};
    const first = ZONES[0].palette;
    for (const k of PALETTE_KEYS) this.pal[k] = hexToRgb(first[k]);

    this.stars = [];
    this.trail = [];
    this.corePulse = 0;
    this.coreSpin = 0;
    this.skyRot = 0;
    this.zoneFlash = 0;
    this.resize();
  }

  setReduced(on) {
    this.reduced = !!on;
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
    this.unit = Math.min(cssW, cssH) / 2;
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

  /** Blend the live palette toward the zone the player is about to enter. */
  _mixPalette(zoneIndex, dt) {
    const target = ZONES[zoneIndex % ZONES.length].palette;
    const t = 1 - Math.exp(-3.2 * dt);
    for (const k of PALETTE_KEYS) mixInto(this.pal[k], hexToRgb(target[k]), t);
  }

  // ---------------------------------------------------------------- draw ---

  draw(world, opts) {
    const { fx, dt, skinId, intensity = 1 } = opts;
    const ctx = this.ctx;

    this.corePulse = Math.max(0, this.corePulse - this.corePulse * 5 * dt - 0.2 * dt);
    this.zoneFlash = Math.max(0, this.zoneFlash - dt * 1.6);
    this.coreSpin += dt * (0.25 + this.corePulse * 0.8);
    this.skyRot += dt * (this.reduced ? 0.004 : 0.012) * (1 + world.speedScale * 0.35);
    this._mixPalette(world.visualZone, dt);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.translate(fx.shakeX, fx.shakeY);

    this._drawSky(ctx, intensity);
    this._drawGrid(ctx);
    this._drawCore(ctx, world);
    this._drawOrbitGuide(ctx);
    this._drawRings(ctx, world);
    this._drawPlayer(ctx, world, skinById(skinId));
    fx.draw(ctx);
    ctx.restore();

    this._drawOverlays(ctx, fx);
  }

  _drawSky(ctx, intensity) {
    const p = this.pal;
    const g = ctx.createRadialGradient(
      this.cx, this.cy, this.unit * 0.05,
      this.cx, this.cy, Math.hypot(this.w, this.h) * 0.62,
    );
    g.addColorStop(0, rgba(p.bg1, 1));
    g.addColorStop(0.55, rgba(p.bg0, 1));
    g.addColorStop(1, `rgb(${(p.bg0[0] * 0.45) | 0},${(p.bg0[1] * 0.45) | 0},${(p.bg0[2] * 0.45) | 0})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.stars) {
      const a = s.a + this.skyRot * s.depth;
      const x = this.cx + Math.cos(a) * s.r;
      const y = this.cy + Math.sin(a) * s.r;
      const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.skyRot * 9 + s.tw));
      ctx.fillStyle = rgba(this.pal.accent, 0.10 + 0.30 * s.depth * tw * intensity);
      ctx.fillRect(x, y, s.size, s.size);
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
    const base = this.unit * 0.085;
    const pulse = 1 + this.corePulse * 0.28 + Math.sin(this.coreSpin * 2.2) * 0.035;
    const r = base * pulse;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(this.cx, this.cy, r * 0.2, this.cx, this.cy, r * 4.2);
    halo.addColorStop(0, rgba(p.ring, 0.55));
    halo.addColorStop(0.35, rgba(p.ring, 0.14));
    halo.addColorStop(1, rgba(p.ring, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, r * 4.2, 0, TAU);
    ctx.fill();
    ctx.restore();

    const body = ctx.createRadialGradient(
      this.cx - r * 0.3, this.cy - r * 0.35, r * 0.1,
      this.cx, this.cy, r,
    );
    body.addColorStop(0, rgba(p.accent, 1));
    body.addColorStop(0.6, rgba(p.ring, 0.95));
    body.addColorStop(1, rgba(p.ringDim, 0.9));
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

      // Solid arcs are the complement of the gaps.
      const gaps = [];
      for (let g = 0; g < ring.gaps.length; g++) {
        gaps.push({
          c: wrap(World.gapCenterAt(ring, g, ring.travel)),
          half: ring.gaps[g].half,
        });
      }
      gaps.sort((a, b) => a.c - b.c);

      const flash = ring.hitFlash;
      const bright = flash > 0
        ? [lerp(p.ring[0], 255, flash), lerp(p.ring[1], 255, flash), lerp(p.ring[2], 255, flash)]
        : p.ring;

      ctx.lineCap = 'round';
      for (let g = 0; g < gaps.length; g++) {
        const from = gaps[g].c + gaps[g].half;
        const next = gaps[(g + 1) % gaps.length];
        let to = next.c - next.half;
        if (to < from) to += TAU;
        if (to - from < 0.02) continue;

        const a0 = rot + from;
        const a1 = rot + to;

        if (!this.reduced) {
          ctx.strokeStyle = rgba(p.ringDim, alpha * 0.42);
          ctx.lineWidth = thick * 2.5;
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

      this._drawOrbs(ctx, ring, radius, alpha, world);
    }
  }

  _drawOrbs(ctx, ring, radius, alpha, world) {
    if (!ring.orbs.length) return;
    const u = this.unit;
    for (const orb of ring.orbs) {
      if (orb.taken) continue;
      const a = ring.rot + World.gapCenterAt(ring, orb.gapIndex, ring.travel) + orb.offset;
      const x = this.cx + Math.cos(a) * radius;
      const y = this.cy + Math.sin(a) * radius;
      const isPower = orb.type !== 'energy';
      const color = isPower ? POWERUPS[orb.type].color : `rgb(${this.pal.orb.join(',')})`;
      const r = (isPower ? TUNE.orbRadius * 1.5 : TUNE.orbRadius) * u;
      const bob = 1 + Math.sin(world.time * 7 + ring.id) * 0.10;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.1);
      g.addColorStop(0, color);
      g.addColorStop(0.28, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = alpha * 0.55;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.1, 0, TAU);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r * bob, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(x - r * 0.22, y - r * 0.26, r * 0.34, 0, TAU);
      ctx.fill();

      if (isPower) {
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
      }
      ctx.restore();
    }
  }

  _drawPlayer(ctx, world, skin) {
    const u = this.unit;
    const orbit = TUNE.playerOrbit * u;
    const a = world.player.angle;
    const x = this.cx + Math.cos(a) * orbit;
    const y = this.cy + Math.sin(a) * orbit;
    const r = TUNE.playerRadius * u;

    this.trail.push({ x, y });
    while (this.trail.length > TRAIL_LEN) this.trail.shift();

    // Trail
    if (!this.reduced && this.trail.length > 2) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        ctx.moveTo(this.trail[0].x, this.trail[0].y);
        for (let i = 1; i < this.trail.length; i++) ctx.lineTo(this.trail[i].x, this.trail[i].y);
        ctx.strokeStyle = skin.trail;
        ctx.globalAlpha = pass === 0 ? 0.16 : 0.4;
        ctx.lineWidth = pass === 0 ? r * 2.1 : r * 0.75;
        ctx.stroke();
      }
      ctx.restore();
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

    const sinceFlip = world.time - world.player.flipAt;
    const squash = 1 + Math.exp(-sinceFlip * 14) * 0.42;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4.5);
    g.addColorStop(0, skin.glow);
    g.addColorStop(0.25, skin.glow);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 4.5, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    ctx.scale(squash, 2 - squash);

    ctx.fillStyle = skin.glow;
    this._shapePath(ctx, skin.shape, r * 1.28);
    ctx.fill();
    ctx.fillStyle = skin.core;
    this._shapePath(ctx, skin.shape, r * 0.72);
    ctx.fill();
    ctx.restore();

    // Shield bubble
    const shieldOn = world.shield || world.shieldTimer > 0;
    if (shieldOn) {
      const pulse = world.shieldTimer > 0 && !world.shield
        ? 0.4 + 0.6 * Math.abs(Math.sin(world.time * 22))
        : 0.75 + 0.25 * Math.sin(world.time * 5);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = POWERUPS.shield.color;
      ctx.lineWidth = Math.max(1.5, r * 0.22);
      ctx.beginPath();
      ctx.arc(x, y, r * 2.0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = pulse * 0.25;
      ctx.fillStyle = POWERUPS.shield.color;
      ctx.fill();
      ctx.restore();
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
    const v = ctx.createRadialGradient(
      this.cx, this.cy, this.unit * 0.55,
      this.cx, this.cy, Math.hypot(this.w, this.h) * 0.58,
    );
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }

  /** Screen position of a point on the player's orbit — used to place FX. */
  orbitPoint(angle, radiusUnits = TUNE.playerOrbit) {
    return {
      x: this.cx + Math.cos(angle) * radiusUnits * this.unit,
      y: this.cy + Math.sin(angle) * radiusUnits * this.unit,
    };
  }
}
