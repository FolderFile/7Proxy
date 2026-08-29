# Build 3 Report: Repository Reorganization + Anthropic Messages API

**Project:** 7Proxy (`seven-proxy@0.3.0`) — zero-dependency AI proxy
**Status:** early development release (Build 3 of 10) — not stable
**Date:** 2026-08-29

## 1. Baseline Verification

- HEAD `0aa8024` == `origin/main`, working tree clean
- Baseline suite confirmed before changes: 52/52 Chat + 45/45 Responses, all
  syntax checks passing
- GitHub CLI authenticated (account `FolderFile`)

## 2. Repository Reorganization

Moved with `git mv` (rename history preserved), imports updated, no behavior
changes. Committed and pushed separately (`chore: organize source and test
structure`, `91cd75c`) with 97/97 passing before the commit.

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

- `.env` now resolves from the project root (`PROJECT_ROOT`), portable paths
- `package.json`: `main: src/app.js`, scripts updated, version `0.2.0 → 0.3.0`
- No compatibility wrappers left in root; root has zero `.js` files (tested)
- Incidentally removed dead code: a duplicated `prepareBody` key in the old
  router's Responses handler (last-write-wins, was dead code)

## 3. Architecture Changes

- **`src/core/http-utils.js` (new)**: `sendError`, `sendJson`, `readBody`,
  `sseHead` extracted from router so protocol edges never import the router.
- **`runWithFailover` extended (no duplication)**: per-API `headerPolicy`
  hook (provider-scoped upstream headers), endpoint selection per API +
  provider mode (`anthropic-messages` → Messages endpoint for native, chat
  endpoint for translated; `anthropic-token-count` → count endpoint), and an
  error-shape mapper table — Anthropic endpoints emit Anthropic-shaped errors,
  OpenAI endpoints unchanged.
- **`makeUpstreamRequest`**: accepts optional prebuilt `headers` (per-API auth
  shape) while defaulting to `provider.buildHeaders(key)`; auth is always
  constructed from the provider's key entry only.
- **`UnsupportedFieldError`** moved to `src/formats/unsupported-field.js`;
  both protocol edges throw the same class the failover loop understands.
- Provider capabilities extended: `anthropicMessages`
  (native|translated|unsupported), `anthropicTokenCount`, `thinking`,
  `documents`, `betas`, `anthropicVersion`, `messagesPath`, `countTokensPath`.
- Proxy auth now accepts `x-api-key` (constant-time compared) alongside
  Bearer; Anthropic paths return Anthropic-shaped 401s.

## 4. Native Anthropic Behavior

- Requests forwarded verbatim to `GET-messages-path` endpoint after strict
  structural validation; `thinking`/`documents`/image blocks gated by caps via
  `UnsupportedFieldError` (zero-cost provider skip, never an attempt).
- Upstream auth: `x-api-key: <provider-key>` + configured `anthropic-version`;
  `anthropic-beta` only when `betas=true`.
- Responses relayed without OpenAI conversion; validated pre-commit (must be
  `{type:'message', id, role:'assistant', content[]}`) — malformed upstream
  output fails over instead of being forwarded.
- SSE relayed byte-passthrough with backpressure; unknown event types pass
  through; post-commit timeout/error injects exactly one `error` event and
  never fabricates `message_stop`.

## 5. Translated Anthropic Behavior

- system (string/blocks) → system message; text/image/tool_use/tool_result
  blocks → chat content (`image_url` data URLs, `tool_calls`, `tool` messages)
  with IDs and ordering preserved; `max_tokens` direct; `stop_sequences` →
  `stop`; tool_choice auto/any/tool mapped (`any` → `required`).
- Requests hit `/v1/chat/completions`; responses synthesized into Anthropic
  Messages with generated `msg_*` ids; `finish_reason` mapped stop→end_turn,
  length→max_tokens, tool_calls→tool_use; `stop_sequence` never guessed.
- `top_k`, thinking, documents, tool-result `is_error`, image-in-tool-result:
  rejected with `unsupported_parameter` (routed to capable providers first) —
  never dropped, never emulated, usage never invented (absent → `null`).

## 6. Supported Request/Content Fields

`model`, `messages` (user/assistant; string or blocks), `max_tokens`,
`system`, `stream`, `temperature`, `top_p`, `top_k` (capability-gated),
`stop_sequences`, `tools`, `tool_choice` (auto/any/tool), `metadata.user_id`,
`service_tier`, `thinking` (capability-gated); blocks: `text`, `image`
(base64/url), `tool_use`, `tool_result`, `thinking`/`redacted_thinking`
(thinking-gated), `document` (documents-gated). Roles beyond user/assistant,
unknown blocks, bad schemas, bad ranges → Anthropic-shaped 400 with field path.

## 7. Streaming Behavior

Shared `pumpStream` core (deadlines, cancellation, backpressure, cleanup).
Translated mode emits the exact lifecycle from chat deltas: `message_start`
(at commit) → block events → `message_delta` (stop_reason + mapped usage) →
`message_stop`. Tool arguments stream as `input_json_delta.partial_json`
fragments whose concatenation is the final input. `[DONE]` and Responses
event names never leak. Inactivity/overall timeouts post-commit → one
`error` event, never a fabricated `message_stop`, never a second generation.

## 8. Token-Count Behavior

`/v1/messages/count_tokens`: native providers only; body forwarded without
`stream`/`max_tokens`; response validated (`input_tokens` numeric) pre-commit
with failover on malformed output; key rotation and provider failover reuse
the shared loop; translated-only setups return an explicit Anthropic error —
counts are never estimated.

## 9. Unsupported Behavior (explicit, never silent)

- `thinking`/documents/`top_k`/beta-only features on incapable providers →
  capable provider selected without consuming an attempt; else 400 naming the
  field
- count_tokens without a native-capable provider → explicit error (no estimate)
- Unknown models → Anthropic 404 `not_found_error`; version-invalid → 400;
  oversized → 413 `request_too_large`; invalid JSON → 400

## 10. Files Moved / Created / Modified / Removed

- Moved: all 24 tracked files (root → src/test/docs layout, see §2)
- Created: `src/core/http-utils.js`, `src/formats/{anthropic-errors,anthropic-request,anthropic-response,anthropic-stream,unsupported-field}.js`,
  `src/api/{chat-completions,responses,anthropic-messages}.js`,
  `test/integration/anthropic-messages.test.js`, `docs/BUILD3-REPORT.md`
- Modified: `providers/base.js` (capabilities/headers/endpoints), `providers/index.js`
  (API-aware failover unchanged — capability checks via `supportsApi`),
  `core/router.js` (modularized + hooks), `core/upstream.js` (headers param),
  `test/helpers/mock-upstream.js` (Anthropic behaviors), README, .env.example,
  package.json, config.js (docs/paths)
- Removed: none (moves only); obsolete root layout replaced

## 11–12. Test Totals & Five Consecutive Runs

Suites: Chat **52**, Responses **45**, Anthropic **72** → **169 total**.
Five consecutive combined runs (`npm test` now runs all three):

```
run 1: 52 passed, 45 passed, 72 passed
run 2: 52 passed, 45 passed, 72 passed
run 3: 52 passed, 45 passed, 72 passed
run 4: 52 passed, 45 passed, 72 passed
run 5: 52 passed, 45 passed, 72 passed
```

(Exact per-run outputs are in the git history transcript; no test was skipped,
weakened or deleted. Coverage includes the spec's test list: organization
invariants, auth/headers, native, translated, streaming safety, rotation/
failover, validation, token counting.)

## 13. Syntax Checks

`node --check` over all 26 JS files: **all pass**.

## 14. Runtime Dependencies

**0** — Node built-ins only.

## 15. Version

`seven-proxy@0.3.0` (early development: Build 3/10). No stable tag created.

## 16. Curl Examples

See README ("Anthropic Messages API") or:

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

# Translated (chat-only upstream; unsupported fields name themselves)
curl -s -X POST http://localhost:8080/v1/messages \
  -H "content-type: application/json" -H "x-api-key: your-proxy-key" \
  -d '{"model":"claude-sonnet-4","max_tokens":64,"messages":[{"role":"user","content":"Hi"}],"thinking":{"type":"enabled","budget_tokens":512}}'
```

## 17. Git Commits

- `91cd75c` — `chore: organize source and test structure` (pushed in Phase 2)
- Build 3 feature commit: `feat: add Anthropic Messages API support` (this push)

## 18. Push Verification

After push: `git status` clean; `git rev-parse HEAD` == `git rev-parse origin/main`.

## 19. Secret Scan

Scanned HEAD tree + staged diff (`sk-*`, `ghp_*`/`gho_*`, `AKIA`, private
keys, bearer tokens): only placeholders (`sk-your-key-*`, mock keys like
`ant-k1`). No `.env`, no real credentials, no authorization headers, no logs
or runtime data committed.

## 20. Remaining Limitations

- Token counting is native-only by design (no exact tokenizer for translated
  providers; character estimation is deliberately not implemented)
- Translated mode cannot preserve `thinking`/`documents`/`top_k`/prompt
  caching/beta features (routed away or rejected — never degraded silently)
- `count_tokens` has no response-streaming semantics to relay beyond the
  validated JSON object; usage-cache fields pass through natively only
- No Anthropic admin/batch/file endpoints (out of scope per spec)
- Early build: not stable; API surface may change through Build 10