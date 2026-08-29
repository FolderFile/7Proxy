/**
 * Mock upstream HTTP servers for integration tests.
 * Each mock is a configurable OpenAI-compatible upstream that records the
 * requests it receives (per Authorization key) so tests can assert attempt
 * counts and key rotation.
 */

import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

/**
 * Create a mock upstream.
 * @param {object} opts
 * @param {number} opts.port - 0 for ephemeral
 * @param {string} opts.behavior - 'json' | 'stream' | 'status' | 'stream-then-disconnect'
 *                                 | 'stream-no-done' | 'malformed-json' | 'malformed-sse'
 *                                 | 'slow' | 'slow-stream' | 'hang' | 'echo'
 * @param {number} opts.status - HTTP status for 'status'/'json'/'stream'
 * @param {number} opts.delayMs - delay before responding (for 'slow'/'slow-stream')
 * @param {number} opts.disconnectAfterMs - for 'stream-then-disconnect'
 * @param {object} opts.body - JSON body to return for 'json'/'status'
 * @param {string[]} opts.chunks - SSE chunks to emit for 'stream'
 * @param {number} opts.chunkGapMs - gap between stream chunks
 * @param {string[]} opts.acceptKeys - only these keys (Bearer tokens) get 200; others get 401
 */
export function createMock(opts = {}) {
  const {
    behavior = 'json',
    status = 200,
    delayMs = 0,
    disconnectAfterMs = 100,
    body = null,
    chunks = null,
    chunkGapMs = 0,
    acceptKeys = null,
    /** '/v1/responses' behavior: 'native-json' | 'native-stream' | 'echo-requests-object' */
    responsesBehavior = null,
    /** Anthropic /v1/messages behavior:
     *  'message' (non-streaming Message), 'messages-stream' (SSE),
     *  'echo' (wrap request in a Message / native SSE events) */
    anthropicBehavior = null,
    /** Anthropic SSE events: [type, payload][] for 'messages-stream'. */
    anthropicEvents = null,
    /** Response body for /v1/messages/count_tokens (default {input_tokens:42}). */
    anthropicCountBody = null
  } = opts;

  const requests = []; // { key, body, headers, time, path }
  let server;

  const defaultStreamChunks = [
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n'
  ];

  // Default native Responses SSE events (used when chunks is null).
  const defaultResponseEvents = [
    ['response.created', { id: 'resp_mock', object: 'response', status: 'in_progress', output: [] }],
    ['response.output_item.added', { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] }],
    ['response.output_text.delta', { item_id: 'msg_1', delta: 'Hello native' }],
    ['response.output_item.done', { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello native', annotations: [] }] }],
    ['response.completed', { id: 'resp_mock', object: 'response', status: 'completed', output: [], usage: null }]
  ];

  const defaultResponsesJson = {
    id: 'resp_mock',
    object: 'response',
    created_at: 1234567890,
    status: 'completed',
    model: 'gpt-4o',
    output: [
      { type: 'message', id: 'msg_mock', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello native', annotations: [] }] }
    ],
    usage: {
      input_tokens: 3, output_tokens: 2, total_tokens: 5,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }
    },
    error: null
  };

  const defaultAnthropicMessage = {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'Hello from Anthropic mock' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 }
  };

  const defaultAnthropicEvents = [
    ['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant',
      model: 'claude-3-5-sonnet-20241022', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' native' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }]
  ];

  const defaultJson = {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1234567890,
    model: 'gpt-4o',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  };

  function handle(req, res) {
    const auth = req.headers['authorization'] || '';
    let reqBody = '';
    req.on('data', c => reqBody += c);
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(reqBody); } catch {}
      const xapiKey = req.headers['x-api-key'] || '';
      requests.push({ key: auth || xapiKey, bearer: auth, xApiKey: xapiKey, body: parsed,
        headers: { ...req.headers }, time: Date.now(), url: req.url, path: req.url?.split('?')[0] });

      // Key gating (for auth rotation tests). Accepts Bearer tokens and
      // Anthropic-style x-api-key headers.
      if (acceptKeys) {
        const token = auth.replace(/^Bearer /, '') || xapiKey;
        if (!acceptKeys.includes(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid authentication key', type: 'invalid_request_error' } }));
          return;
        }
      }

      const respond = () => {
        const wantsStream = parsed?.stream === true;

        // Anthropic native endpoint behavior: the mock serves whatever the
        // proxy sends to /v1/messages (or /v1/messages/count_tokens) according
        // to anthropicBehavior. Honors delayMs (slow upstream tests).
        if (anthropicBehavior && (req.url || '').includes('/v1/messages')) {
          const respondAnthropic = () => {
            const sendAnthropicSse = (events) => {
              res.writeHead(200, { 'Content-Type': 'text/event-stream' });
              let ei = 0;
              const send = () => {
                if (ei >= events.length) { res.end(); return; }
                const [type, payload] = events[ei++];
                res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
                if (chunkGapMs > 0) setTimeout(send, chunkGapMs);
                else setImmediate(send);
              };
              send();
            };
            if ((req.url || '').includes('/count_tokens')) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(anthropicCountBody ?? { input_tokens: 42 }));
              return;
            }
            if (anthropicBehavior === 'message') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(body ?? defaultAnthropicMessage));
              return;
          }
            if (anthropicBehavior === 'messages-stream') {
              sendAnthropicSse(anthropicEvents ?? defaultAnthropicEvents);
              return;
            }
            if (anthropicBehavior === 'echo') {
              // Streaming: replay default native events; non-streaming: a
              // valid Message echoing nothing (request introspection is
              // done via getRequests()).
              if (parsed?.stream === true) {
                sendAnthropicSse(defaultAnthropicEvents);
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ...defaultAnthropicMessage, stop_reason: 'end_turn' }));
              return;
            }
          };
          // Honor delayMs for slow-upstream tests (parallel to chat behavior).
          if (delayMs > 0 && behavior === 'slow') {
            setTimeout(respondAnthropic, delayMs);
            return;
          }
          respondAnthropic();
          return;
        }

        // Native Responses endpoint behavior: the mock serves whatever the
        // proxy sends to /v1/responses according to responsesBehavior.
        if (responsesBehavior) {
          const respondEcho = () => {
            if (parsed?.stream === true) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream' });
              for (const [type, payload] of (opts.nativeEvents ?? [
                ['response.created', { id: 'resp_echo', object: 'response', status: 'in_progress', output: [] }],
                ['response.output_text.delta', { item_id: 'msg_1', delta: JSON.stringify(parsed) }],
                ['response.completed', { id: 'resp_echo', object: 'response', status: 'completed', output: [] }]
              ])) {
                res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
              }
              res.end();
              return;
            }
            const { stream: _s, ...rest } = parsed;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'resp_echo',
              object: 'response',
              created_at: 1234567890,
              status: 'completed',
              output: [],
              ...rest
            }));
          };
          switch (responsesBehavior) {
            case 'echo': {
              if (delayMs > 0) { setTimeout(respondEcho, delayMs); return; }
              respondEcho();
              return;
            }
            case 'status': {
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(body ?? { error: { message: `upstream ${status}` } }));
              return;
            }
            case 'events': {
              // Emit the configured native SSE events verbatim.
              res.writeHead(200, { 'Content-Type': 'text/event-stream' });
              const evts = opts.nativeEvents ?? [];
              let ei = 0;
              const send = () => {
                if (ei >= evts.length) { res.end(); return; }
                const [type, payload] = evts[ei++];
                res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
                if (chunkGapMs > 0) setTimeout(send, chunkGapMs);
                else setImmediate(send);
              };
              send();
              return;
            }
          }
        }


        switch (behavior) {
          case 'status': {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body ?? { error: { message: `upstream ${status}` } }));
            return;
          }
          case 'json': {
            if (wantsStream) {
              // Return a valid SSE stream for stream requests.
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
              res.write(`data: ${JSON.stringify(defaultJson)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body ?? defaultJson));
            return;
          }
          case 'echo': {
            if (wantsStream) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream' });
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            // On a chat endpoint, wrap the echo in a valid chat.completion
            // envelope so translated-mode pre-commit validation passes.
            if (typeof req.url === 'string' && req.url.includes('/v1/chat/completions')) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                id: 'chatcmpl-echo',
                object: 'chat.completion',
                created: 1234567890,
                model: parsed?.model ?? 'gpt-4o',
                choices: [{
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: `echo:${JSON.stringify({
                      messages: parsed?.messages ?? [],
                      temperature: parsed?.temperature ?? null,
                      max_tokens: parsed?.max_tokens ?? null,
                      tools: parsed?.tools ?? null,
                      tool_choice: parsed?.tool_choice ?? null,
                      user: parsed?.user ?? null,
                      metadata: parsed?.metadata ?? null,
                      parallel_tool_calls: parsed?.parallel_tool_calls ?? null,
                      service_tier: parsed?.service_tier ?? null,
                      store: parsed?.store ?? null
                    })}`
                  },
                  finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(parsed));
            return;
          }
          case 'stream': {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            const list = chunks ?? defaultStreamChunks;
            let i = 0;
            const send = () => {
              if (i >= list.length) { res.end(); return; }
              res.write(list[i++]);
              if (chunkGapMs > 0 && i < list.length) setTimeout(send, chunkGapMs);
              else setImmediate(send);
            };
            send();
            return;
          }
          case 'stream-then-disconnect': {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const list = chunks ?? defaultStreamChunks;
            for (let i = 0; i < list.length; i++) res.write(list[i]);
            setTimeout(() => { try { res.destroy(); } catch {} }, disconnectAfterMs);
            return;
          }
          case 'stream-no-done': {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const list = (chunks ?? defaultStreamChunks).filter(c => !c.includes('[DONE]'));
            let i = 0;
            const send = () => {
              if (i >= list.length) { res.end(); return; }
              res.write(list[i++]);
              setImmediate(send);
            };
            send();
            return;
          }
          case 'malformed-json': {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{ this is not valid json');
            return;
          }
          case 'malformed-sse': {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: not-json-at-all\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          case 'slow-stream': {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const list = chunks ?? defaultStreamChunks;
            let i = 0;
            const send = () => {
              if (i >= list.length) { res.end(); return; }
              res.write(list[i++]);
              setTimeout(send, chunkGapMs || 2000);
            };
            send();
            return;
          }
          case 'hang': {
            // Never respond; let the client timeout.
            return;
          }
          case 'slow': {
            setTimeout(() => {
              if (res.writableEnded) return;
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(body ?? defaultJson));
            }, delayMs);
            return;
          }
          default: {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'unknown mock behavior' } }));
          }
        }
      };

      if (delayMs > 0 && behavior !== 'slow' && behavior !== 'slow-stream') setTimeout(respond, delayMs);
      else respond();
    });
  }

  return new Promise((resolve, reject) => {
    server = http.createServer(handle);
    server.on('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        server,
        getRequests: () => requests.slice(),
        getRequestCount: () => requests.length,
        getKeys: () => requests.map(r => r.key),
        getPaths: () => requests.map(r => r.path),
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

/**
 * Start a proxy as a child process with the given environment.
 * Resolves with { port, process, stop }.
 */
export function startProxy(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['src/app.js'], {
      cwd: PROJECT_ROOT,
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let settled = false;
    let errOut = '';
    const capture = (d) => { errOut += d.toString(); };
    proc.stderr.on('data', capture);
    proc.stdout.on('data', capture);
    proc.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    proc.on('exit', (c) => { if (!settled) { settled = true; reject(new Error('proxy exited ' + c + ' stderr: ' + errOut)); } });

    // Poll the health endpoint instead of relying on log output (log level may hide it).
    const port = parseInt(env.PORT, 10);
    const base = `http://127.0.0.1:${port}`;
    const pollHeaders = {};
    if (env.PROXY_API_KEY) pollHeaders.Authorization = `Bearer ${env.PROXY_API_KEY}`;
    let tries = 0;
    const poll = async () => {
      while (!settled && tries < 100) {
        tries++;
        try {
          const resp = await new Promise((res) => {
            const r = http.request(`${base}/health`, { method: 'GET', headers: pollHeaders, timeout: 300 }, (x) => {
              let b = ''; x.on('data', c => b += c); x.on('end', () => res({ ok: x.statusCode === 200, b }));
            });
            r.on('error', () => res({ ok: false }));
            r.on('timeout', () => { r.destroy(); res({ ok: false }); });
            r.end();
          });
          if (resp.ok) {
            settled = true;
            resolve({
              port,
              process: proc,
              stop: () => new Promise((r) => {
                proc.once('exit', () => r());
                proc.kill('SIGTERM');
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
                setTimeout(() => r(), 4000); // hard deadline
              })
            });
            return;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 100));
      }
      if (!settled) { settled = true; proc.kill(); reject(new Error('proxy start timeout. stderr: ' + errOut)); }
    };
    poll();
  });
}
