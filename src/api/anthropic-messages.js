/**
 * Anthropic-compatible Messages API handlers (Build 3).
 *
 * Endpoints:
 *   POST /v1/messages              - Messages (generation)
 *   POST /v1/messages/count_tokens - token counting (native providers only)
 *
 * Reuses the shared core exclusively: provider selection, model resolution,
 * key selection/rotation/cooldown/disable, attempt planning and budgeting,
 * retry classification, failover, backoff, deadlines, cancellation,
 * client-disconnect handling, backpressure, upstream fetch execution, logging
 * and shutdown are all owned by core/ (nothing duplicated here).
 *
 * Inbound authentication accepts `x-api-key` or `Authorization: Bearer`
 * (constant-time compared in core/router.js). The inbound proxy key is never
 * forwarded upstream; provider adapters construct upstream authentication
 * from the provider's own key entry.
 *
 * Errors on these endpoints are Anthropic-shaped (formats/anthropic-errors.js);
 * OpenAI endpoints keep their existing OpenAI-shaped errors.
 */

import { logger } from '../core/logger.js';
import { Errors } from '../core/errors.js';
import { readBody, sseHead } from '../core/http-utils.js';
import { streamAnthropicMessages, anthropicSseEvent, AnthropicStreamTranslator } from '../formats/anthropic-stream.js';
import {
  validateAnthropicMessages,
  translateAnthropicRequest,
  validateNativeAnthropicBody
} from '../formats/anthropic-request.js';
import {
  validateNativeMessagesObject,
  translateChatResponseToAnthropic
} from '../formats/anthropic-response.js';
import { AnthropicErrors } from '../formats/anthropic-errors.js';
import { UnsupportedFieldError } from '../formats/unsupported-field.js';

const ANTHROPIC_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_DEFAULT_VERSION = '2023-06-01';

/** Send an Anthropic-shaped JSON error (headers not yet sent). */
function sendAnthropicError(res, statusCode, AnthropicErrorEnvelope, requestId) {
  if (res.headersSent || res.writableEnded) return;
  const headers = { 'Content-Type': 'application/json', 'X-Request-Id': requestId };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(AnthropicErrorEnvelope.error ?? AnthropicErrorEnvelope));
}

/** Send a JSON success body. */
function sendAnthropicJson(res, data, requestId) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': requestId });
  res.end(JSON.stringify(data));
}

/**
 * Validate/normalize inbound Anthropic headers:
 *  - anthropic-version must be a date string; a safe default applies when
 *    absent and native providers receive the resolved version.
 *  - anthropic-beta is forwarded ONLY to native providers that declare the
 *    `betas` capability (decided at header build time in the provider).
 */
export function normalizeAnthropicHeaders(req) {
  const version = req.headers['anthropic-version'];
  if (version !== undefined) {
    if (typeof version !== 'string' || !ANTHROPIC_VERSION_RE.test(version.trim())) {
      return { ok: false, error: AnthropicErrors.invalidRequest(
        `anthropic-version must be a date string like ${SAFE_DEFAULT_VERSION}`) };
    }
  }
  return { ok: true, version: version ? version.trim() : SAFE_DEFAULT_VERSION };
}

/**
 * Provider-scoped upstream headers for native Anthropic calls. Authentication
 * is constructed exclusively from the provider's key; no inbound header is
 * copied except the (validated) anthropic-version and, when the provider
 * allows betas, a length-capped anthropic-beta.
 */
function nativeUpstreamExtra(provider, req) {
  const caps = provider.capabilities;
  const extra = {
    'anthropic-version': req.headers['anthropic-version']?.trim() || caps.anthropicVersion
  };
  const beta = req.headers['anthropic-beta'];
  if (caps.betas === true && typeof beta === 'string' && beta.trim()) {
    extra['anthropic-beta'] = beta.trim().slice(0, 512);
  }
  return extra;
}

/** Read a JSON body with Anthropic-shaped error mapping. */
async function readAnthropicBody(req, res, config, rid) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) {
    sendAnthropicError(res, 400, AnthropicErrors.invalidRequest('Content-Type must be application/json'), rid);
    return null;
  }
  try {
    return await readBody(req, config.maxRequestBodySize);
  } catch (e) {
    if (e?.error) {
      if (e.statusCode === 400) {
        sendAnthropicError(res, 400, AnthropicErrors.invalidRequest('Invalid JSON in request body'), rid);
      } else {
        sendAnthropicError(res, 413, AnthropicErrors.requestTooLarge(), rid);
      }
    } else if (e?.message !== 'aborted') {
      sendAnthropicError(res, 500, AnthropicErrors.internal(), rid);
    }
    return null;
  }
}

export function createAnthropicHandlers(ctx) {
  const { config, registry, runWithFailover } = ctx;

  /** POST /v1/messages */
  async function handleMessagesCreate(req, res, rid) {
    const hdr = normalizeAnthropicHeaders(req);
    if (!hdr.ok) {
      sendAnthropicError(res, 400, hdr.error, rid);
      return;
    }

    const body = await readAnthropicBody(req, res, config, rid);
    if (body === null) return;

    try {
      validateAnthropicMessages(body);
    } catch (e) {
      sendAnthropicError(res, 400, AnthropicErrors.invalidRequest(e.message, rid), rid);
      return;
    }

    if (!registry.getByModel(body.model)) {
      sendAnthropicError(res, 404,
        AnthropicErrors.unsupportedEndpoint('Messages', body.model, rid), rid);
      return;
    }

    const wantsStream = body.stream === true;
    logger.info('Anthropic Messages request', { requestId: rid, model: body.model,
      provider: registry.getByModel(body.model).name, stream: wantsStream });

    // Capability pre-flight: no provider can serve Messages for this model.
    const capable = registry.getCapableFailoverProviders(body.model, 'anthropic-messages', body);
    if (capable.length === 0) {
      sendAnthropicError(res, 404,
        AnthropicErrors.unsupportedEndpoint('Messages', body.model, rid), rid);
      return;
    }

    await runWithFailover({
      req, res, rid,
      api: 'anthropic-messages',
      body,
      anthropicVersion: hdr.version,
      // Provider-scoped extra headers (validated version + gated beta).
      headerPolicy: (provider) => nativeUpstreamExtra(provider, req),
      prepareBody: (provider) => {
        const mode = provider.capabilities.anthropicMessages;
        if (mode === 'native') {
          // Native: forward verbatim after field gating (throws
          // UnsupportedFieldError to trigger zero-cost provider skip).
          validateNativeAnthropicBody(body, provider.capabilities);
          return body;
        }
        // Translated: Anthropic Messages -> Chat Completions.
        return translateAnthropicRequest(body, provider.capabilities);
      },
      // Pre-commit validation, mode-aware (failover Before Commit).
      validateResult: (result, provider) => {
        if (provider.capabilities.anthropicMessages === 'native') {
          if (result.kind !== 'json') return null;
          return validateNativeMessagesObject(result.body);
        }
        if (result.kind === 'json') {
          const b = result.body;
          if (!b || typeof b !== 'object' || !Array.isArray(b.choices) || b.choices.length === 0) {
            return { error: Errors.upstreamFailed({ reason: 'malformed chat completions object' }),
              retry: true, keyAction: 'none' };
          }
        }
        return null;
      },
      commit: async ({ result, provider, clientCtrl, res, rid, upstreamBody }) => {
        const mode = provider.capabilities.anthropicMessages;

        if (result.kind === 'json') {
          if (mode === 'native') {
            // Relay the validated native Anthropic Message object unchanged.
            sendAnthropicJson(res, result.body, rid);
          } else {
            sendAnthropicJson(res, translateChatResponseToAnthropic(result.body, upstreamBody), rid);
          }
          return;
        }

        sseHead(res, rid);

        if (result.kind === 'stream-json') {
          // Upstream ignored the stream flag: synthesize a complete stream.
          if (mode === 'native') {
            // Relay as a message_start/message_stop envelope around the object.
            res.write(anthropicSseEvent('message_start', { type: 'message_start', message: result.json }));
            res.write(anthropicSseEvent('message_stop', { type: 'message_stop' }));
            res.end();
            return;
          }
          const translator = new AnthropicStreamTranslator(upstreamBody);
          for (const e of [
            ...translator.initialEvents(),
            ...translator.onChatChunk(result.json),
            ...translator.finalEvents()
          ]) {
            res.write(e);
          }
          res.end();
          return;
        }

        // SSE stream.
        await streamAnthropicMessages(
          result.response.body,
          res,
          {
            requestId: rid, provider: provider.name,
            mode: mode === 'native' ? 'native' : 'translated',
            anthropicRequest: upstreamBody
          },
          clientCtrl.signal,
          { inactivityTimeoutMs: config.streamTimeoutMs, overallTimeoutMs: config.streamOverallTimeoutMs }
        );
      }
    }).catch((err) => {
      // runWithFailover is internally guarded; this is a safety net that keeps
      // errors Anthropic-shaped on Anthropic endpoints.
      logger.error('Anthropic handler error', { requestId: rid, error: err?.message });
      if (!res.headersSent) {
        sendAnthropicError(res, 500, AnthropicErrors.internal(), rid);
      }
    });
  }

  /** POST /v1/messages/count_tokens */
  async function handleCountTokens(req, res, rid) {
    const hdr = normalizeAnthropicHeaders(req);
    if (!hdr.ok) {
      sendAnthropicError(res, 400, hdr.error, rid);
      return;
    }

    const body = await readAnthropicBody(req, res, config, rid);
    if (body === null) return;

    // Structural validation. count_tokens requests need not carry max_tokens,
    // so validate shape with a placeholder when it is absent — then forwards
    // happen without it.
    const needsMaxTokens = typeof body.max_tokens !== 'number';
    const validationBody = needsMaxTokens ? { ...body, max_tokens: 1 } : body;
    try {
      validateAnthropicMessages(validationBody);
      // Propagate nothing back into body: it is forwarded as-is below.
    } catch (e) {
      sendAnthropicError(res, 400, AnthropicErrors.invalidRequest(e.message, rid), rid);
      return;
    }

    if (!registry.getByModel(body.model)) {
      sendAnthropicError(res, 404,
        AnthropicErrors.unsupportedEndpoint('Token count', body.model, rid), rid);
      return;
    }

    // Only native token-count providers can serve counting; the proxy never
    // estimates and never invents counts. Pre-flight avoids consuming
    // generation-style attempts on providers that cannot serve the endpoint.
    const capable = registry.getCapableFailoverProviders(body.model, 'anthropic-token-count', body);
    if (capable.length === 0) {
      sendAnthropicError(res, 404, AnthropicErrors.invalidRequest(
        'token counting requires a provider with native token-count support; counts are never estimated', rid), rid);
      return;
    }

    await runWithFailover({
      req, res, rid,
      api: 'anthropic-token-count',
      body,
      anthropicVersion: hdr.version,
      headerPolicy: (provider) => nativeUpstreamExtra(provider, req),
      prepareBody: (provider) => {
        if (provider.capabilities.anthropicTokenCount !== 'native') {
          throw new UnsupportedFieldError('count_tokens', 'provider does not offer exact token counting');
        }
        // Preserve counting-relevant fields; the upstream count endpoint does
        // not take max_tokens/stream, so they are not forwarded.
        const { stream: _s, max_tokens: _m, ...countBody } = body;
        return countBody;
      },
      validateResult: (result) => {
        if (result.kind !== 'json') return null;
        const b = result.body;
        if (!b || typeof b !== 'object' || typeof b.input_tokens !== 'number') {
          return { error: Errors.upstreamFailed({ reason: 'malformed token count object' }),
            retry: true, keyAction: 'none' };
        }
        return null;
      },
      commit: async ({ result, res, rid }) => {
        sendAnthropicJson(res, result.body, rid);
      }
    }).catch((err) => {
      logger.error('Anthropic token-count handler error', { requestId: rid, error: err?.message });
      if (!res.headersSent) {
        sendAnthropicError(res, 500, AnthropicErrors.internal(), rid);
      }
    });
  }

  return { handleMessagesCreate, handleCountTokens };
}

export default createAnthropicHandlers;
