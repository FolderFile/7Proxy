/**
 * HTTP client helpers for tests (real HTTP, no mocking of the proxy itself).
 */

import http from 'http';

/** Find the next SSE event boundary (blank line), tolerating LF or CRLF.
 * Returns { start, end } offsets or -1 when no complete boundary exists. */
function findBoundary(buf) {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1 && b === -1) return -1;
  if (a === -1) return { start: b, end: b + 4 };
  if (b === -1) return { start: a, end: a + 2 };
  if (b < a) return { start: b, end: b + 4 };
  return { start: a, end: a + 2 };
}

export function request(baseUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = options.headers || {};
    if (options.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: body });
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 0, () => { req.destroy(new Error('client timeout')); });
    if (options.body !== undefined) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

/**
 * Raw streaming request that returns each parsed SSE event as received.
 * Returns { status, headers, events, raw }.
 * Each event: { data } for plain data-only frames, or { event, data } when the
 * upstream sends `event:` lines (Responses SSE). [DONE] becomes { done: true }.
 */
export function streamRequest(baseUrl, path, body, options = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    }, (res) => {
      let buffer = '';
      let raw = '';
      res.on('data', chunk => {
        raw += chunk.toString();
        buffer += chunk.toString();
        // Split on blank-line boundaries, tolerating \n\n and \r\n\r\n.
        let idx;
        while ((idx = findBoundary(buffer)) !== -1) {
          const rawEvent = buffer.slice(0, idx.start);
          buffer = buffer.slice(idx.end);
          let eventType = null;
          const datas = [];
          for (const line of rawEvent.split(/[\r\n]+/)) {
            const t = line.trim();
            if (t.startsWith('event:')) eventType = t.slice(6).trim();
            else if (t.startsWith('data:')) datas.push(t.slice(5).trim());
          }
          if (datas.length === 0) continue;
          const data = datas.join('\n');
          if (data === '[DONE]') { events.push({ done: true }); continue; }
          try { events.push({ event: eventType, data: JSON.parse(data) }); }
          catch { events.push({ event: eventType, data }); }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, events, raw }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 0, () => { req.destroy(new Error('client timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Send a request and abort the client socket after `abortMs`.
 * Returns a promise resolving when the response errors/ends.
 */
export function requestWithAbort(baseUrl, path, body, abortMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let received = 0;
      res.on('data', (c) => { received += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: received }));
      res.on('error', () => resolve({ status: 'errored', bytes: received }));
    });
    req.on('error', (e) => resolve({ status: 'aborted', error: e.message }));
    req.write(JSON.stringify(body));
    req.end();
    setTimeout(() => { try { req.destroy(); } catch {} }, abortMs);
  });
}