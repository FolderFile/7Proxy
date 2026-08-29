# Build 3 Report: Repository Reorganization + Anthropic Messages API

**Project:** 7Proxy (`seven-proxy@0.3.0`) — zero-dependency AI proxy
**Status:** early development release (Build 3 of 10) — not stable
**Date:** 2026-08-29
**Commits:** `91cd75c` (reorganization), `2001b0d` (Anthropic Messages API)

## 1. Baseline Verification

- HEAD `0aa8024` == `origin/main`, working tree clean
- Baseline suite confirmed before changes: 52/52 Chat + 45/45 Responses, all
  syntax checks passing
- GitHub CLI authenticated (account `FolderFile`)

## 2. Repository Reorganization

Done first, committed and pushed separately (`chore: organize source and test
structure`, `91cd75c`) with 97/97 tests passing before the commit. All moves
used `git mv` (rename history preserved); no behavior changes.

```
src/{app,server}.js            entry points (npm start = node src/app.js)
src/core/                      router, upstream, stream-core, streaming,
                               key-manager, errors, logger, config, http-utils
src/api/                       chat-completions.js, responses.js, anthropic-messages.js
src/providers/                 base.js (interface + capabilities), index.js (registry)
src/formats/                   responses-* (Build 2) + anthropic-* (Build 3)
test/integration/              3 suites (chat, responses, anthropic)
test/helpers/                  mock-upstream.js, http-client.js
docs/                          BUILD2-REPORT.md, BUILD3-REPORT.md
```

- `.env` resolves from the project root (`PROJECT_ROOT`), portable paths
- `package.json`: `main: src/app.js`, scripts updated, version `0.2.0 → 0.3.0`
- No compatibility wrappers; repository root has zero `.js` files (tested)
- Incidentally removed dead code: a duplicated `prepareBody` key in the old
  router's Responses handler (was harmless last-write-wins dead code)

## 3. Architecture Changes

- **`src/core/http-utils.js` (new)**: `sendError`, `sendJson`, `readBody`,
  `sseHead` extracted from router so protocol edges never import the router.
- **`runWithFailover` extended (nothing duplicated)**: per-API `headerPolicy`
  hook (provider-scoped upstream headers built from the provider key only),
  per-API endpoint selection (`anthropic-messages` → native Messages endpoint
  or chat endpoint; `anthropic-token-count` → count endpoint), and an
  error-shape mapper table — Anthropic endpoints emit Anthropic-shaped errors,
  OpenAI endpoints unchanged.
- **`makeUpstreamRequest`**: accepts optional prebuilt `headers` (per-API auth
  shape), defaulting to `provider.buildHeaders(key)`; auth is always
  constructed from the provider's own key entry.
- **`UnsupportedFieldError`** shared via `src/formats/unsupported-field.js`;
  both protocol edges throw the class the failover loop understands.
- Provider capabilities extended: `anthropicMessages`
  (native|translated|unsupported), `anthropicTokenCount`, `thinking`,
  `documents`, `betas`, `anthropicVersion`, `messagesPath`, `countTokensPath`.
- Proxy auth accepts `x-api-key` (constant-time) alongside Bearer; Anthropic
  paths return Anthropic-shaped 401s.

## 4. Native Anthropic Behavior

- Requests forwarded verbatim to the Messages endpoint after strict structural
  validation; `thinking`/`documents`/image blocks capability-gated via
  `UnsupportedFieldError` (zero-cost provider skip, never an upstream attempt).
- Upstream auth: `x-api-key: <provider-key>` + configured `anthropic-version`;
  `anthropic-beta` forwarded only when the provider declares `betas=true`.
- Responses relayed without OpenAI conversion; validated pre-commit
  (`{type:'message', id, role:'assistant', content[]}`) — malformed upstream
  output fails over instead of being forwarded.
- SSE relayed byte-passthrough with backpressure; unknown native event types
  pass through; post-commit timeout/error injects exactly one `error` event
  and never fabricates `message_stop`.

## 5. Translated Anthropic Behavior

- system (string/blocks) → system message; text/image/tool_use/tool_result
  blocks → chat content (`image_url` data URLs, `tool_calls`, `tool` messages)
  with IDs and ordering preserved; `max_tokens` direct; `stop_sequences` →
  `stop`; tool_choice auto/any/tool mapped (`any` → `required`).
- Requests hit `/v1/chat/completions`; responses synthesized into Anthropic
  Messages with generated `msg_*` ids; finish_reason mapped stop→end_turn,
  length→max_tokens, tool_calls→tool_use; `stop_sequence` never guessed.
- `top_k`, thinking, documents, tool-result `is_error`, image-in-tool-result:
  rejected with `unsupported_parameter` (routed to capable providers first) —
  never dropped, never emulated, usage never invented (absent → `null`).

## 6. Supported Request and Content Fields

- Request: `model`, `messages` (user/assistant; string or blocks), `max_tokens`,
  `system` (string or text blocks), `stream`, `temperature`, `top_p`, `top_k`
  (capability-gated), `stop_sequences`, `tools`, `tool_choice`
  (auto/any/tool), `metadata.user_id`, `service_tier`, `thinking`
  (capability-gated)
- Content blocks: `text`, `image` (base64/url), `tool_use`, `tool_result`,
  `thinking`/`redacted_thinking` (thinking-gated), `document` (documents-gated)
- Roles beyond user/assistant, unknown blocks, invalid schemas, invalid ranges
  → Anthropic-shaped 400 with the exact field path

## 7. Streaming Behavior

Shared `pumpStream` core (deadlines, client-disconnect cancellation,
backpressure, cleanup). Translated mode emits the exact lifecycle from chat
deltas: `message_start` (at commit) → `content_block_start` →
`content_block_delta`* (text_delta / input_json_delta) → `content_block_stop`
→ `message_delta` (stop_reason + mapped usage) → `message_stop`. Tool
arguments stream as `input_json_delta.partial_json` fragments whose
concatenation is the final input. `[DONE]` and Responses event names never
leak. CRLF/LF robust; multiple events per TCP chunk safe; one event split
across chunks safe. Post-commit inactivity/overall timeouts inject exactly one
`error` event — never a fabricated `message_stop`, never a second generation.

## 8. Token-Count Behavior

`POST /v1/messages/count_tokens`: native-capable providers only (`anthropicTokenCount=native`);
body forwarded without `stream`/`max_tokens`; response validated
(`input_tokens` numeric) pre-commit with failover on malformed output; key
rotation and provider failover reuse the shared loop; translated-only setups
return an explicit Anthropic error — counts are **never estimated**.

## 9. Unsupported Behavior (explicit, never silent)

- Fields a provider cannot preserve → capability routing without consuming an
  upstream attempt; else 400 `unsupported_parameter` naming the field
- count_tokens without a native-capable provider → explicit error, no estimate
- Unknown model → 404 `not_found_error`; invalid `anthropic-version` → 400
  before any upstream call; oversized → 413 `request_too_large`; invalid JSON
  → 400
- OpenAI endpoints keep OpenAI-shaped errors; Anthropic endpoints keep
  Anthropic-shaped errors (both tested side by side)

## 10. Files Moved / Created / Modified / Removed

- **Moved (Phase 2, separate commit):** all 24 tracked files into the
  src/test/docs layout
- **Created (Build 3):** `src/core/http-utils.js`,
  `src/formats/anthropic-{errors,request,response,stream}.js`,
  `src/formats/unsupported-field.js`,
  `src/api/{chat-completions,responses,anthropic-messages}.js`,
  `test/integration/anthropic-messages.test.js`, `docs/BUILD3-REPORT.md`
- **Modified:** `src/providers/base.js` (capabilities, endpoints, per-API
  headers), `src/core/router.js` (modularized + hooks + auth/x-api-key +
  route table), `src/core/upstream.js` (headers param),
  `test/helpers/mock-upstream.js` (Anthropic behaviors, x-api-key recording),
  `README.md`, `.env.example`, `package.json`, `src/formats/responses-request.js`
  (shared UnsupportedFieldError re-export)
- **Removed:** nothing (moves only)

## 11. Exact Test Totals

- Chat Completions: **52** (unchanged)
- Responses: **45**
- Anthropic Messages: **72** (new)
- **Total: 169**

## 12. Five Consecutive Combined Runs

`npm test` runs all three suites; five consecutive runs all green:

```
run 1: 52 passed, 0 failed | 45 passed, 0 failed | 72 passed, 0 failed
run 2: 52 passed, 0 failed | 45 passed, 0 failed | 72 passed, 0 failed
run 3: 52 passed, 0 failed | 45 passed, 0 failed | 72 passed
run 4: 52 passed, 0 failed | 45 passed, 0 failed | 72 passed
run 5: 52 passed, 0 failed | 45 passed, 0 failed | 72 passed
```

No test was skipped, weakened or deleted. Anthropic coverage includes:
organization invariants (entry point, start command, no root modules, imports
resolve, chat unchanged), auth/headers (x-api-key valid/invalid, Bearer, no
credential forwarding, version default/explicit/invalid, beta gating, no
arbitrary header forwarding), native (non-streaming, streaming, system
string/blocks, text/images/tools/tool_use/tool_result, thinking, usage cache
fields, error translation, malformed-output failover), translated
(non-streaming, streaming, all mappings, stop reasons, missing usage → null,
unsupported-field rejection, native-capable provider selection), streaming
safety (fragment concatenation, framing torture, ping/unknown passthrough,
inactivity timeout → one error event, disconnect cancellation,
post-commit no-retry, no `[DONE]` leak), rotation/failover (401/429,
500/502/503/504, network failure, attempt budget, concurrency, no duplicate
generations), validation (missing/invalid fields, document/thinking rejection,
oversized, invalid JSON, error shapes both ways), token counting (success,
field preservation, key rotation, provider failover, malformed response,
translated refusal), and exact assertions on upstream paths, attempt counts,
keys, event order and terminal counts.

## 13. Syntax Checks

`node --check` over all 26 JavaScript files: **all pass**.

## 14. Runtime Dependency Count

**0** — Node built-ins only (`http`, `fs`, `path`, `url`, `net`).

## 15. Version Confirmation

`seven-proxy@0.3.0` — early development release (Build 3/10). No stable tag.

## 16. Curl Examples (live-tested)

```bash
# Native non-streaming
curl -s -X POST http://localhost:8080/v1/messages \
  -H "content-type: application/json" -H "x-api-key: your-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4","max_tokens":256,"messages":[{"role":"user","content":"Hello!"}]}'

# Native streaming
curl -sN -X POST http://localhost:8080/v1/messages \
  -H "content-type: application/json" -H "x-api-key: your-proxy-key" \
  -d '{"model":"claude-sonnet-4","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Hello!"}]}'

# Token counting (native providers only)
curl -s -X POST http://localhost:8080/v1/messages/count_tokens \
  -H "content-type: application/json" -H "x-api-key: your-proxy-key" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello!"}]}'

# Translated mode (OpenAI-compatible upstream; unsupported fields name themselves)
curl -s -X POST http://localhost:8080/v1/messages \
  -H "content-type: application/json" -H "x-api-key: your-proxy-key" \
  -d '{"model":"claude-sonnet-4","max_tokens":64,"messages":[{"role":"user","content":"Hi"}],"thinking":{"type":"enabled","budget_tokens":512}}'
```

## 17. Git Commits

- `91cd75c` — `chore: organize source and test structure` (pushed in Phase 2)
- `2001b0d` — `feat: add Anthropic Messages API support` (Build 3 feature commit)

## 18. Push Verification

Pushed `91cd75c..2001b0d  main -> main` (fast-forward, no force).
After push: working tree clean; `git rev-parse HEAD` == `git rev-parse origin/main`
(`2001b0d0c4990332cc52f7ea7ab4842c9dc259f2`). No orphaned processes, no
lingering test servers.

## 19. Secret-Scan Result

Staged diff + full tree scanned for `sk-*`, `ghp_*`/`gho_*`, AWS `AKIA`,
private key blocks, bearer tokens: **only placeholders and mock keys**
(`sk-your-key-1`, `sk-ant-your-key-*`, mock keys like `ant-k1`, `client-key`.
No `.env` file exists (only `.env.example`); no credentials, authorization
headers, logs or runtime data committed. Remote `.gitignore` (blocks `.env`,
keys, logs) honored.

## 20. Remaining Limitations

- Token counting is native-only by design (no exact tokenizer for translated
  providers; character-based estimation deliberately not implemented)
- Translated mode routes away from or rejects (never silently degrades):
  `thinking`/`redacted_thinking`, `documents`, `top_k`, prompt caching
  (`cache_control`), tool-result `is_error`, beta-only features
- No Anthropic admin/batch/file/organization endpoints (out of scope per spec)
- No `GET /v1/messages/{id}` retrieval (stateless proxy)
- Early build: not stable; API surface may change through Build 10