#!/usr/bin/env node
/**
 * Render the App Store screenshot sets straight from the running game.
 *
 *   node tools/screenshots.mjs
 *
 * Output lands in store/screenshots/<device>/. Sizes are the exact pixel
 * dimensions App Store Connect accepts, produced by pairing the device's
 * logical viewport with its device pixel ratio — so these are real frames, not
 * upscaled ones.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'store/screenshots');
const PORT = 8210;

const DEVICES = [
  { id: '6.9-inch', label: 'iPhone 17 Pro Max class', width: 440, height: 956, dpr: 3 },   // 1320 x 2868
  { id: '6.5-inch', label: 'iPhone 11 Pro Max class', width: 414, height: 896, dpr: 3 },   // 1242 x 2688
  { id: 'ipad-13', label: 'iPad Pro 13"', width: 1032, height: 1376, dpr: 2 },             // 2064 x 2752
];

/**
 * Each scene sets the game up, lets it breathe for a beat, then is captured.
 * `setup` runs inside the page.
 */
const SCENES = [
  {
    name: '1-title',
    settle: 2600,
    setup: () => {
      const g = globalThis.__ORBITAL__;
      g.profile.bestScore = 428;
      g.profile.seenTutorial = true;
      g.ui.refreshTitle();
      g.world.reset(20260910);
      g.world.jumpTo(30);
    },
  },
  {
    name: '2-first-run',
    settle: 3400,
    setup: () => {
      const g = globalThis.__ORBITAL__;
      g.profile.seenTutorial = true;
      g.profile.skin = 'aurora';
      g.startRun();
      g.demo = true;
      g.world.jumpTo(17);
    },
    pose: () => {
      const g = globalThis.__ORBITAL__;
      g.world.combo = 9;
    },
  },
  {
    name: '3-chain',
    settle: 3200,
    setup: () => {
      const g = globalThis.__ORBITAL__;
      g.profile.ownedSkins.push('plasma');
      g.profile.skin = 'plasma';
      g.world.jumpTo(4 * 14 + 6);
      g.world._grantPower('double');
    },
    pose: () => {
      const g = globalThis.__ORBITAL__;
      g.world.combo = 31;
      g.world.energy = 214;
    },
  },
  {
    name: '4-storm-zone',
    settle: 3000,
    setup: () => {
      const g = globalThis.__ORBITAL__;
      g.profile.ownedSkins.push('cobalt');
      g.profile.skin = 'cobalt';
      g.world.jumpTo(6 * 14 + 5);
      g.world._grantPower('shield');
      g.ui.showZone(6, 0);
    },
    pose: () => {
      const g = globalThis.__ORBITAL__;
      g.world.combo = 22;
      g.world.energy = 361;
    },
  },
  {
    name: '5-skins',
    settle: 900,
    setup: () => {
      const g = globalThis.__ORBITAL__;
      g.demo = false;
      g.profile.energy = 5200;
      g.profile.ownedSkins = ['aurora', 'ember', 'orchid', 'lime', 'cobalt', 'solar', 'void'];
      g.profile.skin = 'solar';
      g.toTitle();
      g.ui.show('shop');
    },
  },
  {
    name: '6-daily',
    settle: 900,
    setup: () => {
      const g = globalThis.__ORBITAL__;
      g.profile.streak = 5;
      g.profile.missions.forEach((m, i) => { m.progress = i === 0 ? m.target : Math.floor(m.target * 0.55); });
      g.ui.show('missions');
    },
  },
];

function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    const builds = readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const candidate = join(base, build, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, [resolve(ROOT, 'scripts/serve.mjs'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((done) => server.stdout.on('data', () => done()));

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });

  try {
    for (const device of DEVICES) {
      const dir = resolve(OUT, device.id);
      await mkdir(dir, { recursive: true });
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.dpr,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => globalThis.__ORBITAL__?.mode === 'attract', null, { timeout: 8000 });
      // Silence is golden in a headless render.
      await page.evaluate(() => {
        globalThis.__ORBITAL__.profile.music = false;
        globalThis.__ORBITAL__.profile.sfx = false;
      });

      for (const scene of SCENES) {
        await page.evaluate(scene.setup);
        await wait(scene.settle);
        if (scene.pose) {
          // Applied at the last moment so the demo run cannot undo it.
          await page.evaluate(scene.pose);
          await wait(140);
        }
        const file = resolve(dir, `${scene.name}.png`);
        await page.screenshot({ path: file });
        console.log(`${device.id.padEnd(10)} ${scene.name.padEnd(14)} ${device.width * device.dpr}x${device.height * device.dpr}`);
      }
      await context.close();
    }
    console.log(`\nScreenshots written to ${OUT}`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
