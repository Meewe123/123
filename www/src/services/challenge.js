/**
 * "Beat my score" challenges.
 *
 * A challenge is a seed plus the score to beat, packed into a short code that
 * travels inside a shared link. No server is involved: the code carries
 * everything the receiving game needs to reproduce the exact same run.
 *
 * When a backend arrives it can hand out the same shape from a URL instead,
 * and `ChallengeService` is the only thing that changes.
 */

const VERSION = '1';
const SEP = '-';

const toBase36 = (n) => Math.max(0, Math.floor(n)).toString(36);
const fromBase36 = (s) => {
  const n = parseInt(s, 36);
  return Number.isFinite(n) ? n : 0;
};

/**
 * @typedef {object} Challenge
 * @property {'endless'|'daily'} mode
 * @property {number} seed
 * @property {number} score
 */

export function encodeChallenge({ mode = 'endless', seed = 0, score = 0 } = {}) {
  return [VERSION, mode === 'daily' ? 'd' : 'e', toBase36(seed >>> 0), toBase36(score)].join(SEP);
}

export function decodeChallenge(code) {
  if (typeof code !== 'string') return null;
  const parts = code.trim().split(SEP);
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, modeChar, seedPart, scorePart] = parts;
  if (modeChar !== 'd' && modeChar !== 'e') return null;
  if (!/^[0-9a-z]+$/.test(seedPart) || !/^[0-9a-z]+$/.test(scorePart)) return null;
  return {
    mode: modeChar === 'd' ? 'daily' : 'endless',
    seed: fromBase36(seedPart) >>> 0,
    score: fromBase36(scorePart),
  };
}

export class ChallengeService {
  constructor({ location = globalThis.location } = {}) {
    this.location = location;
  }

  /** A challenge carried in the current URL, if there is one. */
  incoming() {
    try {
      const params = new URLSearchParams(this.location.search);
      return decodeChallenge(params.get('c'));
    } catch {
      return null;
    }
  }

  /** Remove the challenge from the address bar once it has been consumed. */
  clear() {
    try {
      const url = new URL(this.location.href);
      if (!url.searchParams.has('c')) return;
      url.searchParams.delete('c');
      globalThis.history?.replaceState?.({}, '', url.toString());
    } catch {
      /* ignore */
    }
  }

  /** A shareable link, or just the code when there is no page URL to hang it on. */
  link(challenge) {
    const code = encodeChallenge(challenge);
    try {
      const url = new URL(this.location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set('c', code);
      return url.toString();
    } catch {
      return code;
    }
  }
}
