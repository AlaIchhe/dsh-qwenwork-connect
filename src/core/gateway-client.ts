/**
 * Per-site QwenWork Gateway client:
 * - Singleflight + atomic-update token refresh
 * - REST account context / quota / plan queries
 * - COSY-signed model catalog sync
 * - COSY-signed 1.2.0 agent_chat_generation streaming
 */

import crypto from 'node:crypto';
import {
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  siteOf,
  type ModelCatalogEntry,
  type SiteId,
} from '../shared/sites.js';
import { buildCosyHeaders, encodeBody } from './cosy.js';
import {
  isTokenExpired,
  type CredentialStore,
  type StoredCredential,
} from './credentials.js';
import {
  QwenError,
  QwenErrorCode,
  isTlsCertError,
  redactSecrets,
} from './errors.js';
import {
  SseParser,
  parseQwenWorkFrame,
  type QwenWorkFrame,
} from './sse.js';
import {
  createGatewayTransport,
  isVpcEndpoint,
  resolveGatewayEndpoint,
  type GatewayTransport,
  type VpcTlsOptions,
} from './transport.js';

export const REFRESH_PATH = '/api/v1/deviceToken/refresh';
export const CATALOG_PATH = '/algo/api/v2/model/list?Encode=1';
export const INFER_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

export const REST_ENDPOINTS = Object.freeze({
  accountContext:
    '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing',
  quotaUsage: '/api/v2/quota/usage',
  userPlan: '/api/v2/user/plan',
});

export const DEFAULT_HEADER_TIMEOUT_MS = 180_000;
export const DEFAULT_FIRST_CONTENT_TIMEOUT_MS = 90_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export interface QwenWireMessage {
  readonly role: string;
  readonly content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  readonly tool_call_id?: string;
  readonly name?: string;
  readonly tool_calls?: Array<{
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
}

export interface OpenAiToolSpec {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface InferBodyParams {
  readonly messages: readonly QwenWireMessage[];
  readonly modelKey: string;
  readonly sessionId: string;
  readonly requestId?: string;
  readonly isVl?: boolean;
  readonly isReasoning?: boolean;
  readonly tools?: readonly OpenAiToolSpec[];
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly sessionType?: string;
}

export function buildInferBody(params: InferBodyParams): string {
  const requestId = params.requestId ?? crypto.randomUUID();
  const maxInput = params.maxInputTokens ?? MAX_INPUT_TOKENS;
  const maxOutput = params.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  const isVl = params.isVl === true;
  const isReasoning = params.isReasoning !== false;
  const lastUserText = extractLastUserText(params.messages);

  const body = {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: params.sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text: lastUserText,
      features: [],
      extra: {
        context: [],
        modelConfig: {
          key: params.modelKey,
          source: 'system',
          is_reasoning: isReasoning,
        },
        originalContent: lastUserText,
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: params.sessionType ?? process.env.QODERCN_SESSION_TYPE ?? 'qoder_work',
    aliyun_user_type: '',
    model_config: {
      key: params.modelKey,
      display_name: params.modelKey,
      model: '',
      format: 'openai',
      is_vl: isVl,
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: maxInput,
    },
    system: [],
    messages: params.messages,
    tools: params.tools ? [...params.tools] : [],
    parameters: {
      enable_thinking: true,
      max_tokens: maxOutput,
      context_length: maxInput,
    },
    business: {
      product: 'qoder_work',
      type: 'agent',
      stage: 'init',
    },
  };

  return JSON.stringify(body);
}

export interface AccountOverview {
  readonly degraded: boolean;
  readonly user: {
    readonly id: string | null;
    readonly name: string | null;
    readonly username: string | null;
    readonly email: string | null;
  } | null;
  readonly plan: {
    readonly pid: string | null;
    readonly name: string | null;
    readonly isPersonalVersion: boolean | null;
    readonly nextDueDate: string | null;
  } | null;
  readonly quota: {
    readonly remaining: number | null;
    readonly total: number | null;
    readonly used: number | null;
    readonly usedPercentage: number | null;
    readonly unit: string;
  };
}

export interface StreamChatOptions {
  readonly bodyJson: string;
  readonly modelKey: string;
  readonly signal?: AbortSignal;
  readonly headerTimeoutMs?: number;
  readonly firstContentTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly attributionHeaders?: Readonly<Record<string, string>>;
  readonly onHeaders?: (info: {
    readonly status: number;
    readonly requestId?: string;
    readonly contentType: string | null;
  }) => void;
}

export interface StreamChatResult {
  readonly response: Response;
  readonly requestId?: string;
  readonly frames: AsyncIterable<QwenWorkFrame>;
}

export interface GatewayClientOptions {
  readonly siteId: SiteId;
  readonly store: CredentialStore;
  readonly getTlsOptions?: () => VpcTlsOptions;
  readonly fetchImpl?: typeof fetch;
  readonly cosyVersionOverride?: () => string | undefined;
}

export class GatewayClient {
  readonly siteId: SiteId;
  private readonly store: CredentialStore;
  private readonly getTlsOptions: () => VpcTlsOptions;
  private readonly baseFetch: typeof fetch;
  private readonly cosyVersionOverride?: () => string | undefined;

  private refreshInflight: Promise<StoredCredential> | null = null;
  private transportCache: { key: string; transport: GatewayTransport } | null = null;

  constructor(options: GatewayClientOptions) {
    this.siteId = options.siteId;
    this.store = options.store;
    this.getTlsOptions = options.getTlsOptions ?? (() => ({}));
    this.baseFetch = options.fetchImpl ?? globalThis.fetch;
    this.cosyVersionOverride = options.cosyVersionOverride;
  }

  dispose(): void {
    this.transportCache?.transport.dispose();
    this.transportCache = null;
  }

  async hasCredential(): Promise<boolean> {
    try {
      const cred = await this.store.read(this.siteId);
      return cred !== undefined && cred.token !== '';
    } catch {
      return false;
    }
  }

  /**
   * Return a valid (non-expired) credential, refreshing with singleflight +
   * serialized store `update()` when near expiry.
   */
  async getValidCredential(opts: { forceRefresh?: boolean; now?: number } = {}): Promise<StoredCredential> {
    const current = await this.store.read(this.siteId);
    if (current === undefined) {
      throw new QwenError(
        QwenErrorCode.CREDENTIALS_MISSING,
        `未找到 ${siteOf(this.siteId).label} 登录凭据。`,
      );
    }

    const now = opts.now ?? Date.now();
    if (!opts.forceRefresh && !isTokenExpired(current, 60_000, now)) {
      return current;
    }

    if (this.refreshInflight !== null) {
      return this.refreshInflight;
    }

    const run = this.refreshSerialized(now, opts.forceRefresh === true);
    this.refreshInflight = run;
    const clear = () => {
      if (this.refreshInflight === run) this.refreshInflight = null;
    };
    run.then(clear, clear);
    return run;
  }

  async fetchAccountOverview(signal?: AbortSignal): Promise<AccountOverview> {
    const cred = await this.getValidCredential();
    const endpoint = resolveGatewayEndpoint(cred, this.siteId);

    let contextError: unknown;
    try {
      const payload = await this.restGet(endpoint, REST_ENDPOINTS.accountContext, cred.token, signal);
      const parsed = extractAccountContext(payload);
      if (parsed !== null) return parsed;
    } catch (error) {
      contextError = error;
    }

    // Degraded fallback: fetch quota + plan separately
    const [usage, plan] = await Promise.all([
      this.restGet(endpoint, REST_ENDPOINTS.quotaUsage, cred.token, signal).catch(() => null),
      this.restGet(endpoint, REST_ENDPOINTS.userPlan, cred.token, signal).catch(() => null),
    ]);

    if (usage === null && plan === null) {
      throw contextError instanceof Error
        ? contextError
        : new QwenError(QwenErrorCode.API_ERROR, '账号信息查询失败。', { retryable: true });
    }

    const planRec = isRecord(plan) ? plan : null;
    const usageRec = isRecord(usage) ? usage : null;
    return {
      degraded: true,
      user: null,
      plan: planRec
        ? {
            pid: asString(planRec.plan_tier),
            name: asString(planRec.plan_tier_name),
            isPersonalVersion: typeof planRec.is_personal_version === 'boolean' ? planRec.is_personal_version : null,
            nextDueDate: null,
          }
        : null,
      quota: {
        remaining: null,
        total: null,
        used: null,
        usedPercentage: firstFiniteNumber(usageRec?.total_usage_percentage),
        unit: 'credits',
      },
    };
  }

  async fetchModelCatalog(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    const cred = await this.getValidCredential();
    const endpoint = resolveGatewayEndpoint(cred, this.siteId);
    const url = `${endpoint}${CATALOG_PATH}`;
    const cosyVersion = this.resolveCosyVersion();
    const { headers } = buildCosyHeaders({
      url,
      credential: cred,
      machineId: cred.loginDeviceId,
      cosyVersion,
      body: '',
      mode: 'json',
    });

    const response = await this.doFetch(endpoint, url, {
      method: 'GET',
      headers,
      signal,
    });
    if (!response.ok) {
      throw new QwenError(
        response.status === 401 || response.status === 403
          ? QwenErrorCode.API_UNAUTHORIZED
          : QwenErrorCode.API_ERROR,
        `model list HTTP ${response.status}`,
        { status: response.status, retryable: response.status >= 500 || response.status === 429 },
      );
    }

    const payload = await response.json();
    const parsed = parseCatalogPayload(payload);
    if (parsed.length === 0) {
      throw new QwenError(QwenErrorCode.API_ERROR, 'model list returned no usable models');
    }
    return parsed;
  }

  /**
   * Perform a signed streaming chat request and yield parsed QwenWork frames.
   * Handles distinct cancellable timeouts:
   * - header timeout (clears as soon as headers arrive — never kills long streams)
   * - first-content timeout (aborts silent 200 queues early)
   * - per-chunk idle timeout
   */
  async openChatStream(options: StreamChatOptions): Promise<StreamChatResult> {
    const cred = await this.getValidCredential();
    if (!cred.loginDeviceId) {
      throw new QwenError(
        QwenErrorCode.CREDENTIALS_MISSING,
        '凭据缺少 loginDeviceId，无法完成 COSY 签名。',
      );
    }

    const endpoint = resolveGatewayEndpoint(cred, this.siteId);
    const url = `${endpoint}${INFER_PATH}`;
    const wireBody = encodeBody(options.bodyJson);
    const { headers } = buildCosyHeaders({
      url,
      credential: cred,
      machineId: cred.loginDeviceId,
      cosyVersion: this.resolveCosyVersion(),
      body: wireBody,
      mode: 'chat',
      modelKey: options.modelKey,
      extraHeaders: options.attributionHeaders,
    });

    const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
    const firstContentTimeoutMs = options.firstContentTimeoutMs ?? DEFAULT_FIRST_CONTENT_TIMEOUT_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    const headerAbort = new AbortController();
    const streamAbort = new AbortController();
    const headerTimer = setTimeout(() => {
      headerAbort.abort(new DOMException('Upstream response header timeout', 'TimeoutError'));
    }, headerTimeoutMs);

    const requestSignals: AbortSignal[] = [headerAbort.signal, streamAbort.signal];
    if (options.signal) requestSignals.push(options.signal);

    let response: Response;
    try {
      response = await this.doFetch(endpoint, url, {
        method: 'POST',
        headers,
        body: wireBody,
        signal: AbortSignal.any(requestSignals),
      });
    } finally {
      clearTimeout(headerTimer);
    }

    const requestId = pickRequestId(response.headers);
    options.onHeaders?.({
      status: response.status,
      requestId,
      contentType: response.headers.get('content-type'),
    });

    const frames = iterateFrames(response, {
      streamAbort,
      callerSignal: options.signal,
      firstContentTimeoutMs,
      idleTimeoutMs,
    });

    return { response, requestId, frames };
  }

  private async refreshSerialized(now: number, force: boolean): Promise<StoredCredential> {
    const updated = await this.store.update(this.siteId, async (current) => {
      if (current === undefined) {
        throw new QwenError(
          QwenErrorCode.CREDENTIALS_MISSING,
          `未找到 ${siteOf(this.siteId).label} 登录凭据。`,
        );
      }
      // Another process or caller may have refreshed while we waited for the lock.
      if (!force && !isTokenExpired(current, 60_000, now)) {
        return undefined;
      }
      if (!current.refreshToken) {
        throw new QwenError(
          QwenErrorCode.TOKEN_EXPIRED_NO_REFRESH,
          '登录已过期且凭据中缺少 refresh token。',
        );
      }

      const endpoint = resolveGatewayEndpoint(current, this.siteId);
      const refreshed = await this.requestRefresh(endpoint, current.refreshToken);
      return {
        ...current,
        token: refreshed.token,
        refreshToken: refreshed.refreshToken ?? current.refreshToken,
        expiresAt: refreshed.expiresAt ?? current.expiresAt,
      };
    });

    if (updated === undefined) {
      throw new QwenError(
        QwenErrorCode.CREDENTIALS_MISSING,
        `未找到 ${siteOf(this.siteId).label} 登录凭据。`,
      );
    }
    return updated;
  }

  private async requestRefresh(
    endpoint: string,
    refreshToken: string,
  ): Promise<{ token: string; refreshToken: string | null; expiresAt: string | null }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    let response: Response;
    try {
      response = await this.doFetch(endpoint, `${endpoint}${REFRESH_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: ac.signal,
      });
    } catch (error) {
      if (error instanceof QwenError) throw error;
      throw new QwenError(
        QwenErrorCode.REFRESH_NETWORK,
        `Token 续期网络失败：${redactSecrets(error)}`,
        { cause: error, retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const rejected = response.status === 400 || response.status === 401 || response.status === 403;
      throw new QwenError(
        rejected ? QwenErrorCode.REFRESH_REJECTED : QwenErrorCode.REFRESH_NETWORK,
        `Token 续期失败（HTTP ${response.status}）：${redactSecrets(text, 200)}`,
        { status: response.status, retryable: !rejected },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new QwenError(QwenErrorCode.REFRESH_REJECTED, 'Token 续期响应不是合法 JSON。', { cause: error });
    }
    const rec = isRecord(json) ? json : {};
    const token = asString(rec.device_token) ?? asString(rec.deviceToken) ?? asString(rec.token);
    if (token === null) {
      throw new QwenError(QwenErrorCode.REFRESH_REJECTED, 'Token 续期响应未包含 device_token。');
    }
    const nextRefresh = asString(rec.refresh_token) ?? asString(rec.refreshToken);
    const expiresRaw = rec.expires_at ?? rec.expiresAt;
    const expiresAt = normalizeDateIso(expiresRaw);
    return { token, refreshToken: nextRefresh, expiresAt };
  }

  private async restGet(
    endpoint: string,
    pathname: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const site = siteOf(this.siteId);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    const signals = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

    let response: Response;
    try {
      response = await this.doFetch(endpoint, `${endpoint}${pathname}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': `qoderwork/${site.appVersion}`,
          'x-qwenwork-version': site.appVersion,
          'x-qwenwork-release-version': site.appReleaseVersion,
          'x-qwenwork-build': site.appBuild,
          'x-qwenwork-platform': process.platform,
          'x-qwenwork-arch': process.arch,
          'x-qwenwork-channel': 'stable',
          accept: 'application/json',
        },
        signal: signals,
      });
    } catch (error) {
      if (error instanceof QwenError) throw error;
      throw new QwenError(
        QwenErrorCode.API_ERROR,
        `请求 ${pathname} 失败（网络错误）：${redactSecrets(error)}`,
        { cause: error, retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new QwenError(
        QwenErrorCode.API_UNAUTHORIZED,
        `请求 ${pathname} 鉴权失败（HTTP ${response.status}）：${redactSecrets(text, 200)}`,
        { status: response.status, retryable: false },
      );
    }
    if (!response.ok) {
      throw new QwenError(
        QwenErrorCode.API_ERROR,
        `请求 ${pathname} 失败（HTTP ${response.status}）：${redactSecrets(text, 200)}`,
        { status: response.status, retryable: response.status >= 500 || response.status === 429 },
      );
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new QwenError(QwenErrorCode.API_ERROR, `响应 ${pathname} 不是合法 JSON。`, { cause: error });
    }
  }

  private async doFetch(endpoint: string, url: string, init: RequestInit): Promise<Response> {
    const tls = this.getTlsOptions();
    const cacheKey = `${endpoint}|${tls.caCertPath ?? ''}|${tls.insecureTls === true ? '1' : '0'}`;
    if (this.transportCache === null || this.transportCache.key !== cacheKey) {
      this.transportCache?.transport.dispose();
      this.transportCache = {
        key: cacheKey,
        transport: createGatewayTransport(endpoint, tls, this.baseFetch),
      };
    }

    try {
      return await this.transportCache.transport.fetch(url, init);
    } catch (error) {
      if (isVpcEndpoint(endpoint) && isTlsCertError(error)) {
        throw new QwenError(
          QwenErrorCode.TLS_CERTIFICATE,
          `VPC 网关 ${endpoint} 证书校验失败：${redactSecrets(error)}`,
          { cause: error, retryable: false },
        );
      }
      throw error;
    }
  }

  private resolveCosyVersion(): string {
    const override = this.cosyVersionOverride?.();
    if (typeof override === 'string' && override.trim() !== '') return override.trim();
    return siteOf(this.siteId).cosyVersion;
  }
}

async function* iterateFrames(
  response: Response,
  opts: {
    readonly streamAbort: AbortController;
    readonly callerSignal?: AbortSignal;
    readonly firstContentTimeoutMs: number;
    readonly idleTimeoutMs: number;
  },
): AsyncIterable<QwenWorkFrame> {
  if (!response.body) return;
  const parser = new SseParser();
  const reader = response.body.getReader();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOutReason: string | null = null;

  const arm = (ms: number, reason: string) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOutReason = reason;
      try {
        opts.streamAbort.abort(new DOMException(reason, 'TimeoutError'));
      } catch {
        /* already aborted */
      }
      void reader.cancel(reason).catch(() => undefined);
    }, ms);
  };

  arm(opts.firstContentTimeoutMs, `first content timeout after ${opts.firstContentTimeoutMs}ms`);

  try {
    while (true) {
      if (opts.callerSignal?.aborted) break;
      const { value, done } = await reader.read();
      if (timedOutReason !== null) {
        throw new DOMException(timedOutReason, 'TimeoutError');
      }
      if (done) break;
      arm(opts.idleTimeoutMs, `stream idle timeout after ${opts.idleTimeoutMs}ms`);
      for (const payload of parser.push(value)) {
        yield parseQwenWorkFrame(payload);
      }
    }

    if (!opts.callerSignal?.aborted && !parser.done) {
      for (const payload of parser.flush()) {
        yield parseQwenWorkFrame(payload);
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

// ── Parsers ──────────────────────────────────────────────────────────────────

const CATALOG_SCENES = ['qwork', 'app', 'chat'] as const;

export function parseCatalogPayload(payload: unknown): ModelCatalogEntry[] {
  if (!isRecord(payload)) return [];
  for (const scene of CATALOG_SCENES) {
    const list = payload[scene];
    if (!Array.isArray(list)) continue;
    const out: ModelCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const entry = toCatalogEntry(item);
      if (entry === null || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
    if (out.length > 0) return out;
  }
  return [];
}

function toCatalogEntry(item: unknown): ModelCatalogEntry | null {
  if (!isRecord(item)) return null;
  const id = typeof item.key === 'string' ? item.key.trim() : '';
  if (id === '' || item.enable === false) return null;

  const fromConfig = maxContextConfigWindow(item.context_config);
  const fromField = positiveNumber(item.max_input_tokens);
  const contextWindow =
    fromConfig !== undefined && fromField !== undefined
      ? Math.max(fromConfig, fromField)
      : (fromConfig ?? fromField ?? MAX_INPUT_TOKENS);

  const shortName = asString(item.display_name) ?? id;
  const description = asString(item.description) ?? undefined;
  const billingRate = nonNegativeNumber(item.price_factor) ?? 1;

  return {
    id,
    ...(id === 'flash' ? { displayNameId: 'qwen3.8-flash' } : {}),
    shortName,
    ...(description === undefined ? {} : { description }),
    billingRate,
    supportsImages: item.is_vl === true,
    contextWindow,
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(item.is_default === true ? { isDefault: true } : {}),
    ...(item.is_new === true ? { isNew: true } : {}),
  };
}

function maxContextConfigWindow(config: unknown): number | undefined {
  if (!isRecord(config)) return undefined;
  let max: number | undefined;
  for (const value of Object.values(config)) {
    const tokens = isRecord(value) ? positiveNumber(value.token_count) : undefined;
    if (tokens !== undefined && (max === undefined || tokens > max)) {
      max = tokens;
    }
  }
  return max;
}

export function extractAccountContext(payload: unknown): AccountOverview | null {
  if (!isRecord(payload)) return null;
  const root = isRecord(payload.data) ? payload.data : payload;
  const user = isRecord(root.user) ? root.user : {};
  const plan = isRecord(root.plan) ? root.plan : {};
  const quota = isRecord(root.quota) ? root.quota : {};

  const remaining = firstFiniteNumber(quota.remaining, quota.remaining_credits, quota.left);
  const total = firstFiniteNumber(quota.total, quota.total_credits, quota.limit);
  const used =
    firstFiniteNumber(quota.used, quota.used_credits) ??
    (total !== null && remaining !== null ? Math.max(0, total - remaining) : null);

  return {
    degraded: false,
    user: {
      id: asString(user.id) ?? asString(user.uid),
      name: asString(user.name) ?? asString(user.nickname) ?? asString(user.display_name),
      username: asString(user.username) ?? asString(user.account),
      email: asString(user.email),
    },
    plan: {
      pid: asString(plan.pid) ?? asString(plan.plan_tier) ?? asString(plan.tier),
      name: asString(plan.name) ?? asString(plan.plan_tier_name) ?? asString(plan.tier_name),
      isPersonalVersion:
        typeof plan.is_personal_version === 'boolean'
          ? plan.is_personal_version
          : typeof plan.isPersonalVersion === 'boolean'
            ? plan.isPersonalVersion
            : null,
      nextDueDate: normalizeDateIso(plan.next_deduct_date ?? plan.next_due_date),
    },
    quota: {
      remaining,
      total,
      used,
      unit: asString(quota.unit) ?? 'credits',
      usedPercentage:
        firstFiniteNumber(quota.used_percentage, quota.total_usage_percentage) ??
        (total !== null && total > 0 ? Math.round(((used ?? 0) / total) * 100) : null),
    },
  };
}

function extractLastUserText(messages: readonly QwenWireMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
    }
  }
  return '';
}

function pickRequestId(headers: Headers): string | undefined {
  for (const name of ['x-request-id', 'x-acs-request-id', 'request-id', 'x-trace-id']) {
    const v = headers.get(name);
    if (v !== null && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeDateIso(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('0001-01-01')) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
