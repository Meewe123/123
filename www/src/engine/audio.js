/**
 * Fully procedural audio. No audio files ship with the game: every sound and
 * every note of the soundtrack is synthesised with WebAudio at runtime, which
 * keeps the bundle tiny and lets the music react to how the run is going.
 */

const SCALE = [0, 2, 3, 5, 7, 8, 10]; // natural minor
const PENTA = [0, 3, 5, 7, 10];

const noteHz = (semitone) => 440 * Math.pow(2, (semitone - 9) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.sfxEnabled = true;
    this.musicEnabled = true;
    this.intensity = 0;
    this._targetIntensity = 0;
    this._noiseBuffer = null;
    this._timer = null;
    this._nextNote = 0;
    this._step = 0;
    this._root = -5; // G
  }

  /** Must be called from inside a user gesture (iOS unlocks audio that way). */
  unlock() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.85;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.0001;

    // A cheap stereo-ish delay gives the arcade blips some air.
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = 0.22;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.3;
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 2200;
    this.delay.connect(this.feedback).connect(this.delayTone).connect(this.delay);
    this.delayTone.connect(this.master);

    this.sfxBus.connect(this.comp);
    this.musicBus.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);

    const len = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buf;

    this.ready = true;
    if (ctx.state === 'suspended') ctx.resume();
    this._startScheduler();
    this.applyMusicVolume();
  }

  setSfx(on) {
    this.sfxEnabled = !!on;
  }

  setMusic(on) {
    this.musicEnabled = !!on;
    this.applyMusicVolume();
  }

  applyMusicVolume() {
    if (!this.ready) return;
    const target = this.musicEnabled ? 0.32 : 0.0001;
    const g = this.musicBus.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(target, this.ctx.currentTime, 0.4);
  }

  suspend() {
    if (this.ready && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ready && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** 0..1 — drives tempo, brightness and layering of the soundtrack. */
  setIntensity(v) {
    this._targetIntensity = Math.max(0, Math.min(1, v));
  }

  /** Musical key per zone, so each zone sounds distinct. */
  setKey(rootSemitone) {
    this._root = rootSemitone;
  }

  // ---------------------------------------------------------------- sfx ---

  _env(node, t, { attack = 0.004, decay = 0.12, peak = 1, sustain = 0 }) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.exponentialRampToValueAtTime(Math.max(0.0001, sustain || 0.0001), t + attack + decay);
    return t + attack + decay;
  }

  _tone(freq, opts = {}) {
    if (!this.ready || !this.sfxEnabled) return;
    const {
      type = 'triangle', dur = 0.14, gain = 0.3, slideTo = null,
      send = 0, detune = 0, delayStart = 0,
    } = opts;
    const t = this.ctx.currentTime + delayStart;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.value = detune;
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    this._env(amp, t, { attack: 0.005, decay: dur, peak: gain });
    osc.connect(amp).connect(this.sfxBus);
    if (send > 0) {
      const s = this.ctx.createGain();
      s.gain.value = send;
      amp.connect(s).connect(this.delay);
    }
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  _noise(opts = {}) {
    if (!this.ready || !this.sfxEnabled) return;
    const { dur = 0.3, gain = 0.3, cutoff = 1800, type = 'lowpass', q = 1 } = opts;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(cutoff, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.15), t + dur);
    filt.Q.value = q;
    const amp = this.ctx.createGain();
    this._env(amp, t, { attack: 0.002, decay: dur, peak: gain });
    src.connect(filt).connect(amp).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  play(name, arg = 0) {
    if (!this.ready || !this.sfxEnabled) return;
    switch (name) {
      case 'flip':
        this._tone(300, { type: 'square', dur: 0.055, gain: 0.12, slideTo: 210 });
        break;
      case 'pass': {
        const step = PENTA[Math.min(arg, 40) % PENTA.length] + 12 * Math.floor(Math.min(arg, 40) / PENTA.length);
        this._tone(noteHz(this._root + 12 + step), { type: 'triangle', dur: 0.16, gain: 0.22, send: 0.25 });
        break;
      }
      case 'orb':
        this._tone(noteHz(this._root + 24 + PENTA[arg % PENTA.length]), {
          type: 'sine', dur: 0.12, gain: 0.2, send: 0.35,
        });
        break;
      case 'perfect':
        this._tone(noteHz(this._root + 31), { type: 'sine', dur: 0.1, gain: 0.18, send: 0.4 });
        this._tone(noteHz(this._root + 36), { type: 'sine', dur: 0.14, gain: 0.16, send: 0.4, delayStart: 0.055 });
        break;
      case 'hit':
        this._noise({ dur: 0.45, gain: 0.4, cutoff: 3200 });
        this._tone(180, { type: 'sawtooth', dur: 0.5, gain: 0.3, slideTo: 38 });
        break;
      case 'shield':
        this._tone(noteHz(this._root + 19), { type: 'square', dur: 0.18, gain: 0.16, send: 0.3 });
        this._noise({ dur: 0.2, gain: 0.18, cutoff: 5000, type: 'highpass' });
        break;
      case 'power':
        [0, 4, 7, 12].forEach((s, i) => this._tone(noteHz(this._root + 24 + s), {
          type: 'triangle', dur: 0.12, gain: 0.16, delayStart: i * 0.045, send: 0.3,
        }));
        break;
      case 'revive':
        [12, 7, 4, 0].forEach((s, i) => this._tone(noteHz(this._root + 24 + s), {
          type: 'sine', dur: 0.22, gain: 0.16, delayStart: i * 0.07, send: 0.35,
        }));
        break;
      case 'unlock':
        [0, 4, 7, 11, 14].forEach((s, i) => this._tone(noteHz(this._root + 24 + s), {
          type: 'triangle', dur: 0.3, gain: 0.14, delayStart: i * 0.06, send: 0.4,
        }));
        break;
      case 'ui':
        this._tone(660, { type: 'sine', dur: 0.05, gain: 0.1 });
        break;
      case 'deny':
        this._tone(150, { type: 'square', dur: 0.12, gain: 0.12, slideTo: 110 });
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------- music ---

  _startScheduler() {
    if (this._timer) return;
    this._nextNote = this.ctx.currentTime + 0.1;
    this._timer = setInterval(() => this._schedule(), 25);
  }

  _schedule() {
    if (!this.ready || this.ctx.state !== 'running') return;
    this.intensity += (this._targetIntensity - this.intensity) * 0.06;
    const bpm = 96 + this.intensity * 46;
    const spb = 60 / bpm / 2; // eighth notes
    const horizon = this.ctx.currentTime + 0.18;
    let guard = 0;
    while (this._nextNote < horizon && guard++ < 32) {
      this._emitStep(this._nextNote, this._step);
      this._nextNote += spb;
      this._step = (this._step + 1) % 32;
    }
  }

  _emitStep(t, step) {
    const I = this.intensity;
    const bus = this.musicBus;
    const root = this._root;

    // Sub pulse — the heartbeat of the track.
    if (step % 4 === 0) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(noteHz(root - 12), t);
      o.frequency.exponentialRampToValueAtTime(noteHz(root - 24), t + 0.22);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(bus);
      o.start(t);
      o.stop(t + 0.34);
    }

    // Hat — appears as the run heats up.
    if (I > 0.18 && step % 2 === 1) {
      const s = this.ctx.createBufferSource();
      s.buffer = this._noiseBuffer;
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 + I * 0.07, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      s.connect(f).connect(g).connect(bus);
      s.start(t);
      s.stop(t + 0.08);
    }

    // Arpeggio — density scales with intensity.
    const arpGate = I > 0.55 ? 1 : I > 0.25 ? 2 : 4;
    if (step % arpGate === 0) {
      const degree = SCALE[(step * 3) % SCALE.length];
      const octave = 12 * (1 + ((step >> 3) & 1));
      const o = this.ctx.createOscillator();
      const f = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = noteHz(root + octave + degree);
      f.type = 'lowpass';
      f.frequency.value = 900 + I * 4200;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09 + I * 0.05, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(f).connect(g).connect(bus);
      o.start(t);
      o.stop(t + 0.22);
    }

    // Pad — two detuned saws, refreshed once per bar.
    if (step % 16 === 0) {
      const chord = [0, 3, 7, 10];
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(420 + I * 1500, t);
      f.Q.value = 3;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 + I * 0.04, t + 0.9);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      f.connect(g).connect(bus);
      for (const semi of chord) {
        for (const det of [-7, 7]) {
          const o = this.ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = noteHz(root + semi);
          o.detune.value = det;
          o.connect(f);
          o.start(t);
          o.stop(t + 2.8);
        }
      }
    }
  }
}
