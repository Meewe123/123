/**
 * Orbital Rush — application entry point.
 *
 * Wires the simulation, renderer, audio, haptics, input, persistence, the meta
 * services and the UI together, and owns the game's state machine:
 *
 *     attract  <->  play  <->  paused
 *                    |
 *                  dying  ->  over  ->  (revive -> play | retry | attract)
 *
 * Everything that decides a score lives in the simulation; this file only
 * observes it, feeds the presentation layer and persists the result.
 */

import { Loop } from './engine/loop.js';
import { Input } from './engine/input.js';
import { AudioEngine } from './engine/audio.js';
import { Haptics } from './engine/haptics.js';
import { Fx } from './engine/fx.js';
import { clamp, commas, todayKey } from './engine/util.js';
import * as store from './engine/storage.js';

import { World, EVT } from './game/world.js';
import { Renderer } from './game/render.js';
import { createAutopilot, stepAutopilot } from './game/autopilot.js';
import { TUNE, POWERUPS, OVERDRIVE_AT, zoneByIndex, skinById } from './game/config.js';
import { adjustPalette } from './game/palette.js';
import { playPerfect, playOverdrive, resolvePerfectEffect } from './game/effects.js';
import * as daily from './game/daily.js';
import * as achievements from './game/achievements.js';
import * as meta from './game/meta.js';

import { LocalStore, LeaderboardService, DailyLeaderboardService } from './services/leaderboard.js';
import { PurchaseService } from './services/purchase.js';
import { ChallengeService, encodeChallenge } from './services/challenge.js';

import { UI } from './ui/ui.js';
import { shareRun } from './ui/sharecard.js';

class Game {
  constructor() {
    this.profile = store.load();
    this.mode = 'boot';
    this.runMode = 'endless';

    this.canvas = document.getElementById('stage');
    this.renderer = new Renderer(this.canvas);
    this.fx = new Fx();
    this.audio = new AudioEngine();
    this.haptics = new Haptics();
    this.world = new World((Math.random() * 0xffffffff) >>> 0);
    this.autopilot = createAutopilot({ greedy: true, sloppiness: 0.05 });

    this.store = new LocalStore(this.profile);
    this.leaderboard = new LeaderboardService(this.store);
    this.dailyBoard = new DailyLeaderboardService(this.store, () => todayKey());
    this.purchases = new PurchaseService();
    this.challenges = new ChallengeService();
    this.challenge = null;

    this.deathTimer = 0;
    this.runCommitted = null;
    this.pendingResult = null;
    this.audioUnlocked = false;

    this.ui = new UI(this._handlers());
    this.ui.setProfile(this.profile);

    this.input = new Input(window);
    this.input.onTap = () => this._onTap();
    this.input.attach();

    this.loop = new Loop({
      update: (dt) => this.update(dt),
      render: (frameDt) => this.render(frameDt),
    });

    this._applySettings();
    this._bindPlatform();
  }

  // ------------------------------------------------------------- lifecycle ---

  async boot() {
    this.profile = await store.hydrateFromNative(this.profile);
    this.store.profile = this.profile;
    this.ui.setProfile(this.profile);

    meta.ensureDaily(this.profile);
    daily.ensureDaily(this.profile);
    meta.syncAchievementCosmetics(this.profile);
    this._applySettings();
    store.saveSoon(this.profile);

    this.challenge = this.challenges.incoming();
    if (this.challenge) this.challenges.clear();

    this.haptics.init();
    this.mode = 'attract';
    this.ui.show('title');
    this.ui.setTheme(this._theme(0));
    this.loop.start();
    this._hideNativeSplash();

    if (this.challenge) {
      this.ui.toast(`CHALLENGE · BEAT ${commas(this.challenge.score)}`, 2600);
    }
  }

  _handlers() {
    return {
      onPlay: () => this.startRun({ mode: 'endless' }),
      onDaily: () => this.startRun({ mode: 'daily' }),
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onRestart: () => this.startRun({ mode: this.runMode }),
      onQuit: () => this.toTitle(),
      onRevive: () => this.revive(),
      onShare: () => this.share(),
      onCosmetic: (kind, id) => this.chooseCosmetic(kind, id),
      onClaimMission: (m) => this.claimMission(m),
      onToggle: (key, value) => this.toggleSetting(key, value),
      onReset: () => this.resetProgress(),
      onUiSound: () => {
        this._unlockAudio();
        this.audio.play('ui');
        this.haptics.fire('light');
      },
      onScreen: (name) => {
        if (name && name !== 'pause') this.audio.setIntensity(0.12);
      },
      claimableCount: () => meta.claimableCount(this.profile),
      hasShopNews: () => !!meta.nextUnlockable(this.profile),
      dailyAvailable: () => daily.dailyAvailable(this.profile),
      dailyInfo: () => ({
        label: daily.dailyLabel(todayKey()),
        date: new Date().toDateString().toUpperCase(),
      }),
      purchasesAvailable: () => this.purchases.available,
      dailyBoardLabel: () => this.dailyBoard.label,
      dailyBoard: () => this.dailyBoard.top(5),
    };
  }

  _bindPlatform() {
    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.renderer.resize(), 80);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.mode === 'play') this.pause();
        this.audio.suspend();
      } else {
        this.audio.resume();
        this.loop.resync();
      }
    });

    window.addEventListener('pagehide', () => store.flush(this.profile));
    window.addEventListener('blur', () => {
      if (this.mode === 'play') this.pause();
    });

    const cap = globalThis.Capacitor;
    if (cap?.Plugins?.App) {
      cap.Plugins.App.addListener('backButton', () => {
        if (this.mode === 'play') this.pause();
        else if (this.ui.current && this.ui.current !== 'title') this.ui.show('title');
      });
    }
  }

  _hideNativeSplash() {
    globalThis.Capacitor?.Plugins?.SplashScreen?.hide({ fadeOutDuration: 260 }).catch(() => {});
  }

  _unlockAudio() {
    if (this.audioUnlocked) return;
    this.audioUnlocked = true;
    this.audio.unlock();
    this.audio.setSfx(this.profile.sfx);
    this.audio.setMusic(this.profile.music);
  }

  /** The zone palette, nudged clear of whatever skin is equipped. */
  _theme(zoneIndex = this.world.visualZone) {
    return adjustPalette(zoneByIndex(zoneIndex).palette, skinById(this.profile.skin));
  }

  _applySettings() {
    this.audio.setSfx(this.profile.sfx);
    this.audio.setMusic(this.profile.music);
    this.haptics.setEnabled(this.profile.haptics);
    this.fx.reduced = !!this.profile.reducedFx;
    this.renderer.setReduced(!!this.profile.reducedFx);
  }

  _applyZone(zoneIndex) {
    const zone = zoneByIndex(zoneIndex);
    this.audio.setKey(zone.key);
    this.audio.setVoice(zone.voice);
    this.ui.setTheme(this._theme(zoneIndex));
  }

  // ------------------------------------------------------------------ flow ---

  startRun({ mode = 'endless', seed = null } = {}) {
    this._unlockAudio();
    this.runMode = mode;

    meta.ensureDaily(this.profile);
    daily.ensureDaily(this.profile);
    // First run of the day: the streak advances and the daily bonus is simply
    // handed over. No pop-up, no button to hunt for, no reason to feel behind.
    if (meta.registerPlay(this.profile)) {
      const bonus = meta.claimDailyReward(this.profile);
      if (bonus) this.ui.toast(`DAY ${this.profile.streak} · +${bonus} ◈`, 2200);
    }
    for (const milestone of meta.claimStreakMilestones(this.profile)) {
      this.ui.toast(`${milestone.name.toUpperCase()} · +${milestone.reward} ◈`, 2400);
    }

    let runSeed = seed;
    if (runSeed === null) {
      if (mode === 'daily') runSeed = daily.dailySeedFor();
      else if (this.challenge && this.challenge.mode === 'endless') {
        runSeed = this.challenge.seed;
        // One run against the challenge; after that it is your own game again.
        this.challenge = null;
      } else {
        runSeed = (Math.random() * 0xffffffff) >>> 0;
      }
    }

    this.world.reset(runSeed);
    // Identifies this run across a revive, so it files one score, not two.
    this.runId = `${runSeed}:${Date.now()}`;
    this.autopilot = createAutopilot({ greedy: true, sloppiness: 0.05 });
    this.fx.clear();
    this.renderer.resetRun();
    this.runCommitted = {
      score: 0, shards: 0, orbs: 0, greedOrbs: 0, perfects: 0, timeMs: 0, counted: false,
    };
    this.pendingResult = null;
    this.deathTimer = 0;
    this.mode = 'play';
    this.ui.resetHud();
    this.ui.showGame();
    this._applyZone(0);
    if (mode === 'daily') this.ui.toast(`DAILY ${daily.dailyLabel(todayKey())}`, 1600);
    this._coach('tap', 'TAP TO FLIP ORBIT');
    store.saveSoon(this.profile);
  }

  pause() {
    if (this.mode !== 'play') return;
    this.mode = 'paused';
    this.ui.showPause({
      score: this.world.score,
      multiplier: this.world.multiplier,
      zone: this.world.zone,
      lap: this.world.lap,
    });
    this.audio.setIntensity(0.1);
  }

  resume() {
    if (this.mode !== 'paused') return;
    this.mode = 'play';
    this.ui.showGame();
    this.loop.resync();
  }

  toTitle() {
    if (this.mode === 'over' || this.mode === 'dying') this._commitRun();
    this.mode = 'attract';
    this.world.reset((Math.random() * 0xffffffff) >>> 0);
    this.autopilot = createAutopilot({ greedy: true, sloppiness: 0.05 });
    this.fx.clear();
    this.renderer.resetRun();
    this.ui.show('title');
  }

  _die() {
    this.mode = 'dying';
    this.deathTimer = TUNE.deathHold;
  }

  _finishDeath() {
    const outcome = this._commitRun();
    const w = this.world;
    this.mode = 'over';
    this.pendingResult = {
      mode: this.runMode,
      score: w.score,
      shards: w.shards,
      orbs: w.orbsCollected,
      greedOrbs: w.greedOrbs,
      safeOrbs: w.safeOrbs,
      perfects: w.perfects,
      chainSaves: w.chainSaves,
      bestMultiplier: w.bestMultiplier,
      bestChain: w.bestChain,
      zoneReached: w.zone,
      lap: w.lap,
      seed: w.seed,
      isBest: outcome.isBest,
      isZoneBest: outcome.isZoneBest,
      isMultBest: outcome.isMultBest,
      canRevive: w.revivesUsed < 1
        && this.runMode === 'endless'
        && this.profile.shards >= TUNE.reviveCost,
    };
    this.ui.setProfile(this.profile);
    this.ui.showRunSummary(this.pendingResult);
    if (outcome.isBest) {
      this.haptics.fire('success');
      this.audio.play('unlock');
    }
  }

  /**
   * Fold whatever the run has produced since the last commit into the profile.
   * Called on every death, so a revived run contributes exactly once overall.
   */
  _commitRun() {
    const w = this.world;
    const c = this.runCommitted;
    if (!c) return { isBest: false, isZoneBest: false, isMultBest: false };

    const beforeZone = this.profile.bestZone;
    const beforeMult = this.profile.bestMultiplier;

    const run = {
      score: w.score,
      rings: w.score - c.score,
      shards: w.shards - c.shards,
      orbs: w.orbsCollected - c.orbs,
      greedOrbs: w.greedOrbs - c.greedOrbs,
      perfects: w.perfects - c.perfects,
      bestChain: w.bestChain,
      bestMultiplier: w.bestMultiplier,
      zoneReached: w.zone,
      noShieldZone: w.noShieldZone,
      timeMs: w.time * 1000 - c.timeMs,
      countRun: !c.counted,
      isBest: w.score > this.profile.bestScore,
    };

    const isBest = meta.commitRun(this.profile, run);
    const isZoneBest = this.profile.bestZone > beforeZone;
    const isMultBest = this.profile.bestMultiplier > beforeMult;

    const done = meta.applyRun(this.profile, run);

    if (this.runMode === 'daily') {
      daily.recordDaily(this.profile, {
        score: w.score,
        zoneReached: w.zone,
        bestMultiplier: w.bestMultiplier,
        perfects: w.perfects,
        orbs: w.orbsCollected,
      });
    }

    // Achievements read the profile, so everything that writes to it has to
    // have run first — including the daily record that "Regular" tests.
    const earned = achievements.evaluate(this.profile);
    meta.syncAchievementCosmetics(this.profile);

    const entry = {
      id: this.runId,
      score: w.score,
      zone: w.zone,
      multiplier: w.bestMultiplier,
      perfects: w.perfects,
      orbs: w.orbsCollected,
      seed: w.seed,
      date: todayKey(),
    };
    const board = this.runMode === 'daily' ? this.dailyBoard : this.leaderboard;
    board.submit(entry).catch(() => {});

    c.score = w.score;
    c.shards = w.shards;
    c.orbs = w.orbsCollected;
    c.greedOrbs = w.greedOrbs;
    c.perfects = w.perfects;
    c.timeMs = w.time * 1000;
    c.counted = true;

    if (earned.length) {
      this.ui.toast(`${earned[0].name.toUpperCase()} · +${earned[0].reward} ◈`, 2400);
    } else if (done.length) {
      this.ui.toast(done.length === 1 ? 'MISSION COMPLETE' : `${done.length} MISSIONS COMPLETE`);
    }
    store.flush(this.profile);
    return { isBest, isZoneBest, isMultBest };
  }

  revive() {
    if (this.mode !== 'over' || this.runMode !== 'endless') return;
    if (this.world.revivesUsed >= 1 || this.profile.shards < TUNE.reviveCost) {
      this.ui.toast('NOT ENOUGH SHARDS');
      this.audio.play('deny');
      return;
    }
    meta.spendShards(this.profile, TUNE.reviveCost);
    store.saveSoon(this.profile);
    this.world.revive();
    this.fx.clear();
    this.fx.addFlash(0.35, this.renderer.shieldColor);
    this.fx.wave(this.renderer.cx, this.renderer.cy, this.renderer.unit * 0.1, this.renderer.unit * 1.2, {
      color: this.renderer.shieldColor, width: 6, life: 0.7,
    });
    this.audio.play('revive');
    this.haptics.fire('success');
    this.mode = 'play';
    this.ui.showGame();
    this.loop.resync();
  }

  async share() {
    const result = this.pendingResult;
    if (!result) return;
    const code = encodeChallenge({ mode: result.mode, seed: result.seed, score: result.score });
    const link = this.challenges.link({ mode: result.mode, seed: result.seed, score: result.score });
    const text = `I threaded ${commas(result.score)} rings in Orbital Rush — zone ${result.zoneReached + 1}, x${result.bestMultiplier}. Beat that.`;
    const outcome = await shareRun(
      { ...result, code },
      this.renderer.paletteHex,
      skinById(this.profile.skin),
      text,
      link,
    );
    if (outcome === 'clipboard') this.ui.toast('COPIED TO CLIPBOARD');
    else if (outcome === 'unavailable') this.ui.toast('SHARING UNAVAILABLE');
  }

  // ------------------------------------------------------------------ meta ---

  async chooseCosmetic(kind, id) {
    const result = meta.buyOrEquip(this.profile, kind, id);
    const item = meta.itemOf(kind, id);

    if (result === 'poor') {
      this.audio.play('deny');
      this.haptics.fire('warning');
      this.ui.toast('NOT ENOUGH SHARDS');
    } else if (result === 'achievement') {
      this.audio.play('deny');
      this.ui.toast('EARN IT — SEE ACHIEVEMENTS');
    } else if (result === 'premium') {
      if (!this.purchases.available) {
        this.audio.play('deny');
        this.ui.toast('PURCHASES UNAVAILABLE ON THIS BUILD');
      } else {
        const purchase = await this.purchases.purchase(item.sku);
        if (purchase.ok) {
          meta.grantCosmetic(this.profile, kind, id);
          meta.equipCosmetic(this.profile, kind, id);
          this.audio.play('unlock');
          this.ui.toast(`${item.name.toUpperCase()} UNLOCKED`);
        } else {
          this.ui.toast('PURCHASE NOT COMPLETED');
        }
      }
    } else if (result === 'bought') {
      this.audio.play('unlock');
      this.haptics.fire('success');
      this.ui.toast(`${item.name.toUpperCase()} UNLOCKED`);
    } else if (result === 'equipped') {
      this.audio.play('ui');
      this.haptics.fire('light');
    }

    store.flush(this.profile);
    this.ui.setTheme(this._theme());
    this.ui.refreshShop();
    this.ui.refreshCollection();
    this.ui.refreshTitle();
  }

  claimMission(mission) {
    const reward = meta.claimMission(this.profile, mission);
    if (!reward) return;
    this.audio.play('power');
    this.haptics.fire('success');
    this.ui.toast(`+${reward} ◈`);
    store.flush(this.profile);
    if (this.ui.current === 'over') this.ui.showRunSummary(this.pendingResult);
    else if (this.ui.current === 'daily') this.ui.refreshDaily();
    this.ui.refreshTitle();
  }

  toggleSetting(key, value) {
    const map = { music: 'music', sfx: 'sfx', haptics: 'haptics', reduced: 'reducedFx' };
    this.profile[map[key]] = value;
    this._applySettings();
    if (key === 'sfx' && value) this.audio.play('ui');
    if (key === 'haptics' && value) this.haptics.fire('medium');
    store.saveSoon(this.profile);
  }

  resetProgress() {
    if (!window.confirm('Erase your records, shards and everything you have unlocked?')) return;
    this.profile = store.migrate(null);
    this.store.profile = this.profile;
    meta.ensureDaily(this.profile);
    daily.ensureDaily(this.profile);
    store.flush(this.profile);
    this.ui.setProfile(this.profile);
    this._applySettings();
    this.ui.setTheme(this._theme(0));
    this.ui.refreshSettings();
    this.ui.refreshTitle();
    this.ui.toast('PROGRESS RESET');
  }

  /**
   * Show a coaching line once in the player's life, then never again.
   *
   * A line already on screen is never replaced: several events can land in the
   * same drain — a PERFECT is emitted just before the PASS that carried it —
   * and a line that is overwritten in the same frame would be spent without
   * anybody reading it. The id stays unseen instead, so it gets its turn on a
   * later beat.
   */
  _coach(id, text) {
    const seen = this.profile.tutorialSeen || (this.profile.tutorialSeen = []);
    if (seen.includes(id) || this.ui.coachBusy()) return;
    seen.push(id);
    this.ui.coach(text);
    store.saveSoon(this.profile);
  }

  // ----------------------------------------------------------------- input ---

  _onTap() {
    this._unlockAudio();
    if (this.mode !== 'play') return;
    this.world.flip();
  }

  // ------------------------------------------------------------ simulation ---

  update(dt) {
    if (this.mode === 'attract') {
      stepAutopilot(this.world, this.autopilot);
      this.world.update(dt);
      if (!this.world.alive) {
        this.world.reset((Math.random() * 0xffffffff) >>> 0);
        this.autopilot = createAutopilot({ greedy: true, sloppiness: 0.05 });
        this.renderer.resetRun();
      }
    } else if (this.mode === 'play') {
      if (this.demo) stepAutopilot(this.world, this.autopilot);
      this.world.update(dt);
    } else if (this.mode === 'dying') {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) this._finishDeath();
    }

    this.world.drainEvents((e) => this._onEvent(e));
    this.fx.update(dt);

    if (this.mode === 'play') this._syncHud();
  }

  _syncHud() {
    const w = this.world;
    this.ui.setScore(w.score);
    this.ui.setRunShards(w.shards);
    const step = TUNE.comboPerMultiplier;
    this.ui.setMultiplier(w.multiplier, (w.combo % step) / step);
    this.ui.setPowers({
      shield: w.shieldCharges,
      shieldColor: this.renderer.shieldColor,
      slow: w.slowTimer,
      double: w.doubleTimer,
    });
    this.audio.setIntensity(clamp(
      w.difficulty * 0.6 + ((w.multiplier - 1) / (OVERDRIVE_AT - 1)) * 0.45, 0.15, 1,
    ));

  }

  render(frameDt) {
    this.renderer.draw(this.world, {
      fx: this.fx,
      dt: Math.min(frameDt, 0.05),
      skinId: this.profile.skin,
      trailId: this.profile.trail,
      intensity: this.mode === 'play' ? 1 : 0.75,
    });
  }

  // ---------------------------------------------------------------- events ---

  _onEvent(e) {
    const quiet = this.mode === 'attract';
    const r = this.renderer;
    const skin = skinById(this.profile.skin);
    const zone = zoneByIndex(this.world.visualZone);

    switch (e.type) {
      case EVT.FLIP: {
        const p = r.orbitPoint(this.world.player.angle);
        this.fx.burst(p.x, p.y, 7, {
          color: skin.trail, speed: 90, size: r.unit * 0.008, life: 0.3, shape: 'spark',
        });
        if (!quiet) {
          this.audio.play('flip');
          this.haptics.fire('light');
        }
        break;
      }

      case EVT.PASS: {
        const p = r.orbitPoint(e.angle);
        r.onPass(0.7 + e.precision * 0.6);
        this.fx.burst(p.x, p.y, 10, {
          color: [skin.trail, skin.glow], speed: 190, size: r.unit * 0.008, life: 0.4,
          shape: 'spark', angle: e.angle, spread: Math.PI * 1.2,
        });
        if (!quiet) {
          this.audio.play('pass', Math.min(this.world.combo, 24));
          this.haptics.fire('light');
          this._coach('aim', 'THREAD THE MARKED CENTRE FOR A PERFECT');
        }
        break;
      }

      case EVT.PERFECT: {
        const effectId = resolvePerfectEffect(this.profile.effect, skin, zone);
        playPerfect(this.fx, r, {
          kind: effectId,
          angle: e.angle,
          dir: this.world.player.dir,
          color: skin.glow,
          accent: zone.palette.accent,
        });
        if (!quiet) {
          // A save is the one worth saying out loud: the player let a greed orb
          // go and kept the chain anyway, which is the whole point of threading
          // the centre.
          const text = e.saved ? 'PERFECT · CHAIN HELD' : 'PERFECT';
          const size = Math.round(r.unit * (e.saved ? 0.055 : 0.075));
          const label = r.labelPoint(e.angle, TUNE.playerOrbit + 0.20, text, size);
          this.fx.text(label.x, label.y, text, { color: '#ffd23f', size, life: 0.85 });
          this.fx.addShake(3.5 * (zone.fx.shake || 1));
          this.audio.play('perfect');
          this.haptics.fire('medium');
          this._coach('perfect', 'PERFECT — YOU THREADED THE MARKED CENTRE');
          if (e.saved) this._coach('save', 'DEAD CENTRE HOLDS A CHAIN YOU COULD NOT REACH');
        }
        break;
      }

      case EVT.ORB: {
        const p = r.orbitPoint(e.angle);
        const color = e.greed ? ['#ffd23f', '#ffffff'] : ['#ffe66d', '#ffffff'];
        this.fx.burst(p.x, p.y, e.greed ? 18 : 12, {
          color, speed: e.greed ? 230 : 170, size: r.unit * 0.008, life: 0.45,
        });
        if (!quiet) {
          const text = e.greed ? `+${e.gain} GREED` : `+${e.gain}`;
          const size = Math.round(r.unit * (e.greed ? 0.055 : 0.06));
          const label = r.labelPoint(e.angle, TUNE.playerOrbit - 0.13, text, size);
          this.fx.text(label.x, label.y, text, {
            color: e.greed ? '#ffd23f' : '#ffe66d', size, life: 0.65,
          });
          this.audio.play(e.greed ? 'greed' : 'orb', e.combo);
          this.haptics.fire(e.greed ? 'medium' : 'light');
          this._coach('orb', 'CHAIN ORBS TO BUILD YOUR MULTIPLIER');
          if (e.greed) this._coach('greed', 'GREED ORBS PAY DOUBLE');
        }
        break;
      }

      case EVT.MULTIPLIER: {
        if (!quiet && e.rising && e.value >= 2) this._coach('mult', 'KEEP THE CHAIN ALIVE');
        break;
      }

      case EVT.OVERDRIVE: {
        playOverdrive(this.fx, r, skin.glow);
        if (!quiet) {
          this.fx.text(r.cx, r.cy - r.unit * 0.62, 'OVERDRIVE', {
            color: '#ffffff', size: Math.round(r.unit * 0.095), life: 1.2, vy: -18,
          });
          this.audio.play('overdrive');
          this.haptics.fire('success');
        }
        break;
      }

      case EVT.COMBO_BREAK: {
        if (!quiet) {
          this.fx.text(r.cx, r.cy + r.unit * 0.82, `CHAIN LOST · x${e.from} → x1`, {
            color: 'rgba(255,255,255,0.62)', size: Math.round(r.unit * 0.05), life: 1,
          });
          this.fx.addFlash(0.08, '#ffffff');
          this.audio.play('chainBreak');
          this.haptics.fire('warning');
        }
        break;
      }

      case EVT.NEAR: {
        this.fx.addShake(2.2);
        break;
      }

      case EVT.POWERUP: {
        const p = r.orbitPoint(e.angle);
        const color = e.kind === 'shield' ? r.shieldColor : POWERUPS[e.kind].color;
        this.fx.burst(p.x, p.y, 26, { color, speed: 260, size: r.unit * 0.011, life: 0.7 });
        this.fx.wave(p.x, p.y, r.unit * 0.02, r.unit * 0.42, { color, width: 5, life: 0.55 });
        if (!quiet) {
          const label = e.kind === 'shield'
            ? `${POWERUPS.shield.label} x${TUNE.shieldCharges}`
            : POWERUPS[e.kind].label;
          this.fx.text(r.cx, r.cy - r.unit * 0.62, label, {
            color, size: Math.round(r.unit * 0.085), life: 1.1, vy: -22,
          });
          this.audio.play('power');
          this.haptics.fire('success');
        }
        this.fx.addFlash(0.18, color);
        break;
      }

      case EVT.SHIELD_BREAK: {
        const p = r.orbitPoint(e.angle);
        const shield = r.shieldColor;
        this.fx.burst(p.x, p.y, 30, {
          color: [shield, '#ffffff'], speed: 300, size: r.unit * 0.012, life: 0.6,
        });
        this.fx.wave(p.x, p.y, r.unit * 0.03, r.unit * 0.5, { color: shield, width: 6, life: 0.5 });
        this.fx.addShake(14);
        this.fx.addFlash(0.3, shield);
        if (!quiet) {
          this.audio.play('shield');
          this.haptics.fire(e.remaining > 0 ? 'medium' : 'warning');
          if (e.remaining > 0) {
            this.fx.text(r.cx, r.cy + r.unit * 0.66, `SHIELD x${e.remaining}`, {
              color: shield, size: Math.round(r.unit * 0.055), life: 0.8,
            });
          }
        }
        break;
      }

      case EVT.ZONE: {
        if (!quiet) this.ui.showZone(e.zone, e.lap);
        this._applyZone(e.zone);
        r.onZone();
        this.fx.wave(r.cx, r.cy, r.unit * 0.1, r.unit * 1.5, {
          color: zoneByIndex(e.zone).palette.accent, width: 2, life: 0.6,
        });
        break;
      }

      case EVT.HIT: {
        const p = r.orbitPoint(e.angle);
        this.fx.burst(p.x, p.y, 48, {
          color: ['#ffffff', skin.glow, '#ff5a5a'], speed: 420, size: r.unit * 0.014, life: 0.9, shape: 'spark',
        });
        this.fx.burst(p.x, p.y, 26, {
          color: [skin.trail, '#ffffff'], speed: 180, size: r.unit * 0.02, life: 1.2, shape: 'shard',
        });
        this.fx.wave(p.x, p.y, r.unit * 0.02, r.unit * 0.9, { color: '#ffffff', width: 8, life: 0.6 });
        this.fx.addShake(30);
        this.fx.addFlash(0.55, '#ffffff');
        if (!quiet) {
          this.audio.play('hit');
          this.audio.setIntensity(0.1);
          this.haptics.fire('error');
        }
        if (this.mode === 'play') this._die();
        break;
      }

      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- bootstrap ---

function ready(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

ready(() => {
  const game = new Game();
  globalThis.__ORBITAL__ = game; // handle used by the automated smoke tests
  game.boot();

  // The single-file build has no separate sw.js to register.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !globalThis.__ORBITAL_SINGLE_FILE__) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
});
