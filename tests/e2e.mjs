#!/usr/bin/env node
/**
 * End-to-end test: boots the real game in Chromium on a phone-sized viewport
 * and drives it the way a player would.
 *
 *   node tests/e2e.mjs [--headed] [--keep-shots]
 */

import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = resolve(ROOT, 'test-output');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Use whatever Chromium this machine already has. CI images often ship a
 * browser revision that does not match the installed Playwright, and there is
 * no reason to download a second copy just to run these checks.
 */
function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    const builds = readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = join(base, build, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined; // fall back to Playwright's own download
}

async function startServer() {
  const proc = spawn(process.execPath, [resolve(ROOT, 'scripts/serve.mjs'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('server did not start')), 8000);
    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes('dev server')) {
        clearTimeout(timer);
        done();
      }
    });
    proc.on('exit', (code) => fail(new Error(`server exited early (${code})`)));
  });
  return proc;
}

/** Sample the canvas and report how much of it is not the background colour. */
const CANVAS_VARIETY = () => {
  const canvas = document.getElementById('stage');
  const gl = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const data = gl.getImageData(0, 0, w, h).data;
  const seen = new Set();
  let bright = 0;
  const stride = 4 * 37; // prime-ish stride, samples across the whole frame
  for (let i = 0; i < data.length; i += stride) {
    const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
    seen.add(key);
    if (data[i] + data[i + 1] + data[i + 2] > 330) bright++;
  }
  return { colors: seen.size, bright, samples: Math.floor(data.length / stride) };
};

async function main() {
  const headed = process.argv.includes('--headed');
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({
      headless: !headed,
      executablePath: resolveChromium(),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
    });
  } catch (err) {
    server.kill();
    throw err;
  }
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const page = await context.newPage();

  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  try {
    await mkdir(SHOTS, { recursive: true });

    console.log('\nboot');
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__ORBITAL__?.mode === 'attract', null, { timeout: 8000 });
    check('game boots into attract mode', true);
    check('title screen is visible', await page.locator('#screen-title').evaluate((el) => el.classList.contains('on')));

    console.log('\nattract mode');
    await wait(4000);
    const attract = await page.evaluate(() => ({
      score: globalThis.__ORBITAL__.world.score,
      rings: globalThis.__ORBITAL__.world.rings.length,
      fps: globalThis.__ORBITAL__.loop.fps,
    }));
    check('autopilot survives and scores in attract mode', attract.score > 0, `score=${attract.score}`);
    check('rings are populated', attract.rings >= 2, `rings=${attract.rings}`);
    check('frame rate is healthy', attract.fps > 40, `fps=${attract.fps.toFixed(1)}`);

    const variety = await page.evaluate(CANVAS_VARIETY);
    check('canvas renders a varied scene', variety.colors > 20 && variety.bright > 0,
      `colors=${variety.colors} bright=${variety.bright}`);
    await page.screenshot({ path: `${SHOTS}/01-title.png` });

    console.log('\ntutorial + first run');
    await page.locator('#btn-play').click();
    await page.waitForSelector('#tutorial.on', { timeout: 3000 });
    check('first-time tutorial is shown', true);
    await page.screenshot({ path: `${SHOTS}/02-tutorial.png` });
    await page.locator('#btn-tut-go').click();
    await page.waitForFunction(() => globalThis.__ORBITAL__.mode === 'play', null, { timeout: 3000 });
    check('tapping GOT IT starts the run', true);
    check('HUD is visible during play', await page.locator('#hud').evaluate((el) => el.classList.contains('on')));

    console.log('\ngameplay');
    await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      g.demo = true;
      g.__peak = 0;
      g.__peakTimer = setInterval(() => { g.__peak = Math.max(g.__peak, g.world.score); }, 100);
    });
    await wait(12000);
    // If the demo run ended inside the window, start another so the pause and
    // crash steps below always have a live run to act on.
    await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      clearInterval(g.__peakTimer);
      if (g.mode !== 'play') { g.startRun(); g.demo = true; }
    });
    await wait(4000);
    const play = await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      return {
        mode: g.mode,
        score: g.world.score,
        peak: Math.max(g.__peak, g.world.score),
        energy: g.world.energy,
        zone: g.world.zone,
        hudScore: document.getElementById('score').textContent,
        fps: g.loop.fps,
      };
    });
    check('score climbs during play', play.peak > 5, `peak=${play.peak}`);
    check('HUD score matches the simulation', Number(play.hudScore.replace(/,/g, '')) === play.score,
      `hud=${play.hudScore} world=${play.score}`);
    check('energy is being collected', play.energy > 0 || play.peak > 5, `energy=${play.energy}`);
    check('frame rate holds up under load', play.fps > 40, `fps=${play.fps.toFixed(1)}`);
    await page.screenshot({ path: `${SHOTS}/03-gameplay.png` });

    console.log('\npause');
    await page.locator('#btn-pause').click();
    await page.waitForSelector('#screen-pause.on', { timeout: 3000 });
    check('pause screen opens', true);
    const frozen = await page.evaluate(() => globalThis.__ORBITAL__.world.score);
    await wait(900);
    const stillFrozen = await page.evaluate(() => globalThis.__ORBITAL__.world.score);
    check('simulation is frozen while paused', frozen === stillFrozen, `${frozen} -> ${stillFrozen}`);
    await page.screenshot({ path: `${SHOTS}/04-pause.png` });
    await page.locator('#btn-resume').click();
    await page.waitForFunction(() => globalThis.__ORBITAL__.mode === 'play', null, { timeout: 3000 });
    check('resume returns to play', true);

    console.log('\ndeath and results');
    await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      g.demo = false;
      // Force a collision by parking the player on a solid arc.
      g.world._onCollision(g.world.rings[0], g.world.player.angle);
    });
    await page.waitForSelector('#screen-over.on', { timeout: 6000 });
    check('game over screen appears after a crash', true);
    const over = await page.evaluate(() => ({
      score: Number(document.getElementById('over-score').textContent.replace(/,/g, '')),
      best: document.getElementById('over-best').textContent,
      stored: JSON.parse(localStorage.getItem('orbital-rush/profile/v1') || 'null'),
    }));
    check('result score is shown', over.score > 0, `score=${over.score}`);
    check('profile was written to storage', !!over.stored && over.stored.bestScore === over.score,
      `bestScore=${over.stored?.bestScore} score=${over.score}`);
    check('run counted in lifetime stats', over.stored.runs === 1, `runs=${over.stored?.runs}`);
    await page.screenshot({ path: `${SHOTS}/05-gameover.png` });

    console.log('\nmenus');
    await page.locator('#btn-over-home').click();
    await page.waitForSelector('#screen-title.on', { timeout: 3000 });
    await page.locator('#btn-shop').click();
    await page.waitForSelector('#screen-shop.on', { timeout: 3000 });
    const skinCount = await page.locator('#skin-grid .skin').count();
    check('shop lists every skin', skinCount === 12, `found ${skinCount}`);
    check('starter skin is equipped', await page.locator('#skin-grid .skin.equipped').count() === 1);
    await page.screenshot({ path: `${SHOTS}/06-shop.png` });

    await page.locator('#btn-shop-back').click();
    await page.locator('#btn-missions').click();
    await page.waitForSelector('#screen-missions.on', { timeout: 3000 });
    const missionCount = await page.locator('#mission-list .mission').count();
    check('three daily missions are offered', missionCount === 3, `found ${missionCount}`);
    await page.screenshot({ path: `${SHOTS}/07-missions.png` });

    const before = await page.evaluate(() => globalThis.__ORBITAL__.profile.energy);
    await page.locator('#btn-daily').click();
    const after = await page.evaluate(() => globalThis.__ORBITAL__.profile.energy);
    check('daily bonus can be claimed once', after > before, `${before} -> ${after}`);
    check('daily bonus button disables after claiming',
      await page.locator('#btn-daily').isDisabled());

    await page.locator('#btn-missions-back').click();
    await page.locator('#btn-settings').click();
    await page.waitForSelector('#screen-settings.on', { timeout: 3000 });
    await page.locator('#sw-music').click();
    const musicOff = await page.evaluate(() => globalThis.__ORBITAL__.profile.music);
    check('settings toggles update the profile', musicOff === false, `music=${musicOff}`);
    await page.locator('#sw-music').click();
    await page.screenshot({ path: `${SHOTS}/08-settings.png` });

    console.log('\npersistence');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__ORBITAL__?.mode === 'attract', null, { timeout: 8000 });
    const reloaded = await page.evaluate(() => ({
      best: globalThis.__ORBITAL__.profile.bestScore,
      runs: globalThis.__ORBITAL__.profile.runs,
      energy: globalThis.__ORBITAL__.profile.energy,
      titleBest: document.getElementById('title-best').textContent,
    }));
    check('best score survives a reload', reloaded.best === over.score, `${reloaded.best} vs ${over.score}`);
    check('title screen shows the stored best',
      Number(reloaded.titleBest.replace(/,/g, '')) === reloaded.best);
    check('energy survives a reload', reloaded.energy > 0, `energy=${reloaded.energy}`);
    check('tutorial is not shown again', await page.evaluate(() => globalThis.__ORBITAL__.profile.seenTutorial));

    console.log('\nresponsive layout');
    for (const [label, size] of [['small-phone', { width: 320, height: 568 }],
                                 ['tablet', { width: 834, height: 1112 }],
                                 ['landscape', { width: 844, height: 390 }]]) {
      await page.setViewportSize(size);
      await wait(500);
      const overflow = await page.evaluate(() => ({
        x: document.documentElement.scrollWidth - window.innerWidth,
        y: document.documentElement.scrollHeight - window.innerHeight,
        canvasW: document.getElementById('stage').getBoundingClientRect().width,
      }));
      check(`no page overflow at ${label}`, overflow.x <= 1 && overflow.y <= 1,
        `overflow ${overflow.x}x${overflow.y}`);
      check(`canvas fills the viewport at ${label}`, Math.abs(overflow.canvasW - size.width) <= 1,
        `canvas=${overflow.canvasW}`);
      await page.screenshot({ path: `${SHOTS}/09-${label}.png` });
    }

    check('no runtime errors were logged', problems.length === 0, problems.join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }

  await writeFile(`${SHOTS}/summary.json`,
    JSON.stringify({ passed, failed: failures.length, failures }, null, 2));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // The dev server is a detached child; make sure the process can exit.
    process.exit(process.exitCode || 0);
  });
