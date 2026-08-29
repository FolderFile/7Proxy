/**
 * Responses API streaming.
 *
 * Two modes, selected per attempt:
 *  - native      : forward upstream Responses SSE events with minimal buffering.
 *                  [DONE] is NOT a Responses concept; the upstream terminal event
 *                  is response.completed / response.failed / response.incomplete.
 *  - translated  : chat.completion.chunk SSE -> Responses SSE via the
 *                  ChatToResponsesStreamTranslator (incremental, no full buffering).
 *
 * Ordering, single terminal event, backpressure, inactivity/overall deadlines,
 * client-disconnect cancellation and cleanup are owned by stream-core.js.
 * Unknown native event types are passed through untouched (forward compatible).
 */

import { logger } from './logger.js';
import { pumpStream } from './stream-core.js';
import { ChatToResponsesStreamTranslator, sseEvent } from './responses-translate.js';

function drain(res) {
  if (res.writableNeedDrain) {
    return new Promise((resolve) => res.once('drain', resolve));
  }
  return Promise.resolve();
}

const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete']);

/**
 * Native passthrough sink.
 * Forwards the upstream bytes verbatim (event types and framing preserved).
 * Tracks whether a terminal event passed through so exactly-one-terminal and
 * failure-injection invariants hold without re-serializing anything.
 */
function makeNativeSink(res, meta) {
  let sawTerminal = false;
  let responseId = null;
  return {
    async write(chunkBytes, text) {
      if (res.writableEnded) return;
      if (!responseId) {
        // Light scan: first "object":"response" data payload carries the id.
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          try {
            const parsed = JSON.parse(t.slice(5).trim());
            if (parsed && parsed.object === 'response' && typeof parsed.id === 'string') {
              responseId = parsed.id;
              break;
            }
          } catch {}
        }
      }
      if (!sawTerminal) {
        // Cheap scan for terminal event names in the raw frame text.
        sawTerminal = /event:\s*response\.(completed|failed|incomplete)\b/.test(text);
      }
      const ok = res.write(chunkBytes);
      if (!ok) await drain(res);
    },
    async end(why) {
      if (!res.writableEnded) {
        try {
          // Upstream ended without a terminal event, or was aborted by a
          // timeout: inject exactly one response.failed (protocol permits
          // failure after commitment), except for client disconnects.
          if (why && why !== 'client-disconnect' && !sawTerminal) {
            const failed = {
              id: responseId ?? `resp_${meta.requestId}`,
              object: 'response',
              status: 'failed',
              error: { code: 'upstream_failure', message: 'Upstream stream interrupted' }
            };
            res.write(`event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`);
          }
          res.end();
        } catch { try { res.destroy(); } catch {} }
      }
      logger.info('Responses stream completed (native)', { requestId: meta.requestId });
    },
    async abort(why) {
      if (res.writableEnded) return;
      try {
        if (why && why !== 'client-disconnect' && !sawTerminal) {
          const failed = {
            id: responseId ?? `resp_${meta.requestId}`,
            object: 'response',
            status: 'failed',
            error: { code: 'upstream_failure', message: 'Upstream stream interrupted' }
          };
          res.write(`event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`);
        }
        res.end();
      } catch {
        try { res.destroy(); } catch {}
      }
    }
  };
}

/**
 * Translated stream sink: parse chat SSE chunks, translate incrementally.
 */
function makeTranslatedSink(res, translator, meta) {
  let buffer = '';
  return {
    async write(chunkBytes, text) {
      if (res.writableEnded) return;
      buffer += text;
      // Split on SSE event boundaries (blank line).
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const events = handleChatSseEvent(rawEvent, translator, meta);
        for (const e of events) {
          if (res.writableEnded) return;
          const ok = res.write(e);
          if (!ok) await drain(res);
        }
      }
    },
    async end(why) {
      if (why === 'client-disconnect') {
        if (!res.writableEnded) { try { res.end(); } catch {} }
        return;
      }
      if (!res.writableEnded) {
        // Flush any trailing buffered event, then close out the generation.
        try {
          const tail = handleChatSseEvent(buffer, translator, meta);
          buffer = '';
          for (const e of tail) { res.write(e); }
        } catch {}
        const final = translator.finalEvents();
        for (const e of final) {
          const ok = res.write(e);
          if (!ok) await drain(res);
        }
        res.end();
      }
      logger.info('Responses stream completed (translated)', { requestId: meta.requestId });
    },
    async abort(why) {
      if (res.writableEnded) return;
      try {
        if (why !== 'client-disconnect') {
          // response.failed is permitted after commitment.
          for (const e of translator.failureEvent('Upstream stream interrupted')) {
            res.write(e);
          }
        }
        res.end();
      } catch {
        try { res.destroy(); } catch {}
      }
    }
  };
}

/**
 * Parse one raw SSE event (may be data-only) from a chat stream and return the
 * translated Responses events.
 */
function handleChatSseEvent(rawEvent, translator, meta) {
  let dataPayload = null;
  let isDone = false;
  for (const line of rawEvent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') { isDone = true; continue; }
      try { dataPayload = JSON.parse(data); } catch { return []; }
    }
  }
  if (isDone) return []; // never forward [DONE] as a Responses event
  if (!dataPayload) return [];
  if (dataPayload?.error) {
    // Upstream reported an error mid-stream.
    return translator.failureEvent(
      typeof dataPayload.error.message === 'string' ? dataPayload.error.message : 'Upstream stream error'
    );
  }
  return translator.onChatChunk(dataPayload);
}

/**
 * Stream an upstream ReadableStream to the client as Responses SSE.
 *
 * @param {ReadableStream} upstream
 * @param {http.ServerResponse} res - headers already written
 * @param {object} meta - { requestId, provider, mode: 'native'|'translated' }
 * @param {AbortSignal} clientSignal
 * @param {object} opts - { inactivityTimeoutMs, overallTimeoutMs, requestBody } or null for native
 * @returns {Promise<{ok:boolean, reason?:string, bytes?:number}>}
 */
export async function streamResponses(upstream, res, meta, clientSignal, opts) {
  const { inactivityTimeoutMs, overallTimeoutMs, mode, requestBody } = opts;

  if (mode === 'native') {
    return pumpStream(upstream, makeNativeSink(res, meta), {
      requestId: meta.requestId,
      clientSignal,
      inactivityTimeoutMs,
      overallTimeoutMs
    });
  }

  // Translated mode: emit response.created + response.in_progress first.
  const translator = new ChatToResponsesStreamTranslator(requestBody);
  for (const e of translator.initialEvents()) {
    const ok = res.write(e);
    if (!ok) await drain(res);
  }
  return pumpStream(upstream, makeTranslatedSink(res, translator, meta), {
    requestId: meta.requestId,
    clientSignal,
    inactivityTimeoutMs,
    overallTimeoutMs
  });
}

export default { streamResponses: streamResponses };