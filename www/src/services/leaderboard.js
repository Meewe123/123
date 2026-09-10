/**
 * Leaderboards, behind an interface that a backend can slot into later.
 *
 * There is no server in this build, so there are no global standings and the
 * UI says so: everything here is the player's own history, stored on their own
 * device. `LocalStore` is one implementation of the store contract; a
 * Supabase/Firebase/own-backend store would implement the same three methods
 * and nothing above it would change.
 */

const MAX_RECENT = 20;

/**
 * @typedef {object} ScoreEntry
 * @property {'endless'|'daily'} mode
 * @property {number} score
 * @property {number} zone        zero-based zone index reached
 * @property {number} multiplier  peak multiplier
 * @property {number} perfects
 * @property {number} orbs
 * @property {string} date        YYYY-MM-DD
 * @property {number} seed
 */

/** Store contract: submit(entry) -> void, list(query) -> entries, best(query) -> entry|null. */
export class LocalStore {
  constructor(profile) {
    this.profile = profile;
  }

  async submit(entry) {
    const recent = this.profile.recent || (this.profile.recent = []);
    // An entry carrying an id replaces its earlier version, so a run that was
    // revived files one score rather than one per death.
    if (entry.id) {
      const existing = recent.findIndex((e) => e.id === entry.id);
      if (existing >= 0) recent.splice(existing, 1);
    }
    recent.unshift(entry);
    recent.length = Math.min(recent.length, MAX_RECENT);
  }

  async list({ mode, date, limit = 10 } = {}) {
    return (this.profile.recent || [])
      .filter((e) => (!mode || e.mode === mode) && (!date || e.date === date))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async best(query = {}) {
    const [top] = await this.list({ ...query, limit: 1 });
    return top || null;
  }
}

export class LeaderboardService {
  constructor(store) {
    this.store = store;
  }

  /** True once a real backend is wired in. The UI must not imply otherwise. */
  get isGlobal() {
    return false;
  }

  get label() {
    return 'YOUR RECORDS';
  }

  async submit(entry) {
    if (!entry || typeof entry.score !== 'number') return;
    await this.store.submit({ mode: 'endless', ...entry });
  }

  async top(limit = 10) {
    return this.store.list({ mode: 'endless', limit });
  }

  async personalBest() {
    return this.store.best({ mode: 'endless' });
  }
}

export class DailyLeaderboardService extends LeaderboardService {
  /** `dateKey` may be a string or a function — a session can outlive midnight. */
  constructor(store, dateKey) {
    super(store);
    this._dateKey = dateKey;
  }

  get dateKey() {
    return typeof this._dateKey === 'function' ? this._dateKey() : this._dateKey;
  }

  get label() {
    return "TODAY'S RUNS";
  }

  async submit(entry) {
    await this.store.submit({ ...entry, mode: 'daily', date: this.dateKey });
  }

  async top(limit = 10) {
    return this.store.list({ mode: 'daily', date: this.dateKey, limit });
  }

  async personalBest() {
    return this.store.best({ mode: 'daily', date: this.dateKey });
  }
}
