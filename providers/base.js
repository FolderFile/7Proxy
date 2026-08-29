/**
 * Base provider - defines the provider interface.
 * Default behaviour is OpenAI-compatible pass-through.
 *
 * Capabilities:
 *   chatCompletions - provider serves POST /v1/chat/completions
 *   responses       - 'native'     upstream implements POST /v1/responses
 *                     'translated'  proxy translates Responses<->Chat Completions
 *                     'unsupported' provider cannot serve the Responses API
 *   tools           - function tools supported
 *   vision          - image inputs supported
 *   reasoning       - reasoning parameters/fields supported
 */

/**
 * Normalize a capability declaration. Unknown values are coerced safely.
 */
export function normalizeCapabilities(caps = {}) {
  const responses = caps.responses;
  const validResponses = responses === 'native' || responses === 'translated' || responses === 'unsupported';
  return {
    chatCompletions: caps.chatCompletions !== false,
    responses: validResponses ? responses : 'unsupported',
    tools: caps.tools !== false,
    vision: caps.vision !== false,
    reasoning: caps.reasoning === true,
    metadata: typeof caps.metadata === 'boolean' ? caps.metadata : undefined,
    serviceTier: caps.serviceTier !== false,
    previousResponseId: caps.previousResponseId === true,
    store: caps.store !== false,
    truncation: caps.truncation === true,
    textFormat: caps.textFormat === true
  };
}

export function createProvider(config) {
  const baseUrl = (config.baseUrl || '').replace(/\/$/, '');
  const capabilities = normalizeCapabilities(config.capabilities);

  return {
    name: config.name,
    baseUrl,
    apiKeys: [...(config.apiKeys || [])],
    models: [...(config.models || [])],
    capabilities,

    /** Chat completions endpoint. */
    getChatEndpoint() {
      return `${this.baseUrl}/v1/chat/completions`;
    },

    /** Responses endpoint (only meaningful when capabilities.responses === 'native'). */
    getResponsesEndpoint() {
      return `${this.baseUrl}/v1/responses`;
    },

    /** Models endpoint. */
    getModelsEndpoint() {
      return `${this.baseUrl}/v1/models`;
    },

    /** Build upstream request headers. */
    buildHeaders(apiKey) {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        // Disable transparent decompression so streaming bytes are raw SSE.
        'Accept-Encoding': 'identity'
      };
    },

    supportsModel(model) {
      return this.models.includes(model);
    },

    /** Can this provider serve the given API format for the given body? */
    supportsApi(api, body = {}) {
      if (api === 'chat') {
        return this.capabilities.chatCompletions === true;
      }
      if (api === 'responses') {
        const mode = this.capabilities.responses;
        if (mode === 'native') {
          // A provider with native Responses support may still be unusable if
          // the request carries fields it cannot serve (e.g. reasoning).
          const caps = this.capabilities;
          if (body.reasoning && !caps.reasoning) return false;
          return true;
        }
        return mode === 'translated';
      }
      return false;
    }
  };
}

export default createProvider;