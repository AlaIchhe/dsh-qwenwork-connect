/**
 * Native DSH LlmAdapter for QwenWork (.cn & .ai).
 * Talks directly to the QwenWork gateway with COSY signing and yields DSH
 * StreamChunks — zero local HTTP loopback shim, zero pi-ai translation layer.
 */

import {
  EMPTY_RESPONSE_CODE,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ToolCallId,
  attributionHeaders,
  createUserMessage,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
  textOnlyImageText,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type ImageBlock,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type RequestMessage,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm';
import type {
  ImageAttachmentRef,
  ImageRequestTarget,
  OptionalAttachmentsService,
  OptionalFsService,
  RequestImageAttachment,
} from './dsh-services.js';
import { isQwenError, classifyUpstreamFailure, parseUpstreamFailureText, redactSecrets } from '../core/errors.js';
import {
  buildInferBody,
  type OpenAiToolSpec,
  type QwenWireMessage,
} from '../core/gateway-client.js';
import { ToolCallIndexNormalizer, type NormalizedUsage } from '../core/sse.js';
import {
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  describeModel,
  formatModelDisplayName,
  normalizeModelKey,
  siteIdOfProvider,
  type SiteId,
} from '../shared/sites.js';
import type { SiteRuntime } from './site-runtime.js';
import type { DebugTracer } from './trace.js';

export const MAX_REQUEST_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_REQUEST_IMAGES = 32;
const REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304; // 2048 x 2048
const REQUEST_IMAGE_MAX_BYTES = 1_048_576; // 1 MiB per image

interface CallSnapshot {
  readonly runtime: SiteRuntime;
  readonly provider: string;
  readonly modelKey: string;
  readonly resolvedModel: LlmResolvedModelInfo;
  readonly isVl: boolean;
  readonly isDisabled: boolean;
}

export interface QwenWorkAdapterOptions {
  readonly runtimes: ReadonlyMap<SiteId, SiteRuntime>;
  readonly getAttachments?: () => OptionalAttachmentsService | undefined;
  readonly getFs?: () => OptionalFsService | undefined;
  readonly tracer?: DebugTracer;
}

export class QwenWorkLlmAdapter extends LlmAdapter {
  private readonly runtimes: ReadonlyMap<SiteId, SiteRuntime>;
  private readonly getAttachments?: () => OptionalAttachmentsService | undefined;
  private readonly getFs?: () => OptionalFsService | undefined;
  private readonly tracer?: DebugTracer;
  private readonly retryPolicy: ResolvedRetryPolicy;

  constructor(options: QwenWorkAdapterOptions) {
    super();
    this.runtimes = options.runtimes;
    this.getAttachments = options.getAttachments;
    this.getFs = options.getFs;
    this.tracer = options.tracer;
    this.retryPolicy = resolveRetryPolicy(undefined, 'dsh-qwenwork-connect retryPolicy');
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const runtime = this.runtimeForProvider(provider);
    return {
      id: provider,
      name: runtime.site.label,
    };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy;
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const runtime = this.runtimeForProvider(provider);
    if (!(await runtime.gateway.hasCredential())) {
      return [];
    }
    return runtime.visibleModels().map((entry) => ({
      provider,
      id: entry.id,
      name: formatModelDisplayName(entry),
      description: describeModel(entry),
      inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
    }));
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.buildSnapshot(provider, model).resolvedModel;
  }

  imageRequestTarget(
    _provider: string,
    _model: string,
    image: ImageAttachmentRef,
  ): ImageRequestTarget {
    const { width, height } = fitPixelBudget(image.width, image.height, REQUEST_IMAGE_PIXEL_BUDGET);
    return {
      width,
      height,
      maxImageBytes: REQUEST_IMAGE_MAX_BYTES,
      imageTargetBytes: REQUEST_IMAGE_MAX_BYTES,
    };
  }

  override async prepareCall(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const snapshot = this.buildSnapshot(provider, model);
    return {
      model: snapshot.resolvedModel,
      stream: (options) => this.streamWithSnapshot(options, snapshot),
    };
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const snapshot = this.buildSnapshot(options.provider, options.model);
    return this.streamWithSnapshot(options, snapshot);
  }

  private runtimeForProvider(provider: string): SiteRuntime {
    const siteId = siteIdOfProvider(provider);
    const runtime = siteId !== undefined ? this.runtimes.get(siteId) : undefined;
    if (runtime === undefined) {
      throw new LlmError(`Provider "${provider}" is not owned by dsh-qwenwork-connect`, 'NO_ADAPTER');
    }
    return runtime;
  }

  private buildSnapshot(provider: string, requestedModel: string): CallSnapshot {
    const runtime = this.runtimeForProvider(provider);
    const catalog = runtime.allModels();
    const modelKey = normalizeModelKey(requestedModel, catalog);
    const entry = runtime.findModel(modelKey);
    const disabled = runtime.disabledModels().includes(modelKey);

    const isVl = entry?.supportsImages ?? true;
    const contextWindow = entry?.contextWindow ?? MAX_INPUT_TOKENS;
    const maxTokens = entry?.maxTokens ?? MAX_OUTPUT_TOKENS;

    // Deliberately omit `reasoning`: QwenWork gateway forces thinking on and
    // ignores reasoning effort levels, so we avoid advertising fake effort menus.
    const resolvedModel: LlmResolvedModelInfo = {
      provider,
      id: modelKey,
      name: entry ? formatModelDisplayName(entry) : modelKey,
      ...(entry ? { description: describeModel(entry) } : {}),
      inputModalities: isVl ? ['text', 'image'] : ['text'],
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
    };

    return {
      runtime,
      provider,
      modelKey,
      resolvedModel,
      isVl,
      isDisabled: disabled,
    };
  }

  private async *streamWithSnapshot(
    options: GenerateOptions,
    snapshot: CallSnapshot,
  ): AsyncIterable<StreamChunk> {
    const startedAt = Date.now();
    const { runtime, modelKey, isVl, isDisabled } = snapshot;

    if (isDisabled) {
      throw new LlmError(
        `模型 ${modelKey} 已被停用，请在「插件 → 千问办公」卡片中重新启用，或改选其它模型。`,
        'INVALID_REQUEST',
      );
    }

    options.signal?.throwIfAborted();

    const wireMessages = await this.serializeMessages(options, snapshot);
    if (!wireMessages.some((m) => m.role === 'user')) {
      throw new LlmError('messages must contain at least one user message', 'INVALID_REQUEST');
    }

    const sessionId =
      options.sessionId !== undefined && String(options.sessionId) !== ''
        ? String(options.sessionId)
        : deriveSessionId(wireMessages);

    const tools = serializeTools(options.tools);
    const maxOutputTokens =
      typeof options.maxTokens === 'number' && options.maxTokens > 0
        ? Math.min(options.maxTokens, MAX_OUTPUT_TOKENS)
        : snapshot.resolvedModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS;

    const bodyJson = buildInferBody({
      messages: wireMessages,
      modelKey,
      sessionId,
      isVl,
      isReasoning: true,
      tools,
      maxInputTokens: snapshot.resolvedModel.context?.contextWindow ?? MAX_INPUT_TOKENS,
      maxOutputTokens,
    });

    const timeouts = runtime.config().timeouts;
    this.tracer?.record('request-start', {
      siteId: runtime.siteId,
      model: modelKey,
      sessionId,
      messageCount: wireMessages.length,
      toolCount: tools.length,
    });

    let firstContentAt: number | null = null;
    let outputChars = 0;
    let thinkingChars = 0;
    let upstreamRequestId: string | undefined;

    try {
      const { response, requestId, frames } = await runtime.gateway.openChatStream({
        bodyJson,
        modelKey,
        signal: options.signal,
        headerTimeoutMs: timeouts.headerMs,
        firstContentTimeoutMs: timeouts.firstContentMs,
        idleTimeoutMs: timeouts.idleMs,
        attributionHeaders: attributionHeaders(),
        onHeaders: (info) => {
          this.tracer?.record('upstream-headers', {
            siteId: runtime.siteId,
            model: modelKey,
            status: info.status,
            requestId: info.requestId ?? null,
            ms: Date.now() - startedAt,
          });
        },
      });
      upstreamRequestId = requestId;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const parsed = parseUpstreamFailureText(text);
        const failure = classifyUpstreamFailure({ status: response.status, ...parsed });
        throw new LlmError(failure.message, failure.llmCode, {
          status: failure.status,
          ...(failure.retryAfterMs !== undefined ? { providerRetryAfterMs: failure.retryAfterMs } : {}),
          ...(upstreamRequestId ? { requestId: ProviderRequestId(upstreamRequestId) } : {}),
        });
      }

      // Stream state: translate QwenWork double-envelope SSE frames directly into DSH StreamChunks.
      let nextBlockIndex = 0;
      let reasoningBlock: { index: number; text: string } | null = null;
      let textBlock: { index: number; text: string } | null = null;
      const toolNormalizer = new ToolCallIndexNormalizer();
      const toolBlocks = new Map<
        number,
        { blockIndex: number; id: string; name: string; args: string }
      >();

      let latestUsage: NormalizedUsage | null = null;
      let rawFinishReason: string | null = null;

      const closeReasoning = function* (): Generator<StreamChunk> {
        if (reasoningBlock === null) return;
        const done = reasoningBlock;
        reasoningBlock = null;
        yield {
          type: 'block-end',
          index: done.index,
          block: { type: 'reasoning', text: done.text },
        };
      };

      const closeText = function* (): Generator<StreamChunk> {
        if (textBlock === null) return;
        const done = textBlock;
        textBlock = null;
        yield {
          type: 'block-end',
          index: done.index,
          block: { type: 'text', text: done.text },
        };
      };

      for await (const frame of frames) {
        if (frame.kind === 'skip') continue;

        if (frame.kind === 'error') {
          const failure = classifyUpstreamFailure(frame.error);
          throw new LlmError(failure.message, failure.llmCode, {
            status: failure.status,
            ...(failure.retryAfterMs !== undefined ? { providerRetryAfterMs: failure.retryAfterMs } : {}),
            ...(upstreamRequestId ? { requestId: ProviderRequestId(upstreamRequestId) } : {}),
          });
        }

        if (frame.usage !== undefined) {
          latestUsage = frame.usage;
        }

        const { reasoning, content, toolCalls } = frame.delta;

        if (reasoning !== undefined && reasoning !== '') {
          yield* closeText();
          if (reasoningBlock === null) {
            reasoningBlock = { index: nextBlockIndex++, text: '' };
            yield {
              type: 'block-start',
              index: reasoningBlock.index,
              blockType: 'reasoning',
            };
          }
          reasoningBlock.text += reasoning;
          thinkingChars += reasoning.length;
          yield {
            type: 'reasoning-delta',
            index: reasoningBlock.index,
            text: reasoning,
          };
        }

        if (content !== undefined && content !== '') {
          yield* closeReasoning();
          if (textBlock === null) {
            textBlock = { index: nextBlockIndex++, text: '' };
            yield {
              type: 'block-start',
              index: textBlock.index,
              blockType: 'text',
            };
          }
          if (firstContentAt === null) {
            firstContentAt = Date.now();
            this.tracer?.record('first-content', {
              siteId: runtime.siteId,
              model: modelKey,
              ms: firstContentAt - startedAt,
            });
          }
          textBlock.text += content;
          outputChars += content.length;
          yield {
            type: 'text-delta',
            index: textBlock.index,
            text: content,
          };
        }

        if (toolCalls !== undefined && toolCalls.length > 0) {
          yield* closeReasoning();
          yield* closeText();
          const normalized = toolNormalizer.normalize(toolCalls);
          for (const tc of normalized) {
            let slot = toolBlocks.get(tc.index);
            if (slot === undefined) {
              const id =
                typeof tc.id === 'string' && tc.id !== ''
                  ? tc.id
                  : `call_${tc.index}_${Date.now().toString(36)}`;
              const name = tc.function?.name ?? '';
              slot = { blockIndex: nextBlockIndex++, id, name, args: '' };
              toolBlocks.set(tc.index, slot);
              yield {
                type: 'block-start',
                index: slot.blockIndex,
                blockType: 'tool-call',
              };
            } else {
              if (typeof tc.id === 'string' && tc.id !== '' && slot.id === '') {
                slot.id = tc.id;
              }
              if (typeof tc.function?.name === 'string' && tc.function.name !== '') {
                slot.name += tc.function.name;
              }
            }

            const argsDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
            slot.args += argsDelta;
            yield {
              type: 'tool-call-delta',
              index: slot.blockIndex,
              id: ToolCallId(slot.id),
              ...(tc.function?.name ? { name: tc.function.name } : {}),
              argumentsDelta: argsDelta,
            };
          }
        }

        if (frame.finishReason !== null) {
          rawFinishReason = frame.finishReason;
        }
      }

      // Close all open blocks in order
      yield* closeReasoning();
      yield* closeText();
      for (const slot of toolBlocks.values()) {
        yield {
          type: 'block-end',
          index: slot.blockIndex,
          block: {
            type: 'tool-call',
            id: ToolCallId(slot.id),
            name: slot.name,
            arguments: slot.args === '' ? '{}' : slot.args,
          },
        };
      }

      const hasOutput = outputChars > 0 || toolBlocks.size > 0;
      if (rawFinishReason === null && !hasOutput) {
        throw new LlmError(
          `Upstream stream ended without finish or content (thinking ${thinkingChars} chars)`,
          'STREAM_CLOSED',
          upstreamRequestId ? { requestId: ProviderRequestId(upstreamRequestId) } : undefined,
        );
      }
      if (!hasOutput && thinkingChars === 0) {
        throw new LlmError(
          'QwenWork returned an empty response',
          EMPTY_RESPONSE_CODE,
          upstreamRequestId ? { requestId: ProviderRequestId(upstreamRequestId) } : undefined,
        );
      }

      if (latestUsage !== null) {
        const usage: TokenUsage = {
          inputTokens: latestUsage.inputTokens,
          outputTokens: latestUsage.outputTokens,
          totalTokens: latestUsage.totalTokens,
          ...(latestUsage.cacheReadTokens !== undefined
            ? { cacheReadTokens: latestUsage.cacheReadTokens }
            : {}),
          ...(latestUsage.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: latestUsage.cacheWriteTokens }
            : {}),
        };
        yield { type: 'usage', usage };
      }

      const reason = mapFinishReason(rawFinishReason, toolBlocks.size > 0);
      yield { type: 'finish', reason };

      if (firstContentAt !== null && outputChars > 0) {
        const endedAt = Date.now();
        const genMs = endedAt - firstContentAt;
        runtime.recordPerf(modelKey, {
          ttftMs: firstContentAt - startedAt,
          charsPerSec: genMs > 0 ? (outputChars / genMs) * 1000 : 0,
          totalMs: endedAt - startedAt,
          outputChars,
        });
      }

      this.tracer?.record('stream-end', {
        siteId: runtime.siteId,
        model: modelKey,
        finish: reason.kind,
        outputChars,
        thinkingChars,
        toolCalls: toolBlocks.size,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      this.tracer?.record('stream-error', {
        siteId: runtime.siteId,
        model: modelKey,
        error: redactSecrets(error),
        ms: Date.now() - startedAt,
      });

      if (error instanceof LlmError) throw error;
      if (options.signal?.aborted) {
        throw new LlmError('QwenWork request aborted', 'ABORTED', { cause: error });
      }
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new LlmError(error.message || 'QwenWork request timed out', 'TIMEOUT', { cause: error });
      }
      if (isQwenError(error)) {
        if (error.code === 'CREDENTIALS_MISSING') {
          throw new LlmError(error.message, 'MISSING_CREDENTIAL', { cause: error });
        }
        if (
          error.code === 'API_UNAUTHORIZED' ||
          error.code === 'REFRESH_REJECTED' ||
          error.code === 'TOKEN_EXPIRED_NO_REFRESH'
        ) {
          throw new LlmError(error.message, 'AUTH', { cause: error });
        }
        if (error.code === 'TLS_CERTIFICATE') {
          throw new LlmError(`${error.message} ${error.recovery}`, 'TRANSPORT', { cause: error });
        }
      }
      throw new LlmError(`QwenWork transport failed: ${redactSecrets(error)}`, 'TRANSPORT', {
        cause: error,
        ...(upstreamRequestId ? { requestId: ProviderRequestId(upstreamRequestId) } : {}),
      });
    }
  }

  private async serializeMessages(
    options: GenerateOptions,
    snapshot: CallSnapshot,
  ): Promise<QwenWireMessage[]> {
    const attachments = this.getAttachments?.();
    const fsService = this.getFs?.();
    const resolveAccess = (ref: ImageAttachmentRef) => {
      if (attachments === undefined) return undefined;
      try {
        const mapHostPath = fsService?.processPathFromHostPath
          ? (hostPath: string) => fsService.processPathFromHostPath!(hostPath)
          : () => undefined;
        return resolveImageAttachmentAccess(attachments as never, mapHostPath, ref);
      } catch {
        return undefined;
      }
    };

    const projected = projectOffloadedImages(options.messages, (ref) =>
      offloadedImageText(ref, resolveAccess(ref)),
    );

    // Collect and read retained image attachments if the model supports vision
    const retainedRefs = collectRetainedImages(projected);
    const imageVersions = new Map<string, RequestImageAttachment>();

    if (retainedRefs.length > 0 && snapshot.isVl) {
      if (attachments === undefined) {
        throw new LlmError(
          'QwenWork image input requires the durable attachment service',
          'UNSUPPORTED_CONTENT',
        );
      }
      for (const block of retainedRefs) {
        const id = attachmentKey(block.attachment);
        if (imageVersions.has(id)) continue;
        const target = this.imageRequestTarget(
          snapshot.provider,
          snapshot.modelKey,
          block.attachment,
        );
        const loaded = await attachments.readImageRequest(
          block.attachment,
          target,
          options.signal,
        );
        imageVersions.set(id, loaded);
      }

      const offloadImages = requiredImageOffload(
        projected,
        {
          representation: 'base64',
          maxBytes: MAX_REQUEST_IMAGE_BYTES,
          maxImages: MAX_REQUEST_IMAGES,
        },
        (block) => {
          const version = imageVersions.get(attachmentKey(block.attachment));
          return version === undefined ? 0 : requestImageByteLength(version);
        },
      );
      if (offloadImages > 0) {
        throw new LlmError(
          `Request image payload exceeds QwenWork limit (${MAX_REQUEST_IMAGE_BYTES} bytes / ${MAX_REQUEST_IMAGES} images); offload ${offloadImages} oldest image(s).`,
          IMAGE_OFFLOAD_REQUIRED_CODE,
          { offloadImages },
        );
      }
    }

    const out: QwenWireMessage[] = [];
    if (typeof options.system === 'string' && options.system !== '') {
      out.push({ role: 'system', content: options.system });
    }

    for (let i = 0; i < projected.length; i += 1) {
      const message = projected[i]!;
      if (message.role === 'tool') {
        const toolImageParts: Array<
          { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
        > = [];
        let j = i;
        for (; j < projected.length && projected[j]!.role === 'tool'; j += 1) {
          const toolMsg = projected[j]!;
          if (toolMsg.role !== 'tool') break;
          const textParts: string[] = [];
          let toolHasRetainedImage = false;
          for (const block of toolMsg.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            } else if (block.type === 'image') {
              if (!snapshot.isVl || block.offloaded === true) {
                textParts.push(
                  block.offloaded === true
                    ? offloadedImageText(block.attachment, resolveAccess(block.attachment))
                    : textOnlyImageText(block.attachment),
                );
                continue;
              }
              const version = imageVersions.get(attachmentKey(block.attachment));
              if (version === undefined) {
                textParts.push(textOnlyImageText(block.attachment));
                continue;
              }
              toolHasRetainedImage = true;
              toolImageParts.push({
                type: 'text',
                text: requestImageHandleText(
                  block.attachment,
                  version,
                  resolveAccess(block.attachment),
                ),
              });
              const base64 = Buffer.from(version.data).toString('base64');
              toolImageParts.push({
                type: 'image_url',
                image_url: { url: `data:${version.mediaType};base64,${base64}` },
              });
            }
          }
          const content = textParts.join('');
          out.push({
            role: 'tool',
            tool_call_id: String(toolMsg.toolCallId),
            content: content !== '' ? content : toolHasRetainedImage ? '(see attached image)' : '',
          });
        }
        i = j - 1;
        if (toolImageParts.length > 0) {
          out.push({
            role: 'user',
            content: [
              { type: 'text', text: 'Attached image(s) from tool result:' },
              ...toolImageParts,
            ],
          });
        }
        continue;
      }

      const converted = convertMessage(message, {
        isVl: snapshot.isVl,
        imageVersions,
        resolveAccess,
      });
      if (converted !== null) out.push(converted);
    }

    return out;
  }
}

function attachmentKey(ref: ImageAttachmentRef): string {
  return String(ref.attachmentId);
}

function requestImageByteLength(version: RequestImageAttachment): number {
  return typeof version.bytes === 'number' ? version.bytes : version.data.byteLength;
}

function collectRetainedImages(messages: readonly RequestMessage[]): ImageBlock[] {
  const out: ImageBlock[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image' && block.offloaded !== true) {
        out.push(block);
      }
    }
  }
  return out;
}

function convertMessage(
  message: RequestMessage,
  ctx: {
    readonly isVl: boolean;
    readonly imageVersions: ReadonlyMap<string, RequestImageAttachment>;
    readonly resolveAccess: (ref: ImageAttachmentRef) => ReturnType<typeof resolveImageAttachmentAccess>;
  },
): QwenWireMessage | null {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: String(message.toolCallId),
      content: joinTextBlocks(message.content, ctx.resolveAccess),
    };
  }

  if (message.role === 'assistant') {
    const textParts: string[] = [];
    const toolCalls: NonNullable<QwenWireMessage['tool_calls']> = [];
    for (const block of message.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool-call') {
        toolCalls.push({
          id: String(block.id),
          type: 'function',
          function: {
            name: block.name,
            arguments: block.arguments,
          },
        });
      }
    }
    const content = textParts.join('');
    if (toolCalls.length > 0) {
      return { role: 'assistant', content, tool_calls: toolCalls };
    }
    if (content === '') return null;
    return { role: 'assistant', content };
  }

  if (message.role === 'system' || message.role === 'developer') {
    const content = joinTextBlocks(message.content, ctx.resolveAccess);
    if (content === '') return null;
    return { role: 'system', content };
  }

  // User message (may contain images)
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  let hasImage = false;

  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text !== '') parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      if (!ctx.isVl || block.offloaded === true) {
        parts.push({
          type: 'text',
          text:
            block.offloaded === true
              ? offloadedImageText(block.attachment, ctx.resolveAccess(block.attachment))
              : textOnlyImageText(block.attachment),
        });
        continue;
      }
      const version = ctx.imageVersions.get(attachmentKey(block.attachment));
      if (version === undefined) {
        parts.push({ type: 'text', text: textOnlyImageText(block.attachment) });
        continue;
      }
      hasImage = true;
      parts.push({
        type: 'text',
        text: requestImageHandleText(block.attachment, version, ctx.resolveAccess(block.attachment)),
      });
      const base64 = Buffer.from(version.data).toString('base64');
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${version.mediaType};base64,${base64}` },
      });
    }
  }

  if (hasImage) {
    return { role: 'user', content: parts };
  }
  const text = parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
  if (text === '') return null;
  return { role: 'user', content: text };
}

function joinTextBlocks(
  blocks: readonly ContentBlock[],
  resolveAccess: (ref: ImageAttachmentRef) => ReturnType<typeof resolveImageAttachmentAccess>,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') {
      parts.push(
        block.offloaded === true
          ? offloadedImageText(block.attachment, resolveAccess(block.attachment))
          : textOnlyImageText(block.attachment),
      );
    }
  }
  return parts.join('');
}

function serializeTools(tools: readonly ToolSchema[] | undefined): OpenAiToolSpec[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function mapFinishReason(raw: string | null, hadToolCalls: boolean): FinishReason {
  if (raw === 'tool_calls' || raw === 'function_call') return { kind: 'tool-calls' };
  if (raw === 'length' || raw === null) return { kind: 'max-tokens' };
  if (hadToolCalls && raw === 'stop') return { kind: 'tool-calls' };
  return { kind: 'stop' };
}

function fitPixelBudget(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w * h <= maxPixels) return { width: w, height: h };
  const scale = Math.sqrt(maxPixels / (w * h));
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
  };
}

function deriveSessionId(messages: readonly QwenWireMessage[]): string {
  const first = messages[0];
  if (first === undefined) return `sess-${Date.now().toString(36)}`;
  const seed =
    typeof first.content === 'string'
      ? first.content
      : first.content
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('');
  return seed === '' ? `sess-${Date.now().toString(36)}` : `conv-${fnv1a(seed)}`;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export { createUserMessage };
