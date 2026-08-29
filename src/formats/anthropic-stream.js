/**
 * Anthropic Messages SSE streaming (Build 3).
 *
 * Two modes, selected per attempt:
 *  - native      : upstream Anthropic SSE is forwarded with minimal buffering;
 *                  unknown future event types pass through untouched.
 *  - translated  : chat.completion.chunk SSE -> Anthropic SSE via the
 *                  AnthropicStreamTranslator state machine (incremental).
 *
 * Lifecycle: message_start -> (content_block_start -> content_block_delta* ->
 * content_block_stop)* -> message_delta -> message_stop.
 * Exactly one terminal outcome. Never emits OpenAI `data: [DONE]` or Responses
 * event names. Post-commit failure emits at most one Anthropic `error` event
 * and terminates without fabricating message_stop.
 *
 * Ordering, backpressure, inactivity/overall deadlines, client-disconnect
 * cancellation and cleanup are owned by stream-core.js.
 */

import { logger } from '../core/logger.js';
import { pumpStream } from '../core/stream-core.js';

function drain(res) {
  if (res.writableNeedDrain) {
    return new Promise((resolve) => res.once('drain', resolve));
  }
  return Promise.resolve();
}

/** Serialize one Anthropic SSE event (typed event line + data line). */
export function anthropicSseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Standard post-commit failure event (never followed by message_stop). */
export function anthropicErrorEvent(message = 'Upstream stream interrupted') {
  return anthropicSseEvent('error', { type: 'error', error: { type: 'api_error', message } });
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Native passthrough sink. Forwards upstream bytes verbatim while respecting
 * backpressure. Tracks whether the terminal message_stop was seen so a
 * post-commit timeout/error can emit exactly one `error` event and never
 * fabricate a normal completion.
 */
function makeNativeSink(res, meta) {
  let sawMessageStop = false;
  return {
    async write(chunkBytes, text) {
      if (res.writableEnded) return;
      if (!sawMessageStop && /event:\s*message_stop\b/.test(text)) sawMessageStop = true;
      const ok = res.write(chunkBytes);
      if (!ok) await drain(res);
    },
    async end(why) {
      if (res.writableEnded) return;
      try {
        if (why && why !== 'client-disconnect' && !sawMessageStop) {
          // Timeouts/errors after commitment: one error event, never a
          // fabricated message_stop.
          res.write(anthropicErrorEvent());
        }
        res.end();
      } catch { try { res.destroy(); } catch {} }
      logger.info('Anthropic stream completed (native)', { requestId: meta.requestId, reason: why || 'completed' });
    },
    async abort(why) {
      await this.end(why);
    }
  };
}

/**
 * Incremental Chat Completions -> Anthropic Messages stream translator.
 * Emits proper Anthropic event ordering from chat delta chunks. Tool
 * invocations stream as input_json_delta partial_json fragments; the
 * concatenation of every fragment is the final tool input (fragments are
 * deliberately NOT required to be valid JSON individually).
 */
export class AnthropicStreamTranslator {
  constructor(anthropicRequest) {
    this.request = anthropicRequest || {};
    this.messageId = genId('msg');
    this.emittedInitial = false;
    this.outputIndex = 0;
    this.openBlock = null;      // { index, type: 'text'|'tool', id?, name?, args? }
    this.closedBlocks = [];
    this.textParts = [];
    this.toolUses = [];         // completed { id, name, input }
    this.usage = null;          // from final chat usage chunk, when supplied
    this.finishReason = null;
    this.failed = false;
  }

  sse(type, payload) {
    return anthropicSseEvent(type, payload);
  }

  /** message_start, emitted once at commitment time. */
  initialEvents() {
    if (this.emittedInitial) return [];
    this.emittedInitial = true;
    // Usage fields are null until the upstream supplies numbers (never invented).
    return [this.sse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.request.model || 'unknown',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: null, output_tokens: 0 }
      }
    })];
  }

  closeOpenBlock() {
    if (!this.openBlock) return [];
    const events = [this.sse('content_block_stop', {
      type: 'content_block_stop',
      index: this.openBlock.index
    })];
    if (this.openBlock.type === 'tool') {
      let input = {};
      try { input = JSON.parse(this.openBlock.args || '{}'); } catch { input = {}; }
      this.toolUses.push({ id: this.openBlock.id, name: this.openBlock.name, input });
    }
    this.closedBlocks.push(this.openBlock);
    this.openBlock = null;
    return events;
  }

  /**
   * Consume one parsed chat chunk object; returns Anthropic SSE strings.
   * Handles incremental delta chunks AND full message objects (stream-json wrap).
   */
  onChatChunk(chunk) {
    const events = [];
    if (!chunk || typeof chunk !== 'object') return events;
    if (chunk.usage && typeof chunk.usage === 'object') {
      this.usage = {
        input_tokens: typeof chunk.usage.prompt_tokens === 'number' ? chunk.usage.prompt_tokens : null,
        output_tokens: typeof chunk.usage.completion_tokens === 'number' ? chunk.usage.completion_tokens : null
      };
    }
    if (!Array.isArray(chunk.choices)) return events;

    for (const choice of chunk.choices) {
      const delta = choice?.delta ?? choice?.message ?? {};
      if (choice?.finish_reason) this.finishReason = choice.finish_reason;

      const text = typeof delta.content === 'string' ? delta.content : '';
      if (text.length > 0) {
        if (this.openBlock && this.openBlock.type !== 'text') events.push(...this.closeOpenBlock());
        if (!this.openBlock) {
          this.openBlock = { index: this.outputIndex++, type: 'text' };
          events.push(this.sse('content_block_start', {
            type: 'content_block_start',
            index: this.openBlock.index,
            content_block: { type: 'text', text: '' }
          }));
        }
        this.textParts.push(text);
        events.push(this.sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.openBlock.index,
          delta: { type: 'text_delta', text }
        }));
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const slot = typeof call.index === 'number' ? call.index : 0;
          const fn = call.function ?? {};
          if (this.openBlock && this.openBlock.type === 'tool' && this.openBlock.slot !== slot) {
            events.push(...this.closeOpenBlock());
          }
          if (!this.openBlock || this.openBlock.type !== 'tool') {
            if (this.openBlock) events.push(...this.closeOpenBlock());
            const id = call.id || genId('toolu');
            const name = fn.name || '';
            this.openBlock = { index: this.outputIndex++, type: 'tool', slot, id, name, args: '' };
            events.push(this.sse('content_block_start', {
              type: 'content_block_start',
              index: this.openBlock.index,
              content_block: { type: 'tool_use', id, name, input: {} }
            }));
          }
          const frag = typeof fn.arguments === 'string' ? fn.arguments : '';
          if (frag) {
            this.openBlock.args += frag;
            events.push(this.sse('content_block_delta', {
              type: 'content_block_delta',
              index: this.openBlock.index,
              delta: { type: 'input_json_delta', partial_json: frag }
            }));
          }
        }
      }
    }
    return events;
  }

  /** Terminal events: close blocks, message_delta with stop_reason, message_stop. */
  finalEvents() {
    const events = [...this.closeOpenBlock()];
    const stopReason = mapFinishReasonToStopReason(this.finishReason) ?? 'end_turn';
    // Anthropic requires tool-call generations to end with stop_reason tool_use.
    const hasToolUse = this.toolUses.length > 0;
    events.push(this.sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: hasToolUse ? 'tool_use' : stopReason,
        stop_sequence: null
      },
      usage: this.usage ?? { output_tokens: null }
    }));
    events.push(this.sse('message_stop', { type: 'message_stop' }));
    return events;
  }

  /** Post-commit failure event (exactly one; no message_stop). */
  failureEvent(message) {
    if (this.failed) return [];
    this.failed = true;
    return [anthropicErrorEvent(message)];
  }
}

/** Map a Chat Completions finish_reason to an Anthropic stop_reason. */
function mapFinishReasonToStopReason(finishReason) {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    default: return null;
  }
}

/**
 * Translated sink: parse chat SSE frames (CRLF/LF robust), translate
 * incrementally, flush on end.
 */
function makeTranslatedSink(res, translator, meta) {
  let buffer = '';
  return {
    async write(chunkBytes, text) {
      if (res.writableEnded) return;
      buffer += text;
      let boundary = findBoundary(buffer);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary.start);
        buffer = buffer.slice(boundary.end);
        const events = handleChatSseEvent(rawEvent, translator);
        for (const e of events) {
          if (res.writableEnded) return;
          const ok = res.write(e);
          if (!ok) await drain(res);
        }
        boundary = findBoundary(buffer);
      }
    },
    async end(why) {
      if (res.writableEnded) return;
      try {
        if (why === 'client-disconnect') {
          res.end();
          return;
        }
        if (why) {
          // Timeout or upstream error after commitment: exactly one error
          // event; never fabricate message_stop.
          for (const e of translator.failureEvent()) {
            if (res.writableEnded) return;
            res.write(e);
          }
          res.end();
          return;
        }
        // Flush any trailing buffered frame, then close out the generation.
        if (buffer.trim()) {
          const tail = handleChatSseEvent(buffer, translator);
          buffer = '';
          for (const e of tail) {
            if (res.writableEnded) return;
            const ok = res.write(e);
            if (!ok) await drain(res);
          }
        }
        for (const e of translator.finalEvents()) {
          const ok = res.write(e);
          if (!ok) await drain(res);
        }
        res.end();
      } catch { try { res.destroy(); } catch {} }
      logger.info('Anthropic stream completed (translated)', { requestId: meta.requestId, reason: why || 'completed' });
    },
    async abort(why) {
      if (res.writableEnded) return;
      try {
        if (why !== 'client-disconnect') {
          for (const e of translator.failureEvent()) res.write(e);
        }
        res.end();
      } catch {
        try { res.destroy(); } catch {}
      }
    }
  };
}

/** Find the next SSE event boundary in buf, tolerating LF and CRLF. */
function findBoundary(buf) {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1 && b === -1) return -1;
  if (a === -1) return { start: b, end: b + 4 };
  if (b === -1) return { start: a, end: a + 2 };
  if (b < a) return { start: b, end: b + 4 };
  return { start: a, end: a + 2 };
}

/**
 * Parse one raw SSE frame (data-only chat frames) into translated events.
 * `[DONE]` is swallowed (never an Anthropic event). Mid-stream chat `error`
 * payloads become a single Anthropic error event.
 */
function handleChatSseEvent(rawEvent, translator) {
  let dataPayload = null;
  let isDone = false;
  for (const line of rawEvent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') { isDone = true; continue; }
      try { dataPayload = JSON.parse(data); } catch { return []; }
    }
  }
  if (isDone) return [];
  if (!dataPayload) return [];
  if (dataPayload?.error) {
    return translator.failureEvent(
      typeof dataPayload.error.message === 'string' ? dataPayload.error.message : 'Upstream stream error'
    );
  }
  return translator.onChatChunk(dataPayload);
}

/**
 * Stream an upstream ReadableStream to the client as Anthropic SSE.
 *
 * @param {ReadableStream} upstream - fetch response.body
 * @param {http.ServerResponse} res - headers already written
 * @param {object} meta - { requestId, provider, mode, anthropicRequest }
 * @param {AbortSignal} clientSignal
 * @param {object} opts - { inactivityTimeoutMs, overallTimeoutMs }
 * @returns {Promise<{ok:boolean, reason?:string, bytes?:number}>}
 */
export async function streamAnthropicMessages(upstream, res, meta, clientSignal, opts) {
  const { inactivityTimeoutMs, overallTimeoutMs } = opts;

  if (meta.mode === 'native') {
    return pumpStream(upstream, makeNativeSink(res, meta), {
      requestId: meta.requestId,
      clientSignal,
      inactivityTimeoutMs,
      overallTimeoutMs
    });
  }

  // Translated mode: message_start is emitted at commitment time (before the
  // first upstream byte) so exactly one generation is ever visible.
  const translator = new AnthropicStreamTranslator(meta.anthropicRequest);
  for (const e of translator.initialEvents()) {
    const ok = res.write(e);
    if (!ok) await drain(res);
  }
  return pumpStream(upstream, makeTranslatedSink(res, translator, meta), {
    requestId: meta.requestId,
    clientSignal,
    inactivityTimeoutMs,
    overallTimeoutMs
  });
}

export default streamAnthropicMessages;