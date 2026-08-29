/**
 * Anthropic Messages -> Chat Completions request translation (Build 3).
 *
 * Protocol edge responsibilities:
 *  - validateAnthropicMessages(): structural validation independent of any
 *    provider. Throws InvalidAnthropicRequest with the exact field path.
 *  - translateAnthropicRequest(): Anthropic Messages -> Chat Completions
 *    translation for providers whose anthropicMessages capability is
 *    'translated'. Throws UnsupportedFieldError for fields the provider
 *    cannot represent (the failover loop treats this as a zero-cost skip).
 *  - validateNativeAnthropicBody(): native-mode gating; the body forwards
 *    verbatim except fields the provider cannot preserve.
 *
 * The caller's parsed request object is never mutated. No field or content
 * block is ever silently discarded: either a lossless mapping exists, another
 * capable provider is selected, or an explicit unsupported error is returned.
 */

import { UnsupportedFieldError } from './unsupported-field.js';

/** Structural (provider-independent) validation failure. */
export class InvalidAnthropicRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAnthropicRequest';
  }
}

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function invalid(path, message) {
  return new InvalidAnthropicRequest(`${path}: ${message}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Validate an image source block. */
function validateImageSource(block, path) {
  const src = block.source;
  if (!isPlainObject(src)) throw invalid(path, 'image block requires a source object');
  if (src.type === 'base64') {
    if (typeof src.media_type !== 'string' || !IMAGE_MEDIA_TYPES.has(src.media_type)) {
      throw invalid(path, `image source media_type must be one of ${[...IMAGE_MEDIA_TYPES].join(', ')}`);
    }
    if (typeof src.data !== 'string' || src.data.length === 0) {
      throw invalid(path, 'image base64 source requires a data string');
    }
  } else if (src.type === 'url') {
    if (typeof src.url !== 'string' || !/^https?:\/\//.test(src.url)) {
      throw invalid(path, 'image url source requires an http(s) url');
    }
  } else {
    throw invalid(path, `unsupported image source type '${src.type}'`);
  }
}

/**
 * Validate one content block (helper for structural validation).
 * Unknown types are rejected (never silently dropped).
 */
function validateContentBlock(block, path) {
  if (!isPlainObject(block) || typeof block.type !== 'string') {
    throw invalid(path, 'content block must be an object with a type field');
  }
  switch (block.type) {
    case 'text':
      if (typeof block.text !== 'string') throw invalid(path, 'text block requires a string text field');
      return 'text';
    case 'image':
      validateImageSource(block, path);
      return 'image';
    case 'tool_use':
      if (typeof block.id !== 'string' || !block.id) throw invalid(path, 'tool_use block requires an id');
      if (typeof block.name !== 'string' || !block.name) throw invalid(path, 'tool_use block requires a name');
      if (block.input !== undefined && !isPlainObject(block.input)) {
        throw invalid(path, 'tool_use input must be an object');
      }
      return 'tool_use';
    case 'tool_result': {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) {
        throw invalid(path, 'tool_result block requires a tool_use_id');
      }
      if (block.content !== undefined) {
        if (typeof block.content !== 'string' && !Array.isArray(block.content)) {
          throw invalid(path, 'tool_result content must be a string or an array of content blocks');
        }
        if (Array.isArray(block.content)) {
          block.content.forEach((b, i) => {
            if (!isPlainObject(b) || (b.type !== 'text' && b.type !== 'image')) {
              throw invalid(`${path}.content[${i}]`, 'tool_result content blocks must be text or image');
            }
            if (b.type === 'image') validateImageSource(b, `${path}.content[${i}]`);
          });
        }
      }
      return 'tool_result';
    }
    case 'thinking':
      if (typeof block.thinking !== 'string') throw invalid(path, 'thinking block requires a string thinking field');
      return 'thinking';
    case 'redacted_thinking':
      if (typeof block.data !== 'string') throw invalid(path, 'redacted_thinking block requires a string data field');
      return 'redacted_thinking';
    case 'document':
      return 'document';
    default:
      throw invalid(path, `unsupported content block type '${block.type}'`);
  }
}

/**
 * Full structural validation of an Anthropic Messages request.
 * @throws {InvalidAnthropicRequest}
 */
export function validateAnthropicMessages(body) {
  if (!isPlainObject(body)) throw invalid('body', 'must be a JSON object');

  if (!body.model || typeof body.model !== 'string') {
    throw invalid('model', 'must be a non-empty string');
  }
  if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    throw invalid('max_tokens', 'must be a positive integer');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid('messages', 'must be a non-empty array');
  }

  body.messages.forEach((msg, i) => {
    const path = `messages[${i}]`;
    if (!isPlainObject(msg)) throw invalid(path, 'must be an object');
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      throw invalid(`${path}.role`, `must be 'user' or 'assistant' (got '${msg.role}')`);
    }
    if (typeof msg.content === 'string') {
      if (msg.content.length === 0) throw invalid(`${path}.content`, 'must not be empty');
    } else if (Array.isArray(msg.content)) {
      if (msg.content.length === 0) throw invalid(`${path}.content`, 'must not be empty');
      msg.content.forEach((b, j) => validateContentBlock(b, `${path}.content[${j}]`));
    } else {
      throw invalid(`${path}.content`, 'must be a string or an array of content blocks');
    }
  });

  // system: string or array of text blocks (never treated as a user message).
  if (body.system !== undefined && body.system !== null) {
    if (typeof body.system !== 'string' && !Array.isArray(body.system)) {
      throw invalid('system', 'must be a string or an array of content blocks');
    }
    if (Array.isArray(body.system)) {
      body.system.forEach((b, i) => {
        if (!isPlainObject(b) || b.type !== 'text' || typeof b.text !== 'string') {
          throw invalid(`system[${i}]`, 'system blocks must be text blocks');
        }
      });
    }
  }

  if (body.temperature !== undefined && body.temperature !== null
      && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 1)) {
    throw invalid('temperature', 'must be a number between 0 and 1');
  }
  if (body.top_p !== undefined && body.top_p !== null
      && (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1)) {
    throw invalid('top_p', 'must be a number between 0 and 1');
  }
  if (body.top_k !== undefined && body.top_k !== null
      && (typeof body.top_k !== 'number' || !Number.isInteger(body.top_k) || body.top_k < 1)) {
    throw invalid('top_k', 'must be a positive integer');
  }
  if (body.stop_sequences !== undefined && body.stop_sequences !== null) {
    if (!Array.isArray(body.stop_sequences) || body.stop_sequences.some(s => typeof s !== 'string')) {
      throw invalid('stop_sequences', 'must be an array of strings');
    }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw invalid('stream', 'must be a boolean');
  }
  if (body.metadata !== undefined && body.metadata !== null && !isPlainObject(body.metadata)) {
    throw invalid('metadata', 'must be an object');
  }
  if (body.service_tier !== undefined && body.service_tier !== null
      && body.service_tier !== 'auto' && body.service_tier !== 'standard') {
    throw invalid('service_tier', "must be 'auto' or 'standard'");
  }

  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) throw invalid('tools', 'must be an array');
    body.tools.forEach((t, i) => {
      if (!isPlainObject(t)) throw invalid(`tools[${i}]`, 'must be an object');
      if (typeof t.name !== 'string' || !t.name) throw invalid(`tools[${i}].name`, 'must be a non-empty string');
      if (t.description !== undefined && typeof t.description !== 'string') {
        throw invalid(`tools[${i}].description`, 'must be a string');
      }
      if (!isPlainObject(t.input_schema)) throw invalid(`tools[${i}].input_schema`, 'must be a JSON schema object');
      if (t.input_schema.type !== 'object') {
        throw invalid(`tools[${i}].input_schema.type`, "tool input schemas must be of type 'object'");
      }
    });
  }

  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    if (!isPlainObject(body.tool_choice)) throw invalid('tool_choice', 'must be an object');
    const tc = body.tool_choice;
    if (tc.type === 'tool') {
      if (typeof tc.name !== 'string' || !tc.name) {
        throw invalid('tool_choice.name', "tool_choice type 'tool' requires a tool name");
      }
    } else if (tc.type !== 'auto' && tc.type !== 'any') {
      throw invalid('tool_choice.type', "must be 'auto', 'any' or 'tool'");
    }
  }

  if (body.thinking !== undefined && body.thinking !== null && !isPlainObject(body.thinking)) {
    throw invalid('thinking', 'must be an object when present');
  }
}

/** Client system field: string, or text blocks joined. */
function systemText(body) {
  if (typeof body.system === 'string') return body.system;
  if (Array.isArray(body.system)) return body.system.map(b => b.text).join('\n\n');
  return null;
}

/** Anthropic tools -> OpenAI function tools. */
function translateTools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.input_schema
    }
  }));
}

/** Anthropic tool_choice -> OpenAI tool choice. */
function translateToolChoice(toolChoice) {
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  return { type: 'function', function: { name: toolChoice.name } };
}

/**
 * Translate an Anthropic Messages request into a Chat Completions request.
 * @throws {UnsupportedFieldError} when the provider cannot represent a field
 */
export function translateAnthropicRequest(body, capabilities) {
  const caps = capabilities;

  // Provider-independent gates: fields a non-native provider cannot preserve.
  if (body.thinking !== undefined && body.thinking !== null) {
    throw new UnsupportedFieldError('thinking', 'extended thinking cannot be preserved by this provider');
  }
  if (Array.isArray(body.system)) {
    for (let i = 0; i < body.system.length; i++) {
      const b = body.system[i];
      if (b.cache_control) {
        throw new UnsupportedFieldError(`system[${i}].cache_control`, 'prompt caching cannot be preserved by this provider');
      }
    }
  }

  const messages = [];

  // Top-level system is a container-level instruction, never a user message.
  const sys = systemText(body);
  if (sys !== null && sys !== '') messages.push({ role: 'system', content: sys });

  body.messages.forEach((msg, mi) => {
    const path = `messages[${mi}]`;

    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      return;
    }

    // Array content: classify each block once (already structurally valid).
    const blocks = msg.content.map((block, bi) => ({ block, index: bi, kind: block.type }));

    // Tool results become OpenAI tool messages (Anthropic requires them to
    // lead their turn; order among blocks is preserved).
    const toolResults = blocks.filter(b => b.kind === 'tool_result');
    for (const { block, index } of toolResults) {
      if (block.is_error === true) {
        throw new UnsupportedFieldError(`${path}.content[${index}].is_error`,
          'tool result error flag cannot be preserved by this provider');
      }
      let text = '';
      if (typeof block.content === 'string') {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        const texts = [];
        block.content.forEach((c, ci) => {
          if (c.type === 'text') texts.push(c.text);
          else {
            throw new UnsupportedFieldError(`${path}.content[${index}].content[${ci}]`,
              'image content in tool results cannot be represented by this provider');
          }
        });
        text = texts.join('\n');
      }
      messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text });
    }

    const others = blocks.filter(b => b.kind !== 'tool_result');
    if (others.length === 0) return;

    const textParts = [];
    const toolUses = [];
    const images = [];
    for (const { block, index } of others) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        if (caps.vision === false) {
          throw new UnsupportedFieldError(`${path}.content[${index}]`, 'image input is not supported by this provider');
        }
        const src = block.source;
        images.push(src.type === 'base64'
          ? { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } }
          : { type: 'image_url', image_url: { url: src.url } });
      } else if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
        });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        throw new UnsupportedFieldError(`${path}.content[${index}].type`,
          `content block type '${block.type}' cannot be preserved by this provider`);
      } else if (block.type === 'document') {
        throw new UnsupportedFieldError(`${path}.content[${index}]`,
          'document blocks are not supported by this provider');
      }
    }

    if (toolUses.length > 0) {
      // Assistant message carrying tool calls.
      messages.push({
        role: msg.role,
        ...(textParts.length > 0 ? { content: textParts.join('') } : { content: null }),
        tool_calls: toolUses
      });
    } else {
      const content = [];
      if (textParts.length > 0) content.push({ type: 'text', text: textParts.join('') });
      content.push(...images);
      if (content.length === 1 && content[0].type === 'text') {
        messages.push({ role: msg.role, content: content[0].text });
      } else {
        messages.push({ role: msg.role, content });
      }
    }
  });

  const out = {
    model: body.model,
    max_tokens: body.max_tokens,
    messages
  };
  if (body.stream === true) out.stream = true;
  if (body.temperature !== undefined && body.temperature !== null) out.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) out.top_p = body.top_p;
  if (body.top_k !== undefined && body.top_k !== null) {
    if (caps.topK !== true) {
      throw new UnsupportedFieldError('top_k', 'this provider cannot preserve top_k');
    }
    out.top_k = body.top_k;
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    if (caps.tools === false) {
      throw new UnsupportedFieldError('tools', 'tool use is not supported by this provider');
    }
    out.tools = translateTools(body.tools);
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    if (caps.tools === false) {
      throw new UnsupportedFieldError('tool_choice', 'tool use is not supported by this provider');
    }
    out.tool_choice = translateToolChoice(body.tool_choice);
  }
  const userId = body.metadata?.user_id;
  if (typeof userId === 'string' && userId) out.user = userId;
  if (body.service_tier !== undefined && body.service_tier !== null) {
    // 'standard' has no OpenAI equivalent; map to 'auto'.
    out.service_tier = body.service_tier === 'standard' ? 'auto' : body.service_tier;
  }
  return out;
}

/**
 * Native-mode gating: the body forwards verbatim, but fields this native
 * provider cannot preserve are rejected BEFORE the upstream attempt (so the
 * failover loop can pick a capable provider; zero attempts consumed).
 * @throws {UnsupportedFieldError}
 */
export function validateNativeAnthropicBody(body, capabilities) {
  const caps = capabilities;

  body.messages.forEach((msg, mi) => {
    if (!Array.isArray(msg.content)) return;
    msg.content.forEach((b, bi) => {
      const path = `messages[${mi}].content[${bi}]`;
      if (b.type === 'thinking' && !caps.thinking) {
        throw new UnsupportedFieldError(path, 'provider does not support thinking blocks');
      }
      if (b.type === 'redacted_thinking' && !caps.thinking) {
        throw new UnsupportedFieldError(path, 'provider does not support thinking blocks');
      }
      if (b.type === 'document' && !caps.documents) {
        throw new UnsupportedFieldError(path, 'provider does not support document blocks');
      }
      if (b.type === 'image' && caps.vision === false) {
        throw new UnsupportedFieldError(path, 'provider does not support image input');
      }
    });
  });

  (Array.isArray(body.system) ? body.system : []).forEach((b, si) => {
    if (b.type === 'document' && !caps.documents) {
      throw new UnsupportedFieldError(`system[${si}]`, 'provider does not support document blocks');
    }
  });

  if (body.thinking !== undefined && body.thinking !== null && !caps.thinking) {
    throw new UnsupportedFieldError('thinking', 'provider does not support extended thinking');
  }
  return body;
}

export default { validateAnthropicMessages, translateAnthropicRequest, validateNativeAnthropicBody };