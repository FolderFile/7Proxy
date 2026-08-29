/**
 * API Key Manager - rotation, cooldown and permanent disable.
 *
 * A key can be in one of three states:
 *  - available:  healthy, may be used
 *  - cooldown:   temporarily cooled down (rate limit), available again after cooldownMs
 *  - disabled:   permanently disabled for this process (bad key 401/403)
 *
 * All mutations happen synchronously on the event loop, so concurrent requests
 * cannot corrupt shared state.
 */

import { logger } from './logger.js';

export class KeyManager {
  constructor(keys, cooldownMs = 60000) {
    this.keys = keys.map((key, index) => ({
      key,
      index,
      disabled: false,
      failures: 0,
      lastFailure: 0,        // timestamp of last cooldown trigger
      totalRequests: 0,
      successfulRequests: 0
    }));
    this.cooldownMs = cooldownMs;
    this.robinIndex = 0;
  }

  /**
   * Get the next available key (round-robin), skipping cooled-down and disabled keys.
   * Returns null if no key is currently usable.
   */
  getKey() {
    const now = Date.now();
    const usable = this.keys.filter(k =>
      !k.disabled && (now - k.lastFailure) >= this.cooldownMs
    );

    let chosen;
    if (usable.length > 0) {
      chosen = usable[this.robinIndex % usable.length];
      this.robinIndex = (this.robinIndex + 1) % usable.length;
    } else {
      // All usable keys are in cooldown; pick the one available soonest
      // (ignore disabled keys entirely).
      const coolable = this.keys.filter(k => !k.disabled);
      if (coolable.length === 0) return null;
      chosen = coolable.reduce((a, b) => (a.lastFailure < b.lastFailure ? a : b));
    }

    chosen.totalRequests++;
    return chosen;
  }

  /**
   * Get a specific key by its entry (for retry of a known key). Not used currently.
   */
  getKeyByIndex(index) {
    return this.keys[index];
  }

  /**
   * Temporarily cool down a key (rate-limit style).
   */
  cooldown(keyEntry) {
    keyEntry.failures++;
    keyEntry.lastFailure = Date.now();
    logger.warn('Key cooled down', { keyIndex: keyEntry.index, failures: keyEntry.failures });
  }

  /**
   * Permanently disable a key (bad credentials 401/403).
   */
  disable(keyEntry) {
    keyEntry.disabled = true;
    keyEntry.failures++;
    logger.warn('Key disabled (auth failure)', { keyIndex: keyEntry.index });
  }

  /**
   * Mark a key as successful; gradually recover failure counters.
   */
  markSuccess(keyEntry) {
    keyEntry.successfulRequests++;
    if (keyEntry.failures > 0) keyEntry.failures = Math.max(0, keyEntry.failures - 1);
  }

  /**
   * True if every key is disabled or in cooldown.
   */
  allUnavailable() {
    const now = Date.now();
    return this.keys.every(k => k.disabled || (now - k.lastFailure) < this.cooldownMs);
  }

  /**
   * True if every key is permanently disabled.
   */
  allDisabled() {
    return this.keys.every(k => k.disabled);
  }

  /**
   * Number of keys that are not permanently disabled.
   */
  activeKeyCount() {
    return this.keys.filter(k => !k.disabled).length;
  }

  getStats() {
    return {
      totalKeys: this.keys.length,
      availableKeys: this.keys.filter(k => !k.disabled && (Date.now() - k.lastFailure) >= this.cooldownMs).length,
      disabledKeys: this.keys.filter(k => k.disabled).length,
      totalRequests: this.keys.reduce((s, k) => s + k.totalRequests, 0),
      successfulRequests: this.keys.reduce((s, k) => s + k.successfulRequests, 0)
    };
  }
}

export default KeyManager;
