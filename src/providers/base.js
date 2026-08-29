/**
 * Base provider - defines the provider interface.
 * Default behaviour is OpenAI-compatible pass-through.
 *
 * Capabilities (normalized by normalizeCapabilities):
 *   chatCompletions   - provider serves POST /v1/chat/completions (boolean)
 *   responses         - 'native'     upstream implements POST /v1/responses
 *                       'translated' proxy translates Responses<->Chat Completions
 *                       'unsupported' provider cannot serve the Responses API
 *   anthropicMessages - 'native'     upstream implements Anthropic /v1/messages
 *                       'translated' proxy translates Messages->Chat Completions
 *                       'unsupported' provider cannot serve the Messages API
 *   anthropicTokenCount - 'native' upstream implements /v1/messages/count_tokens
 *                       (translated counting is not implemented: no exact
 *                        tokenizer exists; estimation is not attempted)
 *   tools             - function tools supported
 *   vision            - image inputs supported
 *   documents         - PDF/document blocks supported (native Anthropic only)
 *   thinking          - extended-thinking field/blocks supported (native only)
 *   betas             - anthropic-beta header may be forwarded (native only)
 *   anthropicVersion  - Anthropic version string to send upstream (native only)
 *   messagesPath      - override for the native Messages endpoint path
 *   countTokensPath   - override for the native token-count endpoint path
 */

const RESPONSE_MODES = new Set(['native', 'translated', 'unsupported']);

/** Validate a mode-valued capability (native | translated | unsupported). */
function normalizeMode(value) {
  return RESPONSE_MODES.has(value) ? value : 'unsupported';
}

/**
 * Normalize a capability declaration. Unknown values are coerced safely.
 */
export function normalizeCapabilities(caps = {}) {
  const responses = caps.responses;
  const validResponses = responses === 'native' || responses === 'translated' || responses === 'unsupported';
  const messages = caps.anthropicMessages ?? caps.anthropicmessages;
  const validMessages = messages === 'native' || messages === 'translated';
  const tokenCount = caps.anthropicTokenCount ?? caps.anthropictokencount;
  const validTokenCount = tokenCount === 'native';
  return {
    chatCompletions: caps.chatCompletions !== false,
    responses: validResponses ? responses : 'unsupported',
    anthropicMessages: validMessages ? messages : 'unsupported',
    anthropicTokenCount: validTokenCount ? 'native' : 'unsupported',
    tools: caps.tools !== false,
    vision: caps.vision !== false,
    reasoning: caps.reasoning === true,
    metadata: typeof caps.metadata === 'boolean' ? caps.metadata : undefined,
    serviceTier: caps.serviceTier !== false,
    previousResponseId: caps.previousResponseId === true,
    store: caps.store !== false,
    truncation: caps.truncation === true,
    textFormat: caps.textFormat === true,
    // Anthropic-specific.
    thinking: caps.thinking === true,
    documents: caps.documents === true,
    betas: caps.betas === true,
    anthropicVersion: typeof caps.anthropicVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(caps.anthropicVersion)
      ? caps.anthropicVersion : undefined,
    messagesPath: typeof caps.messagesPath === 'string' && caps.messagesPath.startsWith('/')
      ? caps.messagesPath : undefined,
    countTokensPath: typeof caps.countTokensPath === 'string' && caps.countTokensPath.startsWith('/')
      ? caps.countTokensPath : undefined
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

    /** Native Anthropic Messages endpoint. */
    getMessagesEndpoint() {
      return `${this.baseUrl}${this.capabilities.messagesPath || '/v1/messages'}`;
    },

    /** Native Anthropic token-count endpoint. */
    getCountTokensEndpoint() {
      return `${this.baseUrl}${this.capabilities.countTokensPath || '/v1/messages/count_tokens'}`;
    },

    /** Models endpoint. */
    getModelsEndpoint() {
      return `${this.baseUrl}/v1/models`;
    },

    /**
     * Build upstream request headers. The proxy NEVER forwards client
     * authentication: headers are constructed exclusively from the provider's
     * own key entry and configuration.
     */
    buildHeaders(apiKey, api = 'chat', extraHeaders = {}) {
      const base = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // Disable transparent decompression so streaming bytes are raw SSE.
        'Accept-Encoding': 'identity'
      };
      if (api === 'anthropic-messages' || api === 'anthropic-token-count') {
        // Anthropic-native authentication and versioning.
        return {
          ...base,
          'x-api-key': apiKey,
          'anthropic-version': extraHeaders['anthropic-version'] || this.capabilities.anthropicVersion || '2023-06-01',
          ...(extraHeaders['anthropic-beta'] ? { 'anthropic-beta': extraHeaders['anthropic-beta'] } : {}),
          ...extraHeaders.safe
        };
      }
      return {
        ...base,
        'Authorization': `Bearer ${apiKey}`,
        ...extraHeaders.safe
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
      if (api === 'anthropic-messages') {
        // Field-level capability gaps are enforced by prepareBody via
        // UnsupportedFieldError (zero-cost provider skip), so this is only
        // the coarse mode check.
        return this.capabilities.anthropicMessages !== 'unsupported';
      }
      if (api === 'anthropic-token-count') {
        // Only native counting exists; the proxy never estimates.
        return this.capabilities.anthropicTokenCount === 'native';
      }
      return false;
    }
  };
}

export default createProvider;