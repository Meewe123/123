/**
 * All gameplay tuning, zone definitions, cosmetics, achievements and mission
 * templates. Values are in "playfield units": 1.0 == half of the shorter
 * screen side, so the game plays identically on every device and aspect ratio.
 *
 * Nothing in here reads the DOM or the clock — the whole file is data, so the
 * simulation stays deterministic and testable in Node.
 */

export const TUNE = {
  playerOrbit: 0.44,
  // The player is a lens, not a ball: narrow across the ring it is crossing,
  // wide along its own orbit. The radial half-extent sets how long a ring
  // touches the player, which is what the collision test has to survive — and
  // it is also what makes the player visible, so both matter.
  playerRadial: 0.030,
  playerTangential: 0.050,
  spawnRadius: 1.30,
  despawnRadius: 0.05,
  playerAngularSpeed: 2.35,
  ringSpeed: 0.48,
  ringThickness: 0.018,
  orbRadius: 0.026,
  baseSpacing: 0.42,
  minSpacing: 0.38,
  // Slack on top of the geometric minimum. The minimum only guarantees a gap
  // is *possible*; this is the room a human's reaction time needs on top of it.
  gapMargin: 0.15,
  // How much of the reachable arc the generator will actually use.
  reachSafety: 0.85,

  // --- safe vs greed -------------------------------------------------------
  // An orb sitting further than this fraction of the gap's spare room counts
  // as a GREED orb: reachable, but it costs most of your margin to take.
  greedThreshold: 0.45,
  // Greed orbs are worth this much more than a safe one.
  greedBonus: 2,
  // How far off-centre an orb may ever sit, as a fraction of the spare room.
  orbReach: 0.85,

  slowFactor: 0.55,
  slowDuration: 4.0,
  doubleDuration: 7.0,
  reviveShield: 2.4,
  perfectThreshold: 0.60,
  comboPerMultiplier: 4,
  maxMultiplier: 8,
  reviveCost: 150,
  zoneLength: 14,
  orbChance: 0.66,
  // Shields are on their own schedule: ring 10, then every 15 after that.
  shieldFirst: 10,
  shieldEvery: 15,
  // A shield always eats two rings before it breaks.
  shieldCharges: 2,
  // Slow-mo and double-score share this slot between shield drops.
  powerupEvery: 11,

  // --- feel ----------------------------------------------------------------
  // A PERFECT freezes the world for a couple of frames. Long enough to feel
  // like an impact, short enough that it never reads as a stutter.
  hitStopSeconds: 0.055,
  // Death: how long the explosion plays before the summary appears.
  deathHold: 0.75,
  // Ghost replay resolution. 20 Hz for 3 minutes is ~14 KB of save data.
  ghostHz: 20,
  ghostMaxSamples: 3600,
};

/** The multiplier at which the run enters OVERDRIVE. */
export const OVERDRIVE_AT = TUNE.maxMultiplier;

/**
 * 0..1 difficulty ramp. Tuned so the gap between rings goes ~0.9s -> ~0.4s over
 * the first couple of hundred rings, which is about as fast as a thumb can
 * usefully react.
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

/**
 * Eight zones, each with its own atmosphere.
 *
 *   flags   change how rings are generated (kept from the original generator)
 *   fx      tells the renderer how the background, particles and PERFECT read
 *   voice   tells the synth what this zone sounds like
 *
 * Gap widths are a *request*: the generator clamps every one of them up to the
 * geometric minimum it computes per ring, so no theme can produce an
 * impossible ring.
 */
export const ZONES = [
  {
    id: 'flow',
    name: 'FLOW',
    key: -5,
    palette: P('#05121f', '#0a2b45', '#5ff0e0', '#1c6a72', '#ffffff', '#ffe66d', '#0f3a52'),
    gaps: () => 1,
    gapHalf: 0.85,
    rot: [0.30, 0.60],
    flags: {},
    fx: { sky: 'calm', motes: 'drift', perfect: 'pulse', shake: 0.8 },
    voice: 'calm',
  },
  {
    id: 'voltage',
    name: 'VOLTAGE',
    key: -3,
    palette: P('#12100a', '#3a3208', '#ffe14d', '#8a6a10', '#fffbe6', '#7ef0ff', '#4a3f0c'),
    gaps: (rng) => (rng.chance(0.35) ? 2 : 1),
    gapHalf: 0.72,
    rot: [0.45, 0.85],
    flags: { alternate: true },
    fx: { sky: 'volt', motes: 'spark', perfect: 'arc', shake: 1.1 },
    voice: 'electric',
  },
  {
    id: 'inferno',
    name: 'INFERNO',
    key: -1,
    palette: P('#1c0708', '#42120c', '#ff8a4c', '#8a3418', '#fff1c9', '#ffd166', '#5a2113'),
    gaps: (rng) => (rng.chance(0.4) ? 2 : 1),
    gapHalf: 0.70,
    rot: [0.50, 0.95],
    flags: { twin: true },
    fx: { sky: 'heat', motes: 'ember', perfect: 'burst', shake: 1.3 },
    voice: 'intense',
  },
  {
    id: 'frozen',
    name: 'FROZEN',
    key: 0,
    palette: P('#050f1c', '#123a5c', '#bfe9ff', '#3f6f8f', '#ffffff', '#ffd6f5', '#1d4a6b'),
    gaps: () => 2,
    gapHalf: 0.62,
    rot: [0.40, 0.80],
    flags: { pulse: true },
    fx: { sky: 'glass', motes: 'frost', perfect: 'shatter', shake: 1.0 },
    voice: 'crystal',
  },
  {
    id: 'drift',
    name: 'DRIFT',
    key: -7,
    palette: P('#0a0718', '#27164a', '#a78bff', '#4d3282', '#e9e2ff', '#8affdc', '#33215e'),
    gaps: (rng) => (rng.chance(0.5) ? 2 : 1),
    gapHalf: 0.66,
    rot: [0.55, 1.00],
    flags: { drift: true },
    fx: { sky: 'warp', motes: 'drift', perfect: 'warp', shake: 1.0 },
    voice: 'unstable',
  },
  {
    id: 'ghost',
    name: 'GHOST',
    key: -9,
    palette: P('#12061a', '#3d0f4a', '#f07ae0', '#7a2a75', '#ffe9fb', '#9dfcff', '#4d1a5c'),
    gaps: () => 1,
    gapHalf: 0.70,
    rot: [0.60, 1.00],
    flags: { ghost: true },
    fx: { sky: 'ghost', motes: 'wisp', perfect: 'echo', shake: 0.9 },
    voice: 'ghostly',
  },
  {
    id: 'storm',
    name: 'STORM',
    key: -4,
    palette: P('#0d1220', '#1e3358', '#8fd0ff', '#2f5f8a', '#ffffff', '#ffd23f', '#22406b'),
    gaps: () => 2,
    gapHalf: 0.45,
    rot: [1.05, 1.55],
    flags: {},
    fx: { sky: 'storm', motes: 'rain', perfect: 'lightning', shake: 1.6 },
    voice: 'storm',
  },
  {
    id: 'void',
    name: 'VOID',
    key: -8,
    palette: P('#030308', '#0c0c16', '#e6e9ff', '#3a3a55', '#ffffff', '#ff9ecd', '#17172a'),
    gaps: (rng) => (rng.chance(0.5) ? 2 : 1),
    gapHalf: 0.55,
    rot: [0.80, 1.30],
    flags: { drift: true, alternate: true },
    fx: { sky: 'void', motes: 'none', perfect: 'void', shake: 1.2 },
    voice: 'void',
  },
];

// A typo-proof guard: palettes must be complete 7-colour sets, and every zone
// must declare its atmosphere.
for (const z of ZONES) {
  for (const k of ['bg0', 'bg1', 'ring', 'ringDim', 'accent', 'orb', 'grid']) {
    if (!/^#[0-9a-f]{6}$/i.test(z.palette[k])) {
      throw new Error(`Zone ${z.id} has an invalid palette colour for "${k}": ${z.palette[k]}`);
    }
  }
  for (const k of ['sky', 'motes', 'perfect']) {
    if (!z.fx[k]) throw new Error(`Zone ${z.id} is missing fx.${k}`);
  }
  if (!z.voice) throw new Error(`Zone ${z.id} is missing a voice`);
}

export const zoneByIndex = (i) => ZONES[((i % ZONES.length) + ZONES.length) % ZONES.length];

export const POWERUPS = {
  shield: { id: 'shield', label: 'SHIELD', color: '#7ef0ff' },
  slow: { id: 'slow', label: 'SLOW-MO', color: '#c08cff' },
  double: { id: 'double', label: 'x2 SCORE', color: '#ffd23f' },
};

// ------------------------------------------------------------- cosmetics ---

/**
 * Unlocks come in four shapes, and the shop shows each differently:
 *   free        — you start with it
 *   shards      — buy it with what you earn by playing
 *   achievement — earned, never bought
 *   premium     — a real purchase, routed through PurchaseService
 */
export const SKINS = [
  { id: 'flow', name: 'Flow', unlock: 'free', cost: 0, core: '#ffffff', glow: '#5ff0e0', trail: '#5ff0e0', shape: 'orb', effect: 'zone' },
  { id: 'volt', name: 'Volt', unlock: 'shards', cost: 300, core: '#fffbe6', glow: '#ffe14d', trail: '#ffb03a', shape: 'diamond', effect: 'zone' },
  { id: 'inferno', name: 'Inferno', unlock: 'shards', cost: 550, core: '#fff1c9', glow: '#ff7a3c', trail: '#ff4d2e', shape: 'orb', effect: 'zone' },
  { id: 'frost', name: 'Frost', unlock: 'shards', cost: 850, core: '#ffffff', glow: '#bfe9ff', trail: '#6fb7ff', shape: 'diamond', effect: 'zone' },
  { id: 'drift', name: 'Drift', unlock: 'shards', cost: 1200, core: '#f0eaff', glow: '#a78bff', trail: '#6f4fd8', shape: 'orb', effect: 'zone' },
  { id: 'ghost', name: 'Ghost', unlock: 'shards', cost: 1700, core: '#ffe9fb', glow: '#f07ae0', trail: '#a13ea6', shape: 'orb', effect: 'zone' },
  { id: 'storm', name: 'Storm', unlock: 'shards', cost: 2400, core: '#ffffff', glow: '#8fd0ff', trail: '#3f7fd0', shape: 'square', effect: 'zone' },
  { id: 'void', name: 'Void', unlock: 'achievement', achievement: 'zone_8', cost: 0, core: '#0a0a12', glow: '#8a8aff', trail: '#4a4ad0', shape: 'orb', effect: 'zone' },
  { id: 'nova', name: 'Nova', unlock: 'achievement', achievement: 'mult_8', cost: 0, core: '#ffffff', glow: '#ffffff', trail: '#ffd23f', shape: 'star', effect: 'zone' },
  { id: 'eclipse', name: 'Eclipse', unlock: 'achievement', achievement: 'perfect_100', cost: 0, core: '#120a18', glow: '#ff8a4c', trail: '#ffd166', shape: 'orb', effect: 'zone' },
  { id: 'nebula', name: 'Nebula', unlock: 'premium', sku: 'cosmetic.nebula', cost: 0, core: '#ffffff', glow: '#ff2e88', trail: '#7b2fff', shape: 'diamond', effect: 'bloom' },
  { id: 'supernova', name: 'Supernova', unlock: 'premium', sku: 'cosmetic.supernova', cost: 0, core: '#fffbe6', glow: '#ffd23f', trail: '#ff5a2e', shape: 'star', effect: 'starburst' },
];

/** Trail styles. `style` picks the renderer's stroke behaviour. */
export const TRAILS = [
  { id: 'comet', name: 'Comet', unlock: 'free', cost: 0, style: 'comet', desc: 'A soft wake behind you.' },
  { id: 'ribbon', name: 'Ribbon', unlock: 'shards', cost: 400, style: 'ribbon', desc: 'One clean line, no bloom.' },
  { id: 'sparks', name: 'Sparks', unlock: 'shards', cost: 700, style: 'sparks', desc: 'Embers that fall away.' },
  { id: 'prism', name: 'Prism', unlock: 'shards', cost: 1100, style: 'prism', desc: 'Split into three colours.' },
  { id: 'pulse', name: 'Pulse', unlock: 'achievement', achievement: 'perfect_10', cost: 0, style: 'pulse', desc: 'Beats with your multiplier.' },
  { id: 'voidline', name: 'Voidline', unlock: 'achievement', achievement: 'orbs_100', cost: 0, style: 'voidline', desc: 'A thin dark cut through the light.' },
];

/**
 * PERFECT effects. `zone` is the default and the best one: it lets every zone
 * keep its own signature. The rest override it everywhere.
 */
export const EFFECTS = [
  { id: 'zone', name: 'Native', unlock: 'free', cost: 0, desc: 'Each zone keeps its own signature.' },
  { id: 'ring', name: 'Ring', unlock: 'shards', cost: 350, desc: 'A single clean shockring.' },
  { id: 'starburst', name: 'Starburst', unlock: 'shards', cost: 650, desc: 'Eight spokes of light.' },
  { id: 'shockwave', name: 'Shockwave', unlock: 'shards', cost: 1000, desc: 'A heavy double pulse.' },
  { id: 'bloom', name: 'Bloom', unlock: 'achievement', achievement: 'mult_5', cost: 0, desc: 'A slow petal of light.' },
  { id: 'novaburst', name: 'Novaburst', unlock: 'achievement', achievement: 'zone_5', cost: 0, desc: 'A collapsing star.' },
];

export const COSMETIC_KINDS = [
  { id: 'skin', label: 'SKINS', items: SKINS, owned: 'ownedSkins', equipped: 'skin' },
  { id: 'trail', label: 'TRAILS', items: TRAILS, owned: 'ownedTrails', equipped: 'trail' },
  { id: 'effect', label: 'EFFECTS', items: EFFECTS, owned: 'ownedEffects', equipped: 'effect' },
];

export const skinById = (id) => SKINS.find((s) => s.id === id) || SKINS[0];
export const trailById = (id) => TRAILS.find((t) => t.id === id) || TRAILS[0];
export const effectById = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS[0];

// ---------------------------------------------------------- achievements ---

/**
 * Twelve, no more. Each is checked against the lifetime profile after a run,
 * so they are deterministic and cannot be triggered from the UI.
 */
export const ACHIEVEMENTS = [
  { id: 'first_perfect', name: 'Dead Centre', desc: 'Land your first PERFECT', reward: 50, test: (p) => p.totalPerfects >= 1 },
  { id: 'perfect_10', name: 'Precision', desc: 'Land 10 PERFECTs', reward: 100, test: (p) => p.totalPerfects >= 10 },
  { id: 'perfect_100', name: 'Surgeon', desc: 'Land 100 PERFECTs', reward: 400, test: (p) => p.totalPerfects >= 100 },
  { id: 'zone_3', name: 'Into the Fire', desc: 'Reach Zone 3', reward: 80, test: (p) => p.bestZone >= 2 },
  { id: 'zone_5', name: 'Unstable', desc: 'Reach Zone 5', reward: 150, test: (p) => p.bestZone >= 4 },
  { id: 'zone_8', name: 'The Void', desc: 'Reach Zone 8', reward: 500, test: (p) => p.bestZone >= 7 },
  { id: 'mult_5', name: 'Momentum', desc: 'Reach a x5 multiplier', reward: 120, test: (p) => p.bestMultiplier >= 5 },
  { id: 'mult_8', name: 'Overdrive', desc: 'Reach x8 — full OVERDRIVE', reward: 400, test: (p) => p.bestMultiplier >= 8 },
  { id: 'orbs_100', name: 'Collector', desc: 'Collect 100 orbs', reward: 150, test: (p) => p.totalOrbs >= 100 },
  { id: 'greed_50', name: 'No Guts', desc: 'Take 50 greed orbs', reward: 250, test: (p) => p.totalGreedOrbs >= 50 },
  { id: 'no_shield', name: 'Bare Handed', desc: 'Reach Zone 3 without taking a shield', reward: 200, test: (p) => p.noShieldZone >= 2 },
  { id: 'daily_done', name: 'Regular', desc: 'Finish a Daily Run', reward: 100, test: (p) => p.dailyRuns >= 1 },
];

export const achievementById = (id) => ACHIEVEMENTS.find((a) => a.id === id);

// -------------------------------------------------------------- missions ---

/**
 * Mission templates. `make` returns a concrete mission for the day; `scope`
 * says whether progress is a peak within one run or a total across the day.
 */
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
    id: 'perfect_run',
    scope: 'run',
    make: (rng) => {
      const target = rng.pick([5, 8, 12]);
      return { text: `Land ${target} PERFECTs in one run`, target, reward: 160 };
    },
  },
  {
    id: 'greed',
    scope: 'total',
    make: (rng) => {
      const target = rng.pick([8, 12, 18]);
      return { text: `Take ${target} greed orbs`, target, reward: 180 };
    },
  },
  {
    id: 'chain',
    scope: 'run',
    make: (rng) => {
      const target = rng.pick([6, 9, 12]);
      return { text: `Chain ${target} orbs without breaking it`, target, reward: 170 };
    },
  },
  {
    id: 'combo',
    scope: 'run',
    make: (rng) => {
      const target = rng.pick([4, 5, 6]);
      return { text: `Reach a x${target} multiplier`, target, reward: 150 };
    },
  },
  {
    id: 'no_shield',
    scope: 'run',
    make: (rng) => {
      const target = rng.pick([2, 3, 4]);
      return { text: `Reach Zone ${target} without a shield`, target, reward: 190 };
    },
  },
  {
    id: 'zone',
    scope: 'run',
    make: (rng) => {
      const target = rng.pick([3, 4, 5]);
      return { text: `Reach Zone ${target}`, target, reward: 140 };
    },
  },
  {
    id: 'orbs',
    scope: 'total',
    make: (rng) => {
      const target = rng.pick([40, 60, 80]);
      return { text: `Collect ${target} orbs`, target, reward: 100 };
    },
  },
  {
    id: 'beat_best',
    scope: 'run',
    make: () => ({ text: 'Beat your personal best', target: 1, reward: 250 }),
  },
];

export const DAILY_REWARDS = [40, 60, 90, 130, 180, 250, 400];

/** Streak milestones. Generous, never punishing — miss a day and you restart. */
export const STREAK_MILESTONES = [
  { days: 3, reward: 150, name: 'Three days' },
  { days: 7, reward: 400, name: 'One week' },
  { days: 14, reward: 900, name: 'Two weeks' },
  { days: 30, reward: 2500, name: 'One month' },
];
