#!/usr/bin/env node
/**
 * Responses API integration tests (Build 2).
 * Local mock upstreams only. Preserves all Chat Completions behaviors and adds
 * Responses coverage: native + translated modes, streaming order, terminal
 * events, capability routing, failover semantics, errors, cancellation.
 */

import assert from 'assert';
import { createMock, startProxy } from './test-mock.js';
import { request, streamRequest, requestWithAbort } from './test-client.js';

let portCounter = 48300;

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

async function setupMock(opts) {
  const m = await createMock(opts);
  mocks.push(m);
  return m;
}

async function setupProxy(env) {
  const p = await startProxy(env);
  proxies.push(p);
  return p;
}

/**
 * Env builder for a proxy whose primary openai provider is native-or-translated
 * for Responses.
 *  - mode 'native':     OPENAI_CAPABILITIES="responses=native"
 *  - mode 'translated': OPENAI_CAPABILITIES="responses=translated"
 */
async function responsesProxyEnv(mockPort, {
  mode = 'native', keys = 'sk-k1,sk-k2,sk-k3', maxAttempts = 4,
  requestTimeoutMs = 3000, streamTimeoutMs = 3000, models, alt, extra = {}
} = {}) {
  const env = {
    PORT: String(await nextPort()),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    LOG_LEVEL: 'error',
    OPENAI_API_KEYS: keys,
    OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}`,
    OPENAI_CAPABILITIES: `responses=${mode},reasoning=true,previousResponseId=true`,
    MAX_ATTEMPTS: String(maxAttempts),
    REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
    STREAM_TIMEOUT_MS: String(streamTimeoutMs),
    STREAM_OVERALL_TIMEOUT_MS: String(streamTimeoutMs),
    RETRY_DELAY_MS: '10',
    RETRY_MAX_DELAY_MS: '50',
    KEY_COOLDOWN_MS: '1000',
    ...extra
  };
  if (models) env.OPENAI_MODELS = models;
  if (alt) {
    env.ALT_API_KEYS = alt.keys || 'alt-k1';
    env.ALT_BASE_URL = `http://127.0.0.1:${alt.port}`;
    env.ALT_MODELS = alt.models || 'gpt-4o';
    env.ALT_CAPABILITIES = alt.capabilities || 'responses=translated';
  }
  return env;
}

async function main() {
  console.log('AI Proxy - Responses API integration tests\n');

  /** ---------------- Native mode ---------------- */
  console.log('Native Responses:');

  await test('Native non-streaming Responses request', async () => {
    const m = await setupMock({ responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'say hi' }
    });
    assertEqual(r.status, 200, `status: ${JSON.stringify(r.body)}`);
    assert.equal(m.getRequestCount(), 1);
    assertEqual(m.getPaths()[0], '/v1/responses', 'hits upstream /v1/responses');
    assertEqual(r.body.object, 'response');
  });

  await test('Native streaming Responses request', async () => {
    const m = await setupMock({ responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      model: 'gpt-4o', input: 'hi', stream: true
    });
    assertEqual(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/event-stream'));
    const types = r.events.filter(e => e.event).map(e => e.event);
    assert.ok(types.includes('response.created'), `got ${types.join(',')}`);
    assert.ok(types.includes('response.completed'));
  });

  await test('String input passes through natively', async () => {
    const m = await setupMock({ responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'hello world' }
    });
    assertEqual(m.getRequests()[m.getRequestCount() - 1].body.input, 'hello world');
  });

  await test('Array input passes through natively', async () => {
    const m = await setupMock({ responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input }
    });
    assertDeepEqual(m.getRequests()[m.getRequestCount() - 1].body.input, input);
  });

  await test('Instructions pass through natively', async () => {
    const m = await setupMock({ responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x', instructions: 'be brief' }
    });
    assertEqual(m.getRequests()[m.getRequestCount() - 1].body.instructions, 'be brief');
  });

  await test('Native previous_response_id passthrough', async () => {
    const m = await setupMock({ responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x', previous_response_id: 'resp_123' }
    });
    assertEqual(r.status, 200);
    assertEqual(m.getRequests()[m.getRequestCount() - 1].body.previous_response_id, 'resp_123');
  });

  await test('Reasoning passthrough natively', async () => {
    const m = await setupMock({ responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x', reasoning: { effort: 'high' } }
    });
    assertEqual(r.status, 200);
    assertDeepEqual(m.getRequests()[m.getRequestCount() - 1].body.reasoning, { effort: 'high' });
  });

  await test('Usage passthrough natively', async () => {
    const m = await setupMock({
      responsesBehavior: 'echo',
      // Non-echo json object with usage
    });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    // echo returns what we send; craft a full object via a custom mock instead.
    const m2 = await setupMock({ responsesBehavior: 'echo' });
    const respObject = {
      id: 'resp_usage', object: 'response', status: 'completed',
      output: [], usage: { input_tokens: 7, output_tokens: 9, total_tokens: 16 }
    };
    const p2 = await setupProxy(await responsesProxyEnv(m2.port, { mode: 'native' }));
    // First call: ask echo to return this object by putting it in input? No -
    // simpler: use a status mock returning the object.
    const m3 = await setupMock({ behavior: 'json', body: respObject });
    const p3 = await setupProxy(await responsesProxyEnv(m3.port, { mode: 'native' }));
    const r3 = await request(`http://127.0.0.1:${p3.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertEqual(r3.status, 200);
    assertDeepEqual(r3.body.usage, respObject.usage);
  });

  /** ---------------- Translated mode ---------------- */
  console.log('\nTranslated Responses:');

  await test('Translated non-streaming response', async () => {
    const m = await setupMock({ behavior: 'json' }); // chat completions mock
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'say hi' }
    });
    assertEqual(r.status, 200, `status: ${JSON.stringify(r.body)}`);
    assertEqual(m.getPaths()[m.getPaths().length - 1], '/v1/chat/completions', 'hits chat endpoint');
    assertEqual(r.body.object, 'response');
    assert.ok(r.body.id.startsWith('resp_'), `id: ${r.body.id}`);
    assert.ok(Array.isArray(r.body.output));
    const text = r.body.output.find(o => o.type === 'message')?.content?.[0]?.text;
    assertEqual(text, 'Hello world');
    assertEqual(r.body.status, 'completed');
  });

  await test('Translated request maps fields (instructions, max_output_tokens)', async () => {
    const m = await setupMock({ behavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x', instructions: 'sys prompt',
        max_output_tokens: 123, temperature: 0.4 }
    });
    const seen = m.getRequests()[m.getRequestCount() - 1].body;
    assertDeepEqual(seen.messages[0], { role: 'system', content: 'sys prompt' });
    assertEqual(seen.messages[1].content, 'x');
    assertEqual(seen.max_tokens, 123, 'max_output_tokens -> max_tokens');
    assertEqual(seen.temperature, 0.4);
    assertEqual(seen.max_output_tokens, undefined, 'no Responses field leaks upstream');
  });

  await test('Translated string input -> user message', async () => {
    const m = await setupMock({ behavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'plain string' }
    });
    const seen = m.getRequests()[m.getRequestCount() - 1].body;
    assertDeepEqual(seen.messages, [{ role: 'user', content: 'plain string' }]);
  });

  await test('Translated array input with input_text/input_image', async () => {
    const m = await setupMock({ behavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: [{
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: 'https://example.com/x.png' }
        ]
      }] }
    });
    assertEqual(r.status, 200);
    const seen = m.getRequests()[m.getRequestCount() - 1].body;
    assertDeepEqual(seen.messages, [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }
      ]
    }]);
  });

  await test('Translated function_call + function_call_output items', async () => {
    const m = await setupMock({ behavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: [
        { type: 'message', role: 'user', content: 'weather?' },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"loc":"sf"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"temp":70}' }
      ] }
    });
    assertEqual(r.status, 200);
    const seen = m.getRequests()[m.getRequestCount() - 1].body;
    assertEqual(seen.messages.length, 3);
    assertDeepEqual(seen.messages[1], {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"loc":"sf"}' } }]
    });
    assertDeepEqual(seen.messages[2], { role: 'tool', tool_call_id: 'call_1', content: '{"temp":70}' });
  });

  await test('Translated tools and tool_choice', async () => {
    const m = await setupMock({ behavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x',
        tools: [{ type: 'function', name: 'f1', description: 'd', parameters: { type: 'object', properties: {} } }],
        tool_choice: { type: 'function', name: 'f1' } }
    });
    const seen = m.getRequests()[m.getRequestCount() - 1].body;
    assertDeepEqual(seen.tools, [{
      type: 'function',
      function: { name: 'f1', description: 'd', parameters: { type: 'object', properties: {} } }
    }]);
    assertDeepEqual(seen.tool_choice, { type: 'function', function: { name: 'f1' } });
  });

  await test('Function-call output item translated to Responses function_call output', async () => {
    const m = await setupMock({ behavior: 'json', body: {
      id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4o',
      choices: [{ index: 0, finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"loc":"sf"}' } }] } }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
    }});
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'weather?' }
    });
    assertEqual(r.status, 200);
    const fc = r.body.output.find(o => o.type === 'function_call');
    assert.ok(fc, 'has function_call output item');
    assertEqual(fc.call_id, 'call_9');
    assertEqual(fc.name, 'get_weather');
    assertEqual(fc.arguments, '{"loc":"sf"}');
    assertEqual(r.body.status, 'completed');
  });

  await test('Usage mapping in translated mode (no invented counts)', async () => {
    const m = await setupMock({ behavior: 'json' }); // default has usage 3/2/5
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertDeepEqual(r.body.usage, {
      input_tokens: 3, input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 5
    });
  });

  await test('Translated streaming response with correct event order', async () => {
    const m = await setupMock({ behavior: 'stream' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    assertEqual(r.status, 200);
    const types = r.events.map(e => e.event);
    // Order: created -> in_progress -> output_item.added -> content_part.added
    //        -> output_text.delta* -> output_text.done -> content_part.done
    //        -> output_item.done -> completed
    const expect = ['response.created', 'response.in_progress', 'response.output_item.added',
      'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.completed'];
    assertDeepEqual(types, expect, `got: ${types.join(',')}`);
  });

  await test('Incremental text deltas (no full buffering)', async () => {
    const m = await setupMock({ behavior: 'stream', chunks: [
      'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"b"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"c"}}]}\n\n',
      'data: [DONE]\n\n'
    ]});
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    const deltas = r.events.filter(e => e.event === 'response.output_text.delta').map(e => e.data.delta);
    assertDeepEqual(deltas, ['a', 'b', 'c'], 'three separate deltas');
  });

  await test('Incremental function-call arguments delta/done', async () => {
    const m = await setupMock({ behavior: 'stream', chunks: [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n'
    ]});
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    const types = r.events.map(e => e.event);
    assert.ok(types.includes('response.output_item.added'), 'function item added');
    assert.ok(types.includes('response.function_call_arguments.delta'), 'args delta present');
    assert.ok(types.includes('response.function_call_arguments.done'), 'args done present');
    const doneEv = r.events.find(e => e.event === 'response.function_call_arguments.done');
    assertEqual(doneEv.data.arguments, '{"a":1}', 'accumulated args');
    const addedEv = r.events.find(e => e.event === 'response.output_item.added');
    assertEqual(addedEv.data.name, 'f', 'function name on added event');
    assertDeepEqual(r.events.filter(e => e.event === 'response.completed').length, 1);
  });

  await test('Exactly one terminal event and no chat [DONE] leakage (translated)', async () => {
    const m = await setupMock({ behavior: 'stream' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    const terminals = r.events.filter(e =>
      e.event === 'response.completed' || e.event === 'response.failed');
    assertEqual(terminals.length, 1, 'exactly one terminal');
    assertEqual(terminals[0].event, 'response.completed');
    // No chat [DONE] anywhere in the raw stream.
    assert.ok(!r.raw.includes('[DONE]'), 'no chat DONE leaked');
  });

  await test('Native stream passes through unknown event types safely', async () => {
    const m = await setupMock({ responsesBehavior: 'events', nativeEvents: [
      ['response.created', { id: 'r1', object: 'response', status: 'in_progress', output: [] }],
      ['response.some_future_event', { fanciful: true }],
      ['response.completed', { id: 'r1', object: 'response', status: 'completed', output: [] }]
    ]});
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    assertEqual(r.status, 200);
    const types = r.events.map(e => e.event);
    assert.ok(types.includes('response.some_future_event'), 'future event preserved');
    assert.ok(types.includes('response.created') && types.includes('response.completed'));
  });

  /** ---------------- Capability-based selection & failover ---------------- */
  console.log('\nCapabilities, failover & rotation:');

  await test('Capability-based selection: unsupported provider -> failover to capable', async () => {
    // Primary provider does NOT support responses; alt provider does (native).
    const mNative = await setupMock({ responsesBehavior: 'echo' });
    const mPrimary = await setupMock({ behavior: 'json' });
    const env = await responsesProxyEnv(mPrimary.port, {
      mode: 'native', // applies to primary
      keys: 'sk-primary-only',
      alt: { port: mNative.port, keys: 'alt-native', models: 'gpt-4o',
        capabilities: 'responses=native,reasoning=true,previousResponseId=true' },
      extra: {}
    });
    // Make the primary explicitly unsupported for Responses:
    env.OPENAI_CAPABILITIES = 'responses=unsupported,reasoning=true';
    const p = await setupProxy(env);
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertEqual(r.status, 200);
    assertEqual(mNative.getRequestCount(), 1, 'native alt served the request');
    assertEqual(mPrimary.getRequestCount(), 0, 'primary never called');
    assert.ok(r.body.id.startsWith('resp_echo'), 'native alt response');
  });

  await test('Unsupported field routes to capable provider before failing', async () => {
    const mNative = await setupMock({ responsesBehavior: 'echo' });
    const mPrimary = await setupMock({ behavior: 'json' });
    const env = await responsesProxyEnv(mPrimary.port, {
      mode: 'translated',
      keys: 'sk-p',
      alt: { port: mNative.port, keys: 'alt-n', models: 'gpt-4o',
        capabilities: 'responses=native,reasoning=true,previousResponseId=true' }
    });
    const p = await setupProxy(env);
    // Translated provider rejects previous_response_id -> routes to native alt.
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x', previous_response_id: 'resp_1' }
    });
    assertEqual(r.status, 200, `status: ${JSON.stringify(r.body)}`);
    assertEqual(mNative.getRequestCount(), 1);
    assertEqual(mPrimary.getRequestCount(), 0);
  });

  await test('previous_response_id rejected when only translated providers exist', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x', previous_response_id: 'resp_1' }
    });
    assertEqual(r.status, 400);
    assertEqual(r.body.error.code, 'unsupported_parameter');
    assert.ok(r.body.error.message.includes('previous_response_id'), 'names the parameter');
    assertEqual(m.getRequestCount(), 0, 'nothing sent upstream');
  });

  await test('Unsupported tool type rejected, not discarded (translated)', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x',
        tools: [{ type: 'web_search' }] }
    });
    assertEqual(r.status, 400);
    assertEqual(r.body.error.code, 'unsupported_parameter');
    assert.ok(r.body.error.message.includes('web_search'), 'identifies the tool type');
    assertEqual(m.getRequestCount(), 0);
  });

  await test('Failover before first event: 5xx native -> next provider (event ordering intact)', async () => {
    const mBad = await setupMock({ responsesBehavior: 'status', status: 500 });
    const mGood = await setupMock({ responsesBehavior: 'echo' });
    const env = await responsesProxyEnv(mBad.port, {
      mode: 'native', keys: 'sk-bad',
      alt: { port: mGood.port, keys: 'alt-good', models: 'gpt-4o', capabilities: 'responses=native,reasoning=true,previousResponseId=true' }
    });
    const p = await setupProxy(env);
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    assertEqual(r.status, 200);
    assertEqual(mBad.getRequestCount(), 1);
    assertEqual(mGood.getRequestCount(), 1, 'failover happened');
    assert.ok(r.events.some(e => e.event === 'response.completed'), 'good stream served');
  });

  await test('No failover after first event (translated stream, then disconnect)', async () => {
    const m = await setupMock({ behavior: 'stream-then-disconnect', disconnectAfterMs: 300, chunks: [
      'data: {"choices":[{"index":0,"delta":{"content":"P"}}]}\n\n'
    ]});
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated', keys: 'sk-1', maxAttempts: 4 }));
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    assertEqual(m.getRequestCount(), 1, 'no retry after stream commit');
    // Terminates with exactly one terminal event (failed allowed post-commit).
    const terminals = r.events.filter(e =>
      e.event === 'response.completed' || e.event === 'response.failed');
    assertEqual(terminals.length, 1, `one terminal, got ${terminals.map(t => t.event).join(',')}`);
2
  });

  /** ---------------- Errors ---------------- */
  console.log('\nResponses errors:');

  await test('Missing model', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { input: 'x' }
    });
    assertEqual(r.status, 400);
    assert.ok(r.body.error.message.includes('model'));
  });

  await test('Unknown model', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'native' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'no-such-model', input: 'x' }
    });
    assertEqual(r.status, 404);
  });

  await test('Invalid input (bad input item type)', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: [{ type: 'wat' }] }
    });
    assertEqual(r.status, 400);
    assertEqual(r.body.error.code, 'unsupported_parameter');
    assert.ok(r.body.error.message.includes('wat'), 'names the bad type');
    assertEqual(m.getRequestCount(), 0);
  });

  await test('Provider without Responses capability on all providers -> unsupported_endpoint', async () => {
    const m = await setupMock({ behavior: 'json' });
    const env = await responsesProxyEnv(m.port, { mode: 'translated' });
    env.OPENAI_CAPABILITIES = 'responses=unsupported';
    const p = await setupProxy(env);
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertEqual(r.status, 400);
    assertEqual(r.body.error.code, 'unsupported_endpoint');
    assertEqual(m.getRequestCount(), 0, 'no upstream call');
  });

  await test('Malformed native Responses object triggers failover then 502', async () => {
    const mBad = await setupMock({ behavior: 'json', body: { not_a_response: true } });
    const p = await setupProxy(await responsesProxyEnv(mBad.port, {
      mode: 'native', keys: 'sk-1', maxAttempts: 1
    }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertEqual(r.status, 502);
    assertEqual(mBad.getRequestCount(), 1);
  });

  await test('Malformed translated output (no choices) -> failover/502', async () => {
    const mBad = await setupMock({ behavior: 'json', body: { junk: true } });
    const p = await setupProxy(await responsesProxyEnv(mBad.port, {
      mode: 'translated', keys: 'sk-1', maxAttempts: 2
    }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    // A chat body without a choices array is malformed for this API: the
    // attempt fails pre-commit and the client gets a 502 (no partial output).
    assertEqual(r.status, 502);
    assertEqual(mBad.getRequestCount(), 1, 'attempted once (budget exhausted)');
  });

  await test('401 key rotation on Responses', async () => {
    const m = await setupMock({ responsesBehavior: 'echo', acceptKeys: ['sk-good'] });
    const p = await setupProxy(await responsesProxyEnv(m.port, {
      mode: 'native', keys: 'sk-bad,sk-good', maxAttempts: 4
    }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertEqual(r.status, 200);
    const keys = m.getKeys();
    assert.ok(keys.includes('Bearer sk-bad') && keys.includes('Bearer sk-good'),
      `rotated: ${keys.join(',')}`);
  });

  await test('429 key rotation on Responses', async () => {
    const m = await setupMock({ responsesBehavior: 'status', status: 429 });
    const p = await setupProxy(await responsesProxyEnv(m.port, {
      mode: 'native', keys: 'sk-a,sk-b,sk-c', maxAttempts: 6
    }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertEqual(r.status, 502);
    assertEqual(m.getRequestCount(), 3, `all 3 keys cooled down: got ${m.getRequestCount()}`);
  });

  await test('5xx provider failover on Responses', async () => {
    const m = await setupMock({ responsesBehavior: 'status', status: 500 });
    const p = await setupProxy(await responsesProxyEnv(m.port, {
      mode: 'native', keys: 'sk-1,sk-2', maxAttempts: 4
    }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertEqual(r.status, 502);
    assertEqual(r.body.error.message, 'Upstream Provider has failed');
  });

  await test('Attempt-budget enforcement on Responses', async () => {
    const m = await setupMock({ responsesBehavior: 'status', status: 500 });
    const p = await setupProxy(await responsesProxyEnv(m.port, {
      mode: 'native', keys: 'sk-1,sk-2,sk-3,sk-4,sk-5', maxAttempts: 3
    }));
    await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assertEqual(m.getRequestCount(), 3, `exactly maxAttempts, got ${m.getRequestCount()}`);
  });

  await test('Overall timeout on Responses (non-streaming)', async () => {
    const m = await setupMock({ behavior: 'slow', delayMs: 5000, responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, {
      mode: 'native', keys: 'sk-1', maxAttempts: 1, requestTimeoutMs: 1000
    }));
    const t0 = Date.now();
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x' }
    });
    assert.ok(Date.now() - t0 < 2500, 'timeout enforced quickly');
    assertEqual(r.status, 502);
  });

  await test('Stream inactivity timeout on native Responses', async () => {
    // Native events stream with a 3s gap after the first event; timeout 1s.
    const m = await setupMock({ responsesBehavior: 'events', chunkGapMs: 3000, nativeEvents: [
      ['response.created', { id: 'r1', object: 'response', status: 'in_progress', output: [] }],
      ['response.output_text.delta', { item_id: 'm1', delta: 'x' }]
    ]});
    const p = await setupProxy(await responsesProxyEnv(m.port, {
      mode: 'native', keys: 'sk-1', maxAttempts: 1, streamTimeoutMs: 1000
    }));
    const t0 = Date.now();
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    assert.ok(Date.now() - t0 < 2500, `stream ended at timeout, took ${Date.now() - t0}ms`);
    // Post-commit failure surfaces as response.failed, exactly once.
    const failed = r.events.filter(e => e.event === 'response.failed');
    assertEqual(failed.length, 1, 'one response.failed');
  });

  await test('Client-disconnect cancellation on Responses', async () => {
    const m = await setupMock({ behavior: 'slow', delayMs: 5000, responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, {
      mode: 'native', keys: 'sk-1', maxAttempts: 4, requestTimeoutMs: 5000
    }));
    await requestWithAbort(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x' }, 200);
    await new Promise(r => setTimeout(r, 500));
    assert.ok(m.getRequestCount() <= 1, `upstream count ${m.getRequestCount()} <= 1`);
  });

  await test('Malformed upstream SSE on native stream does not crash', async () => {
    // A native mock that emits garbage 'data:' frames - must be forwarded or
    // dropped without crashing; the proxy must close the stream.
    const m = await setupMock({ behavior: 'malformed-sse' });
    const env = await responsesProxyEnv(m.port, { mode: 'native', keys: 'sk-1', maxAttempts: 1 });
    const p = await setupProxy(env);
    const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/responses',
      { model: 'gpt-4o', input: 'x', stream: true });
    // Native passthrough forwards bytes verbatim; must terminate cleanly.
    assert.ok(r.raw.length > 0, 'stream content present');
  });

  await test('Concurrent Responses requests with correct rotation', async () => {
    const m = await setupMock({ responsesBehavior: 'echo' });
    const p = await setupProxy(await responsesProxyEnv(m.port, {
      mode: 'native', keys: 'sk-1,sk-2,sk-3', maxAttempts: 1
    }));
    const N = 10;
    const results = await Promise.all(Array.from({ length: N }, () =>
      request(`http://127.0.0.1:${p.port}`, '/v1/responses', { method: 'POST', body: { model: 'gpt-4o', input: 'x' } })
    ));
    assert.ok(results.every(r => r.status === 200), 'all concurrent succeeded');
    const keys = new Set(m.getKeys());
    assert.ok(keys.size >= 2, `round-robin used ${keys.size} keys`);
  });

  await test('Invalid input: input must be string or array (translated)', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 42 }
    });
    assertEqual(r.status, 400);
    assertEqual(r.body.error.code, 'unsupported_parameter');
    assert.ok(r.body.error.message.includes('input'));
  });

  await test('Invalid tool definition rejected (translated)', async () => {
    const m = await setupMock({ behavior: 'json' });
    const p = await setupProxy(await responsesProxyEnv(m.port, { mode: 'translated' }));
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x',
        tools: [{ type: 'function' }] }
    });
    assertEqual(r.status, 400);
    assertEqual(r.body.error.code, 'unsupported_parameter');
    assert.equal(m.getRequestCount(), 0);
  });

  await test('include forwarded natively; rejected for translated', async () => {
    const mN = await setupMock({ responsesBehavior: 'echo' });
    const pN = await setupProxy(await responsesProxyEnv(mN.port, { mode: 'native' }));
    const rn = await request(`http://127.0.0.1:${pN.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x', include: ['reasoning.encrypted_content'] }
    });
    assertEqual(rn.status, 200);
    assertDeepEqual(mN.getRequests()[mN.getRequestCount() - 1].body.include, ['reasoning.encrypted_content']);

    const mT = await setupMock({ behavior: 'json' });
    const pT = await setupProxy(await responsesProxyEnv(mT.port, { mode: 'translated' }));
    const rt = await request(`http://127.0.0.1:${pT.port}`, '/v1/responses', {
      method: 'POST', body: { model: 'gpt-4o', input: 'x', include: ['reasoning.encrypted_content'] }
    });
    assertEqual(rt.status, 400);
    assertEqual(rt.body.error.code, 'unsupported_parameter');
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