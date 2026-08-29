/**
 * Shared unsupported-field signal used by every protocol edge.
 *
 * The failover loop (core/router.js) catches this class around prepareBody():
 * a field a provider cannot represent is NOT a failed upstream attempt — the
 * loop moves to the next capable provider, or rejects with an explicit
 * unsupported-parameter error naming the field. Protocol edges extend their
 * own enriched variant from this base.
 */

export class UnsupportedFieldError extends Error {
  constructor(param, reason) {
    super(reason
      ? `Parameter '${param}': ${reason}`
      : `Parameter '${param}' is not supported by this provider`);
    this.name = 'UnsupportedFieldError';
    this.param = param;
    this.reason = reason || null;
  }
}

export default UnsupportedFieldError;