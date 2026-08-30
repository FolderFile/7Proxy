/**
 * Provider adapter registry (Build 4).
 *
 * Adapters own everything provider-TYPE-specific so the router never grows
 * per-provider conditions:
 *   - endpoint construction (URL-safe, trailing-slash and /v1 agnostic)
 *   - authentication header construction (from the provider key only)
 *   - capability defaults per type
 *   - request/response format selection (per API mode)
 *
 * Supported types this build: 'openai-compatible', 'anthropic-compatible'.
 * Gemini is intentionally not implemented yet.
 *
 * Inbound client credentials are NEVER forwarded: adapters build upstream
 * authentication exclusively from the resolved provider key entry.
 */

import { createProvider, normalizeCapabilities, __bareHeaderBuilder } from './base.js';

/**
 * Build an absolute endpoint URL from a base URL and an endpoint path.
 * Uses the URL API (never string concat), tolerant of:
 *   - trailing slash on the base       ("https://h/v1/" == "https://h/v1")
 *   - an existing /v1 on the base      (no double /v1)
 *   - paths with or without a leading slash
 * Returns the URL string, or null when the base is not a valid URL.
 */
export function apiEndpoint(baseUrl, endpointPath) {
  let u;
  try {
    u = new URL(String(baseUrl));
  } catch {
    return null;
  }
  const segments = u.pathname.split('/').filter(Boolean);
  const suffix = String(endpointPath).split('/').filter(Boolean);
  // Avoid doubling the trailing /v1 segment when the endpoint path repeats it.
  const merged = (segments.length > 0 && segments[segments.length - 1] === 'v1'
    && suffix.length > 0 && suffix[0] === 'v1')
    ? [...segments, ...suffix.slice(1)]
    : [...segments, ...suffix];
  const out = new URL(u.origin);
  out.pathname = '/' + merged.join('/');
  // Preserve any query/hash from the base (rare, but deterministic).
  out.search = u.search;
  return out.href;
}

const ADAPTERS = new Map();

/**
 * openai-compatible: chat completions natively; Responses/Anthropic per
 * capability mode (native endpoints exist only when declared).
 */
ADAPTERS.set('openai-compatible', {
  type: 'openai-compatible',
  capabilities: normalizeCapabilities({}),
  getEndpoint(provider, api) {
    switch (api) {
      case 'responses':
        return provider.capabilities.responses === 'native'
          ? apiEndpoint(provider.baseUrl, '/v1/responses')
          : apiEndpoint(provider.baseUrl, '/v1/chat/completions');
      case 'anthropic-messages':
        return provider.capabilities.anthropicMessages === 'native'
          ? apiEndpoint(provider.baseUrl, provider.capabilities.messagesPath || '/v1/messages')
          : apiEndpoint(provider.baseUrl, '/v1/chat/completions');
      case 'anthropic-token-count':
        return apiEndpoint(provider.baseUrl, provider.capabilities.countTokensPath || '/v1/messages/count_tokens');
      case 'chat':
      default:
        return apiEndpoint(provider.baseUrl, '/v1/chat/completions');
    }
  },
  buildHeaders(provider, apiKey, api, extra = {}) {
    // Delegates to the bare builder (never to provider.buildHeaders, which is
    // adapter-delegated and would recurse).
    return __bareHeaderBuilder(apiKey, api, extra, provider.capabilities);
  },
  supportsApi(provider, api, body) {
    return provider.supportsApi(api, body);
  }
});

/**
 * anthropic-compatible: the upstream speaks the Anthropic Messages protocol.
 *  - generation:  POST {base}/v1/messages
 *  - token count: POST {base}/v1/messages/count_tokens
 *  - authentication: x-api-key + anthropic-version (never Bearer upstream)
 *  - chat/responses surfaces are never native on this type
 */
ADAPTERS.set('anthropic-compatible', {
  type: 'anthropic-compatible',
  capabilities: normalizeCapabilities({
    chatCompletions: false,
    responses: 'unsupported',
    anthropicMessages: 'native',
    anthropicTokenCount: 'native',
    tools: true,
    vision: true,
    thinking: false,
    documents: false,
    betas: false
  }),
  getEndpoint(provider, api) {
    switch (api) {
      case 'anthropic-token-count':
        return apiEndpoint(provider.baseUrl, provider.capabilities.countTokensPath || '/v1/messages/count_tokens');
      case 'anthropic-messages':
      case 'responses':
      case 'chat':
      default:
        return apiEndpoint(provider.baseUrl, provider.capabilities.messagesPath || '/v1/messages');
    }
  },
  buildHeaders(provider, apiKey, api, extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'identity',
      'x-api-key': apiKey,
      'anthropic-version': extra['anthropic-version'] || provider.capabilities.anthropicVersion || '2023-06-01'
    };
    if (provider.capabilities.betas === true && extra['anthropic-beta']) {
      headers['anthropic-beta'] = String(extra['anthropic-beta']).slice(0, 512);
    }
    return headers;
  },
  supportsApi(provider, api, body) {
    if (api === 'anthropic-messages') return provider.capabilities.anthropicMessages !== 'unsupported';
    if (api === 'anthropic-token-count') return provider.capabilities.anthropicTokenCount === 'native';
    // Chat/Responses requests are never native on an Anthropic upstream.
    return false;
  }
});

/** Look up an adapter by provider type. */
export function getAdapter(type) {
  return ADAPTERS.get(type) || null;
}

/** All registered adapter type names. */
export function adapterTypes() {
  return [...ADAPTERS.keys()];
}

export function registerAdapter(type, adapter) {
  ADAPTERS.set(type, adapter);
}

/**
 * Create a provider object from a validated provider spec. The result has the
 * same shape the transport core already uses, extended with `providerType`
 * and adapter-delegated endpoint/header methods.
 */
export function createProviderFromSpec(spec) {
  const adapter = ADAPTERS.get(spec.providerType);
  if (!adapter) {
    throw new Error(`no provider adapter registered for type '${spec.providerType}'`);
  }
  const provider = createProvider({
    name: spec.name,
    baseUrl: spec.baseUrl.replace(/\/+$/, ''),
    apiKeys: spec.apiKeys,
    models: spec.models,
    capabilities: mergeCapabilities(adapter.capabilities, spec.capabilities)
  });
  provider.providerType = spec.providerType;

  // Endpoint + header construction always goes through the adapter so the
  // router and API edges never branch on provider type or provider name.
  provider.getEndpointFor = (api) => adapter.getEndpoint(provider, api);
  provider.getChatEndpoint = () => adapter.getEndpoint(provider, 'chat');
  provider.getResponsesEndpoint = () => adapter.getEndpoint(provider, 'responses');
  provider.getMessagesEndpoint = () => adapter.getEndpoint(provider, 'anthropic-messages');
  provider.getCountTokensEndpoint = () => adapter.getEndpoint(provider, 'anthropic-token-count');
  provider.buildHeaders = (apiKey, api = 'chat', extra = {}) =>
    adapter.buildHeaders(provider, apiKey, api, extra);

  provider.adapter = adapter;
  Object.freeze(provider.models);
  Object.freeze(provider.apiKeys);
  return provider;
}

function mergeCapabilities(adapterCaps, declared) {
  // Declared (validated) values win; adapter defaults fill the rest.
  return { ...adapterCaps, ...(declared || {}) };
}

export default { getAdapter, adapterTypes, registerAdapter, createProviderFromSpec };