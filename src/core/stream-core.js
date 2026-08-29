/**
 * Shared stream reader core.
 *
 * Transport-independent bridge between an upstream fetch ReadableStream and
 * an event emitter. Handles the concerns that must NOT be duplicated between
 * the Chat Completions passthrough and the Responses translator:
 *
 *   - reader lifecycle and cleanup on every exit path
 *   - stream inactivity deadline (cancels the upstream reader)
 *   - client-disconnect cancellation
 *   - backpressure via sink drain
 *   - single TextDecoder reuse across chunks (multi-byte safety)
 *   - write-after-end guards, no unhandled rejections
 *
 * The sink decides what the bytes mean (passthrough vs SSE parsing vs
 * translation); this module only moves bytes safely.
 */

import { logger } from './logger.js';

/**
 * @param {ReadableStream} upstream - response.body from fetch
 * @param {object} sink - { write(chunkBytes) -> Promise|void, end(), abort(reason) }
 * @param {object} opts
 * @param {string} opts.requestId
 * @param {string} [opts.provider]
 * @param {AbortSignal} [opts.clientSignal] - aborts when the client disconnects
 * @param {number} opts.inactivityTimeoutMs - max gap between upstream chunks
 * @param {number} [opts.overallTimeoutMs] - hard cap for the whole stream
 * @returns {Promise<{ok:boolean, reason?:string, bytes:number}>}
 */
export async function pumpStream(upstream, sink, opts) {
  const { requestId, clientSignal, inactivityTimeoutMs } = opts;
  const reader = upstream.getReader();
  const decoder = new TextDecoder(); // single decoder; shared state across chunks
  let inactivityTimer = null;
  let overallTimer = null;
  let aborted = false;
  let reason = null;
  let bytes = 0;
  let settled = false;

  const cancelUpstream = (why) => {
    if (aborted) return;
    aborted = true;
    reason = why;
    try { reader.cancel(why); } catch {}
  };

  const armInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      logger.warn('Stream inactivity timeout', { requestId });
      cancelUpstream('inactivity-timeout');
    }, inactivityTimeoutMs);
  };

  if (opts.overallTimeoutMs > 0) {
    overallTimer = setTimeout(() => {
      logger.warn('Stream overall timeout', { requestId });
      cancelUpstream('overall-timeout');
    }, opts.overallTimeoutMs);
    if (overallTimer.unref) overallTimer.unref();
  }

  const onClientAbort = () => cancelUpstream('client-disconnect');
  if (clientSignal) {
    if (clientSignal.aborted) cancelUpstream('client-disconnect');
    else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  }

  const cleanup = () => {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    if (overallTimer) { clearTimeout(overallTimer); overallTimer = null; }
    if (clientSignal) clientSignal.removeEventListener('abort', onClientAbort);
    try { reader.releaseLock(); } catch {}
  };

  try {
    armInactivity();
    while (true) {
      const { done, value } = await reader.read();
      if (done || aborted) break;
      armInactivity();
      if (!value || value.length === 0) continue;
      bytes += value.length;
      // Decode strictly for the sink (keeps multi-byte chaining correct);
      // raw bytes remain available via the sink for pure passthrough.
      const text = decoder.decode(value, { stream: true });
      await sink.write(value, text);
      if (aborted) break;
    }
    await sink.end(aborted ? reason : null);
    settled = true;
    return { ok: true, reason: aborted ? reason : undefined, bytes };
  } catch (err) {
    const isAbort = aborted || err?.name === 'AbortError';
    if (!isAbort) {
      logger.error('Stream read error', { requestId, error: err?.message });
    }
    try { await sink.abort(isAbort ? (reason || 'aborted') : 'error'); } catch {}
    settled = true;
    return { ok: !isAbort, reason: isAbort ? (reason || 'aborted') : 'error', bytes };
  } finally {
    cleanup();
    if (!settled) {
      try { await sink.end('cleanup'); } catch {}
    }
  }
}

export default pumpStream;