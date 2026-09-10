/**
 * One-thumb input. Pointer events only (no mouse/touch double-fire), plus
 * keyboard for desktop play. Taps that land on interactive DOM chrome are
 * ignored so buttons keep working over the canvas.
 */

export class Input {
  constructor(target = window) {
    this.target = target;
    this.onTap = () => {};
    this.enabled = true;
    this._bound = [];
  }

  attach() {
    const down = (e) => {
      if (!this.enabled) return;
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-ui]')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.onTap(e);
    };
    const key = (e) => {
      if (!this.enabled || e.repeat) return;
      if (e.code === 'Space' || e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'Enter') {
        e.preventDefault();
        this.onTap(e);
      }
    };

    this._add(this.target, 'pointerdown', down, { passive: true });
    this._add(window, 'keydown', key);
    // Stop iOS Safari's double-tap-to-zoom and rubber-band scroll.
    this._add(document, 'gesturestart', (e) => e.preventDefault());
    this._add(document, 'touchmove', (e) => {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    this._add(document, 'contextmenu', (e) => e.preventDefault());
  }

  _add(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this._bound.push([el, type, fn, opts]);
  }

  detach() {
    for (const [el, type, fn, opts] of this._bound) el.removeEventListener(type, fn, opts);
    this._bound.length = 0;
  }
}
