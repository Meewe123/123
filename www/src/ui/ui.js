/**
 * DOM layer: screens, HUD, shop, collection, daily and toasts.
 * Knows nothing about the simulation — main.js feeds it plain values and
 * receives callbacks back.
 */

import { commas, mmss, clamp } from '../engine/util.js';
import { ZONES, POWERUPS, TUNE, OVERDRIVE_AT, COSMETIC_KINDS, zoneByIndex } from '../game/config.js';
import {
  isComplete, unlockState, kindOf, collectionProgress, nextStreakMilestone,
} from '../game/meta.js';
import { listed as listedAchievements, progress as achievementProgress } from '../game/achievements.js';

const $ = (id) => document.getElementById(id);

const SCREENS = ['title', 'pause', 'over', 'daily', 'collection', 'shop', 'settings'];

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.current = null;
    this.shopTab = 'skin';

    this.el = {
      hud: $('hud'),
      score: $('score'),
      multiplier: $('multiplier'),
      chainBar: $('chain-bar'),
      chainFill: $('chain-bar').firstElementChild,
      runShards: $('run-shards'),
      ghostPill: $('ghost-pill'),
      ghostDelta: $('ghost-delta'),
      powerbar: $('powerbar'),
      coach: $('coach'),
      zoneBanner: $('zone-banner'),
      zoneNum: $('zone-banner').querySelector('.z-num'),
      zoneName: $('zone-banner').querySelector('.z-name'),
      toast: $('toast'),
      screens: {},
      switches: {
        music: $('sw-music'), sfx: $('sw-sfx'), haptics: $('sw-haptics'), reduced: $('sw-reduced'),
      },
    };
    for (const name of SCREENS) this.el.screens[name] = $(`screen-${name}`);

    this._lastScore = -1;
    this._lastMult = -1;
    this._lastChain = -1;
    this._chips = new Map();
    this._toastTimer = 0;
    this._coachTimer = 0;
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

    // Tapping the title screen anywhere outside a control starts a run.
    this.el.screens.title.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-ui]')) return;
      h.onPlay();
    });

    tap($('btn-play'), () => h.onPlay());
    tap($('btn-pause'), () => h.onPause());
    tap($('btn-resume'), () => h.onResume());
    tap($('btn-restart'), () => h.onRestart());
    tap($('btn-quit'), () => h.onQuit());
    tap($('btn-again'), () => h.onRestart());
    tap($('btn-over-home'), () => h.onQuit());
    tap($('btn-over-daily'), () => this.show('daily'));
    tap($('btn-revive'), () => h.onRevive());
    tap($('btn-share'), () => h.onShare());

    tap($('btn-daily-open'), () => this.show('daily'));
    tap($('btn-daily-back'), () => this.show('title'));
    tap($('btn-daily-play'), () => h.onDaily());
    tap($('btn-collection'), () => this.show('collection'));
    tap($('btn-collection-back'), () => this.show('title'));
    tap($('btn-shop'), () => this.show('shop'));
    tap($('btn-shop-back'), () => this.show('title'));
    tap($('btn-settings'), () => this.show('settings'));
    tap($('btn-settings-back'), () => this.show('title'));
    tap($('btn-reset'), () => h.onReset());

    for (const [key, el] of Object.entries(this.el.switches)) {
      tap(el, () => {
        const next = el.getAttribute('aria-checked') !== 'true';
        el.setAttribute('aria-checked', String(next));
        h.onToggle(key, next);
      });
    }

    this._buildShopTabs();
  }

  // -------------------------------------------------------------- screens ---

  show(name) {
    for (const key of SCREENS) this.el.screens[key]?.classList.toggle('on', key === name);
    this.current = name || null;
    this.el.hud.classList.toggle('on', name === null);
    this.el.hud.setAttribute('aria-hidden', name === null ? 'false' : 'true');
    if (name === 'title') this.refreshTitle();
    if (name === 'shop') this.refreshShop();
    if (name === 'collection') this.refreshCollection();
    if (name === 'daily') this.refreshDaily();
    if (name === 'settings') this.refreshSettings();
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
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', pal.bg0);
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

  setRunShards(n) {
    this.el.runShards.textContent = commas(n);
  }

  /** The multiplier and, under it, how close the next step is. */
  setMultiplier(m, chainProgress) {
    if (m !== this._lastMult) {
      this._lastMult = m;
      this.el.multiplier.textContent = `x${m}`;
      this.el.multiplier.classList.toggle('on', m > 1);
      this.el.multiplier.classList.toggle('hot', m >= 4);
      this.el.multiplier.classList.toggle('overdrive', m >= OVERDRIVE_AT);
      this.el.multiplier.classList.remove('bump');
      void this.el.multiplier.offsetWidth;
      if (m > 1) this.el.multiplier.classList.add('bump');
      this.el.chainBar.classList.toggle('on', m > 1 && m < OVERDRIVE_AT);
    }
    const pct = Math.round(clamp(chainProgress, 0, 1) * 100);
    if (pct !== this._lastChain) {
      this._lastChain = pct;
      this.el.chainFill.style.width = `${pct}%`;
    }
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
        this.el.powerbar.appendChild(chip);
        this._chips.set(key, chip);
      }
      chip.style.color = key === 'shield' && timers.shieldColor
        ? timers.shieldColor
        : POWERUPS[key].color;
      const label = `${POWERUPS[key].label}${suffix ? ` ${suffix}` : ''}`;
      if (chip.textContent !== label) chip.textContent = label;
    }
  }

  /** How the player is doing against their personal best ghost. */
  setGhost(state) {
    const pill = this.el.ghostPill;
    if (!state) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    const delta = state.delta;
    pill.classList.toggle('ahead', delta > 0);
    this.el.ghostDelta.textContent = delta > 0 ? `+${commas(delta)}` : commas(delta);
  }

  showZone(zoneIndex, lap) {
    const zone = zoneByIndex(zoneIndex);
    this.el.zoneNum.textContent = `ZONE ${zoneIndex + 1 + lap * ZONES.length}`;
    this.el.zoneName.textContent = zone.name;
    this.el.zoneBanner.classList.remove('show');
    void this.el.zoneBanner.offsetWidth;
    this.el.zoneBanner.classList.add('show');
  }

  /** One short line of in-run coaching, then it gets out of the way. */
  coach(text, ms = 2200) {
    this.el.coach.textContent = text;
    this.el.coach.classList.add('on');
    clearTimeout(this._coachTimer);
    this._coachTimer = setTimeout(() => this.el.coach.classList.remove('on'), ms);
  }

  resetHud() {
    this._lastScore = -1;
    this._lastMult = -1;
    this._lastChain = -1;
    this.setScore(0);
    this.setRunShards(0);
    this.setMultiplier(1, 0);
    this.setPowers({ shield: 0, slow: 0, double: 0 });
    this.setGhost(null);
    this.el.coach.classList.remove('on');
    this.el.zoneBanner.classList.remove('show');
  }

  // ---------------------------------------------------------------- title ---

  refreshTitle() {
    const p = this.profile;
    if (!p) return;
    $('title-best').textContent = commas(p.bestScore);
    $('title-daily').textContent = p.dailyBest?.score ? commas(p.dailyBest.score) : '—';
    $('title-streak').textContent = String(p.streak || 0);
    $('badge-shop').hidden = !this.h.hasShopNews?.();
    const claimable = this.h.claimableCount?.() || 0;
    const dailyBadge = $('badge-daily');
    dailyBadge.hidden = !this.h.dailyAvailable?.() && claimable === 0;
    dailyBadge.textContent = claimable ? String(claimable) : '!';
  }

  // ------------------------------------------------------------ summary ---

  showRunSummary(result) {
    const p = this.profile;
    $('over-mode').textContent = result.mode === 'daily' ? 'DAILY COMPLETE' : 'RUN COMPLETE';
    $('over-score').textContent = commas(result.score);
    $('over-best').textContent = result.mode === 'daily'
      ? `TODAY'S BEST ${commas(p.dailyBest?.score || 0)}`
      : `BEST ${commas(p.bestScore)}`;

    const records = $('over-records');
    records.innerHTML = '';
    const addRecord = (cls, text) => {
      const el = document.createElement('div');
      el.className = `record ${cls}`;
      el.textContent = text;
      records.appendChild(el);
    };
    if (result.isBest) addRecord('', 'NEW BEST');
    if (result.isZoneBest) addRecord('zone', 'NEW ZONE BEST');
    if (result.isMultBest) addRecord('mult', 'NEW MULTIPLIER BEST');

    const near = $('over-near');
    const gap = (p.bestScore || 0) - result.score;
    near.textContent = !result.isBest && gap > 0 && gap <= Math.max(25, p.bestScore * 0.25)
      ? `${commas(gap)} from your best`
      : '';

    $('over-zone').textContent = String(result.zoneReached + 1 + result.lap * ZONES.length);
    $('over-mult').textContent = `x${result.bestMultiplier}`;
    $('over-perfects').textContent = commas(result.perfects);
    $('over-orbs').textContent = commas(result.orbs);

    const greed = $('over-greed');
    greed.innerHTML = result.orbs
      ? `<b>${commas(result.greedOrbs)}</b> greed · ${commas(result.safeOrbs)} safe · <b>+${commas(result.shards)}</b> shards`
      : `<b>+${commas(result.shards)}</b> shards`;

    const revive = $('btn-revive');
    revive.classList.toggle('hidden', !result.canRevive);
    revive.textContent = `REVIVE · ${TUNE.reviveCost} ◈`;
    revive.disabled = !result.canRevive;
    $('btn-over-daily').classList.toggle('hidden', result.mode === 'daily');

    this._renderMissions($('over-missions'), p, true);

    this.show('over');
  }

  showPause(state) {
    $('pause-score').textContent = commas(state.score);
    $('pause-mult').textContent = `x${state.multiplier}`;
    $('pause-zone').textContent = String(state.zone + 1 + state.lap * ZONES.length);
    this.show('pause');
  }

  // ---------------------------------------------------------------- daily ---

  async refreshDaily() {
    const p = this.profile;
    if (!p) return;
    const info = this.h.dailyInfo?.() || {};
    $('daily-shards').textContent = commas(p.shards);
    $('daily-seed').textContent = info.label || '#00000';
    $('daily-date').textContent = info.date || '';
    const best = p.dailyBest || {};
    $('daily-score').textContent = commas(best.score || 0);
    $('daily-zone').textContent = String((best.zone || 0) + 1);
    $('daily-mult').textContent = `x${best.multiplier || 1}`;
    $('daily-perfects').textContent = commas(best.perfects || 0);

    const btn = $('btn-daily-play');
    const played = !!p.dailyPlayed;
    btn.textContent = played ? 'RUN IT AGAIN' : 'START DAILY';
    $('daily-note').textContent = played
      ? "Today's attempt is recorded. Replays are for practice — they still improve your own best."
      : 'Everyone gets the same rings today.';

    $('streak-n').textContent = String(Math.max(1, p.streak || 1));
    const next = nextStreakMilestone(p);
    $('streak-next').innerHTML = next
      ? `<b>${next.days - (p.streak || 0)}</b> more day${next.days - (p.streak || 0) === 1 ? '' : 's'}<br />to <b>+${next.reward} ◈</b>`
      : 'Every milestone claimed.';

    this._renderMissions($('mission-list'), p);
    $('mission-count').textContent = `${(p.missions || []).filter(isComplete).length}/${(p.missions || []).length}`;

    const board = $('daily-board');
    $('daily-board-title').textContent = this.h.dailyBoardLabel?.() || "TODAY'S RUNS";
    board.innerHTML = '<div class="board-empty">Loading…</div>';
    const rows = (await this.h.dailyBoard?.()) || [];
    board.innerHTML = '';
    if (!rows.length) {
      board.innerHTML = '<div class="board-empty">No runs today yet.</div>';
      return;
    }
    rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'board-row';
      el.innerHTML = `<span class="rank">${i + 1}</span>
        <span class="meta">ZONE ${(row.zone || 0) + 1} · x${row.multiplier || 1}</span>
        <span class="val">${commas(row.score)}</span>`;
      board.appendChild(el);
    });
  }

  /** Missions render the same on the daily screen and the run summary. */
  _renderMissions(host, profile, compact = false) {
    host.innerHTML = '';
    for (const m of profile.missions || []) {
      const done = isComplete(m);
      const row = document.createElement('div');
      row.className = 'mission';
      if (compact) row.style.padding = 'calc(var(--u) * 1.6)';
      row.innerHTML = `
        <div class="body">
          <div class="text"${compact ? ' style="font-size:calc(var(--u)*2.8)"' : ''}>${escapeHtml(m.text)}</div>
          <div class="bar"><i style="width:${clamp((m.progress / m.target) * 100, 0, 100)}%"></i></div>
          ${compact ? '' : `<div class="meta">${Math.floor(Math.min(m.progress, m.target))} / ${m.target}</div>`}
        </div>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-ui', '');
      btn.textContent = m.claimed ? '✓' : `+${m.reward}`;
      if (done && !m.claimed) {
        btn.className = 'btn small gold';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.h.onClaimMission(m);
        });
      } else {
        btn.className = 'btn small ghost';
        btn.disabled = true;
      }
      row.appendChild(btn);
      host.appendChild(row);
    }
  }

  // ----------------------------------------------------------- collection ---

  refreshCollection() {
    const p = this.profile;
    if (!p) return;
    $('collection-shards').textContent = commas(p.shards);
    $('pr-best').textContent = commas(p.bestScore);
    $('pr-zone').textContent = String((p.bestZone || 0) + 1);
    $('pr-mult').textContent = `x${p.bestMultiplier || 1}`;
    $('pr-perfects').textContent = commas(p.totalPerfects);
    $('pr-orbs').textContent = commas(p.totalOrbs);
    $('pr-streak').textContent = String(p.streak || 0);

    const cp = collectionProgress(p);
    $('collection-count').textContent = `${cp.owned}/${cp.total}`;

    const grid = $('collection-grid');
    grid.innerHTML = '';
    for (const kind of COSMETIC_KINDS) {
      const block = document.createElement('div');
      block.className = 'collection-kind';
      const heading = document.createElement('h4');
      heading.textContent = kind.label;
      block.appendChild(heading);
      const row = document.createElement('div');
      row.className = 'chip-row';
      for (const item of kind.items) {
        const state = unlockState(p, kind.id, item.id);
        const owned = state === 'owned' || state === 'equipped';
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `chip${state === 'equipped' ? ' equipped' : ''}${owned ? '' : ' locked'}`;
        chip.setAttribute('data-ui', '');
        chip.disabled = !owned;
        chip.innerHTML = `<span class="dotcol" style="background:${swatchOf(kind.id, item)}"></span>${escapeHtml(item.name)}`;
        if (owned) {
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            this.h.onCosmetic(kind.id, item.id);
          });
        }
        row.appendChild(chip);
      }
      block.appendChild(row);
      grid.appendChild(block);
    }

    const ap = achievementProgress(p);
    $('achievement-count').textContent = `${ap.unlocked}/${ap.total}`;
    const list = $('achievement-list');
    list.innerHTML = '';
    for (const a of listedAchievements(p)) {
      const el = document.createElement('div');
      el.className = `ach${a.unlocked ? ' done' : ''}`;
      el.innerHTML = `
        <div class="mark">${a.unlocked ? '✓' : '•'}</div>
        <div class="body">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="desc">${escapeHtml(a.desc)}</div>
        </div>
        <div class="reward">${a.unlocked ? 'EARNED' : `+${a.reward}`}</div>`;
      list.appendChild(el);
    }
  }

  // ----------------------------------------------------------------- shop ---

  _buildShopTabs() {
    const tabs = $('shop-tabs');
    tabs.innerHTML = '';
    for (const kind of COSMETIC_KINDS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-ui', '');
      btn.textContent = kind.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.h.onUiSound?.();
        this.shopTab = kind.id;
        this.refreshShop();
      });
      tabs.appendChild(btn);
    }
  }

  refreshShop() {
    const p = this.profile;
    if (!p) return;
    $('shop-shards').textContent = commas(p.shards);

    const tabs = $('shop-tabs').children;
    COSMETIC_KINDS.forEach((kind, i) => {
      tabs[i].setAttribute('aria-selected', String(kind.id === this.shopTab));
    });

    const kind = kindOf(this.shopTab);
    const grid = $('shop-grid');
    grid.innerHTML = '';
    for (const item of kind.items) {
      const state = unlockState(p, kind.id, item.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `skin${state === 'equipped' ? ' equipped' : ''}${state === 'owned' || state === 'equipped' ? '' : ' locked'}`;
      card.setAttribute('data-ui', '');
      card.innerHTML = `
        <div class="swatch ${previewClass(kind.id, item)}" style="${swatchStyle(kind.id, item)}"><i style="${innerStyle(kind.id, item)}"></i></div>
        <div class="name">${escapeHtml(item.name)}</div>
        ${priceMarkup(state, item)}
        ${item.desc ? `<div class="desc">${escapeHtml(item.desc)}</div>` : ''}`;
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        this.h.onCosmetic(kind.id, item.id);
      });
      grid.appendChild(card);
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
    $('st-runs').textContent = commas(p.runs);
    $('st-rings').textContent = commas(p.totalRings);
    $('st-time').textContent = mmss(p.totalTimeMs / 1000);
    $('st-greed').textContent = commas(p.totalGreedOrbs);
    $('st-shards').textContent = commas(p.totalShards);
    $('st-daily').textContent = commas(p.dailyRuns);
  }

  // ---------------------------------------------------------------- toast ---

  toast(message, ms = 1700) {
    this.el.toast.textContent = message;
    this.el.toast.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('on'), ms);
  }
}

// ------------------------------------------------------------- helpers ---

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function shade(hex, k = 0.55) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${Math.round(((n >> 16) & 255) * k)},${Math.round(((n >> 8) & 255) * k)},${Math.round((n & 255) * k)})`;
}

/** Every cosmetic kind previews as a colour, so the collection reads at a glance. */
function swatchOf(kindId, item) {
  if (kindId === 'skin') return item.glow;
  if (kindId === 'trail') return trailColor(item.id);
  return effectColor(item.id);
}

const trailColor = (id) => ({
  comet: '#5ff0e0', ribbon: '#8fd0ff', sparks: '#ffd23f',
  prism: '#ff6fd8', pulse: '#b6ff3c', voidline: '#8a8aff',
}[id] || '#5ff0e0');

const effectColor = (id) => ({
  zone: '#5ff0e0', ring: '#8fd0ff', starburst: '#ffd23f',
  shockwave: '#ff8a4c', bloom: '#ff6fd8', novaburst: '#ffffff',
}[id] || '#5ff0e0');

function previewClass(kindId, item) {
  if (kindId === 'skin') return item.shape;
  if (kindId === 'trail') return 'trailprev';
  return 'effectprev';
}

function swatchStyle(kindId, item) {
  const color = swatchOf(kindId, item);
  return `background:radial-gradient(circle at 32% 30%, ${color}, ${shade(color)});`
    + `box-shadow:0 0 calc(var(--u)*2.4) ${color}66`;
}

function innerStyle(kindId, item) {
  if (kindId === 'skin') return `background:${item.core}`;
  return 'background:#ffffff';
}

function priceMarkup(state, item) {
  switch (state) {
    case 'equipped': return '<div class="cost owned">EQUIPPED</div>';
    case 'owned': return '<div class="cost owned">OWNED</div>';
    case 'achievement': return '<div class="lock">ACHIEVEMENT</div>';
    case 'premium': return '<div class="lock premium">PREMIUM</div>';
    case 'buyable': return `<div class="cost">${commas(item.cost)} ◈</div>`;
    default: return `<div class="cost" style="color:var(--ink-faint)">${commas(item.cost)} ◈</div>`;
  }
}
