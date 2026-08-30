# Build 4 Report: Configurable Model Routing

**Project:** 7Proxy (`seven-proxy@0.4.0`) — zero-dependency AI proxy
**Status:** early development release (Build 4 of 8) — not stable
**Commit:** `d945a42` (`feat: add configurable model routing`)
**Baseline:** `fc82e4a` == `origin/main`, clean tree, 169/169, syntax clean

## Configuration Schema

Two sources, converging on one validated internal shape:

1. **JSON file** (new): `config/7proxy.json`, override with
   `SEVEN_PROXY_CONFIG`. Priority `SEVEN_PROXY_CONFIG` > default file >
   env-only. Contains `providers` (type/baseUrl/keys/capabilities/models),
   optional `models` (public name → provider+`upstreamModel` pins), optional
   `aliases` (to model/alias/group; multi-level chains allowed), optional
   `groups` (strategy + provider-model targets, optional weights), optional
   `server` (timing overrides; env vars still win for server settings).
2. **Environment-only** (legacy, unchanged): `OPENAI_*`, `ANTHROPIC_*`,
   `ALT_*` slots with `*_CAPABILITIES`.

Keys are always `{ "env": "VAR" }` references; inline secrets in file configs
are rejected at startup. Example: `config/7proxy.example.json` (safe URLs;
datacenter1/datacenter2 carrying the requested model vocabulary:
minimax-m3, glm-5.2, deepseek_v4_pro, deepseek-v4-flash,
qwen3.8-27b-abliterated-nvfp4, hy3-heretic-bf16, kimi-k27-bf16,
kimi-k2.7-code — plus an anthropic-compatible slot, `coding`/`fast` aliases
and smart/fast/balanced groups).

## Strict Validation (startup, path-naming, value-free)

Unknown provider type; invalid or non-HTTPS base URL (localhost relaxation
requires `ALLOW_INSECURE_UPSTREAM=true`); provider without models/keys;
missing referenced env var (`{env}` naming the variable only); duplicate
provider ids/targets; model or group targeting unknown providers; upstream
model not offered by target provider; dangling alias targets; alias cycles;
empty groups; invalid strategies (`fallback|round-robin|random|
weighted-random`); invalid capabilities (strict whitelist); invalid
timeouts/retries/cooldown/weights (positive finite weights); unsafe
identifiers (letters/digits/`._:@~+/--`, no dot-segments); forbidden keys
(`__proto__`/`prototype`/`constructor`) anywhere in the tree; ambiguous
public names (model/alias/group collisions). Parsed config is deep-frozen.
Identifiers may contain only a safe character class — no URL/header smuggling.

## Provider Adapter Registry

`src/providers/registry.js`: two adapters — `openai-compatible`
(Bearer; chat natively; Responses/Anthropic per capability mode) and
`anthropic-compatible` (`x-api-key` + `anthropic-version`; Messages
natively; chat/responses never native). Endpoints built with the `URL` API
(`apiEndpoint`): trailing slash and existing `/v1` tolerated, never doubled;
query preserved. Adapters own endpoint construction, auth header shape,
capability defaults and API support; `runWithFailover` calls
`provider.getEndpointFor(api)`/`buildHeaders(key, api, extra)` with **no
per-provider-name conditions in the router**. Inbound credentials never
upstream: the adapter builder takes the provider key entry only.

## Model Registry

`src/models/registry.js` builds once at startup from validated/frozen config:
derived provider models, explicit pinned entries, resolved alias chains,
groups; ambiguity across models/aliases/groups rejected (explicit entry over
a same-named provider model is the documented refinement, not ambiguity).
`resolve(name)` → `{requested, kind: model|alias|group, resolvedName,
strategy, targets:[{provider, model, weight}]}`; `resolvePlan` adds
capability filtering and the strategy-ordered finite plan.
`GET /v1/models` / `/v1/models/:id` list public names (direct models,
aliases, groups; alias/group entries carry `metadata.kind`) — never provider
ids, keys, env names, base URLs or health state; unknown ids keep the
compatible 404 shape.

## Routing Strategies

- **fallback** — declared order (capability-filtered).
- **round-robin** — rotating start via a registry-owned counter
  (concurrency-safe on the event loop; config arrays never mutated).
- **random** — rotating-seed deterministic shuffle of the eligible set.
- **weighted-random** — cumulative-weight first pick (positive finite weights
  enforced by the validator; NaN/Infinity cannot survive JSON but are also
  rejected), remainder completes a duplicate-free rotating plan; injected
  seed gives exact deterministic plans for tests.

Every plan is finite (≤ declared targets). Key walk (round-robin start per
provider) and the global attempt budget (`config.maxAttempts` ≤ 20) remain
authoritative in the loop — an 8-target group with `MAX_ATTEMPTS=3` makes
exactly 3 upstream calls (tested). No retry after output commitment.

## Capability Filtering

Pre-attempt (zero cost): mode support via `supportsApi` plus body-implied
needs — chat tools array, chat `image_url` parts, Responses `tools`/`reasoning`
and `input_image`; Anthropic image blocks; token counting selects
native-count targets only. Anthropic field-level gaps (thinking/documents on
translated providers) still throw `UnsupportedFieldError` in `prepareBody`
(precise field-named errors, zero upstream calls — preserved semantics of
Build 3). If no target qualifies: protocol-native error (Responses →
`unsupported_endpoint` 400; Anthropic → its 404/error shape), zero attempts.

## Model Rewriting

`prepareBody: (provider, upstreamModel)` in every API edge builds a **fresh**
upstream body with `model` = the target's upstream id — client objects are
never mutated (asserted in tests). Applies to `/v1/chat/completions`,
`/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`
(`max_tokens`/`stream` still never forwarded to counting). Translated
responses report the public requested model (`publicModel` preference in
translators and stream-translator bootstrap); Anthropic-native passthrough
forwards the same id verbatim (documented). Errors never reveal internal ids.

## Files Changed

**New:** `src/config/{loader,validator}.js`, `src/models/{registry,routing,
routing-utils,strategies,model-introspection}.js`, `src/providers/registry.js`,
`config/7proxy.example.json`, `test/integration/routing.test.js`.
**Modified:** `src/core/config.js` (file-mode + priority + validation hooks),
`src/core/router.js` (target/lanes plan, per-target model, adapter-delegated
endpoints/headers, public introspection), `src/api/*` (existence checks via
routing registry, rewriting, pre-flight zero-attempt filters, public-model
reporting), `src/providers/base.js` (shared `__bareHeaderBuilder`), `src/app.js`
(routing bootstrap), `test/helpers/mock-upstream.js` (`json-echo-object`,
`message-echo-model` behaviors), README, `.env.example`, `.gitignore`
(ignores `config/7proxy.json`), `package.json` (0.4.0, 4-suite test script).

## Tests

- New `test/integration/routing.test.js`: **43 tests** — file loading/explicit
  path/env backward compat, 16 negative validation cases (invalid JSON,
  missing env var, bad URL/type/references/identifiers, `__proto__`, cycles,
  empty groups, strategies, weights, inline secret rejection, ambiguity),
  alias/group resolution incl. multi-level chains, fallback ordering with
  exact key order assertions, in-target key rotation + never-forwarded client
  auth, attempt budget vs large group, round-robin order + concurrency +
  file immutability, deterministic weighted/random checks + live traffic,
  model rewriting on all four surfaces (client-object non-mutation asserted),
  native adapter auth shape, capability skipping with zero-attempt asserts,
  public models listing with no private details, URL normalization,
  no-host-override, no-retry-after-commitment.
- Combined suite: **212 tests** (52 chat + 45 responses + 72 anthropic +
  43 routing). All 169 prior tests unchanged and passing.

## Three Consecutive Combined Runs

```
run 1: 52 passed | 45 passed | 72 passed | 43 passed
run 2: 52 passed | 45 passed | 72 passed | 43 passed
run 3: 52 passed | 45 passed | 72 passed | 43 passed
```

## Syntax, Dependencies, Live Verification

- `node --check`: all 32 JS files pass.
- Runtime deps: **0** (only `fs`/`http`/`path`/`url` built-ins imported).
- Live run with `config/7proxy.example.json` (providers repointed to a local
  mock; keys via env): direct model routed with rewritten upstream id;
  `coding` alias → group first target (`glm-5.2`); `fast` → round-robin
  group target (`deepseek-v4-flash`); `/v1/models` listed all 8 public
  datacenter models + claude-sonnet-4 + 5 aliases/groups with no private
  fields; unknown model 404. Cross-target fallback after failure is covered
  by integration tests 22–23 with exact request counts.

## Git / Push / Secrets

- Commit `d945a42` pushed `fc82e4a..d945a42 main -> main` (fast-forward);
  `HEAD == origin/main`; working tree clean.
- Staged diff scanned (`sk-*`, `ghp_*`, `AKIA`, private keys): only test
  fixtures; high-entropy matches 0. Only `config/7proxy.example.json`
  committed; the real `config/7proxy.json` is git-ignored and absent.

## Remaining Limitations

- No Gemini adapter yet (spec: next builds).
- Groups are flat (targets are provider models; nesting via aliases only).
- Weights validated positive-finite; JSON cannot encode NaN/Infinity so those
  classes are structurally excluded from file configs (unit-level boundary
  covered in strategies).
- Legacy env mode keeps implicit owner-first failover (toggle:
  `ENFORCE_EXPLICIT_GROUPS=true`) for backward compatibility; file mode is
  strictly explicit.
- Early build: not stable; interfaces may change through Build 8.