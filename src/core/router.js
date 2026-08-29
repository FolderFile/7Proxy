/**
 * HTTP Router - routing, retry/failover orchestration.
 *
 * Architecture:
 *  - A transport-independent core is shared by every API surface:
 *      buildAttemptPlan (provider selection + key selection order),
 *      the attempt loop (key cooldown/disable, retry classification,
 *      attempt budgeting, provider failover, abortable backoff),
 *      makeUpstreamRequest (upstream.js: fetch + timeout + cancellation),
 *      readBody, sendError/sendJson, CORS/auth, logging, error mapping.
 *  - API-specific logic lives at the edges only: request parsing/validation
 *    and response serialization (chat completions vs responses).
 *  - A response is "committed" only once we start writing to `res`. After
 *    commit we NEVER retry and NEVER start another generation.
 *  - Total upstream attempts are capped by config.maxAttempts across all keys
 *    and providers; the same (provider,key) is never attempted twice.
 */

import { logger } from './logger.js';
import { Errors, classifyNetworkError } from './errors.js';
import { KeyManager } from './key-manager.js';
import { makeUpstreamRequest } from './upstream.js';
import { streamResponse } from './streaming.js';
import { streamResponses } from '../formats/responses-stream.js';
import { translateResponsesRequest, UnsupportedFieldError } from '../formats/responses-request.js';
import { validateNativeResponsesBody, validateNativeResponsesObject } from '../formats/responses-native.js';
import { translateChatResponseToResponses, ChatToResponsesStreamTranslator } from '../formats/responses-translate.js';

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

/** Send a JSON error body (OpenAI-compatible: only {error:{...}}). */
function sendError(res, statusCode, err, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...extraHeaders
  });
  res.end(JSON.stringify({ error: err.error }));
}

/** Send a JSON success body. */
function sendJson(res, statusCode, data, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

/** Read request body with streaming size limit (rejects while reading). */
function readBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    const onAbort = () => { if (!rejected) reject(new Error('aborted')); cleanup(); };
    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAbort);
    }
    function onData(chunk) {
      if (rejected) return;
      size += chunk.length;
      if (size > maxSize) {
        rejected = true;
        cleanup();
        // Drain remaining data without buffering, then reject.
        req.on('data', () => {});
        reject(Errors.bodyTooLarge());
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (rejected) return;
      cleanup();
      const body = Buffer.concat(chunks).toString('utf-8');
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(Errors.invalidRequest('Invalid JSON in request body')); }
    }
    function onError(err) {
      if (rejected) return;
      rejected = true; cleanup(); reject(err);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAbort);
  });
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

/** SSE response headers shared by all streaming APIs. */
function sseHead(res, rid) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Request-Id': rid
  });
}

export function createRouter(config, registry) {
  // One key manager per provider.
  const keyManagers = new Map();
  for (const provider of registry.getAll()) {
    keyManagers.set(provider.name, new KeyManager(provider.apiKeys, config.keyCooldownMs));
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
    const token = bearerToken(req);
    if (!token) return false;
    return timingSafeEqual(token, config.proxyApiKey);
  }

  function handleHealth(req, res, rid) {
    const stats = {};
    for (const [name, km] of keyManagers) stats[name] = km.getStats();
    sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString(), providers: stats },
      { 'X-Request-Id': rid });
  }

  function handleModelsList(req, res, rid) {
    sendJson(res, 200, { object: 'list', data: registry.getAllModels() }, { 'X-Request-Id': rid });
  }

  function handleModelLookup(req, res, rid, modelId) {
    const model = registry.getModel(modelId);
    if (!model) {
      sendError(res, 404, Errors.notFound(`Model '${modelId}'`), { 'X-Request-Id': rid });
      return;
    }
    sendJson(res, 200, model, { 'X-Request-Id': rid });
  }

  /**
   * Build the ordered attempt plan: list of {provider, keyEntry} pairs.
   * Capability-filtered (only providers that can serve `api`), model owner
   * first (round-robin start), then other capable providers. Each (provider,
   * key) appears at most once.
   */
  function buildAttemptPlan(model, api, body) {
    const providers = registry.getCapableFailoverProviders(model, api, body);
    const plan = [];
    for (const provider of providers) {
      const km = keyManagers.get(provider.name);
      if (!km) continue;
      // Start from the round-robin position so concurrent requests spread
      // across keys, then try the rest of this provider's keys in order.
      const start = km.robinIndex % km.keys.length;
      for (let i = 0; i < km.keys.length; i++) {
        const keyEntry = km.keys[(start + i) % km.keys.length];
        plan.push({ provider, km, keyEntry });
      }
      // Advance the round-robin so the next request starts on a different key.
      km.robinIndex = (km.robinIndex + 1) % km.keys.length;
    }
    return plan;
  }

  /**
   * Shared attempt/failover loop used by every API surface.
   *
   * @param {object} args
   * @param {string} args.api - 'chat' | 'responses'
   * @param {object} args.body - validated client request body (with .model)
   * @param {Function} args.prepareBody - (provider) => upstreamBody; may throw
   *        UnsupportedFieldError (field not representable by that provider)
   * @param {Function} [args.validateResult] - (result) => classification|null;
   *        pre-commit validation of a successful upstream result.
   * @param {Function} args.commit - async ({ result, provider, clientCtrl, res, rid, upstreamBody }) => void
   */
  async function runWithFailover({ req, res, rid, api, body, prepareBody, validateResult, commit }) {
    const startTime = Date.now();
    // Client disconnect controller: shared with the commit phase.
    const clientCtrl = new AbortController();
    const onClientClose = () => { try { clientCtrl.abort(); } catch {} };
    req.on('close', onClientClose);

    try {
      const plan = buildAttemptPlan(body.model, api, body);
      const attempted = new Set(); // "provider:keyIndex"
      let attempts = 0;
      let committed = false;
      let firstUnsupported = null;

      for (let i = 0; i < plan.length && attempts < config.maxAttempts; i++) {
        if (clientCtrl.signal.aborted) break;

        const { provider, km, keyEntry } = plan[i];
        const sig = `${provider.name}:${keyEntry.index}`;

        // Skip disabled keys and keys in cooldown.
        if (keyEntry.disabled) continue;
        const now = Date.now();
        if ((now - keyEntry.lastFailure) < config.keyCooldownMs) continue;
        if (attempted.has(sig)) continue;

        // API edge: build the upstream body for this provider. A field the
        // provider cannot represent is NOT a failed upstream attempt; we move
        // to the next capable provider (or reject at the end).
        let upstreamBody;
        try {
          upstreamBody = prepareBody(provider);
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
          // Translated Responses requests execute against the provider's chat
          // endpoint; native Responses requests go to /v1/responses.
          const endpoint = api === 'chat'
            ? provider.getChatEndpoint()
            : (provider.capabilities.responses === 'native'
              ? provider.getResponsesEndpoint()
              : provider.getChatEndpoint());
          result = await makeUpstreamRequest({
            provider,
            keyEntry,
            body: upstreamBody,
            endpoint,
            requestId: rid,
            clientSignal: clientCtrl.signal,
            timeoutMs: upstreamBody.stream === true ? config.streamTimeoutMs : config.requestTimeoutMs,
            expectStream: upstreamBody.stream === true
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
          // Terminal client-side error from upstream (e.g. 400/404): forward it.
          if (c.error) sendError(res, c.error.statusCode, c.error, { 'X-Request-Id': rid });
          committed = true;
          break;
        }

        // Backoff before next attempt (abortable, jittered).
        if (attempts < config.maxAttempts && i + 1 < plan.length) {
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
        if (firstUnsupported) {
          // No capable provider could represent the request: explicit 400,
          // never a partially degraded forward. Include the identifying detail.
          const err = Errors.unsupportedParameter(firstUnsupported.param);
          const detail = firstUnsupported.reason ?? '';
          if (detail) err.error.message = `Parameter '${firstUnsupported.param}': ${detail}`;
          sendError(res, 400, err, { 'X-Request-Id': rid });
        } else {
          sendError(res, 502, Errors.upstreamFailed(), { 'X-Request-Id': rid });
        }
      }
    } finally {
      req.removeListener('close', onClientClose);
    }
  }

  /** ---------------- Chat Completions (unchanged behavior) ---------------- */

  async function handleChatCompletions(req, res, rid) {
    // Content-Type validation for POST with a body.
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      sendError(res, 415, Errors.invalidRequest('Content-Type must be application/json'), { 'X-Request-Id': rid });
      return;
    }

    let body;
    try {
      body = await readBody(req, config.maxRequestBodySize);
    } catch (e) {
      if (e?.error) {
        sendError(res, e.statusCode, e, { 'X-Request-Id': rid });
      } else if (e?.message === 'aborted') {
        return; // client gone
      } else {
        sendError(res, 500, Errors.internal(), { 'X-Request-Id': rid });
      }
      return;
    }

    const model = body.model;
    if (!model || typeof model !== 'string') {
      sendError(res, 400, Errors.invalidRequest('you must provide a model parameter'), { 'X-Request-Id': rid });
      return;
    }

    if (!registry.getByModel(model)) {
      sendError(res, 404, Errors.notFound(`Model '${model}'`), { 'X-Request-Id': rid });
      return;
    }

    logger.info('Chat request', { requestId: rid, model, provider: registry.getByModel(model).name,
      stream: body.stream === true });

    await runWithFailover({
      req, res, rid,
      api: 'chat',
      body,
      // OpenAI-compatible pass-through: forward the client body unchanged.
      prepareBody: (provider) => body,
      validateResult: null,
      commit: async ({ result, provider, clientCtrl, res, rid }) => {
        if (result.kind === 'json') {
          sendJson(res, 200, result.body, { 'X-Request-Id': rid });
        } else if (result.kind === 'stream-json') {
          // Upstream ignored stream flag; wrap JSON as one SSE event + [DONE].
          sseHead(res, rid);
          const ok = res.write(`data: ${JSON.stringify(result.json)}\n\n`);
          if (!ok) await new Promise(r => res.once('drain', r));
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          sseHead(res, rid);
          await streamResponse(
            result.response.body,
            res,
            { requestId: rid, provider: provider.name },
            clientCtrl.signal,
            config.streamTimeoutMs,
            config.streamOverallTimeoutMs
          );
        }
      }
    });
  }

  /** ---------------- Responses API ---------------- */

  async function handleResponses(req, res, rid) {
    // Content-Type validation for POST with a body.
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      sendError(res, 415, Errors.invalidRequest('Content-Type must be application/json'), { 'X-Request-Id': rid });
      return;
    }

    let body;
    try {
      body = await readBody(req, config.maxRequestBodySize);
    } catch (e) {
      if (e?.error) {
        sendError(res, e.statusCode, e, { 'X-Request-Id': rid });
      } else if (e?.message === 'aborted') {
        return; // client gone
      } else {
        sendError(res, 500, Errors.internal(), { 'X-Request-Id': rid });
      }
      return;
    }

    const model = body.model;
    if (!model || typeof model !== 'string') {
      sendError(res, 400, Errors.invalidRequest('you must provide a model parameter'), { 'X-Request-Id': rid });
      return;
    }

    if (!registry.getByModel(model)) {
      sendError(res, 404, Errors.notFound(`Model '${model}'`), { 'X-Request-Id': rid });
      return;
    }

    const wantsStream = body.stream === true;

    // Capability pre-flight: if NO provider can serve Responses for this body
    // (including field-level constraints), reject before any upstream call.
    const capable = registry.getCapableFailoverProviders(model, 'responses', body);
    if (capable.length === 0) {
      sendError(res, 400, Errors.unsupportedEndpoint('Responses', model), { 'X-Request-Id': rid });
      return;
    }

    logger.info('Responses request', { requestId: rid, model,
      provider: registry.getByModel(model).name, stream: wantsStream });

    await runWithFailover({
      req, res, rid,
      api: 'responses',
      body,
      // API edge: per-provider request preparation.
      //  - native:      body validated & forwarded as-is (endpoint /v1/responses)
      //  - translated:  Responses -> Chat Completions translation
      prepareBody: (provider) => {
        const mode = provider.capabilities.responses;
        if (mode === 'native') {
          // Native: forward as-is. Capability gating for power fields.
          validateNativeResponsesBody(body, provider.capabilities);
          return body;
        }
        return translateResponsesRequest(body, provider.capabilities);
      },
      validateResult: (result, provider) => {
        if (provider.capabilities.responses === 'native') {
          return result.kind === 'json' ? validateNativeResponsesObject(result.body) : null;
        }
        // Translated: chat JSON must have a choices array (if not, fail over).
        if (result.kind === 'json') {
          const b = result.body;
          if (!b || typeof b !== 'object' || !Array.isArray(b.choices)) {
            return { error: Errors.upstreamFailed({ reason: 'malformed chat completions object' }),
              retry: true, keyAction: 'none' };
          }
        }
        return null;
      },
      commit: async ({ result, provider, clientCtrl, res, rid, upstreamBody }) => {
        const mode = provider.capabilities.responses;

        if (result.kind === 'json') {
          if (mode === 'native') {
            // Preserve the native Responses object.
            sendJson(res, 200, result.body, { 'X-Request-Id': rid });
          } else {
            // Translate chat completion -> Responses object.
            sendJson(res, 200, translateChatResponseToResponses(result.body, upstreamBody),
              { 'X-Request-Id': rid });
          }
          return;
        }

        // Streaming.
        sseHead(res, rid);

        if (result.kind === 'stream-json') {
          // Upstream ignored the stream flag.
          if (mode === 'native') {
            const ok = res.write(`data: ${JSON.stringify(result.json)}\n\n`);
            if (!ok) await new Promise(r => res.once('drain', r));
          } else {
            const translator = new ChatToResponsesStreamTranslator(upstreamBody);
            for (const e of translator.initialEvents()) res.write(e);
            for (const e of translator.onChatChunk(result.json)) res.write(e);
            for (const e of translator.finalEvents()) {
              const ok = res.write(e);
              if (!ok) await new Promise(r => res.once('drain', r));
            }
          }
          res.end();
          return;
        }

        // SSE stream.
        await streamResponses(
          result.response.body,
          res,
          { requestId: rid, provider: provider.name, mode: mode === 'native' ? 'native' : 'translated' },
          clientCtrl.signal,
          {
            inactivityTimeoutMs: config.streamTimeoutMs,
            overallTimeoutMs: config.streamOverallTimeoutMs,
            mode: mode === 'native' ? 'native' : 'translated',
            requestBody: upstreamBody
          }
        );
      }
    });
  }

  return async function handleRequest(req, res) {
    const rid = generateRequestId();
    corsHeaders(req, res);

    if (handleCorsPreflight(req, res)) return;

    if (!validateProxyAuth(req)) {
      sendError(res, 401, Errors.proxyAuthRequired(), { 'X-Request-Id': rid });
      return;
    }

    const path = req.url || '/';
    const method = req.method;

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
}

export default createRouter;
