/**
 * Anthropic-compatible error format (Build 3).
 *
 * The Anthropic endpoints return Anthropic-shaped errors:
 *   { type: 'error', error: { type, message }, request_id? }
 * never the OpenAI shape used on OpenAI endpoints, and never raw upstream
 * bodies, keys, headers, stack traces or filesystem paths.
 *
 * Messages are sanitized and stable. Internal detail is preserved for logging.
 */

export const AnthropicErrorTypes = {
  INVALID_REQUEST: 'invalid_request_error',
  AUTHENTICATION: 'authentication_error',
  PERMISSION: 'permission_error',
  NOT_FOUND: 'not_found_error',
  REQUEST_TOO_LARGE: 'request_too_large',
  RATE_LIMIT: 'rate_limit_error',
  OVERLOADED: 'overloaded_error',
  API_ERROR: 'api_error',
  TIMEOUT: 'timeout_error'
};

/**
 * Create an Anthropic-shaped error envelope.
 * Returns { type:'error', error:{type,message}, statusCode, request_id? }.
 * statusCode is internal routing metadata; it is used for the HTTP status and
 * never embedded in the body.
 */
export function anthropicError(type, message, statusCode = 400, requestId = null) {
  const body = { type: 'error', error: { type, message } };
  if (requestId) body.request_id = requestId;
  return { error: body, statusCode, internal: { anthropicType: type } };
}

/** Standard Anthropic-compatible errors, mirroring Errors.* shapes. */
export const AnthropicErrors = {
  invalidRequest: (message = 'Invalid request', requestId = null) =>
    anthropicError(AnthropicErrorTypes.INVALID_REQUEST, message, 400, requestId),

  authentication: (requestId = null, message = 'authentication failed') =>
    anthropicError(AnthropicErrorTypes.AUTHENTICATION, message, 401, requestId),

  permission: (requestId = null, message = 'permission denied') =>
    anthropicError(AnthropicErrorTypes.PERMISSION, message, 403, requestId),

  notFound: (what = 'Resource', requestId = null, message = null) =>
    anthropicError(AnthropicErrorTypes.NOT_FOUND, message || `${what} not found`, 404, requestId),

  requestTooLarge: (requestId = null) =>
    anthropicError(AnthropicErrorTypes.REQUEST_TOO_LARGE, 'Request too large', 413, requestId),

  rateLimited: (requestId = null) =>
    anthropicError(AnthropicErrorTypes.RATE_LIMIT, 'Rate limit exceeded', 429, requestId),

  overloaded: (requestId = null) =>
    anthropicError(AnthropicErrorTypes.OVERLOADED, 'Overloaded', 529, requestId),

  unavailable: (requestId = null) =>
    anthropicError(AnthropicErrorTypes.API_ERROR, 'Upstream provider has failed', 502, requestId),

  timeout: (requestId = null) =>
    anthropicError(AnthropicErrorTypes.TIMEOUT, 'Request timeout', 504, requestId),

  internal: (requestId = null) =>
    anthropicError(AnthropicErrorTypes.API_ERROR, 'Internal server error', 500, requestId),

  methodNotAllowed: (requestId = null) =>
    anthropicError(AnthropicErrorTypes.INVALID_REQUEST, 'Method not allowed', 405, requestId),

  /** An endpoint is unavailable for the requested model on every provider. */
  unsupportedEndpoint: (endpoint, model, requestId = null) =>
    anthropicError(
      AnthropicErrorTypes.NOT_FOUND,
      `Model '${model}' is not available on the ${endpoint} endpoint for any configured provider`,
      404, requestId
    ),

  /** A request field cannot be served by any viable provider. */
  unsupportedParameter: (param, requestId = null) =>
    anthropicError(
      AnthropicErrorTypes.INVALID_REQUEST,
      `Parameter '${param}' is not supported by any provider that can serve this request`,
      400, requestId
    )
};

/**
 * Map an OpenAI-shaped classification/Errors envelope to an Anthropic-shaped
 * error envelope. Used when the shared core signals failure on an Anthropic
 * endpoint (upstream 4xx/5xx, timeouts, network) so client-facing errors stay
 * Anthropic-shaped and sanitized.
 */
export function anthropicErrorFromOpenAI(openAIError, requestId = null) {
  const code = openAIError?.error?.code;
  const type = openAIError?.error?.type;
  const statusCode = openAIError?.statusCode ?? 500;

  // Map status + OpenAI-ish code to the Anthropic error taxonomy.
  if (openAIError?.error?.code === 'unsupported_parameter' || code === 'unsupported_endpoint') {
    return anthropicError(AnthropicErrorTypes.INVALID_REQUEST, openAIError.error.message, 400, requestId);
  }
  if (code === 'not_found') {
    return anthropicError(AnthropicErrorTypes.NOT_FOUND, openAIError.error.message, 404, requestId);
  }
  if (code === 'auth_failure') {
    return anthropicError(AnthropicErrorTypes.AUTHENTICATION, 'Authorization failed', 401, requestId);
  }
  if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
    return anthropicError(AnthropicErrorTypes.RATE_LIMIT, 'Rate limit exceeded', 429, requestId);
  }
  if (code === 'invalid_request') {
    return anthropicError(AnthropicErrorTypes.INVALID_REQUEST, openAIError.error.message, 400, requestId);
  }
  if (code === 'timeout') {
    return anthropicError(AnthropicErrorTypes.TIMEOUT, 'Request timeout', 504, requestId);
  }
  if (code === 'body_too_large' || statusCode === 413) {
    return anthropicError(AnthropicErrorTypes.REQUEST_TOO_LARGE, 'Request too large', 413, requestId);
  }
  if (statusCode === 429) {
    return anthropicError(AnthropicErrorTypes.RATE_LIMIT, 'Rate limit exceeded', 429, requestId);
  }
  if (statusCode === 404) {
    return anthropicError(AnthropicErrorTypes.NOT_FOUND, 'Not found', 404, requestId);
  }
  // Everything else keeps only its sanitized status semantics.
  if (statusCode >= 500) {
    return anthropicError(AnthropicErrorTypes.API_ERROR, 'Upstream provider has failed', 502, requestId);
  }
  if (statusCode >= 400) {
    return anthropicError(AnthropicErrorTypes.INVALID_REQUEST, 'Invalid request', 400, requestId);
  }
  return anthropicError(AnthropicErrorTypes.API_ERROR, 'Internal server error', 500, requestId);
}

export default { anthropicError, AnthropicErrors, anthropicErrorFromOpenAI, AnthropicErrorTypes };