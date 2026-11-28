/**
 * Configurable auto-continue guard for "announced next step without tool calls".
 *
 * Uses `ctx.sessionProjections` when available (pure, deterministic fold over
 * committed session events so resume/fork state stays consistent), falling back
 * to a lightweight event observer in minimal environments.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { readPluginConfig } from './config.js';
import type {
  AgentLike,
  HostContext,
  LoggerLike,
  OptionalSessionProjectionHandle,
  SessionLike,
  SessionLikeEvent,
} from './dsh-services.js';
import { detectStall } from './stall-detector.js';

export const STALL_PROJECTION_KEY = 'qwenwork.stallGuard';
export const STALL_STEER_SOURCE_KIND = 'qwenwork-stall-continue';

export interface StallProjectionState {
  readonly stopped: boolean;
  readonly currentTurn: number | null;
  readonly sessionContinues: number;
  readonly lastTurn: number | null;
  readonly lastTurnContinues: number;
  readonly lastAssistant: {
    readonly turn: number | null;
    readonly provider: string | null;
    readonly text: string;
    readonly toolCallCount: number;
  } | null;
}

export const StallProjectionStateSchema = z.object({
  stopped: z.boolean(),
  currentTurn: z.number().nullable(),
  sessionContinues: z.number(),
  lastTurn: z.number().nullable(),
  lastTurnContinues: z.number(),
  lastAssistant: z
    .object({
      turn: z.number().nullable(),
      provider: z.string().nullable(),
      text: z.string(),
      toolCallCount: z.number(),
    })
    .nullable(),
});

export function initStallProjection(): StallProjectionState {
  return {
    stopped: false,
    currentTurn: null,
    sessionContinues: 0,
    lastTurn: null,
    lastTurnContinues: 0,
    lastAssistant: null,
  };
}

/**
 * Pure synchronous fold over committed session events.
 * Returns the exact same object reference for ignored events (DSH projection rule).
 */
export function foldStallEvent(
  state: StallProjectionState,
  event: SessionLikeEvent,
): StallProjectionState {
  const data = event.data;
  if (!data) return state;

  if (event.type === 'turn/start') {
    if (typeof data.turn !== 'number' || data.turn === state.currentTurn) return state;
    return {
      ...state,
      currentTurn: data.turn,
    };
  }

  if (event.type === 'user/message') {
    const source = asRecord(data.source);
    const kind = typeof source?.kind === 'string' ? source.kind : '';
    if (kind === 'user') {
      if (!state.stopped && state.sessionContinues === 0 && state.lastTurnContinues === 0) {
        return state;
      }
      return {
        ...state,
        stopped: false,
        sessionContinues: 0,
        lastTurn: null,
        lastTurnContinues: 0,
      };
    }
    if (kind === STALL_STEER_SOURCE_KIND) {
      const turn = state.currentTurn ?? state.lastAssistant?.turn ?? state.lastTurn;
      const sameTurn = turn !== null && turn === state.lastTurn;
      return {
        ...state,
        sessionContinues: state.sessionContinues + 1,
        lastTurn: turn,
        lastTurnContinues: sameTurn ? state.lastTurnContinues + 1 : 1,
      };
    }
    return state;
  }

  if (event.type === 'assistant/message') {
    const summary = summarizeAssistantMessage(data.message);
    if (summary === null) return state;
    const turn = typeof data.turn === 'number' ? data.turn : null;
    return {
      ...state,
      currentTurn: turn ?? state.currentTurn,
      lastAssistant: {
        turn,
        provider: summary.provider ?? null,
        text: summary.text,
        toolCallCount: summary.toolCallCount,
      },
    };
  }

  if (event.type === 'turn/end') {
    const reason = asRecord(data.reason);
    const kind = typeof reason?.kind === 'string' ? reason.kind : '';
    if (kind !== '' && kind !== 'completed') {
      if (state.stopped) return state;
      return { ...state, stopped: true };
    }
    return state;
  }

  return state;
}

export interface InstallStallGuardOptions {
  readonly rawConfig: unknown;
  readonly providers: readonly string[];
  readonly logger?: LoggerLike;
}

export function installStallGuard(
  ctx: HostContext,
  options: InstallStallGuardOptions,
): () => void {
  const targets = new Set(options.providers);
  const logger = options.logger ?? ctx.logger;

  let projectionHandle: OptionalSessionProjectionHandle<StallProjectionState> | null = null;
  let disposed = false;

  const attachProjections = (projections: HostContext['sessionProjections']) => {
    if (
      disposed ||
      projectionHandle !== null ||
      projections === undefined ||
      typeof projections.register !== 'function'
    ) {
      return;
    }
    void Promise.resolve(
      projections.register<StallProjectionState>({
        key: STALL_PROJECTION_KEY,
        stateVersion: 2,
        stateSchema: StallProjectionStateSchema,
        init: () => initStallProjection(),
        apply: foldStallEvent,
      }),
    )
      .then((handle) => {
        if (disposed) {
          void handle.dispose().catch(() => undefined);
          return;
        }
        projectionHandle = handle;
      })
      .catch((error) => {
        logger?.debug?.('dsh-qwenwork-connect: sessionProjections unavailable for stall-guard', error);
      });
  };

  // Register pure session projection via ctx.inject so startup order does not matter
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], (projCtx) => {
      attachProjections(projCtx.sessionProjections ?? projCtx.get?.('sessionProjections'));
    });
  } else {
    attachProjections(ctx.get?.('sessionProjections'));
  }

  const disposeStopping = ctx.on(
    'agent/turn-stopping',
    async ({
      agent,
      turn,
      signal,
    }: {
      agent?: AgentLike;
      turn?: number;
      signal?: AbortSignal;
    }) => {
      try {
        const cfg = readPluginConfig(options.rawConfig).stallGuard;
        if (!cfg.enabled || cfg.maxContinues <= 0) return;
        if (signal?.aborted) return;

        const session = agent?.session;
        if (!session) return;
        if (hasQueuedWork(agent)) return;

        const state = readSessionState(session, projectionHandle);
        if (state.stopped) return;

        const last = state.lastAssistant;
        if (last === null || last.provider === null || !targets.has(last.provider)) return;
        if (turn !== undefined && last.turn !== null && last.turn !== turn) return;

        const turnContinues =
          turn !== undefined && state.lastTurn === turn ? state.lastTurnContinues : 0;
        if (turnContinues >= cfg.maxContinues || state.sessionContinues >= cfg.maxContinues) {
          return;
        }

        const res = detectStall(last.text, { toolCallCount: last.toolCallCount });
        if (!res.stall || res.prompt === null) return;

        logger?.info?.(
          `dsh-qwenwork-connect: stall detected (turn=${turn}, attempt=${turnContinues + 1}/${cfg.maxContinues}, score=${res.score}, signals=${res.signals.join('+')}); steering continuation`,
        );

        agent.steer(
          createUserMessage({
            content: [{ type: 'text', text: res.prompt }],
            source: {
              kind: STALL_STEER_SOURCE_KIND as never,
              form: 'notice',
              summary: '模型宣布了下一步但未调用工具，已自动提示继续执行',
            } as never,
          }),
        );
      } catch (error) {
        logger?.debug?.('dsh-qwenwork-connect: stall-guard skipped due to error', error);
      }
    },
  );

  return () => {
    disposed = true;
    disposeStopping();
    if (projectionHandle !== null) {
      const handle = projectionHandle;
      projectionHandle = null;
      void handle.dispose().catch(() => undefined);
    }
  };
}

function readSessionState(
  session: SessionLike,
  handle: OptionalSessionProjectionHandle<StallProjectionState> | null,
): StallProjectionState {
  if (handle !== null) {
    try {
      return handle.stateOf(session);
    } catch {
      /* fallback to direct fold over Session snapshot */
    }
  }
  let state = initStallProjection();
  for (const ev of readEventsFromSession(session)) {
    if (ev) state = foldStallEvent(state, ev);
  }
  return state;
}

function readEventsFromSession(session: SessionLike): readonly SessionLikeEvent[] {
  if (typeof session.snapshotEvents === 'function') {
    return session.snapshotEvents();
  }
  if (typeof session.eventAt === 'function' && typeof session.seq === 'number') {
    const out: SessionLikeEvent[] = [];
    for (let seq = 0; seq < session.seq; seq += 1) {
      const ev = session.eventAt(seq);
      if (ev !== undefined) out.push(ev);
    }
    return out;
  }
  return [];
}

function hasQueuedWork(agent: AgentLike): boolean {
  try {
    const inbox = agent.inbox;
    if (inbox === undefined) return false;
    return (
      (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) ||
      (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0)
    );
  } catch {
    return false;
  }
}

function summarizeAssistantMessage(
  raw: unknown,
): { provider: string | undefined; text: string; toolCallCount: number } | null {
  const msg = asRecord(raw);
  if (msg === null) return null;
  const source = asRecord(msg.source);
  const provider = typeof source?.provider === 'string' ? source.provider : undefined;
  const content = Array.isArray(msg.content) ? msg.content : [];
  let toolCallCount = 0;
  const textParts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b === null) continue;
    if (b.type === 'tool-call') toolCallCount += 1;
    else if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
  }
  return { provider, text: textParts.join('\n').trim(), toolCallCount };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
