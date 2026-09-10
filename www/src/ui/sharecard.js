/**
 * The share card, drawn with the same canvas primitives as the game.
 *
 * No image library and no assets: a portrait card rendered on demand, so it
 * always matches the run it describes and the palette the player was in.
 */

import { commas } from '../engine/util.js';
import { FONT } from '../engine/fx.js';
import { TAU } from '../engine/util.js';

const W = 1080;
const H = 1350;

export function drawShareCard(result, palette, skin) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Ground
  const sky = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.42, H * 0.8);
  sky.addColorStop(0, palette.bg1);
  sky.addColorStop(0.6, palette.bg0);
  sky.addColorStop(1, '#04060c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // The mark: an arc with a gap, and the player sitting in it.
  const cx = W / 2;
  const cy = H * 0.40;
  const R = 250;
  ctx.lineCap = 'round';
  ctx.strokeStyle = palette.ringDim;
  ctx.lineWidth = 46;
  ctx.beginPath();
  ctx.arc(cx, cy, R, -Math.PI * 0.42, Math.PI * 1.32);
  ctx.stroke();
  ctx.strokeStyle = palette.ring;
  ctx.lineWidth = 20;
  ctx.beginPath();
  ctx.arc(cx, cy, R, -Math.PI * 0.42, Math.PI * 1.32);
  ctx.stroke();

  const pa = -Math.PI / 2;
  const px = cx + Math.cos(pa) * R;
  const py = cy + Math.sin(pa) * R;
  const glow = ctx.createRadialGradient(px, py, 0, px, py, 120);
  glow.addColorStop(0, skin.glow);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(px, py, 120, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(1, 0.6);
  ctx.fillStyle = skin.glow;
  ctx.beginPath();
  ctx.arc(0, 0, 34, 0, TAU);
  ctx.fill();
  ctx.fillStyle = skin.core;
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Wordmark
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.font = `800 34px ${FONT}`;
  ctx.fillText('O R B I T A L   R U S H', cx, 120);

  // Score
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `800 30px ${FONT}`;
  ctx.fillText(result.isBest ? 'NEW BEST' : 'SCORE', cx, H * 0.62);
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 190px ${FONT}`;
  ctx.fillText(commas(result.score), cx, H * 0.62 + 155);

  // Stats
  const stats = [
    [`ZONE ${result.zoneReached + 1}`, 'REACHED'],
    [`x${result.bestMultiplier}`, 'MULTIPLIER'],
    [`${commas(result.perfects)}`, 'PERFECTS'],
    [`${commas(result.greedOrbs)}`, 'GREED'],
  ];
  const colW = W / stats.length;
  stats.forEach(([value, label], i) => {
    const x = colW * i + colW / 2;
    ctx.fillStyle = palette.ring;
    ctx.font = `900 54px ${FONT}`;
    ctx.fillText(value, x, H * 0.86);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = `800 24px ${FONT}`;
    ctx.fillText(label, x, H * 0.86 + 40);
  });

  // Call to action
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `900 40px ${FONT}`;
  ctx.fillText('BEAT MY SCORE', cx, H - 96);
  if (result.code) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(result.code, cx, H - 50);
  }

  return canvas;
}

const toBlob = (canvas) => new Promise((resolve) => {
  if (canvas.toBlob) canvas.toBlob(resolve, 'image/png');
  else resolve(null);
});

/**
 * Share the card as an image where the platform allows it, then plain text,
 * then the clipboard. Returns what actually happened so the UI can say so.
 */
export async function shareRun(result, palette, skin, text, link) {
  const payload = { title: 'Orbital Rush', text, url: link };

  try {
    const canvas = drawShareCard(result, palette, skin);
    const blob = await toBlob(canvas);
    if (blob && navigator.canShare) {
      const file = new File([blob], 'orbital-rush.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ ...payload, files: [file] });
        return 'image';
      }
    }
  } catch {
    /* fall through to text */
  }

  try {
    if (navigator.share) {
      await navigator.share(payload);
      return 'text';
    }
  } catch {
    return 'cancelled';
  }

  try {
    await navigator.clipboard.writeText(`${text} ${link}`);
    return 'clipboard';
  } catch {
    return 'unavailable';
  }
}
