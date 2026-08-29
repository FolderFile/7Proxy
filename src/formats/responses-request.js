/**
 * Responses API - request translation to Chat Completions format.
 *
 * Translates a Responses request into an upstream Chat Completions request for
 * providers whose `capabilities.responses === 'translated'`.
 *
 * Rules:
 *  - Never silently discard unsupported fields: throw UnsupportedFieldError.
 *  - Do not invent values; only map fields that have a safe equivalent.
 *  - previous_response_id is rejected outright (no stateful emulation).
 */

/** Error signaling a request field the target provider cannot represent. */
export class UnsupportedFieldError extends Error {
  constructor(param, reason) {
    super(reason
      ? `Parameter '${param}': ${reason}`
      : `Parameter '${param}' is not supported by this provider`);
    this.name = 'UnsupportedFieldError';
    this.param = param;
    this.reason = reason || null;
  }
}

const KNOWN_FIELDS = [
  'model', 'input', 'instructions', 'stream', 'temperature', 'top_p',
  'max_output_tokens', 'tools', 'tool_choice', 'parallel_tool_calls',
  'metadata', 'user', 'reasoning', 'text', 'truncation', 'service_tier',
  'store', 'previous_response_id', 'include'
];

/**
 * Validate and translate a Responses request body into Chat Completions body.
 * @param {object} body - parsed Responses request
 * @param {object} caps - provider capabilities
 * @returns {object} chat completions body
 * @throws {UnsupportedFieldError} when a field cannot be represented safely
 */
export function translateResponsesRequest(body, caps) {
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.includes(key)) {
      throw new UnsupportedFieldError(key, 'unknown field');
    }
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw new UnsupportedFieldError('previous_response_id',
      'stateful conversation emulation is not supported for translated providers');
  }
  if (body.reasoning !== undefined && body.reasoning !== null) {
    throw new UnsupportedFieldError('reasoning', 'target upstream has no reasoning capability');
  }
  if (body.text !== undefined && body.text !== null) {
    throw new UnsupportedFieldError('text', 'structured text.format is not supported for translated providers');
  }
  if (body.truncation !== undefined && body.truncation !== null) {
    throw new UnsupportedFieldError('truncation', 'target upstream has no truncation control');
  }

  const out = { model: body.model };

  const messages = [];
  // instructions map to a system message before any input items.
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    messages.push({ role: 'system', content: body.instructions });
  }

  messages.push(...translateInput(body.input));
  out.messages = messages;

  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  if (body.user !== undefined) out.user = body.user;
  if (body.metadata !== undefined) out.metadata = body.metadata;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.service_tier !== undefined) {
    if (!caps.serviceTier) {
      throw new UnsupportedFieldError('service_tier', 'target upstream has no service_tier support');
    }
    out.service_tier = body.service_tier;
  }
  if (body.store !== undefined) {
    if (!caps.store) {
      throw new UnsupportedFieldError('store', 'target upstream has no store support');
    }
    out.store = body.store;
  }
  if (body.include !== undefined) {
    // include is Responses-specific passthrough; translated upstreams have no
    // equivalent, so it is only accepted when empty.
    const inc = body.include;
    if (Array.isArray(inc) && inc.length === 0) {
      // nothing requested - fine
    } else {
      throw new UnsupportedFieldError('include', 'target upstream has no include support');
    }
  }

  if (body.tools !== undefined) {
    out.tools = translateTools(body.tools, caps);
    if (body.tools.length > 0) {
      // OpenAI defaults tool_choice to "auto" when tools are present; only
      // forward explicit values.
      if (body.tool_choice !== undefined) {
        out.tool_choice = translateToolChoice(body.tool_choice);
      }
    } else if (body.tool_choice !== undefined) {
      throw new UnsupportedFieldError('tool_choice', 'provided without tools');
    }
  } else if (body.tool_choice !== undefined) {
    throw new UnsupportedFieldError('tool_choice', 'provided without tools');
  }

  return out;
}

/** Validate tools array and map Responses function tools to chat tools. */
function translateTools(tools, caps) {
  if (!Array.isArray(tools)) {
    throw new UnsupportedFieldError('tools', 'must be an array');
  }
  return tools.map((t, i) => {
    if (!t || typeof t !== 'object') {
      throw new UnsupportedFieldError(`tools[${i}]`, 'must be an object');
    }
    if (t.type !== 'function') {
      throw new UnsupportedFieldError(`tools[${i}].type`, `tool type '${t.type}' is not supported`);
    }
    const fn = t.function ?? t;
    if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name) {
      throw new UnsupportedFieldError(`tools[${i}].function`, 'function tool requires a name');
    }
    const chatTool = {
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description ?? '',
        parameters: fn.parameters ?? { type: 'object', properties: {} }
      }
    };
    if (fn.strict !== undefined) chatTool.function.strict = fn.strict;
    return chatTool;
  });
}

/** Map Responses tool_choice: 'auto'|'none'|'required'|{type:'function',name}. */
function translateToolChoice(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (choice && typeof choice === 'object' && choice.type === 'function') {
    const name = choice.name ?? choice.function?.name;
    if (!name) throw new UnsupportedFieldError('tool_choice', 'function choice requires a name');
    return { type: 'function', function: { name } };
  }
  throw new UnsupportedFieldError('tool_choice', 'unrecognized tool_choice value');
}

/**
 * Translate Responses `input` (string | array of input items) into chat messages.
 * Supports: message (input_text/input_image content parts), function_call,
 * function_call_output.
 */
export function translateInput(input) {
  if (input === undefined || input === null) return [];
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (!Array.isArray(input)) {
    throw new UnsupportedFieldError('input', 'must be a string or an array of input items');
  }

  const messages = [];
  let functionCallId = null; // pending function_call awaiting its output

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item || typeof item !== 'object') {
      throw new UnsupportedFieldError(`input[${i}]`, 'must be an object');
    }
    const type = item.type ?? 'message';
    switch (type) {
      case 'message': {
        const msg = translateMessageItem(item, i);
        functionCallId = null;
        messages.push(msg);
        break;
      }
      case 'function_call': {
        if (!item.name) throw new UnsupportedFieldError(`input[${i}].name`, 'function_call requires name');
        // Represent as an assistant tool_calls message.
        const callId = item.call_id ?? item.id;
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: callId ?? `call_${i}`,
            type: 'function',
            function: {
              name: item.name,
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
            }
          }]
        });
        functionCallId = callId ?? `call_${i}`;
        break;
      }
      case 'function_call_output': {
        if (!('output' in item)) {
          throw new UnsupportedFieldError(`input[${i}].output`, 'function_call_output requires output');
        }
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id ?? functionCallId ?? `call_${i}`,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
        });
        functionCallId = null;
        break;
      }
      default:
        throw new UnsupportedFieldError(`input[${i}].type`, `input item type '${type}' is not supported`);
    }
  }
  return messages;
}

/** Translate a Responses message item into a chat message. */
function translateMessageItem(item, index) {
  const role = item.role ?? 'user';
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer' && role !== 'tool') {
    throw new UnsupportedFieldError(`input[${index}].role`, `role '${role}' is not valid`);
  }
  const chatRole = role === 'developer' ? 'system' : role;

  // string content
  if (typeof item.content === 'string') {
    return { role: chatRole, content: item.content };
  }
  // array of content parts
  if (Array.isArray(item.content)) {
    const parts = item.content.map((part, pi) => translateContentPart(part, index, pi));
    // Pure text arrays collapse to a plain string for maximal compatibility.
    if (chatRole !== 'assistant' && parts.every(p => p.type === 'text')) {
      return { role: chatRole, content: parts.map(p => p.text).join('') };
    }
    return { role: chatRole, content: parts };
  }
  // missing content
  if (item.content === undefined || item.content === null) {
    if (chatRole === 'assistant') return { role: chatRole, content: null };
    return { role: chatRole, content: '' };
  }
  throw new UnsupportedFieldError(`input[${index}].content`, 'must be a string or an array of content parts');
}

/** Translate one content part: input_text | input_image. */
function translateContentPart(part, itemIndex, partIndex) {
  if (!part || typeof part !== 'object') {
    throw new UnsupportedFieldError(`input[${itemIndex}].content[${partIndex}]`, 'must be an object');
  }
  if (part.type === 'input_text') {
    if (typeof part.text !== 'string') {
      throw new UnsupportedFieldError(`input[${itemIndex}].content[${partIndex}].text`, 'input_text requires text');
    }
    return { type: 'text', text: part.text };
  }
  if (part.type === 'input_image') {
    const url = part.image_url ?? part.url;
    if (typeof url !== 'string' || !url) {
      throw new UnsupportedFieldError(`input[${itemIndex}].content[${partIndex}].image_url`, 'input_image requires image_url');
    }
    const chatPart = { type: 'image_url', image_url: { url } };
    if (part.detail !== undefined) chatPart.image_url.detail = part.detail;
    return chatPart;
  }
  throw new UnsupportedFieldError(
    `input[${itemIndex}].content[${partIndex}].type`,
    `content part type '${part.type}' is not supported`
  );
}

export default { translateResponsesRequest, translateInput, UnsupportedFieldError };