/**
 * Incremental SSE parser, double-envelope QwenWork frame decoder,
 * usage normalizer (DSH disjoint accounting), and parallel tool_call index normalizer.
 */

import { decodeBody, looksEncoded } from './cosy.js';
import { parseUpstreamFailureText, type ParsedUpstreamFailure } from './errors.js';

export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

export class SseParser {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');
  done = false;
  droppedFrames = 0;

  push(chunk: string | Uint8Array | null | undefined): string[] {
    if (this.done) return [];
    if (chunk !== undefined && chunk !== null && chunk !== '') {
      this.buffer += typeof chunk === 'string'
        ? chunk
        : this.decoder.decode(chunk, { stream: true });
    }
    return this.drain(false);
  }

  flush(): string[] {
    const out = this.drain(true);
    try {
      const tail = this.decoder.decode();
      if (tail !== '') this.buffer += tail;
    } catch {
      /* already flushed */
    }
    if (this.buffer !== '') {
      const payload = extractData(this.buffer);
      this.buffer = '';
      if (payload !== null && payload !== '' && payload !== '[DONE]') out.push(payload);
    }
    return out;
  }

  private drain(atEnd: boolean): string[] {
    const out: string[] = [];
    if (this.buffer.length > MAX_SSE_BUFFER_BYTES) {
      this.droppedFrames += 1;
      this.buffer = '';
      return out;
    }

    while (true) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;

      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      const payload = extractData(line);
      if (payload !== null) {
        if (payload === '[DONE]') {
          this.done = true;
          return out;
        }
        if (payload === '') {
          this.droppedFrames += 1;
          continue;
        }
        out.push(payload);
      }
    }

    if (atEnd && this.buffer !== '') {
      const payload = extractData(this.buffer);
      this.buffer = '';
      if (payload !== null && payload !== '' && payload !== '[DONE]') out.push(payload);
    }

    return out;
  }
}

export function extractData(line: string): string | null {
  if (line === '' || line.startsWith(':') || !line.startsWith('data:')) return null;
  let payload = line.slice(5);
  if (payload.startsWith(' ')) payload = payload.slice(1);
  return payload.trim();
}

export interface UpstreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ParsedDelta {
  readonly content?: string;
  readonly reasoning?: string;
  readonly toolCalls?: UpstreamToolCallDelta[];
}

export interface NormalizedUsage {
  /** Uncached prompt tokens (DSH disjoint accounting). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export type QwenWorkFrame =
  | { readonly kind: 'skip' }
  | { readonly kind: 'error'; readonly error: ParsedUpstreamFailure }
  | {
      readonly kind: 'chunk';
      readonly delta: ParsedDelta;
      readonly finishReason: string | null;
      readonly modelName: string | null;
      readonly usage?: NormalizedUsage;
    };

export function parseQwenWorkFrame(payload: unknown): QwenWorkFrame {
  if (typeof payload !== 'string') return { kind: 'skip' };
  const text = payload.startsWith('data:') ? payload.slice(5).trim() : payload.trim();
  if (text === '' || text === '[DONE]') return { kind: 'skip' };

  let outer: unknown;
  try {
    outer = JSON.parse(text);
  } catch {
    return { kind: 'skip' };
  }
  if (!isRecord(outer)) return { kind: 'skip' };

  const statusValue = typeof outer.statusCodeValue === 'number' ? outer.statusCodeValue : null;
  if (statusValue !== null && statusValue >= 400) {
    const parsed = parseUpstreamFailureText(outer.body);
    return {
      kind: 'error',
      error: { ...parsed, status: statusValue },
    };
  }

  const modelName = pickModelName(outer);

  let inner: unknown = outer.body;
  if (typeof inner === 'string') {
    let innerText = inner;
    if (looksEncoded(innerText)) {
      try {
        innerText = decodeBody(innerText).trim();
      } catch {
        return { kind: 'skip' };
      }
    }
    try {
      inner = JSON.parse(innerText);
    } catch {
      return { kind: 'skip' };
    }
  }
  if (!isRecord(inner)) return { kind: 'skip' };

  if (inner.code !== undefined && inner.code !== null && inner.message !== undefined) {
    return {
      kind: 'error',
      error: {
        code: String(inner.code),
        message: String(inner.message),
        ...(isRecord(inner.queue) ? { queue: inner.queue } : {}),
      },
    };
  }

  // Prefer standard OpenAI `usage` (e.g. qwork-claude-chat-mode-pool),
  // falling back to `raw_usage` (OpenAI pool or Anthropic-fielded fallback).
  const usage = parseUsage(inner.usage) ?? parseUsage(inner.raw_usage) ?? undefined;

  const choices = Array.isArray(inner.choices) ? inner.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : undefined;
  if (choice === undefined) {
    if (usage === undefined) return { kind: 'skip' };
    return {
      kind: 'chunk',
      delta: {},
      finishReason: null,
      modelName,
      usage,
    };
  }

  const rawDelta = isRecord(choice.delta) ? choice.delta : {};
  const content =
    typeof rawDelta.content === 'string' && rawDelta.content !== ''
      ? rawDelta.content
      : undefined;
  const reasoning =
    typeof rawDelta.reasoning_content === 'string' && rawDelta.reasoning_content !== ''
      ? rawDelta.reasoning_content
      : undefined;
  const toolCalls =
    Array.isArray(rawDelta.tool_calls) && rawDelta.tool_calls.length > 0
      ? (rawDelta.tool_calls.filter(isRecord) as UpstreamToolCallDelta[])
      : undefined;

  return {
    kind: 'chunk',
    delta: {
      ...(content === undefined ? {} : { content }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { toolCalls }),
    },
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    modelName,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Normalize upstream `usage` or `raw_usage` into DSH disjoint `TokenUsage`.
 *
 * OpenAI's `prompt_tokens` includes `cached_tokens`, so we subtract
 * `cached_tokens` to produce disjoint `inputTokens` + `cacheReadTokens`.
 */
export function parseUsage(rawUsage: unknown): NormalizedUsage | null {
  if (!isRecord(rawUsage)) return null;
  const data = isRecord(rawUsage.data) ? rawUsage.data : rawUsage;

  // OpenAI shape
  const prompt = toNonNegInt(data.prompt_tokens);
  const completion = toNonNegInt(data.completion_tokens);
  const total = toNonNegInt(data.total_tokens);
  if (prompt !== null || completion !== null || total !== null) {
    const details = isRecord(data.prompt_tokens_details) ? data.prompt_tokens_details : undefined;
    const completionDetails = isRecord(data.completion_tokens_details)
      ? data.completion_tokens_details
      : undefined;
    const cached = toNonNegInt(details?.cached_tokens);
    const reasoning = toNonNegInt(completionDetails?.reasoning_tokens);
    const rawPrompt = prompt ?? 0;
    const cacheRead = cached !== null && cached > 0 ? Math.min(cached, rawPrompt) : 0;
    const inputTokens = Math.max(0, rawPrompt - cacheRead);
    const outputTokens = completion ?? 0;
    const totalTokens = total ?? rawPrompt + outputTokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(reasoning !== null && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    };
  }

  // Anthropic shape fallback (some raw_usage.data entries use input_tokens/output_tokens)
  const input = toNonNegInt(data.input_tokens);
  const output = toNonNegInt(data.output_tokens);
  if (input !== null || output !== null) {
    const cacheRead = toNonNegInt(data.cache_read_input_tokens) ?? 0;
    const cacheWrite = toNonNegInt(data.cache_creation_input_tokens) ?? 0;
    const inputTokens = input ?? 0;
    const outputTokens = output ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + cacheRead + cacheWrite + outputTokens,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };
  }

  return null;
}

/**
 * Normalizes upstream parallel tool_call indexes.
 *
 * Some pools (e.g. qwen4-max routed to Claude pool) emit `index: 0` for every
 * parallel tool call and distinguish calls only by a fresh non-empty `id` on
 * each call's first chunk. Reassigning monotonic normalized indexes prevents
 * arguments from different calls from being concatenated together.
 */
export class ToolCallIndexNormalizer {
  private readonly byId = new Map<string, number>();
  private readonly byUpstreamIndex = new Map<number, number>();
  private nextIndex = 0;

  normalize(toolCalls: readonly UpstreamToolCallDelta[]): Array<UpstreamToolCallDelta & { index: number }> {
    return toolCalls.map((tc) => {
      const upstreamIndex =
        typeof tc.index === 'number' && Number.isFinite(tc.index) ? tc.index : 0;
      const id = typeof tc.id === 'string' && tc.id !== '' ? tc.id : null;

      let normalized: number;
      if (id !== null) {
        const existing = this.byId.get(id);
        if (existing === undefined) {
          normalized = this.nextIndex;
          this.nextIndex += 1;
          this.byId.set(id, normalized);
        } else {
          normalized = existing;
        }
        this.byUpstreamIndex.set(upstreamIndex, normalized);
      } else {
        normalized = this.byUpstreamIndex.get(upstreamIndex) ?? upstreamIndex;
      }

      return { ...tc, index: normalized };
    });
  }
}

function toNonNegInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function pickModelName(outer: Record<string, unknown>): string | null {
  const headers = isRecord(outer.headers) ? outer.headers : undefined;
  if (headers === undefined) return null;
  const name = headers['X-Model-Name'];
  if (Array.isArray(name) && typeof name[0] === 'string') return name[0];
  if (typeof name === 'string') return name;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
