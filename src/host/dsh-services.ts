/**
 * Structural interfaces for optional DSH runtime services accessed via
 * `ctx.get(...)` or `ctx.inject([...])`, avoiding hard runtime imports
 * when a profile omits optional services.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock, Message } from '@deepseek-ai/dsh-llm';

export type ImageAttachmentRef = ImageBlock['attachment'];

export interface ImageRequestTarget {
  readonly width: number;
  readonly height: number;
  readonly maxBytes: number;
}

export interface RequestImageAttachment {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
}

export interface OptionalWebServer {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

export interface OptionalGrantRecord {
  readonly kind: 'grant';
  readonly payload: unknown;
}

export interface OptionalCredentialRecord {
  readonly kind: string;
  readonly payload?: unknown;
}

export interface OptionalCredentialsService {
  readRecord(key: string): Promise<OptionalCredentialRecord | undefined>;
  modifyRecord(
    key: string,
    mutate: (current: OptionalCredentialRecord | undefined) => Promise<OptionalCredentialRecord | undefined>,
  ): Promise<OptionalCredentialRecord | undefined>;
  deleteRecord(key: string): Promise<void>;
}

export interface OptionalConfigEditorService {
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
}

export interface OptionalAttachmentsService {
  readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment>;
  imageHostPath?(ref: ImageAttachmentRef): string | undefined;
}

export interface OptionalFsService {
  processPathFromHostPath?(hostPath: string): string | undefined;
}

export interface OptionalSessionProjectionHandle<S> {
  stateOf(session: unknown): S;
  dispose(): Promise<void>;
}

export interface OptionalSessionProjectionRegistry {
  register<S>(definition: {
    key: string;
    stateVersion: number;
    stateSchema: unknown;
    init(header: unknown, inheritedEventCount: number): S;
    apply(state: S, event: SessionLikeEvent): S;
  }): Promise<OptionalSessionProjectionHandle<S>> | OptionalSessionProjectionHandle<S>;
}

export interface SessionLikeEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

export interface SessionLike {
  readonly events?: readonly SessionLikeEvent[];
}

export interface AgentLike {
  readonly session?: SessionLike;
  readonly inbox?: { readonly hasPending?: boolean };
  steer(message: Message): void;
}

export interface LoggerLike {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export type HostContext = Context & {
  logger?: LoggerLike;
  webServer?: OptionalWebServer;
  credentials?: OptionalCredentialsService;
  configEditor?: OptionalConfigEditorService;
  attachments?: OptionalAttachmentsService;
  fs?: OptionalFsService;
  sessionProjections?: OptionalSessionProjectionRegistry;
  get<T = unknown>(name: string): T | undefined;
  effect(fn: () => (() => void) | void, label?: string): () => void;
  on(event: string, listener: (...args: any[]) => unknown): () => void;
  inject(deps: readonly string[], callback: (ctx: HostContext) => void): unknown;
  fiber?: { readonly entry?: unknown };
};
