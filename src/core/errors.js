/**
 * Error handling - OpenAI-compatible error types
 * Centralized classification of upstream failures for retry/rotation decisions.
 */

export const ErrorTypes = {
  UPSTREAM_ERROR: 'upstream_error',
  AUTH_ERROR: 'authentication_error',
  RATE_LIMIT_ERROR: 'rate_limit_error',
  INVALID_REQUEST: 'invalid_request_error',
  TIMEOUT_ERROR: 'timeout_error',
  INTERNAL_ERROR: 'internal_error',
  NOT_FOUND: 'not_found'
};

export const ErrorCodes = {
  UPSTREAM_FAILURE: 'upstream_failure',
  AUTH_FAILURE: 'auth_failure',
  RATE_LIMIT: 'rate_limit_exceeded',
  INSUFFICIENT_QUOTA: 'insufficient_quota',
  INVALID_REQUEST: 'invalid_request',
  TIMEOUT: 'timeout',
  INTERNAL: 'internal_error',
  NOT_FOUND: 'not_found',
  UNSUPPORTED_PARAMETER: 'unsupported_parameter',
  UNSUPPORTED_ENDPOINT: 'unsupported_endpoint'
};

/**
 * Create an OpenAI-compatible error envelope.
 * Returns { error: {message,type,code}, statusCode }.
 * Note: statusCode is internal metadata, never serialized into the client body.
 */
export function createError(message, type, code, statusCode = 500, internal = null) {
  return {
    error: { message, type, code },
    statusCode,
    // internal is never sent to the client; kept for logging/debugging only
    internal
  };
}

/** Standard, finalized error sent to clients (no extra fields). */
export const Errors = {
  upstreamFailed: (internal = null) =>
    createError('Upstream Provider has failed', ErrorTypes.UPSTREAM_ERROR, ErrorCodes.UPSTREAM_FAILURE, 502, internal),

  authFailed: (internal = null) =>
    createError('Authentication failed', ErrorTypes.AUTH_ERROR, ErrorCodes.AUTH_FAILURE, 401, internal),

  rateLimited: (internal = null) =>
    createError('Rate limit exceeded', ErrorTypes.RATE_LIMIT_ERROR, ErrorCodes.RATE_LIMIT, 429, internal),

  quotaExceeded: (internal = null) =>
    createError('Insufficient quota', ErrorTypes.RATE_LIMIT_ERROR, ErrorCodes.INSUFFICIENT_QUOTA, 429, internal),

  invalidRequest: (message = 'Invalid request', internal = null) =>
    createError(message, ErrorTypes.INVALID_REQUEST, ErrorCodes.INVALID_REQUEST, 400, internal),

  timeout: (internal = null) =>
    createError('Request timeout', ErrorTypes.TIMEOUT_ERROR, ErrorCodes.TIMEOUT, 504, internal),

  internal: (internal = null) =>
    createError('Internal server error', ErrorTypes.INTERNAL_ERROR, ErrorCodes.INTERNAL, 500, internal),

  notFound: (resource = 'Resource', internal = null) =>
    createError(`${resource} not found`, ErrorTypes.NOT_FOUND, ErrorCodes.NOT_FOUND, 404, internal),

  bodyTooLarge: (internal = null) =>
    createError('Request body too large', ErrorTypes.INVALID_REQUEST, ErrorCodes.INVALID_REQUEST, 413, internal),

  proxyAuthRequired: (internal = null) =>
    createError('Proxy authentication required', ErrorTypes.AUTH_ERROR, ErrorCodes.AUTH_FAILURE, 401, internal),

  methodNotAllowed: (internal = null) =>
    createError('Method not allowed', ErrorTypes.INVALID_REQUEST, ErrorCodes.INVALID_REQUEST, 405, internal),

  /** A request field cannot be served by any viable provider. */
  unsupportedParameter: (param, internal = null) =>
    createError(
      `Parameter '${param}' is not supported by any provider that can serve this request`,
      ErrorTypes.INVALID_REQUEST, ErrorCodes.UNSUPPORTED_PARAMETER, 400, internal
    ),

  /** The endpoint is not available for the requested model. */
  unsupportedEndpoint: (endpoint, model, internal = null) =>
    createError(
      `Model '${model}' is not available on the ${endpoint} endpoint for any configured provider`,
      ErrorTypes.INVALID_REQUEST, ErrorCodes.UNSUPPORTED_ENDPOINT, 400, internal
    )
};

/**
 * Classification result returned to the retry/failover loop.
 * retry:        should we attempt again (another key/provider)?
 * keyAction:    'disable' (permanent) | 'cooldown' (temporary) | 'none'
 * clientError:  if set, this is a terminal client-side error that should be
 *               forwarded to the client immediately WITHOUT retry.
 */
function classify(statusCode, message = '') {
  const msg = (message || '').toLowerCase();

  // Authentication / forbidden -> key is bad, disable it, retry with another key
  if (statusCode === 401 || statusCode === 403) {
    return { error: Errors.authFailed({ statusCode, message }), retry: true, keyAction: 'disable' };
  }

  // Rate limit / quota -> temporary, cooldown key, retry
  if (statusCode === 429) {
    const err = msg.includes('quota') || msg.includes('billing')
      ? Errors.quotaExceeded({ statusCode, message })
      : Errors.rateLimited({ statusCode, message });
    return { error: err, retry: true, keyAction: 'cooldown' };
  }

  // Request timeout from upstream -> retry, don't blame the key
  if (statusCode === 408) {
    return { error: Errors.timeout({ statusCode, message }), retry: true, keyAction: 'none' };
  }

  // Conflict -> retry cautiously, don't blame the key
  if (statusCode === 409) {
    return { error: Errors.invalidRequest('Upstream conflict', { statusCode, message }), retry: true, keyAction: 'none' };
  }

  // Model / resource not found upstream -> terminal, do not retry
  if (statusCode === 404) {
    return { error: Errors.notFound('Model', { statusCode, message }), retry: false, keyAction: 'none', clientError: true };
  }

  // Other 4xx (400, 413, 415, 422...) -> client-side, do not retry, forward
  if (statusCode >= 400 && statusCode < 500) {
    return { error: Errors.invalidRequest(message || 'Invalid request', { statusCode, message }), retry: false, keyAction: 'none', clientError: true };
  }

  // 5xx -> upstream fault, retry, don't disable the key (transient)
  if (statusCode >= 500) {
    return { error: Errors.upstreamFailed({ statusCode, message }), retry: true, keyAction: 'none' };
  }

  return { error: Errors.upstreamFailed({ statusCode, message }), retry: true, keyAction: 'none' };
}

/**
 * Classify an upstream HTTP status response.
 */
export function classifyUpstreamStatus(statusCode, message = '') {
  return classify(statusCode, message);
}

/**
 * Classify a network/fetch error (no HTTP status available).
 */
export function classifyNetworkError(err, kind = 'network') {
  // Connection refused / DNS / reset / unreachable -> upstream fault, retry
  return {
    error: Errors.upstreamFailed({ kind, code: err?.code, message: err?.message }),
    retry: true,
    keyAction: 'none'
  };
}

/**
 * Classify a timeout (local or upstream inactivity).
 */
export function classifyTimeout() {
  return {
    error: Errors.timeout({ kind: 'timeout' }),
    retry: true,
    keyAction: 'none'
  };
}
