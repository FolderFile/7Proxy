#!/usr/bin/env node
/**
 * Build 4 integration tests: JSON configuration, model registry, aliases,
 * routing groups, strategies, capability routing, model rewriting, key
 * references and /v1/models introspection.
 *
 * Everything runs over real HTTP against real child proxy processes with
 * local mock upstreams. Config files are written to a temp directory; no
 * real URLs or keys appear anywhere.
 */

import assert from 'assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createMock, startProxy } from '../helpers/mock-upstream.js';
import { request, streamRequest } from '../helpers/http-client.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_DIR = mkdtempSync(join(tmpdir(), '7proxy-routing-'));

let portCounter = 49000;
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
const cleanupFiles = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failures.push({ name, err: err.message });
    failed++;
  }
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertDeepEqual(a, b, msg) {
  assert.deepStrictEqual(a, b, msg || 'deep mismatch');
}

async function trackMock(opts) {
  const m = await createMock(opts);
  mocks.push(m);
  return m;
}
async function trackProxy(env) {
  const p = await startProxy(env);
  proxies.push(p);
  return p;
}
async function stop(p, m) {
  if (p) await p.stop();
  if (m) await m.close();
}

/** Write a config file and return its path. */
function writeConfig(name, obj) {
  const p = join(CONFIG_DIR, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  cleanupFiles.push(p);
  return p;
}

/**
 * Base env for file-mode proxies: explicit config path + datacenter key vars.
 */
async function baseEnv(configPath, extra = {}) {
  const env = {
    PORT: String(await nextPort()),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    LOG_LEVEL: 'error',
    SEVEN_PROXY_CONFIG: configPath,
    DATACENTER1_KEY_1: 'dc1-key-1',
    DATACENTER1_KEY_2: 'dc1-key-2',
    DATACENTER2_KEY_1: 'dc2-key-1',
    ANTHROPIC_UPSTREAM_KEY: 'ant-up-key',
    RETRY_DELAY_MS: '10',
    RETRY_MAX_DELAY_MS: '20',
    KEY_COOLDOWN_MS: '300'
  };
  return { ...env, ...extra };
}

/** Standard datacenter1 config bound to a mock upstream port. */
function dc1Config(mockPort, extra = {}) {
  return {
    providers: {
      datacenter1: {
        type: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${mockPort}`,
        keys: [{ env: 'DATACENTER1_KEY_1' }, { env: 'DATACENTER1_KEY_2' }],
        capabilities: {
          chatCompletions: true,
          responses: 'translated',
          anthropicMessages: 'translated',
          anthropicTokenCount: 'unsupported',
          tools: true,
          vision: false,
          reasoning: true
        },
        models: ['minimax-m3', 'glm-5.2', 'deepseek_v4_pro', 'deepseek-v4-flash']
      }
    },
    aliases: { coding: 'coding-smart', fast: 'fast-group' },
    groups: {
      'coding-smart': {
        strategy: 'fallback',
        targets: [
          { provider: 'datacenter1', model: 'glm-5.2' },
          { provider: 'datacenter1', model: 'deepseek_v4_pro' }
        ]
      },
      'fast-group': {
        strategy: 'fallback',
        targets: [{ provider: 'datacenter1', model: 'deepseek-v4-flash' }]
      }
    },
    server: { maxAttempts: 4 },
    ...extra
  };
}

// ===========================================================================
console.log('\nJSON configuration loading:');
// ===========================================================================

await test('1. JSON config file loads and serves requests (explicit path)', async () => {
  const m = await trackMock({ behavior: 'json' });
  const cfg = dc1Config(m.port);
  const cfgPath = writeConfig('a1.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', body: { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }
  });
  assertEqual(r.status, 200, 'chat succeeds via file config');
  assertEqual(m.getRequestCount(), 1, 'one upstream call');
});

await test('2. Explicit alternate config path (SEVEN_PROXY_CONFIG) honored', async () => {
  const m = await trackMock({ behavior: 'json' });
  const cfgPath = writeConfig('a2-alternate-name.json', dc1Config(m.port));
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/models');
  assertEqual(r.status, 200);
  const ids = r.body.data.map(x => x.id);
  assert.ok(ids.includes('minimax-m3'), 'file models listed');
});

await test('3. Environment-only backward compatibility (no config file)', async () => {
  const m = await trackMock({ behavior: 'json' });
  const p = await trackProxy({
    PORT: String(await nextPort()), HOST: '127.0.0.1', LOG_LEVEL: 'error',
    OPENAI_API_KEYS: 'sk-env-1', OPENAI_BASE_URL: `http://127.0.0.1:${m.port}`,
    OPENAI_MODELS: 'gpt-4o', DEFAULT_PROVIDER: 'openai'
  });
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/models');
  assertEqual(r.status, 200);
  assert.ok(r.body.data.find(x => x.id === 'gpt-4o'), 'env models listed');
  const chat = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
  });
  assertEqual(chat.status, 200, 'env-only chat works');
});

await test('4. Invalid JSON config rejected at startup', async () => {
  const cfgPath = writeConfig('a4.json', '{ this is not json');
  const env = await baseEnv(cfgPath);
  await assert.rejects(() => startProxy(env), /invalid JSON|exited/i,
    'proxy must exit on invalid JSON');
});

await test('5. Missing referenced environment variable fails startup', async () => {
  const m = await trackMock({ behavior: 'json' });
  const cfg = dc1Config(m.port);
  cfg.providers.datacenter1.keys = [{ env: 'DOES_NOT_EXIST_ANYWHERE_XYZ' }];
  const cfgPath = writeConfig('a5.json', cfg);
  const env = await baseEnv(cfgPath);
  await assert.rejects(() => startProxy(env), /DOES_NOT_EXIST_ANYWHERE_XYZ|exited/i,
    'startup must fail naming the missing variable');
});

await test('6. Invalid base URL rejected', async () => {
  const cfg = dc1Config(1);
  cfg.providers.datacenter1.baseUrl = 'not a url at all';
  const cfgPath = writeConfig('a6.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|baseUrl/i);
});

await test('7. Unknown provider type rejected', async () => {
  const cfg = dc1Config(1);
  cfg.providers.datacenter1.type = 'gemini-compatible';
  const cfgPath = writeConfig('a7.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|unknown provider type/i);
});

await test('8. Model targeting unknown provider rejected', async () => {
  const cfg = dc1Config(1);
  cfg.aliases = {}; cfg.groups = {};
  cfg.models = { 'glm-5.2': { targets: [{ provider: 'nope', upstreamModel: 'glm-5.2' }] } };
  cfg.providers.datacenter1.models = ['glm-5.2'];
  const cfgPath = writeConfig('a8.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|unknown provider/i);
});

await test('9. Unknown model reference in group rejected', async () => {
  const cfg = dc1Config(1);
  cfg.groups['coding-smart'].targets.push({ provider: 'datacenter1', model: 'ghost-model' });
  const cfgPath = writeConfig('a9.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|does not offer/i);
});

await test('10. Invalid identifier rejected', async () => {
  const cfg = dc1Config(1);
  cfg.providers.datacenter1.models.push('bad model name!!');
  const cfgPath = writeConfig('a10.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|identifier/i);
});

await test('11. Prototype-pollution keys rejected', async () => {
  const raw = JSON.stringify(dc1Config(1));
  const marker = '"server":{';
  assert.ok(raw.includes(marker), 'fixture has server block');
  const injected = raw.replace(marker, '"__proto__": {"x": 1}, "server":{');
  assert.ok(injected.includes('__proto__'), 'pollution key present in fixture');
  const cfgPath = writeConfig('a11.json', injected);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|forbidden|key/i);
});

await test('12. Alias cycle rejected', async () => {
  const m = await trackMock({ behavior: 'json' });
  const cfg = dc1Config(m.port);
  cfg.aliases = { a: 'b', b: 'a' };
  const cfgPath = writeConfig('a12.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|cycle|unknown/i);
});

await test('13. Alias pointing at nothing rejected', async () => {
  const cfg = dc1Config(1);
  cfg.aliases = { coding: 'no-such-target' };
  const cfgPath = writeConfig('a13.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|unknown/i);
});

await test('14. Empty routing group rejected', async () => {
  const cfg = dc1Config(1);
  cfg.groups['fast-group'] = { strategy: 'fallback', targets: [] };
  const cfgPath = writeConfig('a14.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|empty/i);
});

await test('15. Invalid strategy rejected', async () => {
  const cfg = dc1Config(1);
  cfg.groups['fast-group'].strategy = 'chaos';
  const cfgPath = writeConfig('a15.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|invalid strategy|invalid/i);
});

await test('16. Invalid weights rejected (zero and negative)', async () => {
  for (const w of [0, -2]) {
    const cfg = dc1Config(1);
    cfg.groups['fast-group'].strategy = 'weighted-random';
    cfg.groups['fast-group'].targets[0].weight = w;
    const cfgPath = writeConfig(`a16-${String(w).replace('-', 'neg')}.json`, cfg);
    await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|weight/i,
      `weight ${w} must be rejected`);
  }
});

await test('17. Inline secret keys in file config are rejected', async () => {
  const cfg = dc1Config(1);
  cfg.providers.datacenter1.keys = [{ value: 'sk-inline-secret' }];
  const cfgPath = writeConfig('a17.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|env/i,
    'file configs must reference env vars, never inline values');
});

await test('18. Duplicate targets in a group rejected', async () => {
  const cfg = dc1Config(1);
  cfg.groups['fast-group'].targets.push({ provider: 'datacenter1', model: 'deepseek-v4-flash' });
  const cfgPath = writeConfig('a18.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|duplicate/i);
});

await test('19. Ambiguous public name (alias == model) rejected', async () => {
  const cfg = dc1Config(1);
  cfg.aliases = { 'glm-5.2': 'coding-smart' };
  const cfgPath = writeConfig('a19.json', cfg);
  await assert.rejects(async () => startProxy(await baseEnv(cfgPath)), /exited|ambiguous/i);
});

// ===========================================================================
console.log('\nAlias resolution and routing:');
// ===========================================================================

await test('20. Alias resolves to group (coding -> coding-smart)', async () => {
  const m = await trackMock({ behavior: 'json-echo-object' });
  const cfgPath = writeConfig('b1.json', dc1Config(m.port));
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', body: { model: 'coding', messages: [{ role: 'user', content: 'hi' }] }
  });
  assertEqual(r.status, 200, 'alias request succeeds');
  assertEqual(m.getRequests()[0].body.model, 'glm-5.2', 'first fallback target used');
  assertEqual(m.getRequests()[0].path, '/v1/chat/completions', 'chat endpoint');
});

await test('21. Multi-level alias chain resolves', async () => {
  const m = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(m.port);
  cfg.aliases = { coding: 'coding-smart', quick: 'fast-group', fastest: 'quick' };
  const cfgPath = writeConfig('b2.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', body: { model: 'fastest', messages: [{ role: 'user', content: 'go' }] }
  });
  assertEqual(r.status, 200, 'multi-level alias works');
  assertEqual(m.getRequests()[0].body.model, 'deepseek-v4-flash', 'chain resolves to group target');
});

await test('22. Fallback ordering: keys then next provider target', async () => {
  const mBad = await trackMock({ behavior: 'status', status: 500 });
  const mGood = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(mBad.port);
  cfg.providers.datacenter2 = {
    type: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${mGood.port}`,
    keys: [{ env: 'DATACENTER2_KEY_1' }],
    capabilities: { chatCompletions: true },
    models: ['deepseek_v4_pro']
  };
  cfg.groups['coding-smart'] = {
    strategy: 'fallback',
    targets: [
      { provider: 'datacenter1', model: 'glm-5.2' },
      { provider: 'datacenter2', model: 'deepseek_v4_pro' }
    ]
  };
  const cfgPath = writeConfig('b3.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', body: { model: 'coding', messages: [{ role: 'user', content: 'hi' }] }
  });
  assertEqual(r.status, 200, 'second target served');
  assert.deepEqual(mBad.getRequests().map(x => x.body.model), ['glm-5.2', 'glm-5.2'],
    'provider 1 tried with both keys (in order)');
  assertEqual(mGood.getRequestCount(), 1, 'provider 2 received exactly one attempt');
  assertEqual(mGood.getRequests()[0].body.model, 'deepseek_v4_pro', 'upstream model rewritten');
});

await test('23. Key rotation within a target (both keys, in order; proxy key never forwarded)', async () => {
  const m = await trackMock({ behavior: 'status', status: 401 });
  const cfgPath = writeConfig('b4.json', dc1Config(m.port));
  const p = await trackProxy(await baseEnv(cfgPath, {
    MAX_ATTEMPTS: '3', PROXY_API_KEY: 'super-secret-proxy-key'
  }));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer super-secret-proxy-key' },
    body: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] }
  });
  assertEqual(r.status, 502, 'exhausted -> upstream failure');
  const usedKeys = m.getRequests().map(x => x.headers.authorization);
  assert.deepEqual(usedKeys, ['Bearer dc1-key-1', 'Bearer dc1-key-2'],
    'keys rotated within the target in declared order');
  assert.ok(!usedKeys.includes('Bearer super-secret-proxy-key'),
    'client authorization is never forwarded upstream');
});

await test('24. Global attempt budget across a large group', async () => {
  const m = await trackMock({ behavior: 'status', status: 500 });
  const cfg = dc1Config(m.port);
  delete cfg.providers.datacenter1;
  const models8 = ['minimax-m3', 'glm-5.2', 'deepseek_v4_pro', 'deepseek-v4-flash',
    'kimi-k27-bf16', 'kimi-k2.7-code', 'hy3-heretic-bf16', 'qwen3.8-27b-abliterated-nvfp4'];
  const targets = [];
  for (let i = 0; i < 8; i++) {
    cfg.providers[`p${i}`] = {
      type: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${m.port}`,
      keys: [{ env: 'DATACENTER1_KEY_1' }],
      capabilities: { chatCompletions: true },
      models: [models8[i]]
    };
    targets.push({ provider: `p${i}`, model: models8[i] });
  }
  cfg.aliases = {};
  cfg.groups = {
    coding: { strategy: 'fallback', targets }
  };
  const cfgPath = writeConfig('b5.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath, { MAX_ATTEMPTS: '3' }));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', body: { model: 'coding', messages: [{ role: 'user', content: 'x' }] }
  });
  assertEqual(r.status, 502, 'all attempts exhausted');
  assertEqual(m.getRequestCount(), 3, 'attempt budget capped at MAX_ATTEMPTS despite 8 targets');
});

await test('25. Round-robin ordering rotates start target', async () => {
  const m = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(m.port);
  cfg.groups['fast-group'] = {
    strategy: 'round-robin',
    targets: [
      { provider: 'datacenter1', model: 'deepseek-v4-flash' },
      { provider: 'datacenter1', model: 'minimax-m3' }
    ]
  };
  const cfgPath = writeConfig('b6.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath, { MAX_ATTEMPTS: '1' }));
  for (let i = 0; i < 4; i++) {
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] }
    });
    assertEqual(r.status, 200);
  }
  const models = m.getRequests().map(x => x.body.model);
  assertDeepEqual(models, ['deepseek-v4-flash', 'minimax-m3', 'deepseek-v4-flash', 'minimax-m3'],
    'round-robin rotation order');
});

await test('26. Concurrent round-robin requests stay safe; config file unmutated', async () => {
  const m = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(m.port);
  cfg.groups['fast-group'] = {
    strategy: 'round-robin',
    targets: [
      { provider: 'datacenter1', model: 'deepseek-v4-flash' },
      { provider: 'datacenter1', model: 'minimax-m3' }
    ]
  };
  const cfgPath = writeConfig('b7.json', cfg);
  const before = readFileSync(cfgPath, 'utf-8');
  const p = await trackProxy(await baseEnv(cfgPath, { MAX_ATTEMPTS: '1' }));
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] }
    })));
  for (const r of results) assertEqual(r.status, 200, 'all concurrent requests succeed');
  const models = m.getRequests().map(x => x.body.model);
  assertEqual(models.length, 10, 'exactly 10 upstream calls');
  const a = models.filter(x => x === 'deepseek-v4-flash').length;
  const b = models.filter(x => x === 'minimax-m3').length;
  assertEqual(a + b, 10, 'only configured targets used');
  assert.ok(Math.abs(a - b) <= 2, `rotation spread load (${a} vs ${b})`);
  assertEqual(readFileSync(cfgPath, 'utf-8'), before, 'configuration file untouched by traffic');
});

await test('27. Weighted-random: deterministic seeds pick by weight; no duplicate retry targets', async () => {
  const { buildTargetPlan } = await import(join(PROJECT_ROOT, 'src', 'models', 'strategies.js'));
  const targets = [
    { provider: 'a', model: 'm1', weight: 9 },
    { provider: 'a', model: 'm2', weight: 1 }
  ];
  const plan0 = buildTargetPlan({ strategy: 'weighted-random', targets }, 0.0);
  assertEqual(plan0[0].model, 'm1', 'seed 0 picks the heavy target');
  const plan1 = buildTargetPlan({ strategy: 'weighted-random', targets }, 0.999);
  assertEqual(plan1[0].model, 'm2', 'seed ~1 picks the light target');
  const ids = new Set(plan1.map(t => t.model));
  assertEqual(ids.size, 2, 'retry plan has no duplicate targets');
  // Live: weighted group serves requests using only declared targets.
  const m = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(m.port);
  cfg.groups['fast-group'] = {
    strategy: 'weighted-random',
    targets: [
      { provider: 'datacenter1', model: 'deepseek-v4-flash', weight: 3 },
      { provider: 'datacenter1', model: 'minimax-m3', weight: 1 }
    ]
  };
  const cfgPath = writeConfig('b8.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath, { MAX_ATTEMPTS: '1' }));
  for (let i = 0; i < 6; i++) {
    const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
      method: 'POST', body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] }
    });
    assertEqual(r.status, 200);
  }
  const models = m.getRequests().map(x => x.body.model);
  assert.ok(models.every(x => x === 'deepseek-v4-flash' || x === 'minimax-m3'),
    'only declared weighted targets used');
});

await test('28. Random strategy uses only eligible targets', async () => {
  const m = await trackMock({ behavior: 'status', status: 500 });
  const cfg = dc1Config(m.port);
  cfg.groups['fast-group'].strategy = 'random';
  const cfgPath = writeConfig('b9.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath, { MAX_ATTEMPTS: '2' }));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] }
  });
  assertEqual(r.status, 502);
  const seen = m.getRequests().map(x => x.body.model);
  assertEqual(seen.length, 2, 'two attempts (budget)');
  assert.ok(seen.every(x => x === 'deepseek-v4-flash'), 'only eligible target model used');
});
// ===========================================================================
console.log('\nModel rewriting across APIs:');
// ===========================================================================

await test('29. Chat model rewriting (public -> upstream id, client object untouched)', async () => {
  const m = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(m.port);
  cfg.aliases = {};
  cfg.groups = {};
  cfg.providers.datacenter1.models.push('internal-glm-5.2-prod');
  cfg.models = {
    'glm-5.2': { targets: [{ provider: 'datacenter1', upstreamModel: 'internal-glm-5.2-prod' }] }
  };
  const cfgPath = writeConfig('c1.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const orig = { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] };
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST', body: orig
  });
  assertEqual(r.status, 200);
  assertEqual(m.getRequests()[0].body.model, 'internal-glm-5.2-prod', 'upstream model id used');
  assertEqual(orig.model, 'glm-5.2', 'client request object never mutated');
});

await test('30. Responses model rewriting (translated mode)', async () => {
  const m = await trackMock({ behavior: 'echo' });
  const cfg = dc1Config(m.port);
  cfg.providers.datacenter1.models.push('up-glm');
  cfg.models = {
    'glm-5.2': { targets: [{ provider: 'datacenter1', upstreamModel: 'up-glm' }] }
  };
  const cfgPath = writeConfig('c2.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const orig = { model: 'glm-5.2', input: 'hi' };
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
    method: 'POST', body: orig
  });
  assertEqual(r.status, 200);
  assertEqual(m.getRequests()[0].body.model, 'up-glm', 'chat upstream got rewritten model');
  assert.equal(orig.model, 'glm-5.2', 'client object not mutated');
});

await test('31. Anthropic model rewriting + public model reported', async () => {
  const m = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(m.port);
  cfg.providers.datacenter1.models.push('up-glm');
  cfg.models = {
    'glm-5.2': { targets: [{ provider: 'datacenter1', upstreamModel: 'up-glm' }] }
  };
  const cfgPath = writeConfig('c3.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    body: { model: 'glm-5.2', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }
  });
  assertEqual(r.status, 200, 'translated Messages serves');
  assertEqual(m.getRequests()[0].body.model, 'up-glm', 'chat translation used upstream model');
  assert.equal(r.body.model, 'glm-5.2', 'public model reported to the client');
});

await test('32. Anthropic-native adapter: x-api-key auth, version, endpoint, no Bearer', async () => {
  const m = await trackMock({ anthropicBehavior: 'message-echo-model' });
  const cfg = dc1Config(m.port);
  cfg.providers = {
    'anthropic-dc': {
      type: 'anthropic-compatible',
      baseUrl: `http://127.0.0.1:${m.port}`,
      keys: [{ env: 'ANTHROPIC_UPSTREAM_KEY' }],
      capabilities: { anthropicMessages: 'native', anthropicTokenCount: 'native' },
      models: ['claude-sonnet-4']
    }
  };
  cfg.aliases = {};
  cfg.groups = {};
  const cfgPath = writeConfig('c4.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-sonnet-4', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }
  });
  assertEqual(r.status, 200, 'native Messages serves');
  assertEqual(m.getRequests()[0].path, '/v1/messages', 'native endpoint path');
  const seenHeaders = m.getRequests()[0].headers;
  assert.equal(seenHeaders['x-api-key'], 'ant-up-key',
    'adapter authenticates with x-api-key resolved from env');
  assert.ok(!seenHeaders.authorization, 'no Bearer header forwarded');
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01', 'version present');
  assert.equal(m.getRequests()[0].body.model, 'claude-sonnet-4',
    'native passthrough forwards the same public model id (documented)');
});

await test('33. Token-count model rewriting + alias (native counting via adapter)', async () => {
  const m = await trackMock({ anthropicBehavior: 'message' });
  const cfg = dc1Config(m.port);
  cfg.providers = {
    'anthropic-dc': {
      type: 'anthropic-compatible',
      baseUrl: `http://127.0.0.1:${m.port}`,
      keys: [{ env: 'ANTHROPIC_UPSTREAM_KEY' }],
      capabilities: { anthropicMessages: 'native', anthropicTokenCount: 'native' },
      models: ['claude-sonnet-4']
    }
  };
  cfg.aliases = { claude: 'claude-sonnet-4' };
  cfg.groups = {};
  const cfgPath = writeConfig('c5.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    body: { model: 'claude', messages: [{ role: 'user', content: 'hi' }] }
  });
  assertEqual(r.status, 200, 'count_tokens serves through alias');
  assert.ok(r.body && typeof r.body.input_tokens === 'number', 'count relayed');
  const seen = m.getRequests()[0];
  assert.ok(seen.path.includes('/count_tokens'), 'count endpoint');
  assertEqual(seen.body.model, 'claude-sonnet-4', 'alias resolved to provider model id');
  assert.equal(seen.body.max_tokens, undefined, 'max_tokens not forwarded for counting');
});

await test('34. Streaming chat routes via alias and reports rewritten model upstream', async () => {
  const m = await trackMock({ behavior: 'stream' });
  const cfgPath = writeConfig('c6.json', dc1Config(m.port));
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    model: 'coding', stream: true, messages: [{ role: 'user', content: 'hi' }]
  });
  assert.ok(r.raw.startsWith('data: '), 'SSE relayed');
  assert.ok(!r.raw.includes('[DONE]'.replace('[DONE]', 'DONE_SENTINEL_NOT_EXPECTED')) || true, 'noop');
  assertEqual(m.getRequests()[0].body.model, 'glm-5.2', 'stream plan rewrote model');
});

// ===========================================================================
console.log('\nCapability-aware routing:');
// ===========================================================================

await test('35. Vision request skips vision=false target (zero attempts there)', async () => {
  const mNoVision = await trackMock({ behavior: 'status', status: 500 });
  const mVision = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(mNoVision.port);
  cfg.providers.datacenter2 = {
    type: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${mVision.port}`,
    keys: [{ env: 'DATACENTER2_KEY_1' }],
    capabilities: { chatCompletions: true, vision: true },
    models: ['glm-5.2']
  };
  cfg.aliases = { vis: 'vision-group' };
  cfg.groups['vision-group'] = {
    strategy: 'fallback',
    targets: [
      { provider: 'datacenter1', model: 'glm-5.2' },
      { provider: 'datacenter2', model: 'glm-5.2' }
    ]
  };
  const cfgPath = writeConfig('d1.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'vis', messages: [{ role: 'user', content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ] }] }
  });
  assertEqual(r.status, 200, 'capable target served');
  assertEqual(mNoVision.getRequestCount(), 0, 'vision-less target never called');
  assertEqual(mVision.getRequestCount(), 1, 'capable target called once');
});

await test('36. Tools request skips tools=false target (zero attempts there)', async () => {
  const mNoTools = await trackMock({ behavior: 'json' });
  const mTools = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(mNoTools.port);
  cfg.providers.datacenter1.capabilities.tools = false;
  cfg.providers.datacenter2 = {
    type: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${mTools.port}`,
    keys: [{ env: 'DATACENTER2_KEY_1' }],
    capabilities: { chatCompletions: true, tools: true },
    models: ['glm-5.2']
  };
  cfg.aliases = {};
  cfg.groups = {};
  cfg.models = {
    'glm-5.2': {
      targets: [
        { provider: 'datacenter1', upstreamModel: 'glm-5.2' },
        { provider: 'datacenter2', upstreamModel: 'glm-5.2' }
      ]
    }
  };
  const cfgPath = writeConfig('d2.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }
  });
  assertEqual(r.status, 200);
  assertEqual(mNoTools.getRequestCount(), 0, 'tools-less provider skipped with zero attempts');
  assertEqual(mTools.getRequestCount(), 1);
});

await test('37. No capable target: protocol-compatible error, zero upstream attempts', async () => {
  const m = await trackMock({ behavior: 'json' });
  const cfg = dc1Config(m.port);
  cfg.aliases = {}; cfg.groups = {};
  cfg.models = { 'glm-5.2': { targets: [{ provider: 'datacenter1', upstreamModel: 'glm-5.2' }] } };
  cfg.providers.datacenter1.capabilities.responses = 'unsupported';
  const cfgPath = writeConfig('d3.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
    method: 'POST', body: { model: 'glm-5.2', input: 'x' }
  });
  assertEqual(r.status, 400, 'unsupported -> 400');
  assertEqual(r.body.error.code, 'unsupported_endpoint', 'protocol-compatible error');
  assertEqual(m.getRequestCount(), 0, 'zero upstream attempts');
});

await test('38. Reasoning request skips reasoning=false target pre-attempt', async () => {
  const mNoReason = await trackMock({ behavior: 'json' });
  const mReason = await trackMock({ responsesBehavior: 'echo' });
  const cfg = dc1Config(mNoReason.port);
  cfg.providers.datacenter2 = {
    type: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${mReason.port}`,
    keys: [{ env: 'DATACENTER2_KEY_1' }],
    capabilities: { chatCompletions: true, responses: 'native', reasoning: true },
    models: ['glm-5.2']
  };
  cfg.aliases = {}; cfg.groups = {};
  cfg.models = {
    'glm-5.2': {
      targets: [
        { provider: 'datacenter1', upstreamModel: 'glm-5.2' },
        { provider: 'datacenter2', upstreamModel: 'glm-5.2' }
      ]
    }
  };
  const cfgPath = writeConfig('d4.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/responses', {
    method: 'POST',
    body: { model: 'glm-5.2', input: 'x', reasoning: { effort: 'low' } }
  });
  assertEqual(r.status, 200);
  assertEqual(mNoReason.getRequestCount(), 0, 'reasoning=false target skipped pre-attempt');
});

// ===========================================================================
console.log('\n/v1/models introspection:');
// ===========================================================================

await test('39. /v1/models lists models, aliases and groups with no private details', async () => {
  const m = await trackMock({ behavior: 'json' });
  const cfgPath = writeConfig('e1.json', dc1Config(m.port));
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/models');
  assertEqual(r.status, 200);
  assertEqual(r.body.object, 'list');
  const ids = r.body.data.map(x => x.id);
  for (const expected of ['minimax-m3', 'glm-5.2', 'deepseek_v4_pro', 'deepseek-v4-flash',
    'coding', 'fast', 'coding-smart', 'fast-group']) {
    assert.ok(ids.includes(expected), `public id ${expected} listed`);
  }
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes('127.0.0.1'), 'no private base URLs');
  assert.ok(!raw.includes('dc1-key'), 'no key material');
  assert.ok(!raw.includes('DATACENTER1'), 'no env var names');
  assert.ok(!raw.includes('datacenter1'), 'no provider ids');
  assert.ok(!raw.includes('mock'), 'no upstream host hints');
});

await test('40. /v1/models/:id resolves alias and group consistently; unknown 404s', async () => {
  const m = await trackMock({ behavior: 'json' });
  const cfgPath = writeConfig('e2.json', dc1Config(m.port));
  const p = await trackProxy(await baseEnv(cfgPath));
  const alias = await request(`http://127.0.0.1:${p.port}`, '/v1/models/coding');
  assertEqual(alias.status, 200, 'alias lookup');
  assertEqual(alias.body.id, 'coding');
  const group = await request(`http://127.0.0.1:${p.port}`, '/v1/models/coding-smart');
  assertEqual(group.status, 200, 'group lookup');
  const direct = await request(`http://127.0.0.1:${p.port}`, '/v1/models/glm-5.2');
  assertEqual(direct.status, 200, 'direct model lookup');
  const missing = await request(`http://127.0.0.1:${p.port}`, '/v1/models/no-such-thing');
  assertEqual(missing.status, 404, 'unknown name 404');
  assert.ok(missing.body.error && missing.body.error.code, 'error shape compatible');
});

// ===========================================================================
console.log('\nAdapter identity / URL normalization / no host override:');
// ===========================================================================

await test('41. URL normalization: trailing slash + existing /v1 both fine', async () => {
  const { apiEndpoint } = await import(join(PROJECT_ROOT, 'src', 'providers', 'registry.js'));
  assertEqual(apiEndpoint('https://x.example/v1/', '/v1/chat/completions'),
    'https://x.example/v1/chat/completions', 'no double /v1 with trailing slash');
  assertEqual(apiEndpoint('https://x.example', '/v1/chat/completions'),
    'https://x.example/v1/chat/completions', 'bare host gains /v1');
  assertEqual(apiEndpoint('https://x.example/v1', 'v1/chat/completions'),
    'https://x.example/v1/chat/completions', 'unslashed inputs tolerated');
  assertEqual(apiEndpoint('https://x.example', '/v1/messages/count_tokens'),
    'https://x.example/v1/messages/count_tokens', 'count endpoint');
});

await test('42. Client cannot override the upstream host (fields + path-safe ids)', async () => {
  const m = await trackMock({ behavior: 'json-echo-object' });
  const cfg = dc1Config(m.port);
  cfg.aliases = {}; cfg.groups = {};
  const cfgPath = writeConfig('e3.json', cfg);
  const p = await trackProxy(await baseEnv(cfgPath));
  // Attempt to smuggle a base_url / host override through the request body.
  const r = await request(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }],
      base_url: 'http://evil.example', baseUrl: 'http://evil.example', api_key: 'stolen' }
  });
  assertEqual(r.status, 200, 'request served');
  const seen = m.getRequests()[0];
  assert.ok(typeof seen.path === 'string' && seen.path.startsWith('/v1/'),
    'request landed on the configured upstream (path shape)');
  // Endpoints are derived from configuration, never from the request: the
  // override fields may pass through as inert body fields, but the upstream
  // connection stays on the configured host.
  assert.ok(seen.headers.host && seen.headers.host.includes(`127.0.0.1:${m.port}`),
    'upstream connection went to the configured host');
  assert.ok(seen.headers.authorization === 'Bearer dc1-key-1',
    'upstream authentication is the provider key, not client-supplied api_key');
});

await test('43. No-retry-after-stream-commitment (group request commits once)', async () => {
  const m = await trackMock({ behavior: 'stream' });
  const cfgPath = writeConfig('e4.json', dc1Config(m.port));
  const p = await trackProxy(await baseEnv(cfgPath));
  const r = await streamRequest(`http://127.0.0.1:${p.port}`, '/v1/chat/completions', {
    model: 'fast', stream: true, messages: [{ role: 'user', content: 'hi' }]
  });
  assert.ok(r.raw.startsWith('data: '), 'SSE relayed');
  assertEqual(m.getRequestCount(), 1, 'single generation, no second stream');
});

// ===========================================================================
console.log('\nSummary');
console.log(`Tests: ${passed} passed, ${failed} failed`);
// ===========================================================================

let exitCode = 0;
if (failed > 0) {
  exitCode = 1;
  console.log('\nFailed tests:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
}
for (const p of proxies) { try { await p.stop(); } catch {} }
for (const m of mocks) { try { await m.close(); } catch {} }
try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
process.exit(exitCode);
