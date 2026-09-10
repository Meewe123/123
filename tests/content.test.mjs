import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ZONES, SKINS, TRAILS, EFFECTS, COSMETIC_KINDS, ACHIEVEMENTS, TUNE, POWERUPS,
  MISSION_TEMPLATES, DAILY_REWARDS, STREAK_MILESTONES, achievementById,
} from '../www/src/game/config.js';
import { EFFECT_IDS } from '../www/src/game/effects.js';
import * as store from '../www/src/engine/storage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEX = /^#[0-9a-f]{6}$/i;

test('every zone is complete and playable', () => {
  assert.equal(ZONES.length, 8, 'eight zones, each with its own atmosphere');
  const ids = new Set();
  for (const zone of ZONES) {
    assert.ok(zone.id && !ids.has(zone.id), `duplicate zone id: ${zone.id}`);
    ids.add(zone.id);
    assert.ok(zone.name && zone.name === zone.name.toUpperCase(), `${zone.id} needs a display name`);
    assert.equal(typeof zone.gaps, 'function');
    assert.ok(zone.gapHalf > 0.2 && zone.gapHalf < Math.PI / 2, `${zone.id} gap size is out of range`);
    assert.ok(zone.rot[0] > 0 && zone.rot[1] > zone.rot[0], `${zone.id} rotation range is invalid`);
    for (const [key, value] of Object.entries(zone.palette)) {
      assert.match(value, HEX, `${zone.id}.${key} is not a hex colour`);
    }
    for (const key of ['sky', 'motes', 'perfect']) {
      assert.ok(zone.fx[key], `${zone.id} is missing fx.${key}`);
    }
    assert.ok(zone.voice, `${zone.id} has no audio voice`);
  }

  const voices = new Set(ZONES.map((z) => z.voice));
  assert.equal(voices.size, ZONES.length, 'no two zones sound the same');
  const skies = new Set(ZONES.map((z) => z.fx.sky));
  assert.equal(skies.size, ZONES.length, 'no two zones look the same');
});

test('a full lap through the zones is long enough to feel like a journey', () => {
  const ringsPerLap = TUNE.zoneLength * ZONES.length;
  assert.ok(ringsPerLap >= 80, `only ${ringsPerLap} rings before the zones repeat`);
});

test('every cosmetic is unique, legible and reachable', () => {
  const shapes = ['orb', 'diamond', 'square', 'star'];
  for (const kind of COSMETIC_KINDS) {
    const ids = new Set();
    let previousCost = -1;
    for (const item of kind.items) {
      assert.ok(!ids.has(item.id), `duplicate ${kind.id} id: ${item.id}`);
      ids.add(item.id);
      assert.ok(item.name.length > 0, `${item.id} needs a name`);
      assert.ok(['free', 'shards', 'achievement', 'premium'].includes(item.unlock),
        `${item.id} has an unknown unlock type: ${item.unlock}`);
      if (item.unlock === 'shards') {
        assert.ok(item.cost > previousCost, `${item.id} breaks the rising price curve`);
        previousCost = item.cost;
      }
      if (item.unlock === 'achievement') {
        assert.ok(achievementById(item.achievement),
          `${item.id} points at a missing achievement: ${item.achievement}`);
      }
      if (item.unlock === 'premium') {
        assert.ok(item.sku, `${item.id} is premium but has no sku`);
      }
    }
    assert.equal(kind.items[0].unlock, 'free', `${kind.id} needs a starter item`);
  }

  for (const skin of SKINS) {
    for (const key of ['core', 'glow', 'trail']) {
      assert.match(skin[key], HEX, `${skin.id}.${key} is not a hex colour`);
    }
    assert.ok(shapes.includes(skin.shape), `${skin.id} has an unknown shape`);
    assert.ok(EFFECT_IDS.includes(skin.effect) || skin.effect === 'zone',
      `${skin.id} points at an unknown PERFECT effect`);
  }

  assert.equal(SKINS.length, 12, 'twelve skins, as designed');
  assert.ok(TRAILS.length >= 4 && EFFECTS.length >= 4, 'trails and effects are real categories');
});

test('every PERFECT effect a zone or cosmetic names actually exists', () => {
  for (const zone of ZONES) {
    assert.ok(EFFECT_IDS.includes(zone.fx.perfect),
      `zone ${zone.id} wants a PERFECT effect that is not implemented: ${zone.fx.perfect}`);
  }
  for (const effect of EFFECTS) {
    if (effect.id === 'zone') continue;
    assert.ok(EFFECT_IDS.includes(effect.id), `effect ${effect.id} has no recipe`);
  }
});

test('achievements are unique, earnable and pay out', () => {
  const ids = new Set();
  const profile = {
    totalPerfects: 1e6, bestZone: 99, bestMultiplier: 99, totalOrbs: 1e6,
    totalGreedOrbs: 1e6, noShieldZone: 99, dailyRuns: 99,
  };
  for (const a of ACHIEVEMENTS) {
    assert.ok(!ids.has(a.id), `duplicate achievement id: ${a.id}`);
    ids.add(a.id);
    assert.ok(a.name && a.desc, `${a.id} needs a name and a description`);
    assert.ok(a.reward > 0, `${a.id} pays nothing`);
    assert.equal(typeof a.test, 'function');
    assert.ok(a.test(profile), `${a.id} is unreachable even for a maxed profile`);
    assert.equal(a.test({}), false, `${a.id} fires on an empty profile`);
  }
  assert.equal(ACHIEVEMENTS.length, 12, 'a compact set, not a checklist');
});

test('every power-up has a label and a colour', () => {
  for (const [id, power] of Object.entries(POWERUPS)) {
    assert.equal(power.id, id);
    assert.ok(power.label.length > 0);
    assert.match(power.color, HEX);
  }
});

test('mission templates produce sane goals', () => {
  const rng = { next: () => 0.5, int: (a, b) => a, range: (a, b) => a, pick: (a) => a[0], chance: () => true, sign: () => 1 };
  for (const tpl of MISSION_TEMPLATES) {
    const spec = tpl.make(rng, 120);
    assert.ok(spec.target > 0, `${tpl.id} target must be positive`);
    assert.ok(spec.reward >= 50, `${tpl.id} reward is too small to matter`);
    assert.ok(spec.text.length > 6, `${tpl.id} needs readable copy`);
  }
  assert.equal(DAILY_REWARDS.length, 7, 'one reward per day of the streak');
  for (let i = 1; i < DAILY_REWARDS.length; i++) {
    assert.ok(DAILY_REWARDS[i] > DAILY_REWARDS[i - 1], 'daily rewards must grow');
  }
});

test('the revive price is meaningful but attainable', () => {
  assert.ok(TUNE.reviveCost > 0);
  const firstBuyable = SKINS.find((s) => s.unlock === 'shards');
  assert.ok(TUNE.reviveCost < firstBuyable.cost, 'a revive should cost less than the first skin');
});

test('streak milestones grow and stay cosmetic-scale', () => {
  let previousDays = 0;
  let previousReward = 0;
  for (const m of STREAK_MILESTONES) {
    assert.ok(m.days > previousDays, 'milestones must be in order');
    assert.ok(m.reward > previousReward, 'later milestones must be worth more');
    previousDays = m.days;
    previousReward = m.reward;
  }
});

test('a corrupt or partial save never breaks the profile', () => {
  assert.deepEqual(store.migrate(null), store.DEFAULT_PROFILE);
  assert.deepEqual(store.migrate('nonsense'), store.DEFAULT_PROFILE);
  assert.deepEqual(store.migrate({}), store.DEFAULT_PROFILE);

  const partial = store.migrate({ version: 2, bestScore: 42, unknownField: 'x', sfx: 'yes' });
  assert.equal(partial.bestScore, 42);
  assert.equal(partial.sfx, true, 'a wrongly-typed value falls back to the default');
  assert.equal('unknownField' in partial, false, 'unknown keys are dropped');
  assert.ok(partial.ownedSkins.includes('flow'));
});

test('an equipped cosmetic the player does not own is reset', () => {
  const p = store.migrate({ version: 2, skin: 'nova', ownedSkins: ['flow'], trail: 'prism', effect: 'bloom' });
  assert.equal(p.skin, 'flow');
  assert.equal(p.trail, 'comet');
  assert.equal(p.effect, 'zone');
});

test('the service worker precaches every shipped source file', () => {
  const sw = readFileSync(resolve(ROOT, 'www/sw.js'), 'utf8');
  const listed = new Set([...sw.matchAll(/'([^']+\.(?:js|css|html|webmanifest))'/g)].map((m) => m[1]));
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.js')) {
        assert.ok(listed.has(`${prefix}${entry.name}`),
          `${prefix}${entry.name} is missing from the service worker precache list`);
      }
    }
  };
  walk('www/src', 'src/');
  for (const shell of ['index.html', 'styles/main.css', 'manifest.webmanifest']) {
    assert.ok(listed.has(shell), `${shell} is missing from the precache list`);
  }
});

test('every icon the app references actually exists', () => {
  const html = readFileSync(resolve(ROOT, 'www/index.html'), 'utf8');
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'www/manifest.webmanifest'), 'utf8'));
  const referenced = new Set([
    ...[...html.matchAll(/href="(assets\/icons\/[^"]+)"/g)].map((m) => m[1]),
    ...manifest.icons.map((i) => i.src),
  ]);
  assert.ok(referenced.size > 0);
  for (const src of referenced) {
    assert.ok(existsSync(resolve(ROOT, 'www', src)), `${src} is referenced but missing`);
  }
});

test('the iOS asset catalog sizes are all generated', () => {
  const needed = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];
  for (const size of needed) {
    assert.ok(existsSync(resolve(ROOT, `www/assets/icons/icon-${size}.png`)),
      `icon-${size}.png is required by the iOS asset catalog`);
  }
});
