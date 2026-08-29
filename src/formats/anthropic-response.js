/**
 * Chat Completions -> Anthropic Messages response translation (Build 3).
 *
 * Non-streaming synthesis (translateChatResponseToAnthropic), native object
 * validation (validateNativeMessagesObject) and the finish-reason -> stop_reason
 * mapping live here. Usage numbers are never invented: fields are mapped only
 * when the upstream supplied them; absent usage is reported as null.
 */

/** Generate a stable Anthropic-style id. */
export function genAnthropicId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** Map a Chat Completions finish_reason to an Anthropic stop_reason. */
export function mapFinishReasonToStopReason(finishReason) {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    default: return null; // only valid mappings are ever emitted
  }
}

/** Map a Chat Completions usage object (if present) to Anthropic usage. */
function mapUsage(chatUsage) {
  if (!chatUsage || typeof chatUsage !== 'object') return { input_tokens: null, output_tokens: null };
  return {
    input_tokens: typeof chatUsage.prompt_tokens === 'number' ? chatUsage.prompt_tokens : null,
    output_tokens: typeof chatUsage.completion_tokens === 'number' ? chatUsage.completion_tokens : null
  };
}

/**
 * Translate a Chat Completions response object into an Anthropic Message.
 * Ordered content blocks: text first (as produced), then tool_use blocks with
 * preserved tool-call ids. stop_sequence is never guessed (always null).
 */
export function translateChatResponseToAnthropic(chatBody, anthropicRequest) {
  const choice = Array.isArray(chatBody?.choices) ? chatBody.choices[0] : null;
  const message = choice?.message ?? {};
  const content = [];

  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    // Defensive: some upstreams emit content parts.
    for (const part of message.content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        content.push({ type: 'text', text: part.text });
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function?.arguments ?? '{}'); } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function?.name,
        input
      });
    }
  }

  return {
    id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`,
    type: 'message',
    role: 'assistant',
    model: chatBody?.model || anthropicRequest?.model || 'unknown',
    content,
    stop_reason: mapFinishReasonToStopReason(choice?.finish_reason) ?? 'end_turn',
    stop_sequence: null,
    usage: mapUsage(chatBody?.usage)
  };
}

/**
 * Pre-commit validation of a native Anthropic Messages response object.
 * Returns a retry classification when malformed, null when acceptable.
 * Never forwards malformed upstream output as a successful response.
 */
export function validateNativeMessagesObject(body) {
  const malformed = { error: { error: { message: 'malformed Anthropic message object', type: 'api_error' } },
    statusCode: 502 };
  if (!body || typeof body !== 'object') return { classification: malformed };
  if (body.type !== 'message') return { classification: malformed };
  if (typeof body.id !== 'string' || !body.id) return { classification: malformed };
  if (body.role !== 'assistant') return { classification: malformed };
  if (!Array.isArray(body.content)) return { classification: malformed };
  return null;
}

export default { translateChatResponseToAnthropic, validateNativeMessagesObject, mapFinishReasonToStopReason };