# Build 2 Report: Responses API (Build 2/10)

**Project:** 7Proxy (`seven-proxy@2.0.0`) — production-ready, zero-dependency OpenAI-compatible AI proxy
**Date:** 2026-08-29

## Summary

Build 2 adds the OpenAI-compatible **Responses API** (`POST /v1/responses`) with
native passthrough and translated modes, while preserving 100% of existing
Chat Completions behavior (52/52 original tests still pass). All prohibited
duplication was avoided via a shared transport-independent core.

## Architecture Changes

A strict "translate at the edges, share the core" refactor — none of the
prohibited logic is duplicated:

**Shared transport-independent core (single copy, used by both APIs):**
- `router.js` → `runWithFailover()` — the **one** per-request orchestration:
  attempt plan building, key selection (round-robin + cooldown/disable),
  attempt budgeting, abortable jittered backoff, terminal-error forwarding,
  unsupportable-parameter pre-fix, commit guard ("never retry once we've
  written to `res`"), final error synthesis (unsupported-parameter vs 502)
- `upstream.js` → `makeUpstreamRequest()` — single upstream fetch/parse:
  endpoint parameterization, per-attempt timeout budget, `AbortSignal.any`
  cancellation composition, error-body capture, `json|stream|stream-json`
  result kinds
- `stream-core.js` → `pumpStream()` — single read loop owning reader lifecycle,
  inactivity deadline, overall deadline (`STREAM_OVERALL_TIMEOUT_MS`),
  client-disconnect cancellation, backpressure/drain, single `TextDecoder`,
  write-after-end guards for every streaming path (chat + native + translated
  Responses)
- `providers/index.js` → `getCapableFailoverProviders(model, api, body)` —
  capability-filtered failover ordering (owner first, round-robin start), used
  by **both** handlers
- `errors.js` classification, `KeyManager`, logging, CORS/auth, `readBody`
  — unchanged, shared

**API-specific edges (new):** request parsing/validation + response
serialization live separately for chat (unchanged) and Responses (native relay
vs translated).

Key invariants preserved:
- Attempts count only after `prepareBody` succeeds (an unsupported field costs
  zero upstream calls)
- `validateResult` runs pre-commit so a malformed upstream object triggers
  failover instead of a broken client response
- No failover after any event is committed to the client

## Files Changed

| File | Change |
|---|---|
| `router.js` | Refactored: extracted shared `runWithFailover` from the inline chat loop; added `/v1/responses` route + per-mode prepare/validate/commit edges |
| `providers/base.js` | `capabilities` (`normalizeCapabilities`, `supportsApi`), `getResponsesEndpoint()` |
| `providers/index.js` | `getCapableFailoverProviders()` |
| `config.js` | `STREAM_OVERALL_TIMEOUT_MS`, `<NAME>_CAPABILITIES` env parsing; duplicate models now a warning (legitimately needed for failover configs) |
| `errors.js` | `unsupportedParameter` / `unsupportedEndpoint` errors |
| `streaming.js` | Chat passthrough rebuilt on the shared pump; external behavior preserved (`[DONE]` appending, etc.) |
| `stream-core.js` | **New** — shared streaming core |
| `upstream.js` | **New** — single upstream fetch (extracted from router) |
| `responses-request.js` | **New** — Responses→Chat request translation, `UnsupportedFieldError` |
| `responses-translate.js` | **New** — Chat→Responses object translation, usage mapping, finish-reason mapping, streaming translator state machine |
| `responses-native.js` | **New** — native field capability gating + native object pre-commit validation |
| `responses-stream.js` | **New** — native passthrough sink (terminal tracking, id capture) + translated SSE sink |
| `test-mock.js` | Native Responses upstream behaviors (`echo`/`status`/`events` + delay); records request `path` |
| `test-client.js` | SSE parser upgraded: `event:` lines, CRLF, event boundaries |
| `test-responses.js` | **New** — 45 Responses integration tests |
| `package.json` | `seven-proxy@2.0.0`, `npm test` = both suites |
| `README.md`, `.env.example` | Responses documentation, capability configuration |

## Responses Features Supported

**Request fields:**
- `model`, `input` (string or array of input items: `message`, `input_text`,
  `input_image`, `function_call`, `function_call_output`)
- `instructions`, `stream`, `temperature`, `top_p`
- `max_output_tokens` (→ `max_tokens` in translated mode)
- `tools` (function), `tool_choice`, `parallel_tool_calls`
- `reasoning` (capability-gated), `text.format`, `truncation`, `service_tier`,
  `store`, `metadata`, `user`, `include`
- `previous_response_id` (native mode, capability-gated; always rejected in
  translated mode)

**Output items:** `message`/`output_text`, `function_call`, plus passthrough of
anything the native upstream supplies (e.g. `reasoning` items).

**Streaming:**
- Full event ordering: `response.created` → `response.in_progress` →
  `response.output_item.added` → `response.content_part.added` →
  `response.output_text.delta`* → `response.output_text.done` →
  `response.content_part.done` → `response.output_item.done` →
  `response.completed`
- `response.function_call_arguments.delta` / `.done` for tool calls
- Exactly one terminal event; never emits chat `data: [DONE]`
- Unknown native event types passed through (forward compatible)
- Backpressure respected; inactivity + overall deadlines enforced
- Post-commit upstream failure surfaces as exactly one `response.failed`
- Failover allowed only before the first event is committed

## Native vs Translated Behavior

- **Native:** request forwarded as-is to upstream `/v1/responses`; response
  objects and SSE events byte-passthrough; `previous_response_id`/`reasoning`
  gated by capability flags.
- **Translated:** request translation (instructions→system message,
  `max_output_tokens`→`max_tokens`, Responses function tool shape→chat tool
  shape, `function_call`/`function_call_output` items→`tool_calls`/`tool`
  messages); the upstream endpoint hit is `/v1/chat/completions`; response
  synthesized as a valid Responses object with stable generated IDs
  (`resp_`/`msg_`/`fc_`); usage mapped only from what the upstream supplies
  (never invented); `finish_reason` mapped consistently to
  `status`/`incomplete_details`.

## Unsupported Behavior (explicit, never silent)

- `previous_response_id` in translated mode: `400 unsupported_parameter` (no
  stateful emulation)
- `reasoning`/`text.format`/`truncation`/non-empty `include` in translated
  mode: `unsupported_parameter` (capability routing tried first; rejection
  only when no provider can serve)
- Non-function tool types: `400` identifying the field (e.g.
  `tools[0].type: web_search`)
- Unknown fields: passed through in native mode; rejected in translated mode
- Provider with `responses: 'unsupported'` is skipped in routing/failover;
  if no provider can serve the model, a `400 unsupported_endpoint` is returned

## Test Results

- **Chat Completions: 52/52 passing** (multiple runs post-refactor + both final
  verification runs)
- **Responses: 45/45 passing** — 9+ consecutive clean runs, plus two final
  combined runs
- Coverage matches the spec's test list 1–38: native/translated non-streaming
  and streaming, string/array input, instructions, text and function-call
  output, tool definitions/choice, multimodal input, reasoning passthrough,
  usage passthrough, incremental deltas, event order, single terminal event,
  no `[DONE]` leakage, unknown/missing model, invalid input, unsupported-field
  rejection, `previous_response_id` semantics, capability-based selection,
  failover before first event, no failover after first event, 401/429 rotation,
  5xx failover, attempt-budget enforcement, timeouts, client disconnect,
  malformed upstream output, concurrency, and unchanged chat behavior

## Runtime Dependency Count

**0** — Node built-ins only (`http`, `fs`, `path`, `url`, `net`).
Verified by import scan.

## Exact curl Examples (live-verified)

```bash
# Native non-streaming
curl -s -X POST http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","input":"Hello from native mode","instructions":"Be brief","reasoning":{"effort":"high"}}'

# Native streaming
curl -sN -X POST http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","input":"hi","stream":true}'

# Translated non-streaming (tools map to chat format, response converted back)
curl -s -X POST http://localhost:8080/v1/responses -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","input":"Hello","tools":[{"type":"function","name":"get_weather","parameters":{"type":"object","properties":{"loc":{"type":"string"}}}}]}'

# Translated streaming (full event sequence)
curl -sN -X POST http://localhost:8080/v1/responses -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","input":"hi","stream":true}'

# Translated provider → 400 (unsupported parameter, clearly identified)
curl -s -X POST http://localhost:8080/v1/responses -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","input":"hi","previous_response_id":"resp_1"}'
# → {"error":{"message":"Parameter 'previous_response_id': stateful conversation emulation is not supported for translated providers","type":"invalid_request_error","code":"unsupported_parameter"}}
```

## Remaining Limitations

- No stateful `previous_response_id` emulation in translated mode (per spec;
  would require response storage — out of scope for this build)
- Translated mode does not synthesize `reasoning` output items (non-reasoning
  upstreams don't produce them; none invented)
- `/v1/models` stays standard OpenAI-shaped (capabilities are routing-internal,
  not serialized into model listings)
- `service_tier`/`store`/`metadata` forwarded where capability allows; usage
  detail objects mapped only from what the upstream supplies
- `GET /v1/responses/{id}` retrieval not provided (stateless proxy)
- Anthropic Messages API not implemented (per Build 2 scope — the capability
  framework and translation layer are ready for it in a later build)

## Verification Checklist

- [x] Complete test suite run 5+ consecutive times (Responses 45/45 ran 9+
      consecutive clean runs; final combined runs both green)
- [x] Syntax checks over every JavaScript file
- [x] Native and translated Responses tested locally with curl
- [x] Zero external runtime dependencies confirmed (import scan)
- [x] No orphaned processes, handles, timers, or listeners (checked and killed)
- [x] All original Chat Completions tests still pass (52/52)
- [x] README updated with Responses examples and capability configuration
- [x] No unsupported features claimed