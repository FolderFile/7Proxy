/**
 * Responses API handler (protocol edge).
 *
 * Behavior is identical to the pre-Build-3 inline handler in core/router.js:
 *  - native      : body validated & forwarded as-is to /v1/responses
 *  - translated  : Responses -> Chat Completions translation at the edge
 * OpenAI-shaped errors; all transport concerns belong to the shared core.
 */

import { logger } from '../core/logger.js';
import { Errors } from '../core/errors.js';
import { sendError, sendJson, readBody, sseHead } from '../core/http-utils.js';
import { streamResponses } from '../formats/responses-stream.js';
import { translateResponsesRequest } from '../formats/responses-request.js';
import { validateNativeResponsesBody, validateNativeResponsesObject } from '../formats/responses-native.js';
import { translateChatResponseToResponses, ChatToResponsesStreamTranslator } from '../formats/responses-translate.js';

export function createResponsesHandler(ctx) {
  const { config, registry, runWithFailover } = ctx;

  /** POST /v1/responses */
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

  return { handleResponses };
}

export default createResponsesHandler;