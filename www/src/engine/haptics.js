/**
 * Haptics with three tiers: Capacitor Haptics on iOS, the Vibration API on
 * Android/web, and silence everywhere else. Never throws.
 */

const cap = () => globalThis.Capacitor;

function plugin() {
  const c = cap();
  return c && c.Plugins && c.Plugins.Haptics ? c.Plugins.Haptics : null;
}

export class Haptics {
  constructor() {
    this.enabled = true;
    this.plugin = null;
    this.canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  init() {
    this.plugin = plugin();
  }

  setEnabled(on) {
    this.enabled = !!on;
  }

  /** style: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' */
  fire(style = 'light') {
    if (!this.enabled) return;
    const p = this.plugin || plugin();
    if (p) {
      try {
        if (style === 'success' || style === 'warning' || style === 'error') {
          p.notification({ type: style.toUpperCase() });
        } else {
          p.impact({ style: style.toUpperCase() });
        }
        return;
      } catch {
        /* fall through to vibrate */
      }
    }
    if (this.canVibrate) {
      const ms = style === 'heavy' || style === 'error' ? 24 : style === 'medium' ? 14 : 8;
      try {
        navigator.vibrate(ms);
      } catch {
        /* ignore */
      }
    }
  }
}
