import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZONES, SKINS, TUNE, POWERUPS, MISSION_TEMPLATES, DAILY_REWARDS } from '../www/src/game/config.js';
import * as store from '../www/src/engine/storage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEX = /^#[0-9a-f]{6}$/i;

test('every zone is complete and playable', () => {
  assert.ok(ZONES.length >= 6, 'enough visual variety to keep a long run interesting');
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
  }
});

test('a full lap through the zones is long enough to feel like a journey', () => {
  const ringsPerLap = TUNE.zoneLength * ZONES.length;
  assert.ok(ringsPerLap >= 80, `only ${ringsPerLap} rings before the zones repeat`);
});

test('skins are unique and priced on a rising curve', () => {
  const ids = new Set();
  let previousCost = -1;
  for (const skin of SKINS) {
    assert.ok(!ids.has(skin.id), `duplicate skin id: ${skin.id}`);
    ids.add(skin.id);
    assert.ok(skin.name.length > 0);
    assert.ok(skin.cost >= previousCost, `${skin.id} breaks the rising price curve`);
    previousCost = skin.cost;
    for (const key of ['core', 'glow', 'trail']) {
      assert.match(skin[key], HEX, `${skin.id}.${key} is not a hex colour`);
    }
    assert.ok(['orb', 'diamond', 'square', 'star'].includes(skin.shape), `${skin.id} has an unknown shape`);
  }
  assert.equal(SKINS[0].cost, 0, 'the starter skin is free');
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
  assert.ok(TUNE.reviveCost < SKINS[1].cost, 'a revive should cost less than the first skin');
});

test('a corrupt or partial save never breaks the profile', () => {
  assert.deepEqual(store.migrate(null), store.DEFAULT_PROFILE);
  assert.deepEqual(store.migrate('nonsense'), store.DEFAULT_PROFILE);
  assert.deepEqual(store.migrate({}), store.DEFAULT_PROFILE);

  const partial = store.migrate({ bestScore: 42, unknownField: 'x', sfx: 'yes' });
  assert.equal(partial.bestScore, 42);
  assert.equal(partial.sfx, true, 'a wrongly-typed value falls back to the default');
  assert.equal('unknownField' in partial, false, 'unknown keys are dropped');
  assert.ok(partial.ownedSkins.includes('aurora'));
});

test('an equipped skin the player does not own is reset', () => {
  const p = store.migrate({ skin: 'nova', ownedSkins: ['aurora'] });
  assert.equal(p.skin, 'aurora');
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
