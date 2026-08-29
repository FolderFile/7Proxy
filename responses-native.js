/**
 * Native Responses passthrough - capability gating.
 *
 * For providers with capabilities.responses === 'native' the request body is
 * forwarded as-is. Fields a native provider cannot serve are NOT silently
 * discarded: an UnsupportedFieldError is thrown so the shared failover loop
 * can try another capable provider, or the request is rejected with an
 * explicit unsupported-parameter error.
 *
 * pass-through promise: unknown/unordered fields are forwarded untouched so
 * future Responses parameters remain forward-compatible; only fields with a
 * declared capability mismatch are gated here.
 */

import { UnsupportedFieldError } from './responses-request.js';
import { Errors } from './errors.js';

/**
 * Validate a Responses request against a native provider's capabilities.
 * @throws {UnsupportedFieldError} when a requested field is not supported.
 */
export function validateNativeResponsesBody(body, caps) {
  // Explicit capability flags.
  if (body.reasoning !== undefined && body.reasoning !== null && !caps.reasoning) {
    throw new UnsupportedFieldError('reasoning', 'provider does not declare reasoning capability');
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null
      && !caps.previousResponseId) {
    throw new UnsupportedFieldError('previous_response_id',
      'provider does not declare previous_response_id support');
  }
  if (body.tools !== undefined && !caps.tools) {
    throw new UnsupportedFieldError('tools', 'provider does not declare tools capability');
  }
  // All other fields (truncation, text.format, service_tier, store, include,
  // metadata, user, ...) are forwarded verbatim under the native passthrough
  // contract: a native upstream owns Responses semantics.
}

/**
 * Pre-commit validation of a native non-streaming Responses body.
 * Returns a failure classification when the object is malformed (enables
 * failover), or null when usable.
 */
export function validateNativeResponsesObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      error: Errors.upstreamFailed({ reason: 'malformed native responses object' }),
      retry: true, keyAction: 'none'
    };
  }
  if (typeof body.id !== 'string' || !body.id) {
    return {
      error: Errors.upstreamFailed({ reason: 'native responses object missing id' }),
      retry: true, keyAction: 'none'
    };
  }
  if (!Array.isArray(body.output)) {
    return {
      error: Errors.upstreamFailed({ reason: 'native responses object missing output array' }),
      retry: true, keyAction: 'none'
    };
  }
  return null;
}

/**
 * Pre-commit validation of a native streaming result. Streams are validated
 * during pumping; before commit we can only check headers exist.
 */
export function validateNativeResponsesStream(response) {
  return null; // streaming bodies are forwarded; errors handled post-commit
}

export default { validateNativeResponsesBody, validateNativeResponsesObject, validateNativeResponsesStream };