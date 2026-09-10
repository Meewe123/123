/**
 * In-app purchases, behind an interface.
 *
 * This build ships no billing bridge, so `available` is false and every call
 * refuses honestly. Nothing here simulates a purchase: an item that cannot be
 * bought is shown as unavailable rather than pretending to sell.
 *
 * To wire a real store later, hand the constructor a bridge exposing
 * `products(skus)`, `purchase(sku)` and `restore()` — StoreKit through a
 * Capacitor plugin, Play Billing, or a web checkout.
 */

export const PURCHASE_UNAVAILABLE = 'unavailable';

function detectBridge() {
  const cap = globalThis.Capacitor;
  const plugin = cap && cap.Plugins && (cap.Plugins.Purchases || cap.Plugins.InAppPurchase);
  if (plugin && typeof plugin.purchase === 'function') return plugin;
  const injected = globalThis.__ORBITAL_PURCHASE_BRIDGE__;
  if (injected && typeof injected.purchase === 'function') return injected;
  return null;
}

export class PurchaseService {
  constructor(bridge = detectBridge()) {
    this.bridge = bridge;
  }

  get available() {
    return this.bridge !== null;
  }

  /** Product metadata (price strings, localisation) when a store is present. */
  async products(skus = []) {
    if (!this.bridge || typeof this.bridge.products !== 'function') return [];
    try {
      return await this.bridge.products(skus);
    } catch {
      return [];
    }
  }

  /**
   * Returns { ok: true, sku } on success, or { ok: false, reason } — never a
   * fake success.
   */
  async purchase(sku) {
    if (!this.bridge) return { ok: false, reason: PURCHASE_UNAVAILABLE };
    try {
      const result = await this.bridge.purchase(sku);
      return result && result.ok ? { ok: true, sku } : { ok: false, reason: 'declined' };
    } catch (err) {
      return { ok: false, reason: err && err.message ? err.message : 'failed' };
    }
  }

  async restore() {
    if (!this.bridge || typeof this.bridge.restore !== 'function') return [];
    try {
      return (await this.bridge.restore()) || [];
    } catch {
      return [];
    }
  }
}
