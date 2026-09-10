/**
 * Orbital Rush — application entry point.
 *
 * Wires the simulation, renderer, audio, haptics, input, persistence and UI
 * together and owns the game's state machine:
 *
 *     attract  <->  play  <->  paused
 *                    |
 *                  dying  ->  over  ->  (revive -> play | restart | attract)
 */

import { Loop } from './engine/loop.js';
import { Input } from './engine/input.js';
import { AudioEngine } from './engine/audio.js';
import { Haptics } from './engine/haptics.js';
import { Fx } from './engine/fx.js';
import { clamp } from './engine/util.js';
import * as store from './engine/storage.js';

import { World, EVT } from './game/world.js';
import { Renderer } from './game/render.js';
import { createAutopilot, stepAutopilot } from './game/autopilot.js';
import { TUNE, ZONES, POWERUPS, skinById } from './game/config.js';
import * as meta from './game/meta.js';

import { UI } from './ui/ui.js';

const DEATH_HOLD = 1.05;

class Game {
  constructor() {
    this.profile = store.load();
    this.mode = 'boot';

    this.canvas = document.getElementById('stage');
    this.renderer = new Renderer(this.canvas);
    this.fx = new Fx();
    this.audio = new AudioEngine();
    this.haptics = new Haptics();
    this.world = new World((Math.random() * 0xffffffff) >>> 0);
    this.autopilot = createAutopilot({ greedy: true, sloppiness: 0.05 });

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
    this.ui.setProfile(this.profile);
    meta.ensureDaily(this.profile);
    this._applySettings();
    store.saveSoon(this.profile);

    this.haptics.init();
    this.mode = 'attract';
    this.ui.show('title');
    this.ui.setTheme(ZONES[0].palette);
    this.loop.start();
    this._hideNativeSplash();
  }

  _handlers() {
    return {
      onPlay: () => this.startRun(),
      onTutorialDone: () => {
        this.profile.seenTutorial = true;
        store.saveSoon(this.profile);
        this.startRun(true);
      },
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onRestart: () => this.startRun(),
      onQuit: () => this.toTitle(),
      onRevive: () => this.revive(),
      onShare: () => this.share(),
      onSkin: (id) => this.buySkin(id),
      onClaimMission: (m) => this.claimMission(m),
      onClaimDaily: () => this.claimDaily(),
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
      dailyAvailable: () => meta.dailyRewardAvailable(this.profile),
      dailyAmount: () => meta.dailyRewardAmount(this.profile),
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

    // Android hardware back button, when running inside the native shell.
    const cap = globalThis.Capacitor;
    if (cap?.Plugins?.App) {
      cap.Plugins.App.addListener('backButton', () => {
        if (this.mode === 'play') this.pause();
        else if (this.ui.current && this.ui.current !== 'title') this.ui.show('title');
      });
    }
  }

  _hideNativeSplash() {
    const splash = globalThis.Capacitor?.Plugins?.SplashScreen;
    if (splash) splash.hide({ fadeOutDuration: 260 }).catch(() => {});
  }

  _unlockAudio() {
    if (this.audioUnlocked) return;
    this.audioUnlocked = true;
    this.audio.unlock();
    this.audio.setSfx(this.profile.sfx);
    this.audio.setMusic(this.profile.music);
  }

  _applySettings() {
    this.audio.setSfx(this.profile.sfx);
    this.audio.setMusic(this.profile.music);
    this.haptics.setEnabled(this.profile.haptics);
    this.fx.reduced = !!this.profile.reducedFx;
    this.renderer.setReduced(!!this.profile.reducedFx);
  }

  // ------------------------------------------------------------------ flow ---

  startRun(skipTutorial = false) {
    this._unlockAudio();
    if (!this.profile.seenTutorial && !skipTutorial) {
      this.ui.show('tutorial');
      return;
    }

    meta.ensureDaily(this.profile);
    meta.registerPlay(this.profile);

    this.world.reset((Math.random() * 0xffffffff) >>> 0);
    this.autopilot = createAutopilot({ greedy: true, sloppiness: 0.05 });
    this.fx.clear();
    this.renderer.resetRun();
    this.runCommitted = { score: 0, energy: 0, orbs: 0, perfects: 0, timeMs: 0, counted: false };
    this.pendingResult = null;
    this.deathTimer = 0;
    this.mode = 'play';
    this.ui.resetHud();
    this.ui.showGame();
    this.audio.setKey(ZONES[0].key);
    store.saveSoon(this.profile);
  }

  pause() {
    if (this.mode !== 'play') return;
    this.mode = 'paused';
    this.ui.showPause({
      score: this.world.score,
      energy: this.world.energy,
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
    this.deathTimer = DEATH_HOLD;
  }

  _finishDeath() {
    const isBest = this._commitRun();
    const w = this.world;
    this.mode = 'over';
    this.pendingResult = {
      score: w.score,
      energy: w.energy,
      bestCombo: w.bestCombo,
      zoneReached: w.zone,
      lap: w.lap,
      isBest,
      canRevive: w.revivesUsed < 1 && this.profile.energy >= TUNE.reviveCost,
    };
    this.ui.setProfile(this.profile);
    this.ui.showGameOver(this.pendingResult);
    if (isBest) {
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
    if (!c) return false;

    const run = {
      score: w.score,
      rings: w.score - c.score,
      energy: w.energy - c.energy,
      orbs: w.orbsCollected - c.orbs,
      perfects: w.perfects - c.perfects,
      bestCombo: w.bestCombo,
      zoneReached: w.zone,
      lap: w.lap,
      timeMs: w.time * 1000 - c.timeMs,
      countRun: !c.counted,
    };

    const isBest = meta.commitRun(this.profile, run);
    const done = meta.applyRun(this.profile, run);

    c.score = w.score;
    c.energy = w.energy;
    c.orbs = w.orbsCollected;
    c.perfects = w.perfects;
    c.timeMs = w.time * 1000;
    c.counted = true;

    if (done.length) {
      this.ui.toast(done.length === 1 ? 'MISSION COMPLETE' : `${done.length} MISSIONS COMPLETE`);
    }
    store.flush(this.profile);
    return isBest;
  }

  revive() {
    if (this.mode !== 'over') return;
    if (this.world.revivesUsed >= 1 || this.profile.energy < TUNE.reviveCost) {
      this.ui.toast('NOT ENOUGH ENERGY');
      this.audio.play('deny');
      return;
    }
    this.profile.energy -= TUNE.reviveCost;
    store.saveSoon(this.profile);
    this.world.revive();
    this.fx.clear();
    this.fx.addFlash(0.35, '#7ef0ff');
    this.fx.wave(this.renderer.cx, this.renderer.cy, this.renderer.unit * 0.1, this.renderer.unit * 1.2, {
      color: POWERUPS.shield.color, width: 6, life: 0.7,
    });
    this.audio.play('revive');
    this.haptics.fire('success');
    this.mode = 'play';
    this.ui.showGame();
    this.loop.resync();
  }

  share() {
    const score = this.pendingResult?.score ?? this.profile.bestScore;
    const text = `I threaded ${score} rings in Orbital Rush. Beat that.`;
    if (navigator.share) {
      navigator.share({ title: 'Orbital Rush', text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => this.ui.toast('COPIED TO CLIPBOARD'),
        () => this.ui.toast('COULD NOT SHARE'),
      );
    } else {
      this.ui.toast('SHARING UNAVAILABLE');
    }
  }

  // ------------------------------------------------------------------ meta ---

  buySkin(id) {
    const result = meta.buyOrEquip(this.profile, id);
    if (result === 'poor') {
      this.audio.play('deny');
      this.haptics.fire('warning');
      this.ui.toast('NOT ENOUGH ENERGY');
      return;
    }
    if (result === 'bought') {
      this.audio.play('unlock');
      this.haptics.fire('success');
      this.ui.toast(`${skinById(id).name.toUpperCase()} UNLOCKED`);
    } else if (result === 'equipped') {
      this.audio.play('ui');
      this.haptics.fire('light');
    }
    store.flush(this.profile);
    this.ui.refreshShop();
    this.ui.refreshTitle();
  }

  claimMission(mission) {
    const reward = meta.claimMission(this.profile, mission);
    if (!reward) return;
    this.audio.play('power');
    this.haptics.fire('success');
    this.ui.toast(`+${reward} ENERGY`);
    store.flush(this.profile);
    this.ui.refreshMissions();
    this.ui.refreshTitle();
  }

  claimDaily() {
    const amount = meta.claimDailyReward(this.profile);
    if (!amount) return;
    this.audio.play('unlock');
    this.haptics.fire('success');
    this.ui.toast(`DAILY BONUS +${amount}`);
    store.flush(this.profile);
    this.ui.refreshMissions();
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
    if (!window.confirm('Erase your best score, energy and unlocked skins?')) return;
    this.profile = { ...store.DEFAULT_PROFILE, ownedSkins: ['aurora'], missions: [] };
    meta.ensureDaily(this.profile);
    store.flush(this.profile);
    this.ui.setProfile(this.profile);
    this._applySettings();
    this.ui.refreshSettings();
    this.ui.refreshTitle();
    this.ui.toast('PROGRESS RESET');
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
      // `demo` is set only by the automated screenshot/e2e harness.
      if (this.demo) stepAutopilot(this.world, this.autopilot);
      this.world.update(dt);
    } else if (this.mode === 'dying') {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) this._finishDeath();
    }

    this.world.drainEvents((e) => this._onEvent(e));
    this.fx.update(dt);

    if (this.mode === 'play') {
      const w = this.world;
      this.ui.setScore(w.score);
      this.ui.setRunEnergy(w.energy);
      this.ui.setMultiplier(w.multiplier);
      this.ui.setPowers({ shield: w.shield, slow: w.slowTimer, double: w.doubleTimer });
      this.audio.setIntensity(clamp(w.difficulty * 0.75 + Math.min(w.combo / 18, 1) * 0.3, 0.15, 1));
    }
  }

  render(frameDt) {
    const dt = Math.min(frameDt, 0.05);
    this.renderer.draw(this.world, {
      fx: this.fx,
      dt,
      skinId: this.profile.skin,
      intensity: this.mode === 'play' ? 1 : 0.75,
    });
  }

  // ---------------------------------------------------------------- events ---

  _onEvent(e) {
    const quiet = this.mode === 'attract';
    const r = this.renderer;
    const skin = skinById(this.profile.skin);

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
        this.fx.wave(r.cx, r.cy, TUNE.playerOrbit * r.unit, TUNE.playerOrbit * r.unit * 1.35, {
          color: skin.glow, width: 2.5, life: 0.4,
        });
        this.fx.burst(p.x, p.y, 6, {
          color: skin.trail, speed: 130, size: r.unit * 0.007, life: 0.35, shape: 'spark',
        });
        if (!quiet) {
          this.audio.play('pass', Math.min(this.world.combo, 24));
          this.haptics.fire('light');
        }
        break;
      }

      case EVT.PERFECT: {
        const p = r.orbitPoint(e.angle);
        this.fx.burst(p.x, p.y, 14, {
          color: ['#ffffff', '#ffd23f'], speed: 210, size: r.unit * 0.009, life: 0.5, shape: 'spark',
        });
        if (!quiet) {
          const label = r.orbitPoint(e.angle, TUNE.playerOrbit + 0.20);
          this.fx.text(label.x, label.y, 'PERFECT', {
            color: '#ffd23f', size: Math.round(r.unit * 0.075), life: 0.75,
          });
        }
        this.fx.addShake(3.5);
        if (!quiet) {
          this.audio.play('perfect');
          this.haptics.fire('medium');
        }
        break;
      }

      case EVT.ORB: {
        const p = r.orbitPoint(e.angle);
        this.fx.burst(p.x, p.y, 12, {
          color: ['#ffe66d', '#ffffff'], speed: 170, size: r.unit * 0.008, life: 0.45,
        });
        if (!quiet) {
          const label = r.orbitPoint(e.angle, TUNE.playerOrbit - 0.13);
          this.fx.text(label.x, label.y, `+${e.gain}`, {
            color: '#ffe66d', size: Math.round(r.unit * 0.06), life: 0.6,
          });
        }
        if (!quiet) {
          this.audio.play('orb', e.combo);
          this.haptics.fire('light');
        }
        break;
      }

      case EVT.POWERUP: {
        const p = r.orbitPoint(e.angle);
        const color = POWERUPS[e.kind].color;
        this.fx.burst(p.x, p.y, 26, { color, speed: 260, size: r.unit * 0.011, life: 0.7 });
        this.fx.wave(p.x, p.y, r.unit * 0.02, r.unit * 0.42, { color, width: 5, life: 0.55 });
        if (!quiet) {
          this.fx.text(r.cx, r.cy - r.unit * 0.62, POWERUPS[e.kind].label, {
            color, size: Math.round(r.unit * 0.085), life: 1.1, vy: -22,
          });
        }
        this.fx.addFlash(0.18, color);
        if (!quiet) {
          this.audio.play('power');
          this.haptics.fire('success');
        }
        break;
      }

      case EVT.COMBO_BREAK: {
        if (!quiet) {
          this.fx.text(r.cx, r.cy + r.unit * 0.66, 'CHAIN LOST', {
            color: 'rgba(255,255,255,0.55)', size: Math.round(r.unit * 0.05), life: 0.8,
          });
        }
        break;
      }

      case EVT.NEAR: {
        this.fx.addShake(2.2);
        break;
      }

      case EVT.SHIELD_BREAK: {
        const p = r.orbitPoint(e.angle);
        this.fx.burst(p.x, p.y, 30, {
          color: [POWERUPS.shield.color, '#ffffff'], speed: 300, size: r.unit * 0.012, life: 0.6,
        });
        this.fx.wave(p.x, p.y, r.unit * 0.03, r.unit * 0.5, {
          color: POWERUPS.shield.color, width: 6, life: 0.5,
        });
        this.fx.addShake(14);
        this.fx.addFlash(0.3, POWERUPS.shield.color);
        if (!quiet) {
          this.audio.play('shield');
          this.haptics.fire('warning');
        }
        break;
      }

      case EVT.ZONE: {
        if (!quiet) this.ui.showZone(e.zone, e.lap);
        this.audio.setKey(ZONES[e.zone].key);
        this.ui.setTheme(ZONES[e.zone].palette);
        r.onZone();
        this.fx.wave(r.cx, r.cy, r.unit * 0.1, r.unit * 1.5, {
          color: ZONES[e.zone].palette.accent, width: 4, life: 0.9,
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
        this.fx.wave(r.cx, r.cy, TUNE.playerOrbit * r.unit, r.unit * 1.4, {
          color: '#ff5a5a', width: 3, life: 0.8,
        });
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

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
});
