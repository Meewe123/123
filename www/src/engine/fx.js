/**
 * Pooled visual effects: particles, shockwaves, floating text, screen shake
 * and full-screen flashes. Allocation-free during play — every object is
 * recycled, so the GC never stutters a run.
 */

import { clamp, TAU } from './util.js';

const MAX_PARTICLES = 420;
const MAX_WAVES = 24;
const MAX_TEXTS = 16;

class Particle {
  constructor() {
    this.active = false;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.life = 0; this.maxLife = 1; this.size = 2;
    this.drag = 0.9; this.gravity = 0; this.color = '#fff';
    this.rot = 0; this.spin = 0; this.shape = 'dot'; this.glow = 1;
  }
}

class Wave {
  constructor() {
    this.active = false;
    this.x = 0; this.y = 0; this.r = 0; this.r1 = 100;
    this.life = 0; this.maxLife = 0.5; this.width = 3; this.color = '#fff';
  }
}

class FloatText {
  constructor() {
    this.active = false;
    this.x = 0; this.y = 0; this.vy = -40; this.life = 0; this.maxLife = 0.9;
    this.text = ''; this.color = '#fff'; this.size = 20; this.weight = 700;
  }
}

export class Fx {
  constructor() {
    this.particles = Array.from({ length: MAX_PARTICLES }, () => new Particle());
    this.waves = Array.from({ length: MAX_WAVES }, () => new Wave());
    this.texts = Array.from({ length: MAX_TEXTS }, () => new FloatText());
    this.pi = 0; this.wi = 0; this.ti = 0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.flash = 0;
    this.flashColor = '#ffffff';
    this.reduced = false;
  }

  clear() {
    for (const p of this.particles) p.active = false;
    for (const w of this.waves) w.active = false;
    for (const t of this.texts) t.active = false;
    this.shake = 0;
    this.flash = 0;
  }

  _nextParticle() {
    // Ring buffer: the oldest particle is stolen when the pool is exhausted.
    const p = this.particles[this.pi];
    this.pi = (this.pi + 1) % MAX_PARTICLES;
    return p;
  }

  spawn(opts) {
    if (this.reduced && Math.random() < 0.55) return null;
    const p = this._nextParticle();
    p.active = true;
    p.x = opts.x; p.y = opts.y;
    p.vx = opts.vx || 0; p.vy = opts.vy || 0;
    p.maxLife = opts.life || 0.6;
    p.life = p.maxLife;
    p.size = opts.size || 3;
    p.drag = opts.drag ?? 2.2;
    p.gravity = opts.gravity || 0;
    p.color = opts.color || '#ffffff';
    p.shape = opts.shape || 'dot';
    p.glow = opts.glow ?? 1;
    p.rot = opts.rot || 0;
    p.spin = opts.spin || 0;
    return p;
  }

  burst(x, y, count, opts = {}) {
    const n = this.reduced ? Math.ceil(count * 0.5) : count;
    for (let i = 0; i < n; i++) {
      const a = opts.angle !== undefined
        ? opts.angle + (Math.random() - 0.5) * (opts.spread ?? TAU)
        : Math.random() * TAU;
      const sp = (opts.speed || 140) * (0.35 + Math.random() * 0.9);
      this.spawn({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: (opts.life || 0.55) * (0.6 + Math.random() * 0.7),
        size: (opts.size || 3) * (0.6 + Math.random() * 0.8),
        color: Array.isArray(opts.color)
          ? opts.color[(Math.random() * opts.color.length) | 0]
          : opts.color,
        shape: opts.shape || 'dot',
        drag: opts.drag ?? 2.4,
        gravity: opts.gravity || 0,
        spin: (Math.random() - 0.5) * 12,
        rot: Math.random() * TAU,
        glow: opts.glow ?? 1,
      });
    }
  }

  wave(x, y, r0, r1, opts = {}) {
    const w = this.waves[this.wi];
    this.wi = (this.wi + 1) % MAX_WAVES;
    w.active = true;
    w.x = x; w.y = y; w.r = r0; w.r1 = r1;
    w.maxLife = opts.life || 0.45;
    w.life = w.maxLife;
    w.width = opts.width || 3;
    w.color = opts.color || '#ffffff';
  }

  text(x, y, str, opts = {}) {
    const t = this.texts[this.ti];
    this.ti = (this.ti + 1) % MAX_TEXTS;
    const size = opts.size || 20;
    t.active = true;
    t.x = x;
    // Two labels can land at once — twin rings clear together, and a PERFECT
    // arrives with its payout. Stack the second one above the first instead of
    // printing them on top of each other, where neither can be read.
    t.y = this._clearRow(x, y, str, size, t);
    t.text = str;
    t.vy = opts.vy ?? -46;
    t.maxLife = opts.life || 0.9;
    t.life = t.maxLife;
    t.color = opts.color || '#ffffff';
    t.size = size;
    t.weight = opts.weight || 800;
  }

  /**
   * The first vertical slot near `y` that no live label already occupies.
   * Approximate on purpose: widths are estimated from the character count
   * rather than measured, because this runs while the frame is being built and
   * a wrong guess only costs a slightly larger gap.
   */
  _clearRow(x, y, str, size, self) {
    const halfWidth = str.length * size * 0.3;
    let row = y;
    for (let attempt = 0; attempt < 3; attempt++) {
      let clash = false;
      for (const other of this.texts) {
        if (!other.active || other === self) continue;
        if (Math.abs(other.y - row) >= size * 1.15) continue;
        const otherHalf = other.text.length * other.size * 0.3;
        if (Math.abs(other.x - x) < halfWidth + otherHalf) { clash = true; break; }
      }
      if (!clash) return row;
      row -= size * 1.25;
    }
    return row;
  }

  addShake(amount) {
    this.shake = Math.min(this.shake + amount, this.reduced ? 6 : 34);
  }

  addFlash(amount, color = '#ffffff') {
    this.flash = Math.min(1, this.flash + (this.reduced ? amount * 0.35 : amount));
    this.flashColor = color;
  }

  update(dt) {
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    for (const w of this.waves) {
      if (!w.active) continue;
      w.life -= dt;
      if (w.life <= 0) w.active = false;
    }
    for (const t of this.texts) {
      if (!t.active) continue;
      t.life -= dt;
      t.y += t.vy * dt;
      t.vy *= Math.exp(-2.2 * dt);
      if (t.life <= 0) t.active = false;
    }

    this.shake = Math.max(0, this.shake - this.shake * 8 * dt - 6 * dt);
    const s = this.shake;
    this.shakeX = (Math.random() - 0.5) * s;
    this.shakeY = (Math.random() - 0.5) * s;
    this.flash = Math.max(0, this.flash - this.flash * 6 * dt - 0.4 * dt);
  }

  draw(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      if (!p.active) continue;
      const k = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = k * p.glow;
      ctx.fillStyle = p.color;
      if (p.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.35 + k * 0.65), 0, TAU);
        ctx.fill();
      } else if (p.shape === 'spark') {
        const len = p.size * (1.5 + k * 3);
        const a = Math.atan2(p.vy, p.vx);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.5 * k + 0.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
        ctx.stroke();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        const s = p.size * (0.4 + k * 0.9);
        ctx.fillRect(-s * 0.5, -s * 0.5, s, s);
        ctx.restore();
      }
    }
    for (const w of this.waves) {
      if (!w.active) continue;
      const k = 1 - w.life / w.maxLife;
      const e = 1 - Math.pow(1 - k, 3);
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.strokeStyle = w.color;
      ctx.lineWidth = w.width * (1 - k * 0.7);
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.r + (w.r1 - w.r) * e, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    for (const t of this.texts) {
      if (!t.active) continue;
      const k = clamp(t.life / t.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = k;
      ctx.fillStyle = t.color;
      ctx.font = `${t.weight} ${t.size}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.text, t.x, t.y);
      ctx.restore();
    }
  }
}

export const FONT = '"Orbital", ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
