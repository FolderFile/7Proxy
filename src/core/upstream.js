/**
 * Transport-independent upstream execution core.
 *
 * makeUpstreamRequest executes one upstream fetch and returns a result WITHOUT
 * writing to any client response. The caller (per-API request loop) decides
 * whether to commit to the client or retry with another key/provider.
 *
 * Shared by Chat Completions and Responses:
 *   - timeout deadlines (per-attempt; streaming requests get the stream budget)
 *   - client-disconnect signal composition via AbortSignal.any
 *   - error-body capture without leaking raw upstream bodies
 *   - classification via errors.js (retry / keyAction / abort)
 *   - streaming vs JSON result kinds, including stream-json wrap detection
 */

import { isStreamingResponse } from './streaming.js';
import { classifyUpstreamStatus, classifyNetworkError, classifyTimeout } from './errors.js';

/**
 * @param {object} args
 * @param {object} args.provider - provider object
 * @param {object} args.keyEntry - key entry from KeyManager
 * @param {object} args.body - upstream request body (already in the upstream's API format)
 * @param {string} args.endpoint - full upstream URL
 * @param {string} args.requestId
 * @param {AbortSignal} args.clientSignal
 * @param {number} args.timeoutMs - per-attempt deadline
 * @param {boolean} args.expectStream - whether we asked the upstream to stream
 * @returns
 *   { ok: true, kind: 'json', body }        -> non-streaming success
 *   { ok: true, kind: 'stream', response }  -> SSE success (body not consumed)
 *   { ok: true, kind: 'stream-json', json } -> upstream ignored stream flag; JSON captured
 *   { ok: false, classification }           -> failure (caller decides retry)
 */
export async function makeUpstreamRequest({
  provider, keyEntry, body, endpoint, requestId, clientSignal, timeoutMs, expectStream
}) {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);

  let signal;
  try {
    signal = AbortSignal.any([clientSignal, timeoutCtrl.signal]);
  } catch {
    signal = clientSignal; // fallback for older runtimes
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: provider.buildHeaders(keyEntry.key),
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      // Read error body but never expose it raw to the client.
      let upstreamMessage = '';
      try {
        const text = await response.text();
        try { upstreamMessage = JSON.parse(text)?.error?.message || text; }
        catch { upstreamMessage = text; }
      } catch {}
      const classification = classifyUpstreamStatus(response.status, upstreamMessage);
      // Release the body if not consumed.
      try { response.body?.cancel?.(); } catch {}
      return { ok: false, classification };
    }

    if (expectStream) {
      const ct = response.headers.get('content-type') || '';
      if (isStreamingResponse(ct)) {
        return { ok: true, kind: 'stream', response };
      }
      // Upstream ignored the stream flag; read JSON and let the caller wrap it.
      let json;
      try { json = await response.json(); }
      catch { return { ok: false, classification: classifyUpstreamStatus(502, 'malformed upstream JSON') }; }
      return { ok: true, kind: 'stream-json', json };
    }

    // Non-streaming: read full body before committing so a malformed body
    // can trigger a retry instead of a partial client response.
    let parsed;
    try {
      const text = await response.text();
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, classification: classifyUpstreamStatus(502, 'malformed upstream JSON') };
    }
    return { ok: true, kind: 'json', body: parsed };

  } catch (err) {
    if (clientSignal.aborted) {
      return { ok: false, classification: { error: null, abort: true, retry: false } };
    }
    if (timeoutCtrl.signal.aborted && !clientSignal.aborted) {
      return { ok: false, classification: classifyTimeout() };
    }
    if (err?.name === 'AbortError' && timeoutCtrl.signal.aborted) {
      return { ok: false, classification: classifyTimeout() };
    }
    return { ok: false, classification: classifyNetworkError(err) };
  } finally {
    clearTimeout(timer);
  }
}

export default makeUpstreamRequest;