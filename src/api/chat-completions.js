/**
 * Chat Completions API handler (protocol edge).
 *
 * Behavior is identical to the pre-Build-3 inline handler in core/router.js:
 * OpenAI-compatible pass-through of the client body, OpenAI-shaped errors.
 * All transport concerns (attempts, keys, failover, deadlines, cancellation,
 * backpressure) belong to core/runWithFailover; nothing is duplicated here.
 */

import { logger } from '../core/logger.js';
import { Errors } from '../core/errors.js';
import { sendError, sendJson, readBody, sseHead } from '../core/http-utils.js';
import { streamResponse } from '../core/streaming.js';

export function createChatCompletionsHandler(ctx) {
  const { config, registry, runWithFailover } = ctx;

  /** POST /v1/chat/completions */
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

  return { handleChatCompletions };
}

export default createChatCompletionsHandler;