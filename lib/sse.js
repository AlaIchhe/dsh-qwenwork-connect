/**
 * 健壮的 SSE 帧解析器与 OpenAI 兼容分块编码器。
 *
 * ── 上游协议（阶段 A-1 实测）────────────────────────────────────────
 * QwenWork 的 `agent_chat_generation` 返回 `text/event-stream`，每个 `data:`
 * 帧是一个**外层信封**，真正的模型分块在 `body` 字符串里：
 *
 *   data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{...}}]}",
 *        "statusCodeValue":200,"statusCode":"OK"}
 *
 * 因此要解两层 JSON。下游是 pi-ai 的 `openAICompletionsApi`，需要标准
 * OpenAI `chat.completion.chunk` 分块。
 *
 * ── 本模块的设计目标：不崩溃、不挂起 ──────────────────────────────────
 * 真实流里会出现：TCP 分片把一个帧切成两半、空行、注释行（`:`）、
 * `[DONE]` 哨兵、心跳、非法 JSON、上游中途断开。解析器必须对每一种都
 * 有确定的、可测试的行为，而不是抛异常炸掉整条流。
 *
 * @module dsh-qwenwork-connect/sse
 */

import { decodeBody, looksEncoded } from './cosy.js';
import { parseUpstreamFailureText } from './upstream-errors.js';

/** SSE 事件之间允许的最大缓冲；超过即视为上游异常，避免无限增长。 */
export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * 增量式 SSE 解析器：喂入任意切分的字节/字符串，产出完整事件的 `data` 负载。
 *
 * 用法：
 * ```js
 * const p = new SseParser();
 * for (const payload of p.push(chunk)) { ... }
 * for (const payload of p.flush()) { ... }   // 流结束时
 * ```
 */
export class SseParser {
  constructor() {
    /** @type {string} */
    this.buffer = '';
    /** 是否已看到 `[DONE]` 哨兵。 */
    this.done = false;
    /** 被丢弃的畸形帧计数（限流后供诊断）。 */
    this.droppedFrames = 0;
    /**
     * 持久的 UTF-8 解码器。
     *
     * ⚠️ 必须是**有状态、跨 push 复用**的实例：一个多字节字符（如中文）
     * 可能被 TCP 切在两个分片中间，若每次 push 都新建解码器，前半段会被
     * 解成替换字符 `�`，输出就永久损坏了。`{ stream: true }` 会让解码器
     * 把不完整序列暂存到下一次。
     */
    this.decoder = new TextDecoder('utf-8');
  }

  /**
   * 喂入一段数据，返回其中**完整的** `data:` 负载数组。
   *
   * @param {string | Uint8Array} chunk
   * @returns {string[]}
   */
  push(chunk) {
    if (this.done) return [];
    if (chunk !== undefined && chunk !== null && chunk !== '') {
      this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    }
    return this.#drain(false);
  }

  /**
   * 流结束时调用：把缓冲区里最后一个**没有换行结尾**的帧也吐出来，
   * 并冲掉解码器里可能残留的不完整字符。
   *
   * @returns {string[]}
   */
  flush() {
    const out = this.#drain(true);
    try {
      // 冲掉解码器内部的暂存字节（若确实是不完整序列，会得到替换字符，
      // 但不会影响已经完整解码的内容）
      const tail = this.decoder.decode();
      if (tail !== '') this.buffer += tail;
    } catch {
      /* 解码器已冲过，忽略 */
    }
    if (this.buffer !== '') {
      const payload = extractData(this.buffer);
      this.buffer = '';
      if (payload !== null && payload !== '' && payload !== '[DONE]') out.push(payload);
    }
    return out;
  }

  /**
   * @param {boolean} atEnd
   * @returns {string[]}
   */
  #drain(atEnd) {
    /** @type {string[]} */
    const out = [];

    // 缓冲区无界增长保护：宁可丢弃并报告，也不让内存被拖垮
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
          this.droppedFrames += 1; // 空 data 帧：跳过，不当作错误
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

/**
 * 从一行 SSSE 文本里取出 `data:` 负载。
 * 非 data 行（空行、`event:`、`id:`、`retry:`、`:` 注释、`[DONE]` 前缀等）
 * 一律返回 null。`[DONE]` 会被原样返回以便调用方识别。
 *
 * @param {string} line
 * @returns {string | null}
 */
export function extractData(line) {
  if (line === '' || line.startsWith(':')) return null;
  if (!line.startsWith('data:')) return null;
  // 规范允许 "data:xxx" 与 "data: xxx"，只吃掉一个前导空格
  let payload = line.slice(5);
  if (payload.startsWith(' ')) payload = payload.slice(1);
  return payload.trim();
}

/** 用 TextDecoder 解 UTF-8；失败时不抛，返回替代字符。 */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/**
 * 解析一帧 QwenWork 信封，提取出模型分块。
 *
 * 返回结构恒定（永不抛异常），调用方据 `kind` 分支：
 *   - `'chunk'`  正常模型分块（含 `delta`）
 *   - `'error'`  上游报告的错误（HTTP 层或信封层）
 *   - `'skip'`   可安全忽略的帧（空帧、非 JSON、无 choices）
 *
 * @param {string} payload
 * @returns {{ kind: 'chunk'|'error'|'skip', delta?: {content?: string, reasoning?: string},
 *             finishReason?: string|null, modelName?: string|null, error?: {status?: number, message: string} }}
 */
export function parseQwenWorkFrame(payload) {
  if (typeof payload !== 'string') return { kind: 'skip' };
  // 容错：调用方可能直接传入整行 SSE（含 `data:` 前缀）而非裸负载。
  // 明确接受两种形态，避免这个边界成为隐蔽的踩坑点。
  const text = payload.startsWith('data:') ? payload.slice(5).trim() : payload.trim();
  if (text === '' || text === '[DONE]') return { kind: 'skip' };

  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    return { kind: 'skip' };
  }
  if (outer === null || typeof outer !== 'object') return { kind: 'skip' };

  // 上游错误：信封级 statusCodeValue / statusCode
  const statusValue = typeof outer.statusCodeValue === 'number' ? outer.statusCodeValue : null;
  if (statusValue !== null && statusValue >= 400) {
    // 信封级错误：body 里可能还带业务码 / 排队信息，一并交给分类器。
    const parsed = parseUpstreamFailureText(outer.body);
    return {
      kind: 'error',
      error: { ...parsed, status: statusValue },
    };
  }

  const modelName = pickModelName(outer);

  // body 可能是字符串（常态）或已是对象（少数路径）。
  // 上游偶尔会把 body 也按 Encode=1 编码，先解码再解析。
  let inner = outer.body;
  if (typeof inner === 'string') {
    let text = inner;
    if (looksEncoded(text)) {
      try {
        text = decodeBody(text).trim();
      } catch {
        return { kind: 'skip' };
      }
    }
    try {
      inner = JSON.parse(text);
    } catch {
      return { kind: 'skip' };
    }
  }
  if (inner === null || typeof inner !== 'object') return { kind: 'skip' };

  if (inner.code !== undefined && inner.code !== null && inner.message !== undefined) {
    // 业务码不转成 HTTP 状态：`10605`（排队）这类码交给 upstream-errors 分类。
    return {
      kind: 'error',
      error: {
        code: String(inner.code),
        message: String(inner.message),
        ...(inner.queue !== null && typeof inner.queue === 'object' ? { queue: inner.queue } : {}),
      },
    };
  }

  // 帧内标准 usage 优先（qwork-claude-chat-mode-pool 与 finish 同帧下发标准
  // OpenAI usage，而同帧的 raw_usage.data 使用 Anthropic 字段名 input/output_tokens，
  // parseRawUsage 无法识别）；无可用标准 usage 时回退到 raw_usage（openai 池）。
  const rawUsage =
    inner.usage !== undefined && inner.usage !== null && parseRawUsage(inner.usage) !== null
      ? inner.usage
      : inner.raw_usage;

  const choice = Array.isArray(inner.choices) ? inner.choices[0] : undefined;
  if (choice === undefined || choice === null) {
    if (rawUsage === undefined) return { kind: 'skip' };
    return {
      kind: 'chunk',
      delta: {},
      finishReason: null,
      modelName,
      rawUsage,
    };
  }

  const rawDelta = choice.delta ?? {};
  const delta = {};
  if (typeof rawDelta.content === 'string' && rawDelta.content !== '') delta.content = rawDelta.content;
  if (typeof rawDelta.reasoning_content === 'string' && rawDelta.reasoning_content !== '') {
    delta.reasoning = rawDelta.reasoning_content;
  }
  // 工具调用分片：上游以 OpenAI 标准形态逐片给出（透传前由 chat-shim 归一化 index）。
  if (Array.isArray(rawDelta.tool_calls) && rawDelta.tool_calls.length > 0) {
    delta.tool_calls = rawDelta.tool_calls;
  }

  return {
    kind: 'chunk',
    delta,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    modelName,
    ...(rawUsage === undefined ? {} : { rawUsage }),
  };
}

/**
 * 把上游的 `raw_usage` 归一化成 OpenAI 的 `usage` 对象。
 *
 * 上游结构（实测）：
 * ```json
 * { "data": { "prompt_tokens": 17, "completion_tokens": 39, "total_tokens": 56,
 *             "prompt_tokens_details": { "cached_tokens": 0 } } }
 * ```
 *
 * **为什么必须转发**：DSH 依据 OpenAI `usage` 显示 token 统计；
 * 不返回 usage，界面上就没有任何 token 数字。
 *
 * @param {unknown} rawUsage
 * @returns {{prompt_tokens: number, completion_tokens: number, total_tokens: number,
 *            prompt_tokens_details?: {cached_tokens: number}} | null}
 */
export function parseRawUsage(rawUsage) {
  if (rawUsage === null || typeof rawUsage !== 'object') return null;
  const data = /** @type {any} */ (rawUsage).data ?? rawUsage;
  const prompt = toCount(data?.prompt_tokens);
  const completion = toCount(data?.completion_tokens);
  const total = toCount(data?.total_tokens);
  // 三项全缺 → 上游没给可用数据，不编造
  if (prompt === null && completion === null && total === null) return null;

  const cached = toCount(data?.prompt_tokens_details?.cached_tokens);
  /** @type {any} */
  const usage = {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: total ?? (prompt ?? 0) + (completion ?? 0),
  };
  if (cached !== null && cached > 0) {
    usage.prompt_tokens_details = { cached_tokens: cached };
  }
  return usage;
}

/** 取非负整数；缺失或非法返回 null（**不返回 0** —— 0 与「缺失」语义不同）。 */
function toCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** 从信封里尽力取出上游模型名（用于诊断，非必需）。 */
function pickModelName(outer) {
  const headers = outer.headers;
  if (headers !== null && typeof headers === 'object') {
    const name = headers['X-Model-Name'];
    if (Array.isArray(name) && typeof name[0] === 'string') return name[0];
    if (typeof name === 'string') return name;
  }
  return null;
}

/** 从一个错误信封里取出人类可读消息。 */

/**
 * 把解析出的增量编码成 OpenAI `chat.completion.chunk` 的 SSE 帧。
 *
 * @param {object} params
 * @param {string} params.model         模型 id（对外展示用，如 'pro'）
 * @param {string} params.id            分块 id
 * @param {number} params.created       创建时间（秒）
 * @param {{content?: string, reasoning?: string, tool_calls?: Array}} [params.delta]
 * @param {string|null} [params.finishReason]
 * @param {object|null} [params.usage]  OpenAI 形态的 token 统计；有则一并下发
 * @returns {string} 可直接写进响应体的 SSE 文本
 */
export function encodeOpenAiChunk(params) {
  const delta = {};
  if (params.delta?.content !== undefined) delta.content = params.delta.content;
  if (params.delta?.reasoning !== undefined) delta.reasoning_content = params.delta.reasoning;
  if (Array.isArray(params.delta?.tool_calls) && params.delta.tool_calls.length > 0) {
    delta.tool_calls = params.delta.tool_calls;
  }
  if (Object.keys(delta).length === 0 && params.finishReason === undefined) delta.role = 'assistant';

  const chunk = {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
    // DSH 依据 usage 显示 token 统计；只在真实拿到时下发，绝不编造。
    ...(params.usage == null ? {} : { usage: params.usage }),
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 工具调用分片 `index` 归一化器（按单次流式请求新建实例）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────
 * 部分上游池（如 qwen4-max 路由到的 claude 池）在并行工具调用时，多个
 * tool_call 的 `index` 恒为 0，仅在每个新调用的首个分片给出新的非空 `id`。
 * pi-ai 按 `index` 聚合参数增量，共享 index=0 会把多个调用的参数拼进同一块
 * 并报 `MALFORMED_RESPONSE`。
 *
 * 规则：
 *   - 见到新的非空 `id`：分配递增的归一化 index，并**覆写**同上游 index
 *     的映射，使后续无 `id` 的参数续传分片归入最新开始的调用；
 *   - 见到已见 `id`：复用既有归一化 index，并刷新同上游 index 映射；
 *   - 无 `id` 的续传分片：按上游 index 查映射归位；未知 index 保留原值兜底。
 *
 * 对 index 正常递增的上游（如 glm-5.3），该归一化退化为恒等变换。
 */
export function createToolCallIndexNormalizer() {
  /** @type {Map<string, number>} */
  const byId = new Map();
  /** @type {Map<number, number>} */
  const byUpstreamIndex = new Map();
  let next = 0;

  /**
   * @param {Array<any>} toolCalls
   * @returns {Array<any>}
   */
  return function normalize(toolCalls) {
    if (!Array.isArray(toolCalls)) return toolCalls;
    for (const tc of toolCalls) {
      if (tc === null || typeof tc !== 'object') continue;
      const upstreamIndex =
        typeof tc.index === 'number' && Number.isFinite(tc.index) ? tc.index : 0;
      const id = typeof tc.id === 'string' && tc.id !== '' ? tc.id : null;

      if (id !== null) {
        let normalized = byId.get(id);
        if (normalized === undefined) {
          normalized = next;
          next += 1;
          byId.set(id, normalized);
        }
        // 覆写映射：最新开始的调用接管该上游 index（qwen4-max 续传分片也全带 index=0）
        byUpstreamIndex.set(upstreamIndex, normalized);
        tc.index = normalized;
      } else {
        tc.index = byUpstreamIndex.get(upstreamIndex) ?? upstreamIndex;
      }
    }
    return toolCalls;
  };
}

/** SSE 结束哨兵。 */
export const SSE_DONE = 'data: [DONE]\n\n';
