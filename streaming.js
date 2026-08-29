/**
 * Chat Completions SSE passthrough.
 *
 * Design rules:
 *  - Forward upstream chunks as-is (byte-passthrough) to avoid corrupting SSE
 *    framing, multi-line events, comments or multi-byte UTF-8.
 *  - Never emit a second [DONE]; track whether the upstream already sent one.
 *  - If the upstream stream ends without [DONE], emit exactly one [DONE].
 *  - The shared reader core (stream-core.js) owns reader lifecycle, inactivity
 *    timeout, client-disconnect cancellation and backpressure.
 *  - Never write after the response has ended; all writes guarded.
 *  - No unhandled rejections: all errors are caught and surfaced via the result.
 */

import { logger } from './logger.js';
import { pumpStream } from './stream-core.js';

const SSE_DONE = 'data: [DONE]';

function drain(res) {
  if (res.writableNeedDrain) {
    return new Promise((resolve) => res.once('drain', resolve));
  }
  return Promise.resolve();
}

/** Wrap the http.ServerResponse into the sink interface expected by pumpStream. */
function makeSink(res, meta) {
  let doneReceived = false;
  return {
    async write(chunkBytes, text) {
      if (res.writableEnded) return;
      // Track whether the upstream already sent [DONE] (single scan).
      if (!doneReceived && text.includes('[DONE]')) doneReceived = true;
      const ok = res.write(chunkBytes);
      if (!ok) await drain(res);
    },
    async end() {
      if (!res.writableEnded) {
        try {
          // If upstream never sent [DONE], emit exactly one.
          if (!doneReceived) res.write(SSE_DONE + '\n\n');
          res.end();
        } catch { try { res.destroy(); } catch {} }
      }
      logger.info('Streaming completed', { requestId: meta.requestId });
    },
    async abort(why) {
      // Never start another generation; just close the stream cleanly.
      if (!res.writableEnded) {
        try {
          if (why !== 'client-disconnect') {
            const errJson = JSON.stringify({
              error: { message: 'Stream interrupted', type: 'upstream_error', code: 'upstream_failure' }
            });
            res.write(`data: ${errJson}\n\n`);
            res.write(SSE_DONE + '\n\n');
          }
          res.end();
        } catch {
          try { res.destroy(); } catch {}
        }
      }
    }
  };
}

/**
 * Stream an upstream ReadableStream (fetch body) to the client response.
 * Byte-passthrough; preserves SSE framing and UTF-8 exactly.
 *
 * @param {ReadableStream} upstream - response.body from fetch
 * @param {http.ServerResponse} res - client response (headers already written)
 * @param {object} meta - { requestId, provider }
 * @param {AbortSignal} clientSignal - aborts when the client disconnects
 * @param {number} inactivityTimeoutMs - max gap between chunks
 * @param {number} [overallTimeoutMs] - hard cap for the whole exchange (0 = off)
 * @returns {Promise<{ok:boolean, reason?:string, bytes?:number}>}
 */
export async function streamResponse(upstream, res, meta, clientSignal, inactivityTimeoutMs, overallTimeoutMs) {
  return pumpStream(upstream, makeSink(res, meta), {
    requestId: meta.requestId,
    clientSignal,
    inactivityTimeoutMs,
    overallTimeoutMs
  });
}

/**
 * Check if a content-type indicates SSE streaming.
 */
export function isStreamingResponse(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('text/event-stream') || ct.includes('stream');
}

export default { streamResponse, isStreamingResponse };