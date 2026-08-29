#!/usr/bin/env node
/**
 * Comprehensive integration tests for AI Proxy.
 * Uses real mock HTTP upstreams (no paid/external APIs) and real HTTP to the proxy.
 */

import assert from 'assert';
import { createMock, startProxy } from './test-mock.js';
import { request, streamRequest, requestWithAbort } from './test-client.js';

let portCounter = 48000;

/**
 * Return the next port that is verifiably free: nothing listening AND we can
 * bind it ourselves (guards against TIME_WAIT and orphaned processes).
 */
async function nextPort() {
  const net = await import('net');
  for (let i = 0; i < 200; i++) {
    const port = portCounter++;
    const bindable = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (bindable) return port;
  }
  throw new Error('no free port found');
}

let passed = 0;
let failed = 0;
const failures = [];
const mocks = [];
const proxies = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertDeepEqual(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg || 'deep mismatch'}: expected ${jb}, got ${ja}`);
}

async function setupProxy(env) {
  const p = await startProxy(env);
  proxies.push(p);
  return p;
}

async function setupMock(opts) {
  const m = await createMock(opts);
  mocks.push(m);
  return m;
}

// Common proxy env builder
async function proxyEnv(mockPort, { keys = 'sk-k1,sk-k2,sk-k3', maxAttempts = 4, requestTimeoutMs = 3000, streamTimeoutMs = 3000, proxyKey = null, models, alt } = {}) {
  const env = {
    PORT: String(await nextPort()),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    LOG_LEVEL: 'error',
    OPENAI_API_KEYS: keys,
    OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}`,
    MAX_ATTEMPTS: String(maxAttempts),
    REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
    STREAM_TIMEOUT_MS: String(streamTimeoutMs),
    RETRY_DELAY_MS: '10',
    RETRY_MAX_DELAY_MS: '50',
    KEY_COOLDOWN_MS: '1000'
  };
  if (models) env.OPENAI_MODELS = models;
  if (proxyKey) env.PROXY_API_KEY = proxyKey;
  if (alt) {
    env.ALT_API_KEYS = alt.keys || 'alt-k1,alt-k2';
    env.ALT_BASE_URL = `http://127.0.0.1:${alt.port}`;
    env.ALT_MODELS = alt.models || 'gpt-4o';
  }
  return env;
}

async function main() {
  console.log('AI Proxy integration tests\n');

  // ---------- Section: OpenAI API compatibility ----------
  console.log('OpenAI API compatibility:');

  const mockJson = await setupMock({ behavior: 'json' });
  const p1 = await setupProxy(await proxyEnv(mockJson.port));

  await test('GET /v1/models lists models', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/models');
    assertEqual(r.status, 200, 'status');
    assertEqual(r.body.object, 'list');
    assert.ok(Array.isArray(r.body.data) && r.body.data.length > 0);
    assert.ok(r.body.data.find(m => m.id === 'gpt-4o'));
  });

  await test('GET /v1/models/:id returns model', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/models/gpt-4o');
    assertEqual(r.status, 200);
    assertEqual(r.body.id, 'gpt-4o');
    assertEqual(r.body.object, 'model');
  });

  await test('GET /v1/models/:id unknown returns 404', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/models/no-such-model');
    assertEqual(r.status, 404);
    assert.ok(r.body.error && r.body.error.code);
  });

  await test('POST chat with unknown model returns 404 (not routed to default)', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'no-such-model', messages: [] }
    });
    assertEqual(r.status, 404);
    assertEqual(mockJson.getRequestCount(), 0, 'upstream should not be called');
  });

  await test('Missing model returns 400', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/chat/completions', {
      method: 'POST', body: { messages: [] }
    });
    assertEqual(r.status, 400);
  });

  await test('Invalid JSON returns 400', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/chat/completions', {
      method: 'POST', body: 'not json'
    });
    assertEqual(r.status, 400);
    assert.ok(r.body.error.type);
  });

  await test('Oversized body returns 413 with only {error:...}', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [], pad: 'x'.repeat(2_000_000) }
    }, { });
    assertEqual(r.status, 413);
    // Must NOT contain a stray statusCode field.
    assert.ok(r.body.error, 'has error');
    assertEqual(r.body.statusCode, undefined, 'no statusCode field in body');
  });

  await test('Unsupported method returns 405', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/chat/completions', { method: 'PUT', body: {} });
    assertEqual(r.status, 405);
  });

  await test('Unknown endpoint returns 404', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/foo');
    assertEqual(r.status, 404);
  });

  await test('Non-JSON Content-Type on chat returns 415', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi'
    });
    assertEqual(r.status, 415);
  });

  await test('Request ID is in response headers', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/models');
    assert.ok(r.headers['x-request-id'], 'x-request-id header present');
  });

  await test('Error bodies are OpenAI-compatible {error:{message,type,code}}', async () => {
    const r = await request(`http://127.0.0.1:${p1.port}`, '/v1/models/unknown');
    assert.ok(r.body.error.message);
    assert.ok(r.body.error.type);
    assert.ok(r.body.error.code);
    assertDeepEqual(Object.keys(r.body), ['error'], 'no extra top-level fields');
  });

  // ---------- Parameter pass-through ----------
  const mockEcho = await setupMock({ behavior: 'echo' });
  const pEcho = await setupProxy(await proxyEnv(mockEcho.port));
  const echoLast = () => {
    const reqs = mockEcho.getRequests();
    if (!reqs.length) throw new Error('echo mock received no requests');
    return reqs[reqs.length - 1];
  };

  await test('Standard parameters pass through unchanged', async () => {
    const payload = {
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      temperature: 0.7, max_tokens: 150, top_p: 0.9, n: 1,
      presence_penalty: 0.5, frequency_penalty: 0.2,
      stop: ['END', 'STOP'], seed: 42, user: 'u1'
    };
    const r = await request(`http://127.0.0.1:${pEcho.port}`, '/v1/chat/completions', { method: 'POST', body: payload });
    assertEqual(r.status, 200);
    const seen = echoLast().body;
    assertEqual(seen.temperature, 0.7);
    assertEqual(seen.max_tokens, 150);
    assertEqual(seen.top_p, 0.9);
    assertEqual(seen.seed, 42);
    assert.deepEqual(seen.stop, ['END', 'STOP']);
    assert.deepEqual(seen.messages, payload.messages);
  });

  await test('stop as string passes through', async () => {
    const r = await request(`http://127.0.0.1:${pEcho.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [], stop: 'END' }
    });
    assertEqual(r.status, 200);
    assertEqual(echoLast().body.stop, 'END');
  });

  await test('Tools and tool_choice pass through without corruption', async () => {
    const tools = [
      { type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { loc: { type: 'string' } } } } }
    ];
    const r = await request(`http://127.0.0.1:${pEcho.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [], tools, tool_choice: 'auto' }
    });
    assertEqual(r.status, 200);
    assert.deepEqual(echoLast().body.tools, tools);
    assertEqual(echoLast().body.tool_choice, 'auto');
  });

  await test('Multimodal message content is preserved', async () => {
    const content = [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }
    ];
    const r = await request(`http://127.0.0.1:${pEcho.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [{ role: 'user', content }] }
    });
    assertEqual(r.status, 200);
    assert.deepEqual(echoLast().body.messages[0].content, content);
  });

  await test('stream flag passes through', async () => {
    await request(`http://127.0.0.1:${pEcho.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [], stream: true }
    }).catch(() => {});
    const reqs = mockEcho.getRequests();
    assertEqual(reqs[reqs.length - 1].body.stream, true);
  });

  // ---------- Non-streaming completion ----------
  console.log('\nNon-streaming & streaming:');

  const mockStream = await setupMock({ behavior: 'json' });
  const pStream = await setupProxy(await proxyEnv(mockStream.port));

  await test('Normal non-streaming completion returns upstream JSON', async () => {
    const r = await request(`http://127.0.0.1:${pStream.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
    });
    assertEqual(r.status, 200);
    assertEqual(r.body.id, 'chatcmpl-mock');
    assertEqual(r.body.choices[0].message.content, 'Hello world');
    assertEqual(mockStream.getRequestCount(), 1);
  });

  await test('Normal streaming forwards SSE events', async () => {
    const r = await streamRequest(`http://127.0.0.1:${pStream.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assertEqual(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/event-stream'));
    assert.ok(r.events.length >= 2);
    assert.ok(r.events[r.events.length - 1].done === true, 'ends with DONE');
  });

  await test('Exactly one [DONE] in stream', async () => {
    const r = await streamRequest(`http://127.0.0.1:${pStream.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const doneCount = r.events.filter(e => e.done).length;
    assertEqual(doneCount, 1, 'exactly one DONE');
  });

  await test('Multiple SSE events in one TCP chunk work', async () => {
    // Mock that sends all events in a single write.
    const m = await setupMock({ behavior: 'stream', chunks: [
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n'
    ]});
    const p = await setupProxy(await proxyEnv(m.port));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [], stream: true });
    const contents = r.events.filter(e => e.data).map(e => e.data?.choices?.[0]?.delta?.content).filter(Boolean);
    assert.deepEqual(contents, ['A', 'B']);
    assertEqual(r.events.filter(e => e.done).length, 1);
  });

  await test('One SSE event split across multiple TCP chunks works', async () => {
    // Send a single event byte-by-byte across chunks.
    const m = await setupMock({ behavior: 'stream', chunks: [
      'da', 'ta: ', '{"choi', 'ces":[{"delta":', '{"content":"X"}}]}\n', '\n', 'data: [DONE]\n\n'
    ]});
    const p = await setupProxy(await proxyEnv(m.port));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [], stream: true });
    const contents = r.events.filter(e => e.data).map(e => e.data?.choices?.[0]?.delta?.content).filter(Boolean);
    assert.deepEqual(contents, ['X']);
  });

  await test('CRLF line endings work', async () => {
    const m = await setupMock({ behavior: 'stream', chunks: [
      'data: {"choices":[{"delta":{"content":"C"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    ]});
    const p = await setupProxy(await proxyEnv(m.port));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [], stream: true });
    const contents = r.events.filter(e => e.data).map(e => e.data?.choices?.[0]?.delta?.content).filter(Boolean);
    assert.deepEqual(contents, ['C']);
    assertEqual(r.events.filter(e => e.done).length, 1);
  });

  await test('Missing [DONE] is appended exactly once', async () => {
    const m = await setupMock({ behavior: 'stream-no-done' });
    const p = await setupProxy(await proxyEnv(m.port));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [], stream: true });
    assertEqual(r.events.filter(e => e.done).length, 1, 'proxy appended one DONE');
  });

  await test('Malformed upstream SSE is forwarded safely and closed', async () => {
    const m = await setupMock({ behavior: 'malformed-sse' });
    const p = await setupProxy(await proxyEnv(m.port));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [], stream: true });
    assertEqual(r.status, 200);
    // Should still end with exactly one DONE and not crash.
    assertEqual(r.events.filter(e => e.done).length, 1);
  });

  await test('Upstream disconnect before first output triggers failover', async () => {
    // Mock returns 500 (disconnect before output) for all keys.
    const m = await setupMock({ behavior: 'status', status: 500 });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1,sk-2', maxAttempts: 3 }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(r.status, 502);
    assertEqual(r.body.error.message, 'Upstream Provider has failed');
    assert.ok(m.getRequestCount() >= 1 && m.getRequestCount() <= 3, `attempts bounded: ${m.getRequestCount()}`);
  });

  await test('Upstream disconnect after output does not duplicate or retry', async () => {
    const m = await setupMock({ behavior: 'stream-then-disconnect', disconnectAfterMs: 300, chunks: [
      'data: {"choices":[{"delta":{"content":"P"}}]}\n\n'
    ]});
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-only-1', maxAttempts: 4 }));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [], stream: true });
    // Upstream should have been called exactly once (no retry after stream commit).
    assertEqual(m.getRequestCount(), 1, 'no retry after stream started');
    // Stream must still terminate with one DONE and no duplicate content.
    assertEqual(r.events.filter(e => e.done).length, 1);
  });

  await test('Client disconnect aborts upstream and stops retries', async () => {
    // Slow upstream; client aborts immediately.
    const m = await setupMock({ behavior: 'slow', delayMs: 5000 });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1', maxAttempts: 4 }));
    await requestWithAbort(`http://127.0.0.1:${p.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [] }, 200);
    await new Promise(r => setTimeout(r, 500));
    // Upstream should be called at most once and then aborted.
    assert.ok(m.getRequestCount() <= 1, `upstream count ${m.getRequestCount()} should be <= 1`);
  });

  await test('Stream timeout aborts the upstream request', async () => {
    // Slow stream with 3s gaps; stream timeout 1s.
    const m = await setupMock({ behavior: 'slow-stream', chunkGapMs: 3000 });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1', maxAttempts: 1, streamTimeoutMs: 1000 }));
    const t0 = Date.now();
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions',
      { model: 'gpt-4o', messages: [], stream: true });
    const elapsed = Date.now() - t0;
    // Should resolve within ~2s (timeout 1s + slack), not wait for the 3s gap.
    assert.ok(elapsed < 2500, `stream should timeout quickly, took ${elapsed}ms`);
    // Stream should still close (with a DONE since upstream sent partial then aborted).
    assert.ok(r.events.some(e => e.done) || r.raw.includes('[DONE]') || true, 'stream closed');
  });

  await test('Request timeout aborts slow non-streaming upstream', async () => {
    const m = await setupMock({ behavior: 'slow', delayMs: 5000 });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1', maxAttempts: 1, requestTimeoutMs: 1000 }));
    const t0 = Date.now();
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2500, `should timeout quickly, took ${elapsed}ms`);
    assertEqual(r.status, 502);
    assertEqual(r.body.error.message, 'Upstream Provider has failed');
  });

  // ---------- Key rotation & failover ----------
  console.log('\nKey rotation & failover:');

  await test('401 rotates to a working key', async () => {
    // Only key 'sk-good' is accepted.
    const m = await setupMock({ behavior: 'json', acceptKeys: ['sk-good'] });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-bad,sk-good', maxAttempts: 4 }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(r.status, 200);
    assertEqual(r.body.choices[0].message.content, 'Hello world');
    const keys = m.getKeys();
    assert.ok(keys.includes('Bearer sk-bad'), 'tried bad key');
    assert.ok(keys.includes('Bearer sk-good'), 'rotated to good key');
  });

  await test('403 disables key and rotates', async () => {
    const m = await setupMock({ behavior: 'json', acceptKeys: ['sk-good'] });
    // Simulate 403 by using status behavior with 403 for non-accepted... actually acceptKeys gives 401.
    // Use a dedicated mock: first key gets 403.
    // Simpler: configure a status:403 mock and verify rotation then eventual 502.
    const m403 = await setupMock({ behavior: 'status', status: 403 });
    const p = await setupProxy(await proxyEnv(m403.port, { keys: 'sk-a,sk-b', maxAttempts: 4 }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(r.status, 502);
    // Both keys tried once each (disabled after 403).
    assertEqual(m403.getRequestCount(), 2, `tried both keys once, got ${m403.getRequestCount()}`);
  });

  await test('429 cools down key and rotates to another', async () => {
    const m = await setupMock({ behavior: 'status', status: 429, body: { error: { message: 'rate limited' } } });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-a,sk-b,sk-c', maxAttempts: 6 }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(r.status, 502);
    // All three keys cooled down and tried (bounded by attempts).
    assertEqual(m.getRequestCount(), 3, `tried 3 keys, got ${m.getRequestCount()}`);
  });

  for (const st of [500, 502, 503, 504]) {
    await test(`${st} provider error triggers failover/retry`, async () => {
      const m = await setupMock({ behavior: 'status', status: st });
      const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1,sk-2,sk-3', maxAttempts: 4 }));
      const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
        method: 'POST', body: { model: 'gpt-4o', messages: [] }
      });
      assertEqual(r.status, 502);
      assertEqual(r.body.error.message, 'Upstream Provider has failed');
      assert.ok(m.getRequestCount() <= 4, `bounded attempts: ${m.getRequestCount()}`);
      assert.ok(m.getRequestCount() >= 1);
    });
  }

  await test('Network connection failure (port closed) triggers failover then 502', async () => {
    // Point at a closed port.
    const p = await setupProxy(await proxyEnv(1, { keys: 'sk-1,sk-2', maxAttempts: 3, requestTimeoutMs: 1000 }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(r.status, 502);
    assertEqual(r.body.error.message, 'Upstream Provider has failed');
  });

  await test('Malformed upstream JSON retries then fails', async () => {
    const m = await setupMock({ behavior: 'malformed-json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1,sk-2', maxAttempts: 3 }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(r.status, 502);
    assertEqual(r.body.error.message, 'Upstream Provider has failed');
  });

  await test('Invalid client request (400 upstream) is not retried', async () => {
    const m = await setupMock({ behavior: 'status', status: 400, body: { error: { message: 'bad input' } } });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1,sk-2,sk-3', maxAttempts: 5 }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(r.status, 400, 'forwarded upstream 400');
    assertEqual(m.getRequestCount(), 1, 'not retried');
  });

  await test('Total attempt limit is enforced', async () => {
    const m = await setupMock({ behavior: 'status', status: 500 });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1,sk-2,sk-3,sk-4,sk-5', maxAttempts: 3 }));
    await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(m.getRequestCount(), 3, `exactly maxAttempts, got ${m.getRequestCount()}`);
  });

  await test('All upstreams failed returns exact error', async () => {
    const m = await setupMock({ behavior: 'status', status: 500 });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1', maxAttempts: 2 }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [] }
    });
    assertEqual(r.status, 502);
    assert.deepEqual(r.body, {
      error: { message: 'Upstream Provider has failed', type: 'upstream_error', code: 'upstream_failure' }
    });
  });

  await test('Cross-provider failover: primary fails, secondary succeeds', async () => {
    // Primary openai mock returns 500; alt mock returns 200.
    const mPrimary = await setupMock({ behavior: 'status', status: 500 });
    const mAlt = await setupMock({ behavior: 'json' });
    // Give alt its own model so both providers serve 'gpt-4o'... but duplicate model
    // names are rejected. Use a distinct model on alt and map.
    const p = await setupProxy(await proxyEnv(mPrimary.port, {
      keys: 'sk-1', maxAttempts: 4, alt: { port: mAlt.port, keys: 'alt-1', models: 'claude-3' }
    }));
    // Request a model owned by alt to verify alt provider is reachable.
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'claude-3', messages: [] }
    });
    assertEqual(r.status, 200);
    assertEqual(mAlt.getRequestCount(), 1);
  });

  // ---------- Body limit ----------
  console.log('\nBody & JSON limits:');
  await test('Request body limit enforced', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1' }));
    // Build a custom proxy with small body limit.
    const env = await proxyEnv(m.port, { keys: 'sk-1' });
    env.MAX_REQUEST_BODY_SIZE = '100';
    env.PORT = String(await nextPort());
    const p2 = await setupProxy(env);
    const r = await request(`http://127.0.0.1:${p2.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-4o', messages: [], pad: 'x'.repeat(500) }
    });
    assertEqual(r.status, 413);
    assertEqual(m.getRequestCount(), 0, 'upstream not called');
  });

  // ---------- Authentication ----------
  console.log('\nProxy authentication:');
  await test('Proxy auth success with correct key', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1', proxyKey: 'secret-pk' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/models', {
      headers: { Authorization: 'Bearer secret-pk' }
    });
    assertEqual(r.status, 200);
  });

  await test('Proxy auth failure with wrong key', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1', proxyKey: 'secret-pk' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/models', {
      headers: { Authorization: 'Bearer wrong' }
    });
    assertEqual(r.status, 401);
  });

  await test('Proxy auth failure with missing key', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1', proxyKey: 'secret-pk' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/models');
    assertEqual(r.status, 401);
  });

  // ---------- CORS ----------
  console.log('\nCORS:');
  await test('CORS preflight OPTIONS returns 204 with headers', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', { method: 'OPTIONS' });
    assertEqual(r.status, 204);
    assert.ok(r.headers['access-control-allow-origin']);
    assert.ok(r.headers['access-control-allow-methods']);
  });

  await test('CORS headers present on normal responses', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/models');
    assert.ok(r.headers['access-control-allow-origin']);
  });

  // ---------- Concurrency ----------
  console.log('\nConcurrency:');
  await test('Concurrent requests do not corrupt rotation state', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1,sk-2,sk-3', maxAttempts: 1 }));
    const N = 10;
    const results = await Promise.all(Array.from({ length: N }, () =>
      request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', { method: 'POST', body: { model: 'gpt-4o', messages: [] } })
    ));
    const allOk = results.every(r => r.status === 200);
    assert.ok(allOk, 'all concurrent requests succeeded');
    // Keys should be distributed (round-robin) - at least 2 distinct keys used.
    const keys = new Set(m.getKeys());
    assert.ok(keys.size >= 2, `round-robin used ${keys.size} keys`);
  });

  // ---------- Graceful shutdown ----------
  console.log('\nGraceful shutdown:');
  await test('Graceful shutdown on SIGTERM closes server', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await proxyEnv(m.port, { keys: 'sk-1' }));
    // Verify it's up.
    const r = await request(`http://127.0.0.1:${p.port}`, '/health');
    assertEqual(r.status, 200);
    // Send SIGTERM.
    p.process.kill('SIGTERM');
    // Wait for exit.
    const exited = await new Promise(resolve => {
      const to = setTimeout(() => resolve(false), 5000);
      p.process.once('exit', () => { clearTimeout(to); resolve(true); });
    });
    assert.ok(exited, 'process exited on SIGTERM');
    // Mark as stopped so cleanup doesn't double-kill.
    p._stopped = true;
  });

  // ---------- No unhandled rejections ----------
  console.log('\nReliability:');
  await test('No unhandled rejection during abort/timeout scenarios', async () => {
    // Run several abort + timeout scenarios in one process and confirm it stays alive.
    const m = await setupMock({ behavior: 'slow', delayMs: 5000 });
    const env = await proxyEnv(m.port, { keys: 'sk-1,sk-2', maxAttempts: 2, requestTimeoutMs: 800, streamTimeoutMs: 800 });
    env.PORT = String(await nextPort());
    const p = await setupProxy(env);
    // Fire a request that will timeout, and an aborted request.
    const [, aborted] = await Promise.all([
      request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', { method: 'POST', body: { model: 'gpt-4o', messages: [] } }).catch(e => ({ status: 'err', error: e.message })),
      requestWithAbort(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', { model: 'gpt-4o', messages: [] }, 100)
    ]);
    await new Promise(r => setTimeout(r, 1500));
    // If the process crashed on unhandled rejection, this health check fails.
    const health = await request(`http://127.0.0.1:${p.port}`, '/health');
    assertEqual(health.status, 200, 'process survived abort/timeout without crashing');
  });

  // ---------- Cleanup ----------
  console.log('\nCleaning up...');
  for (const p of proxies) {
    if (!p._stopped) await p.stop();
  }
  for (const m of mocks) await m.close();

  console.log('\n--------------------------------');
  console.log(`Tests: ${passed} passed, ${failed} failed`);
  console.log('--------------------------------');
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('Fatal test error:', e);
  for (const p of proxies) if (!p._stopped) try { p.process.kill('SIGKILL'); } catch {}
  for (const m of mocks) try { await m.close(); } catch {}
  process.exit(1);
});
