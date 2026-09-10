/**
 * Skin-aware palette.
 *
 * The zones each have their own colours, and the player carries their own. When
 * the two land on the same hue — a teal skin in a teal zone, or a shield bubble
 * the same colour as the trail inside it — the screen stops reading. This
 * nudges hues apart only where they actually collide, by the smallest rotation
 * that separates them, so each zone keeps its identity.
 */

const HUE_KEYS = ['ring', 'ringDim', 'orb'];

/**
 * Minimum hue separation, in degrees, between the player and each element.
 *
 * Rings get the smaller push on purpose: enough that the player never
 * disappears into one, small enough that a zone still looks like itself when
 * you happen to equip a skin in its own colours. Orbs get more, because
 * mistaking an orb for the player is a mistake that costs a run.
 */
const SEPARATION = {
  ring: 28,
  ringDim: 28,
  orb: 40,
};

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  const v = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  return `#${v.toString(16).padStart(6, '0')}`;
}

export function rgbToHsl([r, g, b]) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h * 360, s, l];
}

export function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255];
}

/** Signed shortest distance from `a` to `b`, in degrees, within [-180, 180]. */
export function hueDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export function hueDistance(a, b) {
  return Math.abs(hueDelta(a, b));
}

/**
 * Rotate `hex` just far enough that its hue sits `minDegrees` away from
 * `awayFrom`, pushing in whichever direction it is already leaning. Saturation
 * and lightness are untouched, so the colour keeps its character.
 */
export function pushHueAway(hex, awayFrom, minDegrees) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const delta = hueDelta(awayFrom, h);
  const distance = Math.abs(delta);
  if (distance >= minDegrees) return hex;
  // A near-grey has no hue worth rotating.
  if (s < 0.12) return hex;
  const direction = delta === 0 ? 1 : Math.sign(delta);
  return rgbToHex(hslToRgb(awayFrom + direction * minDegrees, s, l));
}

/**
 * The shield reads as the player's opposite: a hue roughly across the wheel
 * from the skin, held bright so it stays legible over any zone.
 */
export function shieldColorFor(skin, ringHex) {
  const [skinHue] = rgbToHsl(hexToRgb(skin.glow));
  let hue = skinHue + 165;
  const [ringHue, ringSat] = rgbToHsl(hexToRgb(ringHex));
  // If that lands on the ring colour too, step around it.
  if (ringSat > 0.12 && hueDistance(hue, ringHue) < 40) {
    hue = ringHue + (hueDelta(ringHue, hue) >= 0 ? 40 : -40);
  }
  return rgbToHex(hslToRgb(hue, 0.86, 0.66));
}

/**
 * Adjust one zone palette so nothing in it collides with the equipped skin.
 * Returns a palette of the same shape plus a `shield` colour.
 */
export function adjustPalette(zonePalette, skin) {
  const [skinHue] = rgbToHsl(hexToRgb(skin.glow));
  const out = { ...zonePalette };
  for (const key of HUE_KEYS) {
    out[key] = pushHueAway(zonePalette[key], skinHue, SEPARATION[key]);
  }
  // The orb must also stay distinct from the ring it sits on.
  const [ringHue, ringSat] = rgbToHsl(hexToRgb(out.ring));
  if (ringSat > 0.12) out.orb = pushHueAway(out.orb, ringHue, 34);
  out.shield = shieldColorFor(skin, out.ring);
  return out;
}
