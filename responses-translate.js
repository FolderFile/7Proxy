/**
 * Responses API - response translation from Chat Completions.
 *
 * Converts a Chat Completions response (non-streaming JSON or incremental SSE
 * chunks) into a valid Responses object / Responses SSE event stream.
 *
 * Rules:
 *  - Generate stable response/output item IDs (deterministic random, immutable once issued).
 *  - Map finish reasons consistently; never invent token counts.
 *  - Stream translation is incremental: text deltas are emitted as they arrive,
 *    only minimal accumulator state is kept to produce valid final events.
 *  - Exactly one terminal event; never emit Chat Completions data: [DONE].
 */

import { logger } from './logger.js';

let idCounter = 0;
/** Stable unique ids for synthesized Responses objects. */
export function genId(prefix) {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Map a chat finish_reason to a Responses status. */
export function mapFinishReason(finishReason) {
  switch (finishReason) {
    case 'stop': return 'completed';
    case 'length': return 'incomplete';
    case 'tool_calls':
    case 'function_call': return 'completed';
    case 'content_filter': return 'incomplete';
    default: return 'completed';
  }
}

const REASON_MAP = {
  length: { reason: 'max_output_tokens' },
  content_filter: { reason: 'content_filter' }
};

/** Build the mutable per-generation state used while translating a stream. */
export function createTranslatorState(body) {
  const responseId = genId('resp');
  return {
    body,
    responseId,
    createdAt: Math.floor(Date.now() / 1000),
    outputText: '',
    itemId: null,
    itemEmitted: false,
    contentPartOpen: false,
    functionCalls: new Map(), // index -> { id, name, args, emitted }
    functionItemEmitted: new Set(),
    finishReason: null,
    usageChunk: null,
    terminalEmitted: false,
    failed: false
  };
}

/** Build a full (non-streaming) Responses object from a chat completion. */
export function translateChatResponseToResponses(chat, body) {
  const state = createTranslatorState(body);
  const choice = Array.isArray(chat?.choices) && chat.choices.length > 0
    ? chat.choices[0] : null;
  const message = choice?.message ?? {};

  const outputItems = [];

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      const args = typeof tc?.function?.arguments === 'string'
        ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {});
      outputItems.push({
        type: 'function_call',
        id: genId('fc'),
        call_id: tc.id ?? genId('call'),
        name: tc?.function?.name ?? '',
        arguments: args,
        status: 'completed'
      });
    }
  }

  const content = message.content;
  const hasText = typeof content === 'string' && content.length > 0;
  if (hasText) {
    outputItems.push({
      type: 'message',
      id: genId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }]
    });
  }

  const status = choice ? mapFinishReason(choice.finish_reason) : 'completed';
  const response = {
    id: state.responseId,
    object: 'response',
    created_at: state.createdAt,
    status,
    model: chat?.model ?? body?.model ?? 'unknown',
    output: outputItems,
    parallel_tool_calls: body?.parallel_tool_calls ?? true,
    error: null,
    incomplete_details: REASON_MAP[choice?.finish_reason] ?? null,
    usage: mapUsage(chat?.usage),
    metadata: body?.metadata ?? {}
  };
  if (body?.tools?.length) response.tool_choice = body.tool_choice ?? 'auto';
  if (body?.tools?.length) response.tools = body.tools; // echo original Responses tools
  return response;
}

/** Map chat usage to Responses usage. Never invents token counts. */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
  if (input === null && output === null) return null;
  const out = {
    input_tokens: input ?? 0,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: output ?? 0,
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : (input ?? 0) + (output ?? 0)
  };
  return out;
}

/**
 * Streaming translator sink: consumes chat.completion.chunk data payloads and
 * emits Responses SSE events through `emit(string)` as they arrive.
 * Minimal accumulation: concatenates text, tracks function-call args per index.
 */
export class ChatToResponsesStreamTranslator {
  constructor(body) {
    this.body = body;
    this.state = createTranslatorState(body);
  }

  /** First events of the stream: created + in_progress. */
  initialEvents() {
    const r = this.baseResponse('in_progress');
    return [
      sseEvent({ ...r, status: 'created' }, 'response.created'),
      sseEvent(r, 'response.in_progress')
    ];
  }

  baseResponse(status) {
    return {
      id: this.state.responseId,
      object: 'response',
      created_at: this.state.createdAt,
      status,
      model: this.body?.model ?? 'unknown',
      output: [],
      error: null,
      incomplete_details: null,
      usage: null,
      metadata: this.body?.metadata ?? {}
    };
  }

  outputItemAdded(type) {
    const item = type === 'message'
      ? { type: 'message', id: this.msgItemId(), status: 'in_progress', role: 'assistant', content: [] }
      : { type: 'function_call', id: this.fnItemId(0), call_id: '', name: '', arguments: '', status: 'in_progress' };
    return sseEvent(item, 'response.output_item.added');
  }

  msgItemId() {
    if (!this.state.itemId) this.state.itemId = genId('msg');
    return this.state.itemId;
  }

  fnItemId(index) {
    if (!this.state.functionItems) this.state.functionItems = new Map();
    if (!this.state.functionItems.has(index)) {
      this.state.functionItems.set(index, {
        itemId: genId('fc'),
        callId: genId('call'),
        name: '',
        args: '',
        added: false
      });
    }
    return this.state.functionItems.get(index).itemId;
  }

  /**
   * Consume one parsed chat chunk object; returns array of Responses SSE strings.
   * Handles incremental delta chunks AND full message objects (stream-json wrap).
   */
  onChatChunk(chunk) {
    const events = [];
    if (!chunk || !Array.isArray(chunk.choices)) {
      if (chunk?.usage) this.state.usageChunk = chunk.usage;
      return events;
    }

    for (const choice of chunk.choices) {
      // Normalize: full message objects behave as a single delta.
      const rawDelta = choice?.delta ?? choice?.message ?? {};
      const delta = typeof rawDelta.content === 'string'
        ? { ...rawDelta, content: rawDelta.content }
        : rawDelta;
      const idx = choice?.index ?? 0;

      // Text delta.
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!this.state.outputItemAddedEmitted) {
          events.push(this.outputItemAdded('message'));
          events.push(sseEvent(this.contentPartAdded(), 'response.content_part.added'));
          this.state.outputItemAddedEmitted = true;
          this.state.contentPartOpen = true;
        }
        this.state.outputText += delta.content;
        events.push(sseEvent({
          item_id: this.msgItemId(),
          output_index: 0,
          content_index: 0,
          delta: delta.content
        }, 'response.output_text.delta'));
      }

      // Function call deltas.
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const fi = idxOfToolCall(tc, idx);
          if (!this.state.functionItems) this.state.functionItems = new Map();
          if (!this.state.functionItems.has(fi)) {
            this.state.functionItems.set(fi, {
              itemId: genId('fc'), callId: tc.id ?? genId('call'),
              name: '', args: '', added: false
            });
          }
          const fn = this.state.functionItems.get(fi);
          if (tc.id && !fn.callIdFromUpstream) { fn.callId = tc.id; fn.callIdFromUpstream = true; }
          if (tc.function?.name) fn.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') fn.args += tc.function.arguments;
          if (!fn.added) {
            fn.added = true;
            fn.outputIndex = this.nextOutputIndex();
            events.push(sseEvent({
              type: 'function_call',
              id: fn.itemId,
              call_id: fn.callId,
              name: fn.name,
              arguments: '',
              status: 'in_progress'
            }, 'response.output_item.added'));
          }
          if (tc.function?.arguments) {
            events.push(sseEvent({
              item_id: fn.itemId,
              output_index: fn.outputIndex ?? 0,
              delta: tc.function.arguments
            }, 'response.function_call_arguments.delta'));
          }
        }
      }

      if (choice?.finish_reason) this.state.finishReason = choice.finish_reason;
    }

    if (chunk.usage) this.state.usageChunk = chunk.usage;
    return events;
  }

  nextOutputIndex() {
    this.state.outputCounter = (this.state.outputCounter ?? 0) + 1;
    return this.state.outputCounter;
  }

  contentPartAdded() {
    return {
      item_id: this.msgItemId(),
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    };
  }

  /** Final events: close text part, close items, completed. Called once. */
  finalEvents() {
    const events = [];
    const st = this.state;

    // A message item was opened - close it.
    if (st.outputItemAddedEmitted) {
      events.push(sseEvent({
        item_id: this.msgItemId(),
        output_index: 0,
        content_index: 0,
        text: st.outputText,
        part: { type: 'output_text', text: st.outputText, annotations: [] }
      }, 'response.output_text.done'));
      events.push(sseEvent({
        item_id: this.msgItemId(),
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: st.outputText, annotations: [] }
      }, 'response.content_part.done'));
      events.push(sseEvent({
        type: 'message',
        id: this.msgItemId(),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: st.outputText, annotations: [] }]
      }, 'response.output_item.done'));
    }

    // Close any function call items.
    if (st.functionItems) {
      for (const [, fn] of st.functionItems) {
        if (!fn.added) continue;
        events.push(sseEvent({
          item_id: fn.itemId,
          output_index: fn.outputIndex ?? 0,
          arguments: fn.args
        }, 'response.function_call_arguments.done'));
        events.push(sseEvent({
          type: 'function_call',
          id: fn.itemId,
          call_id: fn.callId,
          name: fn.name,
          arguments: fn.args,
          status: 'completed'
        }, 'response.output_item.done'));
      }
    }

    const response = this.baseResponse(st.failed ? 'failed' : (mapFinishReason(st.finishReason)));
    response.output = this.fullOutput();
    response.usage = mapUsage(st.usageChunk);
    if (st.finishReason && REASON_MAP[st.finishReason]) {
      response.incomplete_details = REASON_MAP[st.finishReason];
    }
    if (!st.failed) events.push(sseEvent(response, 'response.completed'));
    return events;
  }

  /** Terminal failure event (only when permitted after commitment). */
  failureEvent(message) {
    if (this.state.terminalEmitted || this.state.failed) return [];
    this.state.failed = true;
    const response = this.baseResponse('failed');
    response.error = { code: 'upstream_failure', message };
    return [sseEvent(response, 'response.failed')];
  }

  /** Assemble the full output array for non-streaming translation. */
  fullOutput() {
    const st = this.state;
    const output = [];
    if (st.outputItemAddedEmitted) {
      output.push({
        type: 'message',
        id: this.msgItemId(),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: st.outputText, annotations: [] }]
      });
    }
    if (st.functionItems) {
      for (const [, fn] of st.functionItems) {
        if (!fn.added) continue;
        output.push({
          type: 'function_call',
          id: fn.itemId,
          call_id: fn.callId,
          name: fn.name,
          arguments: fn.args,
          status: 'completed'
        });
      }
    }
    return output;
  }
}

function idxOfToolCall(tc, fallbackIdx) {
  return typeof tc?.index === 'number' ? tc.index : (fallbackIdx ?? 0);
}

/** Format one named SSE data event. */
export function sseEvent(data, eventType) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export default {
  ChatToResponsesStreamTranslator,
  translateChatResponseToResponses,
  mapUsage,
  mapFinishReason,
  genId,
  sseEvent
};