/**
 * Fixed-timestep game loop. The simulation always advances in 1/120 s slices
 * so physics is identical on a 60 Hz phone and a 120 Hz iPad, while rendering
 * happens once per animation frame.
 */

export const FIXED_DT = 1 / 120;
const MAX_STEPS = 8; // guards against the spiral of death after a stall

export class Loop {
  constructor({ update, render }) {
    this.update = update;
    this.render = render;
    this.running = false;
    this.acc = 0;
    this.last = 0;
    this.fps = 60;
    this._raf = 0;
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  /** Call after a long pause (tab hidden) so we don't fast-forward the world. */
  resync() {
    this.last = performance.now();
    this.acc = 0;
  }

  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    let frame = (now - this.last) / 1000;
    this.last = now;
    if (!Number.isFinite(frame) || frame < 0) frame = 0;
    if (frame > 0.25) frame = 0.25;
    this.fps += (1 / Math.max(frame, 0.001) - this.fps) * 0.08;

    this.acc += frame;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_STEPS) {
      this.update(FIXED_DT);
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;

    this.render(frame);
  }
}
