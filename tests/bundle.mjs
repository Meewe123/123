#!/usr/bin/env node
/**
 * Checks the single-file build: it must boot straight off the filesystem,
 * play, and never touch the network.
 *
 *   node tests/bundle.mjs
 */

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'dist/orbital-rush.html');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  console.log('\nbuilding');
  const build = spawnSync(process.execPath, [resolve(ROOT, 'scripts/build-single.mjs')], { encoding: 'utf8' });
  check('the bundler runs cleanly', build.status === 0, build.stderr?.trim());
  check('the bundle exists', existsSync(FILE));
  if (!existsSync(FILE)) return;

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  const problems = [];
  const external = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (req) => {
    if (!req.url().startsWith('file://')) external.push(req.url());
  });

  try {
    console.log('\nrunning from the filesystem');
    await page.goto(`file://${FILE}`, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__ORBITAL__?.mode === 'attract', null, { timeout: 8000 });
    check('the single file boots with no server', true);

    await wait(4000);
    const attract = await page.evaluate(() => ({
      score: globalThis.__ORBITAL__.world.score,
      fps: globalThis.__ORBITAL__.loop.fps,
    }));
    check('the demo plays on the title screen', attract.score > 0, `score=${attract.score}`);
    // Software-rasterised headless Chromium sits around 35 fps; this is a
    // liveness check on the loop, not a performance benchmark.
    check('the loop keeps a sane frame rate', attract.fps > 25, `fps=${attract.fps.toFixed(1)}`);

    console.log('\nplaying');
    await page.evaluate(() => { globalThis.__ORBITAL__.profile.seenTutorial = true; });
    await page.locator('#btn-play').click();
    await page.waitForFunction(() => globalThis.__ORBITAL__.mode === 'play', null, { timeout: 3000 });
    // Track the best the demo reached rather than whatever the clock lands on,
    // so a demo run that ends early cannot flake the assertion.
    await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      g.demo = true;
      g.__peak = { score: 0, energy: 0 };
      g.__peakTimer = setInterval(() => {
        g.__peak.score = Math.max(g.__peak.score, g.world.score);
        g.__peak.energy = Math.max(g.__peak.energy, g.world.energy);
      }, 100);
    });
    await wait(12000);
    const play = await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      clearInterval(g.__peakTimer);
      return g.__peak;
    });
    check('a run scores', play.score > 3, `score=${play.score}`);
    check('energy is collected', play.energy > 0, `energy=${play.energy}`);

    const before = await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      g.demo = false;
      if (g.mode !== 'play') g.startRun();
      return g.world.player.dir;
    });
    await page.locator('#stage').tap();
    const after = await page.evaluate(() => globalThis.__ORBITAL__.world.player.dir);
    check('tapping reverses the orbit', before === -after, `${before} -> ${after}`);

    await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      if (g.mode === 'play') g.world._onCollision(g.world.rings[0], g.world.player.angle);
    });
    await page.waitForSelector('#screen-over.on', { timeout: 6000 });
    check('the result screen appears', true);

    console.log('\nisolation');
    check('nothing is fetched from the network', external.length === 0, external.slice(0, 3).join(', '));
    check('no runtime errors', problems.length === 0, problems.join(' | '));
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
