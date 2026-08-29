/**
 * Shared HTTP edge utilities used by every API handler.
 * Extracted from core/router.js (Build 3) so protocol handlers never import
 * the router (and never duplicate request reading / error sending).
 */

import { Errors } from './errors.js';

/** Send a JSON error body (OpenAI-compatible: only {error:{...}}). */
export function sendError(res, statusCode, err, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...extraHeaders
  });
  res.end(JSON.stringify({ error: err.error }));
}

/** Send a JSON success body. */
export function sendJson(res, statusCode, data, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

/** Read request body with streaming size limit (rejects while reading). */
export function readBody(req, maxSize) {
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

/** SSE response headers shared by all streaming APIs. */
export function sseHead(res, rid) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Request-Id': rid
  });
}

export default { sendError, sendJson, readBody, sseHead };