/**
 * DOM layer: screens, HUD, shop, missions, settings and toasts.
 * Knows nothing about the simulation — main.js feeds it plain values and
 * receives callbacks back.
 */

import { commas, mmss, clamp } from '../engine/util.js';
import { SKINS, ZONES, POWERUPS, TUNE } from '../game/config.js';
import { isComplete, ownsSkin, canAfford } from '../game/meta.js';

const $ = (id) => document.getElementById(id);

const SCREENS = ['title', 'tutorial', 'pause', 'over', 'shop', 'missions', 'settings'];

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.current = null;
    this.el = {
      hud: $('hud'),
      score: $('score'),
      multiplier: $('multiplier'),
      energyRun: $('energy-run'),
      powerbar: $('powerbar'),
      zoneBanner: $('zone-banner'),
      zoneNum: $('zone-banner').querySelector('.z-num'),
      zoneName: $('zone-banner').querySelector('.z-name'),
      toast: $('toast'),
      titleBest: $('title-best'),
      badgeShop: $('badge-shop'),
      badgeMissions: $('badge-missions'),
      overScore: $('over-score'),
      overBest: $('over-best'),
      overNewBest: $('over-newbest'),
      overEnergy: $('over-energy'),
      overCombo: $('over-combo'),
      overZone: $('over-zone'),
      overMissions: $('over-missions'),
      btnRevive: $('btn-revive'),
      pauseScore: $('pause-score'),
      pauseEnergy: $('pause-energy'),
      pauseZone: $('pause-zone'),
      skinGrid: $('skin-grid'),
      shopEnergy: $('shop-energy'),
      missionList: $('mission-list'),
      missionsEnergy: $('missions-energy'),
      streakN: $('streak-n'),
      btnDaily: $('btn-daily'),
      screens: {},
      switches: {
        music: $('sw-music'),
        sfx: $('sw-sfx'),
        haptics: $('sw-haptics'),
        reduced: $('sw-reduced'),
      },
      stats: {
        runs: $('st-runs'),
        rings: $('st-rings'),
        time: $('st-time'),
        best: $('st-best'),
        combo: $('st-combo'),
        energy: $('st-energy'),
      },
    };
    for (const name of SCREENS) this.el.screens[name] = $(`screen-${name}`) || $(name);

    this._lastScore = -1;
    this._lastMult = -1;
    this._chips = new Map();
    this._toastTimer = 0;
    this._bind();
  }

  _bind() {
    const h = this.h;
    const tap = (el, fn) => {
      if (!el) return;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        h.onUiSound?.();
        fn(e);
      });
    };

    // Tapping the title screen anywhere (outside a control) starts a run.
    this.el.screens.title.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-ui]')) return;
      h.onPlay();
    });

    tap($('btn-play'), () => h.onPlay());
    tap($('btn-tut-go'), () => h.onTutorialDone());
    tap($('btn-pause'), () => h.onPause());
    tap($('btn-resume'), () => h.onResume());
    tap($('btn-restart'), () => h.onRestart());
    tap($('btn-quit'), () => h.onQuit());
    tap($('btn-again'), () => h.onRestart());
    tap($('btn-over-home'), () => h.onQuit());
    tap($('btn-revive'), () => h.onRevive());
    tap($('btn-share'), () => h.onShare());
    tap($('btn-shop'), () => this.show('shop'));
    tap($('btn-shop-back'), () => this.show('title'));
    tap($('btn-missions'), () => this.show('missions'));
    tap($('btn-missions-back'), () => this.show('title'));
    tap($('btn-settings'), () => this.show('settings'));
    tap($('btn-settings-back'), () => this.show('title'));
    tap($('btn-daily'), () => h.onClaimDaily());
    tap($('btn-reset'), () => h.onReset());

    for (const [key, el] of Object.entries(this.el.switches)) {
      tap(el, () => {
        const next = el.getAttribute('aria-checked') !== 'true';
        el.setAttribute('aria-checked', String(next));
        h.onToggle(key, next);
      });
    }

    this._buildSkinGrid();
  }

  // -------------------------------------------------------------- screens ---

  show(name) {
    for (const key of SCREENS) {
      this.el.screens[key]?.classList.toggle('on', key === name);
    }
    this.current = name || null;
    this.el.hud.classList.toggle('on', name === null);
    this.el.hud.setAttribute('aria-hidden', name === null ? 'false' : 'true');
    if (name === 'shop') this.refreshShop();
    if (name === 'missions') this.refreshMissions();
    if (name === 'settings') this.refreshSettings();
    if (name === 'title') this.refreshTitle();
    this.h.onScreen?.(name);
  }

  showGame() {
    this.show(null);
  }

  setProfile(profile) {
    this.profile = profile;
  }

  /** Keep the interface tinted with the zone the player is currently in. */
  setTheme(pal) {
    const root = document.documentElement.style;
    root.setProperty('--bg0', pal.bg0);
    root.setProperty('--bg1', pal.bg1);
    root.setProperty('--ring', pal.ring);
    root.setProperty('--accent', pal.accent);
    root.setProperty('--orb', pal.orb);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', pal.bg0);
  }

  // ------------------------------------------------------------------ HUD ---

  setScore(score) {
    if (score === this._lastScore) return;
    this._lastScore = score;
    this.el.score.textContent = commas(score);
    this.el.score.classList.remove('bump');
    void this.el.score.offsetWidth;
    this.el.score.classList.add('bump');
  }

  setRunEnergy(n) {
    this.el.energyRun.textContent = commas(n);
  }

  setMultiplier(m) {
    if (m === this._lastMult) return;
    this._lastMult = m;
    this.el.multiplier.textContent = `x${m}`;
    this.el.multiplier.classList.toggle('on', m > 1);
    this.el.multiplier.classList.remove('bump');
    void this.el.multiplier.offsetWidth;
    if (m > 1) this.el.multiplier.classList.add('bump');
  }

  /** timers: { shield: charges, shieldColor, slow: seconds, double: seconds } */
  setPowers(timers) {
    const want = new Map();
    if (timers.shield > 0) want.set('shield', `x${timers.shield}`);
    if (timers.slow > 0) want.set('slow', `${Math.ceil(timers.slow)}s`);
    if (timers.double > 0) want.set('double', `${Math.ceil(timers.double)}s`);

    for (const [key, chip] of this._chips) {
      if (!want.has(key)) {
        chip.remove();
        this._chips.delete(key);
      }
    }
    for (const [key, suffix] of want) {
      let chip = this._chips.get(key);
      if (!chip) {
        chip = document.createElement('div');
        chip.className = 'power-chip';
        chip.style.color = key === 'shield' && timers.shieldColor
          ? timers.shieldColor
          : POWERUPS[key].color;
        this.el.powerbar.appendChild(chip);
        this._chips.set(key, chip);
      }
      if (key === 'shield' && timers.shieldColor) chip.style.color = timers.shieldColor;
      const label = `${POWERUPS[key].label}${suffix ? ` ${suffix}` : ''}`;
      if (chip.textContent !== label) chip.textContent = label;
    }
  }

  showZone(zoneIndex, lap) {
    const zone = ZONES[zoneIndex % ZONES.length];
    const number = zoneIndex + 1 + lap * ZONES.length;
    this.el.zoneNum.textContent = `ZONE ${number}`;
    this.el.zoneName.textContent = zone.name;
    this.el.zoneBanner.classList.remove('show');
    void this.el.zoneBanner.offsetWidth;
    this.el.zoneBanner.classList.add('show');
  }

  resetHud() {
    this._lastScore = -1;
    this._lastMult = -1;
    this.setScore(0);
    this.setRunEnergy(0);
    this.setMultiplier(1);
    this.setPowers({ shield: 0, slow: 0, double: 0 });
    this.el.zoneBanner.classList.remove('show');
  }

  // ---------------------------------------------------------------- title ---

  refreshTitle() {
    const p = this.profile;
    if (!p) return;
    this.el.titleBest.textContent = commas(p.bestScore);
    this.el.badgeShop.hidden = !this.h.hasShopNews?.();
    const claimable = this.h.claimableCount?.() || 0;
    this.el.badgeMissions.hidden = claimable === 0;
    if (claimable) this.el.badgeMissions.textContent = String(claimable);
  }

  // ------------------------------------------------------------ game over ---

  showGameOver(result) {
    const p = this.profile;
    this.el.overScore.textContent = commas(result.score);
    this.el.overBest.textContent = `BEST ${commas(p.bestScore)}`;
    this.el.overNewBest.classList.toggle('hidden', !result.isBest);
    this.el.overEnergy.textContent = commas(result.energy);
    this.el.overCombo.textContent = commas(result.bestCombo);
    this.el.overZone.textContent = String(result.zoneReached + 1 + result.lap * ZONES.length);

    const canRevive = result.canRevive;
    this.el.btnRevive.classList.toggle('hidden', !canRevive);
    this.el.btnRevive.textContent = `REVIVE · ${TUNE.reviveCost} ⬤`;
    this.el.btnRevive.disabled = !canRevive;

    this.el.overMissions.innerHTML = '';
    for (const m of p.missions || []) {
      const row = document.createElement('div');
      row.className = 'mission';
      row.style.padding = 'calc(var(--u) * 1.6)';
      row.innerHTML = `
        <div class="body">
          <div class="text" style="font-size:calc(var(--u)*2.8)">${escapeHtml(m.text)}</div>
          <div class="bar"><i style="width:${clamp((m.progress / m.target) * 100, 0, 100)}%"></i></div>
        </div>
        <div class="cost" style="font-weight:900;color:${isComplete(m) ? 'var(--gold)' : 'var(--ink-faint)'}">
          ${isComplete(m) ? (m.claimed ? '✓' : `+${m.reward}`) : `${Math.floor(m.progress)}/${m.target}`}
        </div>`;
      this.el.overMissions.appendChild(row);
    }

    this.show('over');
  }

  showPause(state) {
    this.el.pauseScore.textContent = commas(state.score);
    this.el.pauseEnergy.textContent = commas(state.energy);
    this.el.pauseZone.textContent = String(state.zone + 1 + state.lap * ZONES.length);
    this.show('pause');
  }

  // ----------------------------------------------------------------- shop ---

  _buildSkinGrid() {
    this.el.skinGrid.innerHTML = '';
    this._skinCards = new Map();
    for (const skin of SKINS) {
      const card = document.createElement('button');
      card.className = 'skin';
      card.type = 'button';
      card.setAttribute('data-ui', '');
      card.innerHTML = `
        <div class="swatch ${skin.shape}" style="background:radial-gradient(circle at 32% 30%, ${skin.glow}, ${shade(skin.trail)});
             box-shadow:0 0 calc(var(--u)*2.4) ${skin.glow}66"><i style="background:${skin.core}"></i></div>
        <div class="name">${escapeHtml(skin.name)}</div>
        <div class="cost"></div>`;
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        this.h.onSkin(skin.id);
      });
      this.el.skinGrid.appendChild(card);
      this._skinCards.set(skin.id, card);
    }
  }

  refreshShop() {
    const p = this.profile;
    if (!p) return;
    this.el.shopEnergy.textContent = commas(p.energy);
    for (const skin of SKINS) {
      const card = this._skinCards.get(skin.id);
      const owned = ownsSkin(p, skin.id);
      const equipped = p.skin === skin.id;
      card.classList.toggle('equipped', equipped);
      card.classList.toggle('locked', !owned);
      const cost = card.querySelector('.cost');
      cost.className = `cost${owned ? ' owned' : ''}`;
      cost.textContent = equipped ? 'EQUIPPED' : owned ? 'OWNED' : `${commas(skin.cost)} ⬤`;
      if (!owned) cost.style.color = canAfford(p, skin.id) ? 'var(--gold)' : 'var(--ink-faint)';
    }
  }

  // ------------------------------------------------------------- missions ---

  refreshMissions() {
    const p = this.profile;
    if (!p) return;
    this.el.missionsEnergy.textContent = commas(p.energy);
    this.el.streakN.textContent = String(Math.max(1, p.streak || 1));

    const available = this.h.dailyAvailable?.();
    this.el.btnDaily.textContent = available ? `CLAIM ${this.h.dailyAmount?.() || 50}` : 'CLAIMED';
    this.el.btnDaily.disabled = !available;

    this.el.missionList.innerHTML = '';
    for (const m of p.missions || []) {
      const done = isComplete(m);
      const row = document.createElement('div');
      row.className = 'mission';
      row.innerHTML = `
        <div class="body">
          <div class="text">${escapeHtml(m.text)}</div>
          <div class="bar"><i style="width:${clamp((m.progress / m.target) * 100, 0, 100)}%"></i></div>
          <div class="meta">${Math.floor(Math.min(m.progress, m.target))} / ${m.target}</div>
        </div>`;
      const btn = document.createElement('button');
      btn.className = 'btn small gold';
      btn.type = 'button';
      btn.setAttribute('data-ui', '');
      if (m.claimed) {
        btn.textContent = '✓';
        btn.disabled = true;
        btn.className = 'btn small ghost';
      } else if (done) {
        btn.textContent = `+${m.reward}`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.h.onClaimMission(m);
        });
      } else {
        btn.textContent = `+${m.reward}`;
        btn.disabled = true;
        btn.className = 'btn small ghost';
      }
      row.appendChild(btn);
      this.el.missionList.appendChild(row);
    }
  }

  // ------------------------------------------------------------- settings ---

  refreshSettings() {
    const p = this.profile;
    if (!p) return;
    this.el.switches.music.setAttribute('aria-checked', String(!!p.music));
    this.el.switches.sfx.setAttribute('aria-checked', String(!!p.sfx));
    this.el.switches.haptics.setAttribute('aria-checked', String(!!p.haptics));
    this.el.switches.reduced.setAttribute('aria-checked', String(!!p.reducedFx));
    this.el.stats.runs.textContent = commas(p.runs);
    this.el.stats.rings.textContent = commas(p.totalRings);
    this.el.stats.time.textContent = mmss(p.totalTimeMs / 1000);
    this.el.stats.best.textContent = commas(p.bestScore);
    this.el.stats.combo.textContent = commas(p.bestCombo);
    this.el.stats.energy.textContent = commas(p.totalEnergy);
  }

  // ---------------------------------------------------------------- toast ---

  toast(message, ms = 1600) {
    this.el.toast.textContent = message;
    this.el.toast.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('on'), ms);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Darken a hex colour for the skin swatch gradient. */
function shade(hex, k = 0.55) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}
