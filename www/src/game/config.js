/**
 * All gameplay tuning, zone definitions, cosmetics and mission templates.
 * Values are in "playfield units": 1.0 == half of the shorter screen side,
 * so the game plays identically on every device and aspect ratio.
 */

export const TUNE = {
  playerOrbit: 0.40,
  playerRadius: 0.042,
  spawnRadius: 1.30,
  despawnRadius: 0.05,
  playerAngularSpeed: 2.45,
  ringSpeed: 0.40,
  ringThickness: 0.030,
  orbRadius: 0.026,
  baseSpacing: 0.38,
  minSpacing: 0.30,
  slowFactor: 0.55,
  slowDuration: 4.0,
  doubleDuration: 7.0,
  reviveShield: 2.4,
  perfectThreshold: 0.60,
  comboPerMultiplier: 4,
  maxMultiplier: 8,
  reviveCost: 150,
  zoneLength: 14,
  orbChance: 0.62,
  powerupEvery: 11,
};

/**
 * 0..1 difficulty ramp. Tuned so the gap between rings goes 1.0s -> 0.6s over
 * the first hundred rings and then flattens out near 0.4s, which is about as
 * fast as a thumb can usefully react.
 */
export function difficultyAt(score) {
  return 1 - Math.exp(-score / 95);
}

export function lapAt(score) {
  return Math.floor(score / (TUNE.zoneLength * ZONES.length));
}

export function zoneIndexAt(score) {
  return Math.floor(score / TUNE.zoneLength) % ZONES.length;
}

const P = (bg0, bg1, ring, ringDim, accent, orb, grid) =>
  ({ bg0, bg1, ring, ringDim, accent, orb, grid });

export const ZONES = [
  {
    id: 'genesis',
    name: 'GENESIS',
    key: -5,
    palette: P('#05121f', '#0a2b45', '#5ff0e0', '#1c6a72', '#ffffff', '#ffe66d', '#0f3a52'),
    gaps: () => 1,
    gapHalf: 0.62,
    rot: [0.35, 0.75],
    flags: {},
  },
  {
    id: 'ember',
    name: 'EMBER',
    key: -3,
    palette: P('#1c0708', '#42120c', '#ff8a4c', '#8a3418', '#fff1c9', '#ffd166', '#5a2113'),
    gaps: (rng) => (rng.chance(0.35) ? 2 : 1),
    gapHalf: 0.54,
    rot: [0.55, 1.05],
    flags: {},
  },
  {
    id: 'reverse',
    name: 'REVERSE',
    key: -7,
    palette: P('#12061f', '#331046', '#c08cff', '#5a2f80', '#ffffff', '#7ef0ff', '#43195c'),
    gaps: () => 1,
    gapHalf: 0.58,
    rot: [0.9, 1.5],
    flags: { alternate: true },
  },
  {
    id: 'twin',
    name: 'TWIN',
    key: -2,
    palette: P('#03170f', '#07422a', '#4dffa8', '#177a52', '#eafff5', '#ffd166', '#0c5236'),
    gaps: (rng) => (rng.chance(0.4) ? 2 : 1),
    gapHalf: 0.5,
    rot: [0.6, 1.2],
    flags: { twin: true },
  },
  {
    id: 'pulse',
    name: 'PULSE',
    key: 0,
    palette: P('#1b0523', '#4a0b3f', '#ff6fd8', '#8c2b6d', '#fff3fb', '#8affdc', '#61154f'),
    gaps: () => 2,
    gapHalf: 0.44,
    rot: [0.7, 1.25],
    flags: { pulse: true },
  },
  {
    id: 'ghost',
    name: 'GHOST',
    key: -9,
    palette: P('#04070f', '#0d1836', '#9fb8ff', '#33477f', '#ffffff', '#ffe66d', '#1a2a52'),
    gaps: () => 1,
    gapHalf: 0.56,
    rot: [0.8, 1.35],
    flags: { ghost: true },
  },
  {
    id: 'storm',
    name: 'STORM',
    key: -4,
    palette: P('#1a1403', '#4a3a06', '#ffd23f', '#8a6a10', '#fffbe6', '#ff7edb', '#5f4a09'),
    gaps: () => 3,
    gapHalf: 0.32,
    rot: [1.3, 2.0],
    flags: {},
  },
  {
    id: 'singularity',
    name: 'SINGULARITY',
    key: -8,
    palette: P('#07060f', '#1d1b3f', '#e6e9ff', '#5a5c8f', '#8affff', '#ff9ecd', '#2b2a55'),
    gaps: (rng) => (rng.chance(0.5) ? 2 : 1),
    gapHalf: 0.46,
    rot: [1.0, 1.7],
    flags: { drift: true, alternate: true },
  },
];

// A typo-proof guard: palettes must be complete 7-colour sets.
for (const z of ZONES) {
  for (const k of ['bg0', 'bg1', 'ring', 'ringDim', 'accent', 'orb', 'grid']) {
    if (!/^#[0-9a-f]{6}$/i.test(z.palette[k])) {
      throw new Error(`Zone ${z.id} has an invalid palette colour for "${k}": ${z.palette[k]}`);
    }
  }
}

export const POWERUPS = {
  shield: { id: 'shield', label: 'SHIELD', color: '#7ef0ff' },
  slow: { id: 'slow', label: 'SLOW-MO', color: '#c08cff' },
  double: { id: 'double', label: 'x2 SCORE', color: '#ffd23f' },
};

export const SKINS = [
  { id: 'aurora', name: 'Aurora', cost: 0, core: '#ffffff', glow: '#5ff0e0', trail: '#5ff0e0', shape: 'orb' },
  { id: 'ember', name: 'Ember', cost: 250, core: '#fff1c9', glow: '#ff7a3c', trail: '#ff4d2e', shape: 'orb' },
  { id: 'orchid', name: 'Orchid', cost: 400, core: '#ffffff', glow: '#ff6fd8', trail: '#c08cff', shape: 'orb' },
  { id: 'lime', name: 'Lime Drop', cost: 600, core: '#f2ffe6', glow: '#b6ff3c', trail: '#4dffa8', shape: 'orb' },
  { id: 'cobalt', name: 'Cobalt', cost: 900, core: '#e8f1ff', glow: '#4d7cff', trail: '#8affff', shape: 'diamond' },
  { id: 'solar', name: 'Solar Flare', cost: 1300, core: '#fffbe6', glow: '#ffd23f', trail: '#ff8a4c', shape: 'diamond' },
  { id: 'void', name: 'Void', cost: 1800, core: '#1a1a24', glow: '#8a8aff', trail: '#5c5cff', shape: 'orb' },
  { id: 'mint', name: 'Mint Chip', cost: 2400, core: '#ffffff', glow: '#6ffff0', trail: '#2ec4b6', shape: 'square' },
  { id: 'rose', name: 'Rose Gold', cost: 3200, core: '#fff0ea', glow: '#ffb4a2', trail: '#e5989b', shape: 'diamond' },
  { id: 'plasma', name: 'Plasma', cost: 4500, core: '#ffffff', glow: '#ff2e88', trail: '#7b2fff', shape: 'orb' },
  { id: 'quantum', name: 'Quantum', cost: 6000, core: '#001018', glow: '#00ffc6', trail: '#00b3ff', shape: 'square' },
  { id: 'nova', name: 'Nova', cost: 9000, core: '#ffffff', glow: '#ffffff', trail: '#ffd23f', shape: 'star' },
];

export const skinById = (id) => SKINS.find((s) => s.id === id) || SKINS[0];

/** Mission templates. `make` returns a concrete mission for the day. */
export const MISSION_TEMPLATES = [
  {
    id: 'rings',
    scope: 'run',
    make: (rng, best) => {
      const target = Math.max(15, Math.round((best * 0.55 + 18) / 5) * 5);
      return { text: `Pass ${target} rings in one run`, target, reward: 120 };
    },
  },
  {
    id: 'orbs',
    scope: 'total',
    make: (rng) => {
      const target = rng.pick([40, 60, 80]);
      return { text: `Collect ${target} energy orbs`, target, reward: 100 };
    },
  },
  {
    id: 'combo',
    scope: 'run',
    make: (rng) => {
      const target = rng.pick([8, 12, 16]);
      return { text: `Reach a x${Math.min(8, 1 + Math.floor(target / 4))} multiplier`, target, reward: 150 };
    },
  },
  {
    id: 'runs',
    scope: 'total',
    make: (rng) => {
      const target = rng.pick([3, 5, 8]);
      return { text: `Play ${target} runs`, target, reward: 80 };
    },
  },
  {
    id: 'zone',
    scope: 'run',
    make: (rng) => {
      const target = rng.pick([3, 4, 5]);
      return { text: `Reach zone ${target} in one run`, target, reward: 140 };
    },
  },
  {
    id: 'perfect',
    scope: 'total',
    make: (rng) => {
      const target = rng.pick([10, 15, 25]);
      return { text: `Nail ${target} perfect passes`, target, reward: 130 };
    },
  },
];

export const DAILY_REWARDS = [50, 75, 100, 150, 200, 300, 500];
