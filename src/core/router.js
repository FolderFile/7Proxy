/**
 * HTTP Router - routing, retry/failover orchestration.
 *
 * Architecture:
 *  - A transport-independent core is shared by every API surface:
 *      the attempt loop (key cooldown/disable, retry classification,
 *      attempt budgeting, provider/key failover, abortable backoff),
 *      makeUpstreamRequest (upstream.js: fetch + timeout + cancellation),
 *      readBody, sendError/sendJson, CORS/auth, logging, error mapping.
 *  - API-specific logic lives at the edges only (src/api/*): request
 *    parsing/validation and response serialization.
 *  - A response is "committed" only once we start writing to `res`. After
 *    commit we NEVER retry and NEVER start another generation.
 *  - Total upstream attempts are capped by config.maxAttempts across all keys
 *    and providers; the same (provider,key) is never attempted twice.
 *
 * Build 4 routing:
 *  - public names (direct models, aliases, routing groups) resolve through the
 *    immutable ModelRoutingRegistry into an ordered target plan BEFORE any
 *    upstream call; strategies (fallback | round-robin | random |
 *    weighted-random) order targets and never mutate configuration;
 *  - each plan entry carries the exact upstreamModel id; prepareBody rewrites
 *    the model field so clients never see internal upstream names;
 *  - the plan is finite (<= declared targets); this loop's global attempt
 *    budget remains authoritative (a large group cannot multiply attempts);
 *  - key rotation walks every key of a target before the next target;
 *  - client objects are never mutated: upstream bodies are fresh objects.
 */

import { logger } from './logger.js';
import { Errors, classifyNetworkError } from './errors.js';
import { KeyManager } from './key-manager.js';
import { makeUpstreamRequest } from './upstream.js';
import { sendError, sendJson, readBody, sseHead } from './http-utils.js';
import { createChatCompletionsHandler } from '../api/chat-completions.js';
import { createResponsesHandler } from '../api/responses.js';
import { createAnthropicHandlers } from '../api/anthropic-messages.js';
import { UnsupportedFieldError } from '../formats/unsupported-field.js';
import { anthropicErrorFromOpenAI } from '../formats/anthropic-errors.js';

const SAFE_METHODS = new Set(['GET', 'POST', 'OPTIONS']);

function generateRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Constant-time string compare to resist timing attacks. */
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Compare to avoid leaking length via early return timing; still return false.
    ab.length === 0 ? bb.compare(Buffer.alloc(0)) : ab.compare(ab);
    return false;
  }
  return ab.compare(bb) === 0 ? true : false;
}

/** Extract Bearer token from Authorization header. */
function bearerToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

/** Abortable, jittered exponential backoff. Resolves true after delay, false if aborted. */
function backoff(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => { cleanup(); resolve(true); }, delayMs);
    const onAbort = () => { cleanup(); clearTimeout(t); resolve(false); };
    function cleanup() { signal.removeEventListener('abort', onAbort); }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function jitteredDelay(attempt, base, max) {
  const exp = Math.min(max, base * Math.pow(2, attempt));
  // full jitter
  return Math.floor(Math.random() * exp);
}

export function createRouter(config, registry, routingRegistry = null) {
  // One key manager per provider.
  const keyManagers = new Map();
  const providers = routingRegistry
    ? [...routingRegistry.providers.values()]
    : registry.getAll();
  for (const provider of providers) {
    keyManagers.set(provider.name, new KeyManager([...provider.apiKeys], config.keyCooldownMs));
  }

  function corsHeaders(req, res) {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', config.corsMethods);
    res.setHeader('Access-Control-Allow-Headers', config.corsHeaders);
    res.setHeader('Access-Control-Max-Age', '86400');
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering for SSE
  }

  function handleCorsPreflight(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    return false;
  }

  function validateProxyAuth(req) {
    if (!config.proxyApiKey) return true;
    // Bearer token or Anthropic-style x-api-key (constant-time compared).
    const token = bearerToken(req) || req.headers['x-api-key'] || '';
    if (!token) return false;
    return timingSafeEqual(token, config.proxyApiKey);
  }

  function handleHealth(req, res, rid) {
    const stats = {};
    for (const [name, km] of keyManagers) stats[name] = km.getStats();
    sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString(), providers: stats },
      { 'X-Request-Id': rid });
  }

  /**
   * Build the ordered attempt lanes: list of {target, provider, km, keyEntry}.
   * A lane is one (target, key) pair; every pair appears at most once and the
   * lane list never exceeds plan.length * keys-per-provider. The loop below
   * enforces the global attempt budget regardless of lane count.
   */
  function buildAttemptLanes(plan) {
    const lanes = [];
    for (const target of plan) {
      const { provider, upstreamModel } = target;
      const km = keyManagers.get(provider.name);
      if (!km) continue;
      // Start from the round-robin position so concurrent requests spread
      // across keys, then try the rest of this provider's keys in order.
      const start = km.robinIndex % km.keys.length;
      for (let i = 0; i < km.keys.length; i++) {
        const keyEntry = km.keys[(start + i) % km.keys.length];
        lanes.push({ target, provider, upstreamModel, km, keyEntry });
      }
      // Advance the round-robin so the next request starts on a different key.
      km.robinIndex = (km.robinIndex + 1) % km.keys.length;
    }
    return lanes;
  }

  /**
   * Error-shape adapter: OpenAI endpoints keep OpenAI-shaped errors; Anthropic
   * endpoints receive Anthropic-shaped errors with identical sanitized status
   * semantics.
   */
  const errorMappers = {
    chat: (res, err, rid, statusCode) =>
      sendError(res, statusCode ?? err.statusCode ?? 502, err, { 'X-Request-Id': rid }),
    responses: (res, err, rid, statusCode) =>
      sendError(res, statusCode ?? err.statusCode ?? 502, err, { 'X-Request-Id': rid }),
    'anthropic-messages': (res, err, rid, statusCode) => {
      const ae = anthropicErrorFromOpenAI(err, rid);
      sendAnthropicShaped(res, statusCode ?? ae.statusCode, ae, rid);
    },
    'anthropic-token-count': (res, err, rid, statusCode) => {
      const ae = anthropicErrorFromOpenAI(err, rid);
      sendAnthropicShaped(res, statusCode ?? ae.statusCode, ae, rid);
    }
  };
  function sendAnthropicShaped(res, statusCode, anthropicErrEnvelope, rid) {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(statusCode, { 'Content-Type': 'application/json', 'X-Request-Id': rid });
    res.end(JSON.stringify(anthropicErrEnvelope.error));
  }
  function errorMapperFor(api) {
    return errorMappers[api] || ((res, err, rid, statusCode) =>
      sendError(res, statusCode ?? err.statusCode ?? 502, err, { 'X-Request-Id': rid }));
  }

  /**
   * Shared attempt/failover loop used by every API surface.
   *
   * @param {object} args
   * @param {string} args.api - 'chat' | 'responses' | 'anthropic-messages' | 'anthropic-token-count'
   * @param {object} args.body - validated client request body (with .model)
   * @param {Function} args.prepareBody - (provider) => upstreamBody; may throw
   *        UnsupportedFieldError (field not representable by that provider)
   * @param {Function} [args.validateResult] - (result) => classification|null;
   *        pre-commit validation of a successful upstream result.
   * @param {Function} args.commit - async ({ result, provider, clientCtrl, res, rid, upstreamBody }) => void
   */
  async function runWithFailover({ req, res, rid, api, body, prepareBody, validateResult, commit,
      headerPolicy, anthropicVersion }) {
    const startTime = Date.now();
    // Client disconnect controller: shared with the commit phase.
    const clientCtrl = new AbortController();
    const onClientClose = () => { try { clientCtrl.abort(); } catch {} };
    req.on('close', onClientClose);

    try {
      // Resolve the public model name to an ordered target plan BEFORE any
      // attempt is spent. Unknown names are the edges' responsibility (edges
      // 404 before calling here); an empty plan means no capable provider.
      let plan;
      if (routingRegistry) {
        const resolution = routingRegistry.resolve(body.model, api, body);
        plan = resolution ? resolution.plan : [];
      } else {
        // Legacy fallback (routing registry not wired): capability-filtered
        // provider list over the raw model name.
        plan = registry.getCapableFailoverProviders(body.model, api, body)
          .map(provider => ({ provider, providerId: provider.name, upstreamModel: body.model }));
      }
      const lanes = buildAttemptLanes(plan);
      const attempted = new Set(); // "provider:keyIndex"
      let attempts = 0;
      let committed = false;
      let firstUnsupported = null;
      let expectStream = false;

      for (let i = 0; i < lanes.length && attempts < config.maxAttempts; i++) {
        if (clientCtrl.signal.aborted) break;

        const { target, provider, upstreamModel, km, keyEntry } = lanes[i];
        const sig = `${provider.name}:${keyEntry.index}`;

        // Skip disabled keys and keys in cooldown.
        if (keyEntry.disabled) continue;
        const now = Date.now();
        if ((now - keyEntry.lastFailure) < config.keyCooldownMs) continue;
        if (attempted.has(sig)) continue;

        // API edge: build the upstream body for this provider. A field the
        // provider cannot represent is NOT a failed upstream attempt; we move
        // to the next capable provider (or reject at the end). The public
        // model name is rewritten to the target's exact upstream model id on
        // a fresh object - the client request object is never mutated.
        let upstreamBody;
        try {
          upstreamBody = prepareBody(provider, upstreamModel);
        } catch (err) {
          if (err instanceof UnsupportedFieldError) {
            if (!firstUnsupported) firstUnsupported = err;
            logger.warn('Request field unsupported by provider', { requestId: rid,
              error: `provider=${provider.name} param=${err.param}` });
            continue;
          }
          throw err;
        }

        attempted.add(sig);
        attempts++;

        let result;
        try {
          // Endpoint + headers come from the provider adapter: never per-name
          // conditions here, never inbound credentials upstream.
          const endpoint = provider.getEndpointFor
            ? provider.getEndpointFor(api)
            : legacyEndpointFor(provider, api);
          expectStream = upstreamBody.stream === true;

          const extraHeaders = headerPolicy
            ? headerPolicy(provider, keyEntry.key, anthropicVersion)
            : {};
          const upstreamHeaders = provider.buildHeaders(keyEntry.key, api, extraHeaders);

          result = await makeUpstreamRequest({
            provider,
            keyEntry,
            body: upstreamBody,
            endpoint,
            headers: upstreamHeaders,
            requestId: rid,
            clientSignal: clientCtrl.signal,
            timeoutMs: upstreamBody.stream === true ? config.streamTimeoutMs : config.requestTimeoutMs,
            expectStream
          });
        } catch (err) {
          // Should not happen (errors are caught inside), but be safe.
          result = { ok: false, classification: classifyNetworkError(err) };
        }

        // Client aborted during the upstream call.
        if (!result.ok && result.classification?.abort) {
          logger.info('Client aborted request', { requestId: rid, attempt: attempts });
          break;
        }

        // Pre-commit validation (e.g. malformed native/translated output).
        if (result.ok && validateResult) {
          const problem = validateResult(result, provider);
          if (problem) result = { ok: false, classification: problem };
        }

        if (result.ok) {
          // Success: commit to client. After this, never retry.
          committed = true;
          km.markSuccess(keyEntry);
          try {
            await commit({ result, provider, clientCtrl, res, rid, upstreamBody });
          } catch (commitErr) {
            // Commit failure (client gone, etc.) - just clean up.
            logger.warn('Commit failed', { requestId: rid, error: commitErr?.message });
          }
          logger.info('Upstream response committed', { requestId: rid, statusCode: 200,
            durationMs: Date.now() - startTime, provider: provider.name, attempt: attempts });
          break;
        }

        // Failure: classify and apply key action.
        const c = result.classification;
        if (c?.keyAction === 'disable') km.disable(keyEntry);
        else if (c?.keyAction === 'cooldown') km.cooldown(keyEntry);

        logger.warn('Upstream attempt failed', { requestId: rid, attempt: attempts,
          provider: provider.name, keyIndex: keyEntry.index, errorCode: c?.error?.code,
          keyAction: c?.keyAction, retry: c?.retry });

        if (c && c.retry === false) {
          // Terminal client-side error from upstream (e.g. 400/404): forward it
          // in the API's native error shape (OpenAI vs Anthropic).
          if (c.error) {
            errorMapperFor(api)(res, c.error, rid, c.error.statusCode);
          }
          committed = true;
          break;
        }

        // Backoff before next attempt (abortable, jittered).
        if (attempts < config.maxAttempts && i + 1 < lanes.length) {
          const delay = jitteredDelay(attempts - 1, config.retryBaseDelayMs, config.retryMaxDelayMs);
          if (delay > 0) {
            const waited = await backoff(delay, clientCtrl.signal);
            if (!waited) break; // aborted during backoff
          }
        }
      }

      if (!committed && !res.headersSent) {
        logger.error('All upstream attempts failed', { requestId: rid,
          attempts, durationMs: Date.now() - startTime });
        const errorMapper = errorMapperFor(api);
        if (firstUnsupported) {
          // No capable provider could represent the request: explicit 400,
          // never a partially degraded forward. Include the identifying detail.
          const err = Errors.unsupportedParameter(firstUnsupported.param);
          const detail = firstUnsupported.reason ?? '';
          if (detail) err.error.message = `Parameter '${firstUnsupported.param}': ${detail}`;
          errorMapper(res, err, rid);
        } else {
          errorMapper(res, Errors.upstreamFailed(), rid);
        }
      }
    } finally {
      req.removeListener('close', onClientClose);
    }
  }

  /** Legacy endpoint selection (providers without adapters; env-only mode). */
  function legacyEndpointFor(provider, api) {
    switch (api) {
      case 'responses':
        return provider.capabilities.responses === 'native'
          ? provider.getResponsesEndpoint() : provider.getChatEndpoint();
      case 'anthropic-messages':
        return provider.capabilities.anthropicMessages === 'native'
          ? provider.getMessagesEndpoint() : provider.getChatEndpoint();
      case 'anthropic-token-count':
        return provider.getCountTokensEndpoint();
      case 'chat':
      default:
        return provider.getChatEndpoint();
    }
  }

  // API handlers live in src/api/* (protocol edges). They receive a shared
  // context: config, registry, routing registry, runWithFailover, sseHead.
  const apiCtx = {
    config, registry, routingRegistry, runWithFailover,
    sseHead,
    now: () => Date.now(),
    /** API edges register Anthropic-shaped error mappers here. */
    registerErrorMapper(api, fn) { errorMappers[api] = fn; }
  };
  const { handleChatCompletions } = createChatCompletionsHandler(apiCtx);
  const { handleResponses } = createResponsesHandler(apiCtx);
  const anthropic = createAnthropicHandlers(apiCtx);

  return async function handleRequest(req, res) {
    const rid = generateRequestId();
    corsHeaders(req, res);

    if (handleCorsPreflight(req, res)) return;

    const path = req.url || '/';
    const method = req.method;

    if (!validateProxyAuth(req)) {
      // Anthropic endpoints return Anthropic-shaped auth errors.
      if (path.startsWith('/v1/messages')) {
        const ae = anthropicErrorFromOpenAI(Errors.proxyAuthRequired(), rid);
        res.writeHead(401, { 'Content-Type': 'application/json', 'X-Request-Id': rid });
        res.end(JSON.stringify(ae.error));
        return;
      }
      sendError(res, 401, Errors.proxyAuthRequired(), { 'X-Request-Id': rid });
      return;
    }

    try {
      if (path === '/health' && method === 'GET') {
        handleHealth(req, res, rid);
      } else if (path === '/v1/models' && method === 'GET') {
        handleModelsList(req, res, rid);
      } else if (path.startsWith('/v1/models/') && method === 'GET') {
        handleModelLookup(req, res, rid, decodeURIComponent(path.slice('/v1/models/'.length)));
      } else if (path === '/v1/chat/completions' && method === 'POST') {
        await handleChatCompletions(req, res, rid);
      } else if (path === '/v1/responses' && method === 'POST') {
        await handleResponses(req, res, rid);
      } else if (path === '/v1/messages' && method === 'POST') {
        await anthropic.handleMessagesCreate(req, res, rid);
      } else if (path === '/v1/messages/count_tokens' && method === 'POST') {
        await anthropic.handleCountTokens(req, res, rid);
      } else if (!SAFE_METHODS.has(method)) {
        sendError(res, 405, Errors.methodNotAllowed(), { 'X-Request-Id': rid, Allow: 'GET, POST, OPTIONS' });
      } else {
        sendError(res, 404, Errors.notFound('Endpoint'), { 'X-Request-Id': rid });
      }
    } catch (err) {
      logger.error('Unexpected handler error', { requestId: rid, error: err?.message, stack: err?.stack });
      if (!res.headersSent) sendError(res, 500, Errors.internal(), { 'X-Request-Id': rid });
    }
  };

  // ---- model introspection (uses the routing registry when available) ------
  function handleModelsList(req, res, rid) {
    if (routingRegistry) {
      sendJson(res, 200,
        { object: 'list', data: routingRegistry.listPublicModels() },
        { 'X-Request-Id': rid });
      return;
    }
    sendJson(res, 200, { object: 'list', data: registry.getAllModels() }, { 'X-Request-Id': rid });
  }

  function handleModelLookup(req, res, rid, modelId) {
    if (routingRegistry) {
      const model = routingRegistry.lookupPublicModel(modelId);
      if (!model) {
        sendError(res, 404, Errors.notFound(`Model '${modelId}'`), { 'X-Request-Id': rid });
        return;
      }
      sendJson(res, 200, model, { 'X-Request-Id': rid });
      return;
    }
    const model = registry.getModel(modelId);
    if (!model) {
      sendError(res, 404, Errors.notFound(`Model '${modelId}'`), { 'X-Request-Id': rid });
      return;
    }
    sendJson(res, 200, model, { 'X-Request-Id': rid });
  }
}

export default createRouter;