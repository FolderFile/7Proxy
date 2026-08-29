# 7Proxy

A lightweight, secure, and blazing-fast AI proxy engineered for high-performance model routing and absolute token efficiency.

A **production-ready, extremely lightweight Node.js AI proxy** implementing the OpenAI-compatible API. Features the Chat Completions and Responses APIs, streaming, key rotation, provider failover, and robust error handling — with **zero runtime dependencies**.

## Features

| Feature | Status |
|---------|--------|
| OpenAI-compatible API | ✅ |
| Server-Sent Events streaming | ✅ |
| Multi-provider support | ✅ |
| API key rotation & failover | ✅ |
| Automatic retry with cooldown | ✅ |
| Request/response timeouts | ✅ |
| Graceful shutdown | ✅ |
| Zero external dependencies | ✅ |

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit .env with your API keys

# 2. Run
npm start

# 3. Test
curl http://localhost:8080/v1/models
```

## Configuration

Create a `.env` file from `.env.example`:

```env
PORT=8080
HOST=0.0.0.0
LOG_LEVEL=info

# OpenAI (required)
OPENAI_API_KEYS=sk-your-key-1,sk-your-key-2

# Optional proxy authentication
# PROXY_API_KEY=your-proxy-secret

# Timeouts (milliseconds)
REQUEST_TIMEOUT_MS=60000
STREAM_TIMEOUT_MS=300000

# Retry settings
MAX_ATTEMPTS=4             # total attempts per request (retries = MAX_ATTEMPTS - 1)
KEY_COOLDOWN_MS=60000
SHUTDOWN_TIMEOUT_MS=10000
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | HTTP server port |
| `HOST` | 0.0.0.0 | Bind address |
| `PROXY_API_KEY` | - | Optional proxy authentication |
| `OPENAI_API_KEYS` | - | Comma-separated API keys |
| `MAX_RETRIES` | 3 | Retries per request (total attempts = MAX_RETRIES + 1) |
| `MAX_ATTEMPTS` | 4 | Total attempts per request (overrides MAX_RETRIES) |
| `RETRY_DELAY_MS` | 500 | Base delay between attempts (jittered, capped by max) |
| `RETRY_MAX_DELAY_MS` | 5000 | Max delay between attempts |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | Graceful shutdown deadline |
| `STREAM_OVERALL_TIMEOUT_MS` | 300000 | Hard cap per streaming exchange (0 disables) |
| `KEY_COOLDOWN_MS` | 60000 | Failed key cooldown |
| `REQUEST_TIMEOUT_MS` | 60000 | Non-streaming upstream timeout |
| `STREAM_TIMEOUT_MS` | 300000 | Streaming inactivity timeout |
| `MAX_REQUEST_BODY_SIZE` | 1048576 | Max body bytes |
| `LOG_LEVEL` | info | debug, info, warn, error |
| `CORS_ORIGIN` | * | Allowed origin |
| `CORS_METHODS` | GET,POST,OPTIONS | Allowed methods |
| `CORS_HEADERS` | Content-Type, Authorization, Accept | Allowed headers |
| `<NAME>_CAPABILITIES` | - | Per-provider capability overrides (see below) |

## API Usage

### Authentication

```bash
# Using OpenAI SDK
export OPENAI_BASE_URL=http://localhost:8080
export OPENAI_API_KEY=your-openai-key

# Or with proxy authentication
export OPENAI_API_KEY=your-proxy-key
```

### Endpoints

#### `GET /health`
Health check with provider statistics.

```json
{
  "status": "ok",
  "providers": {
    "openai": {
      "totalKeys": 2,
      "availableKeys": 2,
      "totalRequests": 42
    }
  }
}
```

#### `GET /v1/models`
List available models.

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

#### `GET /v1/models/:id`
Retrieve a single model by ID (404 if unknown).

#### `POST /v1/chat/completions`
Chat completions with streaming support. Requires `Content-Type: application/json`.
All responses include an `X-Request-Id` header for tracing.

```bash
# Non-streaming
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "temperature": 0.7,
    "max_tokens": 150
  }'

# Streaming
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### OpenAI SDK Example

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: process.env.OPENAI_API_KEY
});

// Non-streaming
const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }]
});

// Streaming
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

## Responses API

`POST /v1/responses` implements the OpenAI Responses API with two provider modes,
selected per provider via capabilities:

- **native** — the upstream implements `/v1/responses`. The request is forwarded
  as-is (arguments preserved, including `previous_response_id`, `include`,
  `reasoning`, `text.format`, `truncation`, etc.), the native response objects and
  native streaming event types are passed through verbatim.
- **translated** — the upstream only speaks Chat Completions. The proxy translates
  Responses input into chat messages and transfers the response back into a valid
  Responses object, generating stable `resp_`/`msg_`/`fc_` IDs.
- **unsupported** — the provider cannot serve this endpoint and is skipped in
  routing (and in failover).

### Supported request fields

| Field | Native | Translated |
|-------|--------|------------|
| `model`, `input` (string or array), `stream` | ✅ passthrough | ✅ translated |
| `instructions` | ✅ | ✅ (system message) |
| `temperature`, `top_p` | ✅ | ✅ |
| `max_output_tokens` | ✅ | ✅ → `max_tokens` |
| `tools` (function), `tool_choice` | ✅ | ✅ (chat format) |
| `parallel_tool_calls`, `user`, `metadata` | ✅ | ✅ / capability-gated |
| `service_tier`, `store` | ✅ | capability-gated |
| `reasoning` | ✅ (needs `reasoning` cap) | ❌ unsupported_parameter |
| `previous_response_id` | ✅ (needs `previousResponseId` cap) | ❌ always rejected (no stateful emulation) |
| `text.format`, `truncation`, `include` | ✅ passthrough | ❌ unsupported_parameter |

Unsupported fields are **never silently discarded**: the proxy first routes to
another capable provider when one exists; otherwise it returns an explicit
`400 unsupported_parameter` naming the field. Nothing partial is forwarded.

Input items supported (translated mode): `message` (`input_text`, `input_image`
content parts), `function_call`, `function_call_output`. Unknown item types are
rejected, not dropped.

### Translated streaming events

Translated streams emit proper Responses SSE (never chat `data: [DONE]`), in order:

```
response.created → response.in_progress → response.output_item.added →
response.content_part.added → response.output_text.delta* →
response.output_text.done → response.content_part.done →
response.output_item.done → response.completed
```

Function calls emit `response.function_call_arguments.delta` / `.done` events.
After commitment, upstream failures surface as exactly one `response.failed`
event; before commitment they trigger normal failover. Usage is mapped from the
upstream when supplied, never invented.

### OpenAI SDK (Responses)

```javascript
const response = await client.responses.create({
  model: 'gpt-4o',
  input: 'Hello!',
  stream: true
});
```

## Provider Capabilities

Declare per-provider capabilities to gate routing and field support:

```env
# responses=native|translated|unsupported
# reasoning / previousResponseId gate those fields natively
OPENAI_CAPABILITIES=responses=native,reasoning=true,previousResponseId=true
ALT_CAPABILITIES=responses=translated
```

Example: an OpenAI-compatible upstream that has no `/v1/responses` endpoint:

```env
OPENAI_API_KEYS=sk-...
OPENAI_BASE_URL=https://api.openai.com
OPENAI_CAPABILITIES=responses=native,reasoning=true,previousResponseId=true
ALT_API_KEYS=alt-...
ALT_BASE_URL=https://internal-llm.internal   # chat completions only
ALT_MODELS=gpt-4o
ALT_CAPABILITIES=responses=translated
```

Requests route to the provider that can actually serve the requested fields;
unsupported fields fail over to a capable provider or return a clear 400.

## Adding New Providers

Create a provider configuration in `config.js`:

```javascript
providers.push({
  name: 'custom-provider',
  baseUrl: 'https://api.custom.com',
  apiKeys: ['key-1', 'key-2'],
  models: ['custom-model-1', 'custom-model-2']
});
```

Or via environment:

```env
CUSTOM_API_KEYS=key-1,key-2
CUSTOM_BASE_URL=https://api.custom.com
```

### Provider Transforms (Advanced)

For non-OpenAI-compatible APIs, implement transform functions:

```javascript
{
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKeys: [...],
  models: [...],
  transformRequest: (openaiBody) => {
    // Convert OpenAI format to provider format
    return {
      model: openaiBody.model,
      messages: openaiBody.messages,
      max_tokens: openaiBody.max_tokens || 4096
    };
  },
  transformResponse: (providerResponse) => {
    // Convert provider format to OpenAI format
    return {
      id: providerResponse.id,
      object: 'chat.completion',
      choices: [...]
    };
  }
}
```

## Key Rotation & Failover

The proxy automatically:

1. **Disables keys permanently** on auth failures (401/403) — an unauthorized key is never retried
2. **Cools down keys temporarily** on rate limits (429) — retried automatically after `KEY_COOLDOWN_MS`
3. **Retries** on temporary errors (5xx, 408, network failures, timeouts) with jittered exponential backoff
4. **Fails over across providers** — if the primary provider fails all its keys, configured secondary providers are tried
5. **Fails fast** with an upstream error if the attempt budget (`MAX_ATTEMPTS`) is exhausted
6. **Never retries after streaming to the client has started** — a mid-stream upstream failure produces an SSE error event and closes the stream

```
Request ──► Key 1 (fails 429) ──► Mark Key 1 cooldown, rotate
              ↓
         Key 2 (fails 503) ──► Retry same key with backoff
              ↓
         Success
```

## Testing

The test suite (`npm test`) runs **52 integration tests** against a real HTTP proxy instance backed by mock upstream servers, covering:

- OpenAI API compatibility (endpoints, error shapes, model lookup)
- Parameter pass-through (temperature, tools, multimodal content, stop sequences)
- Streaming (chunk splitting/merging, CRLF, missing/multiple `[DONE]`, malformed SSE)
- Timeouts (request timeout, stream inactivity timeout, client disconnect)
- Key rotation (401/403 disable, 429 cooldown) and provider failover
- Retry budget enforcement, network failures, malformed upstream JSON
- Body size limits, proxy authentication, CORS, concurrency, graceful shutdown

```bash
# Run all tests
npm test

# Basic connectivity test
curl http://localhost:8080/health

# Test with real API
curl -N http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

## Production Deployment

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json .env ./
COPY *.js ./
COPY providers/ ./providers/
EXPOSE 8080
CMD ["node", "app.js"]
```

### PM2

```bash
npm i -g pm2
pm2 start app.js --name ai-proxy
pm2 save
pm2 startup
```

### Systemd

```ini
[Unit]
Description=AI Proxy
After=network.target

[Service]
Type=simple
User=nodejs
WorkingDirectory=/opt/ai-proxy
ExecStart=/usr/bin/node app.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Environment-Specific Config

```bash
# development
NODE_ENV=development LOG_LEVEL=debug npm start

# production
NODE_ENV=production LOG_LEVEL=warn npm start
```

## Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ HTTP
       ▼
┌─────────────┐     ┌─────────────┐
│   Server    │────▶│   Router    │
└─────────────┘     └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
┌────────────┐     ┌────────────┐     ┌────────────┐
│  /health   │     │ /v1/models │     │ /v1/chat/  │
└────────────┘     └────────────┘     └─────┬──────┘
                                            │
                              ┌─────────────┼─────────────┐
                              ▼             ▼             ▼
                       ┌───────────┐  ┌───────────┐  ┌───────────┐
                       │ KeyManager│  │ Provider  │  │ Failover  │
                       │ (rotation)│  │ Registry  │  │ Handler   │
                       └───────────┘  └───────────┘  └───────────┘
                                               │
                                               ▼
                                        ┌────────────┐
                                        │  Upstream  │
                                        │  Provider  │
                                        └────────────┘
```

## Security Considerations

- API keys are never logged
- Authorization headers are redacted
- Request bodies are sanitized in debug logs
- Configure `PROXY_API_KEY` for additional access control
- Use HTTPS in production (reverse proxy recommended)
- Set reasonable body size limits

## Error Responses

OpenAI-compatible error format (single top-level `error` object, HTTP status in the response line):

```json
{
  "error": {
    "message": "Upstream Provider has failed",
    "type": "upstream_error",
    "code": "upstream_failure"
  }
}
```

| Status | Type | When |
|--------|------|------|
| 400 | `invalid_request_error` | Malformed JSON, missing `model`, invalid params |
| 401 | `authentication_error` | Missing/wrong `PROXY_API_KEY`, or all upstream keys unauthorized |
| 404 | `not_found` | Unknown route or unknown model |
| 405 | `invalid_request_error` | Wrong HTTP method |
| 413 | `invalid_request_error` | Body exceeds `MAX_REQUEST_BODY_SIZE` |
| 415 | `invalid_request_error` | Missing/wrong `Content-Type` on POST |
| 429 | `rate_limit_error` | All upstream keys rate-limited |
| 500 | `internal_error` | Unexpected proxy error |
| 502 | `upstream_error` | All upstream attempts failed |
| 504 | `timeout_error` | Upstream timeout |

## License

MIT
