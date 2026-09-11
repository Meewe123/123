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
    // Software-rasterised headless Chromium sits around 35 fps; these are
    // liveness checks on the loop, not performance benchmarks.
    check('the loop keeps a sane frame rate', attract.fps > 25, `fps=${attract.fps.toFixed(1)}`);

    const variety = await page.evaluate(CANVAS_VARIETY);
    check('canvas renders a varied scene', variety.colors > 20 && variety.bright > 0,
      `colors=${variety.colors} bright=${variety.bright}`);
    await page.screenshot({ path: `${SHOTS}/01-title.png` });

    console.log('\nfirst run');
    await page.locator('#btn-play').click();
    await page.waitForFunction(() => globalThis.__ORBITAL__.mode === 'play', null, { timeout: 3000 });
    check('PLAY starts a run immediately — no tutorial gate', true);
    check('HUD is visible during play', await page.locator('#hud').evaluate((el) => el.classList.contains('on')));
    check('the first run coaches the control in one line',
      await page.locator('#coach').evaluate((el) => el.classList.contains('on') && el.textContent.length > 0));
    await page.screenshot({ path: `${SHOTS}/02-first-run.png` });

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
        shards: g.world.shards,
        orbs: g.world.orbsCollected,
        multiplier: g.world.multiplier,
        zone: g.world.zone,
        hudScore: document.getElementById('score').textContent,
        fps: g.loop.fps,
      };
    });
    check('score climbs during play', play.peak > 5, `peak=${play.peak}`);
    check('HUD score matches the simulation', Number(play.hudScore.replace(/,/g, '')) === play.score,
      `hud=${play.hudScore} world=${play.score}`);
    check('shards are being collected', play.shards > 0 || play.peak > 5, `shards=${play.shards}`);
    check('the loop holds up under load', play.fps > 25, `fps=${play.fps.toFixed(1)}`);
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
      zone: document.getElementById('over-zone').textContent,
      mult: document.getElementById('over-mult').textContent,
      perfects: document.getElementById('over-perfects').textContent,
      orbs: document.getElementById('over-orbs').textContent,
      greed: document.getElementById('over-greed').textContent,
      missions: document.querySelectorAll('#over-missions .mission').length,
      stored: JSON.parse(localStorage.getItem('orbital-rush/profile/v1') || 'null'),
    }));
    check('result score is shown', over.score > 0, `score=${over.score}`);
    check('the summary reports the whole run',
      over.zone !== '' && over.mult.startsWith('x') && over.perfects !== '' && over.orbs !== '',
      `zone=${over.zone} mult=${over.mult} perfects=${over.perfects} orbs=${over.orbs}`);
    check('safe vs greed is broken out', /greed/i.test(over.greed), over.greed);
    check('missions are shown on the summary', over.missions === 3, `found ${over.missions}`);
    check('profile was written to storage', !!over.stored && over.stored.bestScore === over.score,
      `bestScore=${over.stored?.bestScore} score=${over.score}`);
    check('run counted in lifetime stats', over.stored.runs === 1, `runs=${over.stored?.runs}`);
    check('save is on the current schema', over.stored.version === 2, `version=${over.stored?.version}`);
    check('the daily login bonus was granted', over.stored.shards > 0, `shards=${over.stored?.shards}`);
    await page.screenshot({ path: `${SHOTS}/05-gameover.png` });

    console.log('\ninstant retry');
    const retryStart = Date.now();
    await page.locator('#btn-again').click();
    await page.waitForFunction(() => globalThis.__ORBITAL__.mode === 'play', null, { timeout: 3000 });
    check('TRY AGAIN is back in play in under a second', Date.now() - retryStart < 1000,
      `${Date.now() - retryStart}ms`);
    await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      g.world._onCollision(g.world.rings[0], g.world.player.angle);
    });
    await page.waitForSelector('#screen-over.on', { timeout: 6000 });

    console.log('\nmenus');
    await page.locator('#btn-over-home').click();
    await page.waitForSelector('#screen-title.on', { timeout: 3000 });
    await page.locator('#btn-shop').click();
    await page.waitForSelector('#screen-shop.on', { timeout: 3000 });
    // This build ships no billing bridge, so the two premium skins are not
    // offered at all. Dangling an item nobody can buy is worse than not having
    // it; they come back by themselves the day a store exists.
    const sellable = await page.evaluate(() => globalThis.__ORBITAL__.purchases.available);
    const expectedSkins = sellable ? 12 : 10;
    const skinCount = await page.locator('#shop-grid .skin').count();
    check('shop lists every skin this build can hand over',
      skinCount === expectedSkins, `found ${skinCount}, expected ${expectedSkins}`);
    check('nothing is marked PREMIUM when there is no store to buy from',
      sellable || !/PREMIUM/i.test(await page.locator('#shop-grid').innerText()));
    check('starter skin is equipped', await page.locator('#shop-grid .skin.equipped').count() === 1);
    check('the shop has three categories', await page.locator('#shop-tabs .tab').count() === 3);
    // Scan the item cards, not the footer — the footer says "no loot boxes",
    // which is the promise, not a violation of it.
    check('no loot boxes, chests or countdowns among the shop items',
      !/chest|crate|loot|timer|hurry|only \d+ left|ends in/i.test(
        await page.locator('#shop-grid').innerText(),
      ));
    await page.screenshot({ path: `${SHOTS}/06-shop.png` });

    await page.locator('#shop-tabs .tab').nth(1).click();
    const trailCount = await page.locator('#shop-grid .skin').count();
    check('the trails tab has its own items', trailCount >= 4 && trailCount !== skinCount,
      `found ${trailCount}`);

    await page.locator('#btn-shop-back').click();
    await page.locator('#btn-daily-open').click();
    await page.waitForSelector('#screen-daily.on', { timeout: 3000 });
    const missionCount = await page.locator('#mission-list .mission').count();
    check('three daily missions are offered', missionCount === 3, `found ${missionCount}`);
    check('the daily seed is shown', /^#\d{5}$/.test(await page.locator('#daily-seed').innerText()));
    check('the local board is labelled honestly',
      !/world|global|everyone else/i.test(await page.locator('#screen-daily').innerText()));
    await page.screenshot({ path: `${SHOTS}/07-daily.png` });

    console.log('\ndaily run');
    await page.locator('#btn-daily-play').click();
    await page.waitForFunction(() => globalThis.__ORBITAL__.mode === 'play', null, { timeout: 3000 });
    const dailyState = await page.evaluate(async () => {
      const g = globalThis.__ORBITAL__;
      const { dailySeedFor } = await import('./src/game/daily.js');
      return { mode: g.runMode, seed: g.world.seed, expected: dailySeedFor() };
    });
    check('the daily run uses the date-derived seed',
      dailyState.mode === 'daily' && dailyState.seed === dailyState.expected,
      `${dailyState.seed} vs ${dailyState.expected}`);
    await page.evaluate(() => {
      const g = globalThis.__ORBITAL__;
      g.world._onCollision(g.world.rings[0], g.world.player.angle);
    });
    await page.waitForSelector('#screen-over.on', { timeout: 6000 });
    check('the daily summary is labelled as such',
      (await page.locator('#over-mode').innerText()).includes('DAILY'));
    check('a daily run cannot be revived', await page.locator('#btn-revive').evaluate((el) => el.classList.contains('hidden')));
    await page.locator('#btn-over-home').click();

    console.log('\ncollection');
    await page.locator('#btn-collection').click();
    await page.waitForSelector('#screen-collection.on', { timeout: 3000 });
    const expectedChips = sellable ? 24 : 22;
    const chipCount = await page.locator('#collection-grid .chip').count();
    check('the collection lists every cosmetic this build can hand over',
      chipCount === expectedChips, `found ${chipCount}, expected ${expectedChips}`);
    check('the collection total matches what it lists',
      (await page.locator('#collection-count').innerText()).endsWith(`/${expectedChips}`),
      await page.locator('#collection-count').innerText());
    check('achievements are listed', await page.locator('#achievement-list .ach').count() === 12);
    await page.screenshot({ path: `${SHOTS}/08-collection.png` });

    await page.locator('#btn-collection-back').click();
    await page.locator('#btn-settings').click();
    await page.waitForSelector('#screen-settings.on', { timeout: 3000 });
    await page.locator('#sw-music').click();
    const musicOff = await page.evaluate(() => globalThis.__ORBITAL__.profile.music);
    check('settings toggles update the profile', musicOff === false, `music=${musicOff}`);
    await page.locator('#sw-music').click();
    check('no advertising anywhere in the app',
      !/\bads?\b(?!\.)|advert|sponsor/i.test(
        (await page.locator('#screen-settings').innerText()).replace(/NO ADS\. JUST PLAY\./i, ''),
      ));
    await page.screenshot({ path: `${SHOTS}/09-settings.png` });

    console.log('\npersistence');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__ORBITAL__?.mode === 'attract', null, { timeout: 8000 });
    const reloaded = await page.evaluate(() => ({
      best: globalThis.__ORBITAL__.profile.bestScore,
      runs: globalThis.__ORBITAL__.profile.runs,
      shards: globalThis.__ORBITAL__.profile.shards,
      coached: (globalThis.__ORBITAL__.profile.tutorialSeen || []).length,
      titleBest: document.getElementById('title-best').textContent,
    }));
    check('best score survives a reload', reloaded.best >= over.score, `${reloaded.best} vs ${over.score}`);
    check('title screen shows the stored best',
      Number(reloaded.titleBest.replace(/,/g, '')) === reloaded.best);
    check('shards survive a reload', reloaded.shards > 0, `shards=${reloaded.shards}`);
    check('coaching lines are not repeated', reloaded.coached > 0, `seen=${reloaded.coached}`);

    console.log('\naccessibility and practice');
    // Sound: the failure that used to be invisible. A refused unlock must not be
    // remembered as success, and when it is genuinely refused the player has to
    // be told rather than left with toggles that claim everything is on.
    await page.locator('#btn-settings').click();
    await page.waitForSelector('#screen-settings.on', { timeout: 3000 });
    await wait(400);
    const audio = await page.evaluate(() => ({
      running: globalThis.__ORBITAL__.audio.running,
      blocked: globalThis.__ORBITAL__.audio.blocked,
      tries: globalThis.__ORBITAL__._audioTries,
    }));
    // After a real gesture the context exists, so it is either running or
    // refused — never both, and never neither.
    check('audio reports its real state after a gesture',
      audio.running !== audio.blocked, JSON.stringify(audio));
    await page.evaluate(() => globalThis.__ORBITAL__.ui.refreshSettings());
    check('the blocked-sound notice matches whether sound is blocked',
      (await page.locator('#audio-blocked').isVisible()) === audio.blocked,
      `blocked=${audio.blocked}`);

    await page.locator('#sw-colorsafe').click();
    await wait(150);
    check('colour-safe mode reaches the renderer',
      await page.evaluate(() => globalThis.__ORBITAL__.renderer.colorSafe === true
        && globalThis.__ORBITAL__.profile.colorSafe === true));
    await page.locator('#sw-colorsafe').click();
    await wait(150);
    await page.locator('#btn-settings-back').click();
    await page.waitForSelector('#screen-title.on', { timeout: 3000 });

    check('the home screen names a next goal',
      (await page.locator('#next-goal').isVisible())
      && (await page.locator('#ng-name').innerText()).length > 3,
      await page.locator('#ng-name').innerText());

    const beforePractice = await page.evaluate(() => ({
      best: globalThis.__ORBITAL__.profile.bestScore,
      runs: globalThis.__ORBITAL__.profile.runs,
      shards: globalThis.__ORBITAL__.profile.shards,
    }));
    await page.locator('#btn-practice').click();
    await wait(400);
    check('practice is marked on screen',
      await page.locator('#practice-badge').isVisible());
    check('practice hides the run total it never banks',
      !(await page.locator('#shard-pill').isVisible()));
    // Walk the player straight into a wall, twice.
    const practice = await page.evaluate(async () => {
      const g = globalThis.__ORBITAL__;
      g.world.combo = 9;
      for (let i = 0; i < 2; i++) {
        const ring = g.world.rings[0];
        g.world.shieldCharges = 0;
        g.world.shieldTimer = 0;
        g.world._onCollision(ring, g.world.player.angle);
        g.world.drainEvents(() => {});
      }
      return { alive: g.world.alive, hits: g.world.practiceHits, combo: g.world.combo, mode: g.mode };
    });
    check('a practice hit costs the chain, not the run',
      practice.alive && practice.hits === 2 && practice.combo === 0 && practice.mode === 'play',
      JSON.stringify(practice));

    await page.locator('#btn-pause').click();
    await page.waitForSelector('#screen-pause.on', { timeout: 3000 });
    await page.locator('#btn-quit').click();
    await page.waitForSelector('#screen-title.on', { timeout: 3000 });
    const afterPractice = await page.evaluate(() => ({
      best: globalThis.__ORBITAL__.profile.bestScore,
      runs: globalThis.__ORBITAL__.profile.runs,
      shards: globalThis.__ORBITAL__.profile.shards,
    }));
    check('practice banks nothing at all',
      JSON.stringify(afterPractice) === JSON.stringify(beforePractice),
      `${JSON.stringify(beforePractice)} -> ${JSON.stringify(afterPractice)}`);
    check('leaving practice clears its badge',
      !(await page.locator('#practice-badge').isVisible()));

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
      // The coaching line is the longest string the HUD ever shows. It used to
      // be nowrap with no width, so on a narrow phone its first and last words
      // ran off both edges.
      const coach = await page.evaluate(() => {
        const el = document.getElementById('coach');
        el.textContent = 'DEAD CENTRE HOLDS A CHAIN YOU COULD NOT REACH';
        el.classList.add('on');
        const box = el.getBoundingClientRect();
        el.classList.remove('on');
        return { left: box.left, right: box.right, width: window.innerWidth };
      });
      check(`the longest coaching line fits at ${label}`,
        coach.left >= -0.5 && coach.right <= coach.width + 0.5,
        `${coach.left.toFixed(0)}..${coach.right.toFixed(0)} in ${coach.width}`);

      await page.screenshot({ path: `${SHOTS}/10-${label}.png` });
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
