/**
 * Small math / timing helpers shared by the simulation and the renderer.
 * Everything here is pure so it can run head-less inside Node for tests.
 */

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Wrap an angle into [0, TAU). */
export function wrap(a) {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Shortest absolute distance between two angles, in [0, PI]. */
export function angleDist(a, b) {
  const d = Math.abs(wrap(a) - wrap(b));
  return d > Math.PI ? TAU - d : d;
}

/** Format a number with thousands separators without pulling in Intl. */
export function commas(n) {
  const s = Math.floor(n).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Seconds -> m:ss */
export function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Local YYYY-MM-DD, used for daily missions / streaks. */
export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Whole days between two YYYY-MM-DD keys (b - a). */
export function daysBetween(a, b) {
  const pa = Date.parse(`${a}T00:00:00`);
  const pb = Date.parse(`${b}T00:00:00`);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return Infinity;
  return Math.round((pb - pa) / 86400000);
}
