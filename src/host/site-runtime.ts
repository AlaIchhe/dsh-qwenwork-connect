/**
 * Per-site encapsulated runtime.
 * Owns all mutable state for a single QwenWork site (cn or intl):
 * - GatewayClient (token refresh, REST, catalog, chat streaming)
 * - Dynamic model catalog cache (5 min TTL + singleflight)
 * - Short-TTL account overview cache (10 s + singleflight + per-site credit baseline)
 * - Per-site / per-model performance ring buffer (no cross-site contamination)
 * - Device-flow login state machine with real AbortController cancellation
 */

import crypto from 'node:crypto';
import type { CredentialStore } from '../core/credentials.js';
import {
  buildAuthUrl,
  createPkce,
  credentialFromPollPayload,
  pollDeviceToken,
} from '../core/device-flow.js';
import { getOrCreateMachineId } from '../core/credentials.js';
import { isQwenError, redactSecrets } from '../core/errors.js';
import {
  GatewayClient,
  type AccountOverview,
} from '../core/gateway-client.js';
import type { VpcTlsOptions } from '../core/transport.js';
import type {
  EntitlementItem,
  LoginAccountSummary,
  LoginPhase,
  LoginStartResponse,
  LoginStatusResponse,
  PerfSummary,
  SiteStatusResponse,
  StatusErrorPayload,
} from '../shared/contracts.js';
import {
  siteOf,
  type ModelCatalogEntry,
  type SiteId,
  type SitePreset,
} from '../shared/sites.js';
import {
  catalogForCard,
  disabledForSite,
  filterEnabledModels,
  readPluginConfig,
  settingsSnapshotOf,
  type ResolvedPluginConfig,
} from './config.js';
import type { LoggerLike } from './dsh-services.js';

export const CATALOG_TTL_MS = 5 * 60 * 1000;
export const ACCOUNT_CACHE_TTL_MS = 10_000;
const PERF_WINDOW = 20;
const CREDIT_BASELINE_SEED = 2000;

export interface PerfSample {
  readonly ttftMs: number;
  readonly charsPerSec: number;
  readonly totalMs: number;
  readonly outputChars: number;
}

interface LoginSlot {
  phase: LoginPhase;
  url: string | null;
  error: string | null;
  account: LoginAccountSummary | null;
  startedAt: number | null;
  controller: AbortController | null;
  epoch: number;
}

export interface SiteRuntimeOptions {
  readonly siteId: SiteId;
  readonly store: CredentialStore;
  readonly rawConfig: unknown;
  readonly logger?: LoggerLike;
  readonly fetchImpl?: typeof fetch;
  readonly machineIdPath?: string;
  readonly onCatalogChanged?: (siteId: SiteId) => void;
}

export class SiteRuntime {
  readonly siteId: SiteId;
  readonly site: SitePreset;
  readonly gateway: GatewayClient;

  private readonly store: CredentialStore;
  private readonly rawConfig: unknown;
  private readonly logger?: LoggerLike;
  private readonly fetchImpl?: typeof fetch;
  private readonly machineIdPath?: string;
  private readonly onCatalogChanged?: (siteId: SiteId) => void;

  // Dynamic model catalog state
  private catalog: ModelCatalogEntry[];
  private catalogFetchedAt = 0;
  private catalogInflight: Promise<ModelCatalogEntry[]> | null = null;
  private catalogAuthNoticed = false;
  private catalogTimer: ReturnType<typeof setInterval> | null = null;
  private lastAuthenticated: boolean | null = null;

  // Account overview short-TTL cache + per-site baseline
  private accountCache: { overview: AccountOverview; fetchedAt: number } | null = null;
  private accountInflight: Promise<AccountOverview> | null = null;
  private maxObservedCredits = 0;

  // Per-site + per-model performance telemetry
  private readonly perfSamples: PerfSample[] = [];
  private readonly perfByModel = new Map<string, PerfSample[]>();

  // Per-site login flow state machine with AbortController
  private loginSlot: LoginSlot = {
    phase: 'idle',
    url: null,
    error: null,
    account: null,
    startedAt: null,
    controller: null,
    epoch: 0,
  };

  constructor(options: SiteRuntimeOptions) {
    this.siteId = options.siteId;
    this.site = siteOf(options.siteId);
    this.store = options.store;
    this.rawConfig = options.rawConfig;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl;
    this.machineIdPath = options.machineIdPath;
    this.onCatalogChanged = options.onCatalogChanged;
    this.catalog = [...this.site.fallbackModels];

    this.gateway = new GatewayClient({
      siteId: this.siteId,
      store: this.store,
      getTlsOptions: (): VpcTlsOptions => this.config().vpc,
      fetchImpl: this.fetchImpl,
    });
  }

  config(): ResolvedPluginConfig {
    return readPluginConfig(this.rawConfig);
  }

  disabledModels(): string[] {
    return disabledForSite(this.rawConfig, this.siteId);
  }

  allModels(): readonly ModelCatalogEntry[] {
    return this.catalog;
  }

  visibleModels(): ModelCatalogEntry[] {
    return filterEnabledModels(this.catalog, this.disabledModels());
  }

  findModel(modelId: string): ModelCatalogEntry | undefined {
    return this.catalog.find((m) => m.id === modelId || m.displayNameId === modelId);
  }

  startBackgroundCatalogSync(): void {
    void this.refreshCatalog(false);
    if (this.catalogTimer !== null) return;
    this.catalogTimer = setInterval(() => {
      void this.refreshCatalog(false);
    }, CATALOG_TTL_MS);
    this.catalogTimer.unref?.();
  }

  private syncAuthState(authenticated: boolean, forceNotify = false): boolean {
    const changed = this.lastAuthenticated !== null && this.lastAuthenticated !== authenticated;
    this.lastAuthenticated = authenticated;
    if (forceNotify || changed) {
      this.onCatalogChanged?.(this.siteId);
      return true;
    }
    return false;
  }

  async refreshCatalog(force = false): Promise<ModelCatalogEntry[]> {
    if (!force && Date.now() - this.catalogFetchedAt < CATALOG_TTL_MS && this.catalogFetchedAt > 0) {
      return this.catalog;
    }
    if (this.catalogInflight !== null) return this.catalogInflight;

    const run = (async () => {
      try {
        if (!(await this.gateway.hasCredential())) {
          this.syncAuthState(false);
          if (!this.catalogAuthNoticed) {
            this.catalogAuthNoticed = true;
            this.logger?.info?.(
              `dsh-qwenwork-connect: ${this.site.label} 尚未登录，模型目录先用内置快照`,
            );
          }
          return this.catalog;
        }
        const notifiedAuth = this.syncAuthState(true);
        const next = await this.gateway.fetchModelCatalog();
        const prevIds = this.catalog.map((m) => `${m.id}:${m.billingRate}`).join(',');
        const nextIds = next.map((m) => `${m.id}:${m.billingRate}`).join(',');
        this.catalog = next;
        this.catalogFetchedAt = Date.now();
        this.catalogAuthNoticed = false;
        this.logger?.info?.(
          `dsh-qwenwork-connect: 模型目录已刷新（${this.siteId}，${next.length} 个）`,
        );
        if (!notifiedAuth && prevIds !== nextIds) {
          this.onCatalogChanged?.(this.siteId);
        }
        return this.catalog;
      } catch (error) {
        const expected =
          isQwenError(error) &&
          (error.code === 'CREDENTIALS_MISSING' ||
            error.code === 'TOKEN_EXPIRED_NO_REFRESH' ||
            error.code === 'REFRESH_REJECTED');
        if (expected) {
          this.syncAuthState(false);
          if (!this.catalogAuthNoticed) {
            this.catalogAuthNoticed = true;
            this.logger?.info?.(
              `dsh-qwenwork-connect: ${this.site.label} 尚未登录，模型目录先用内置快照`,
            );
          }
        } else {
          this.logger?.warn?.(
            `dsh-qwenwork-connect: ${this.site.label} 模型目录刷新失败，沿用上次快照`,
            redactSecrets(error),
          );
        }
        return this.catalog;
      }
    })();

    this.catalogInflight = run;
    const clear = () => {
      if (this.catalogInflight === run) this.catalogInflight = null;
    };
    run.then(clear, clear);
    return run;
  }

  // ── Performance metrics (per-site & per-model) ──────────────────────────

  recordPerf(modelKey: string, sample: PerfSample): void {
    if (
      !Number.isFinite(sample.charsPerSec) ||
      sample.charsPerSec <= 0 ||
      sample.outputChars <= 0 ||
      !Number.isFinite(sample.ttftMs) ||
      sample.ttftMs < 0
    ) {
      return;
    }

    const entry: PerfSample = {
      ttftMs: Math.round(sample.ttftMs),
      charsPerSec: Math.round(sample.charsPerSec * 10) / 10,
      totalMs: Math.round(sample.totalMs),
      outputChars: Math.round(sample.outputChars),
    };

    pushBounded(this.perfSamples, entry);
    let list = this.perfByModel.get(modelKey);
    if (list === undefined) {
      list = [];
      this.perfByModel.set(modelKey, list);
    }
    pushBounded(list, entry);
  }

  perfSummary(modelKey?: string): PerfSummary | null {
    const list = modelKey !== undefined ? this.perfByModel.get(modelKey) : this.perfSamples;
    if (!list || list.length === 0) return null;
    const avg = (pick: (s: PerfSample) => number) =>
      list.reduce((sum, s) => sum + pick(s), 0) / list.length;
    const last = list[list.length - 1]!;
    return {
      samples: list.length,
      ttftMs: Math.round(avg((s) => s.ttftMs)),
      charsPerSec: Math.round(avg((s) => s.charsPerSec) * 10) / 10,
      totalMs: Math.round(avg((s) => s.totalMs)),
      lastTtftMs: last.ttftMs,
      lastCharsPerSec: last.charsPerSec,
    };
  }

  // ── Account overview + status DTO ───────────────────────────────────────

  invalidateAccountCache(): void {
    this.accountCache = null;
  }

  async getAccountOverview(force = false): Promise<AccountOverview> {
    if (
      !force &&
      this.accountCache !== null &&
      Date.now() - this.accountCache.fetchedAt < ACCOUNT_CACHE_TTL_MS
    ) {
      return this.accountCache.overview;
    }
    if (this.accountInflight !== null) return this.accountInflight;

    const run = this.gateway.fetchAccountOverview().then((overview) => {
      this.accountCache = { overview, fetchedAt: Date.now() };
      return overview;
    });

    this.accountInflight = run;
    const clear = () => {
      if (this.accountInflight === run) this.accountInflight = null;
    };
    run.then(clear, clear);
    return run;
  }

  async buildStatusResponse(force = false): Promise<SiteStatusResponse> {
    const base = {
      provider: this.site.provider,
      siteId: this.siteId,
      siteLabel: this.site.label,
      gateway: this.site.gateway,
    };

    const models = catalogForCard(this.catalog, this.disabledModels());
    const perf = this.perfSummary();
    const settings = settingsSnapshotOf(this.config());

    try {
      const context = await this.getAccountOverview(force);
      const remaining = context.quota.remaining ?? undefined;
      const total = context.quota.total ?? undefined;
      const used = context.quota.used ?? undefined;

      const entitlements: EntitlementItem[] = [];
      if (remaining !== undefined) {
        entitlements.push({
          key: 'credits',
          label: '积分',
          remain: remaining,
          ...(total !== undefined ? { size: total } : {}),
          unit: context.quota.unit || 'credits',
        });
      }

      const creditBaseline =
        remaining !== undefined && total === undefined
          ? this.updateCreditBaseline(remaining)
          : undefined;

      this.syncAuthState(true);

      return {
        ...base,
        status: 'signed-in',
        ...(context.degraded ? { degraded: true } : {}),
        ...(context.user?.name ? { nickname: context.user.name } : {}),
        ...(context.user?.username || context.user?.email
          ? { account: context.user.username ?? context.user.email ?? undefined }
          : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        ...(used !== undefined ? { used } : {}),
        ...(total !== undefined ? { total } : {}),
        ...(context.plan?.name ? { tierName: context.plan.name } : {}),
        ...(context.plan?.pid ? { tier: context.plan.pid } : {}),
        ...(typeof context.plan?.isPersonalVersion === 'boolean'
          ? { isPersonal: context.plan.isPersonalVersion }
          : {}),
        ...(context.plan?.nextDueDate ? { nextDueDate: context.plan.nextDueDate } : {}),
        ...(entitlements.length > 0 ? { entitlements } : {}),
        ...(creditBaseline !== undefined ? { creditBaseline } : {}),
        ...(models.length > 0 ? { models } : {}),
        ...(perf !== null ? { perf } : {}),
        settings,
      };
    } catch (error) {
      const retryable = isQwenError(error) && error.retryable;
      if (!retryable) {
        this.syncAuthState(false);
      }
      const errPayload: StatusErrorPayload = isQwenError(error)
        ? error.toJSON()
        : { code: 'UNKNOWN', message: redactSecrets(error) };
      return {
        ...base,
        status: retryable ? 'signed-in' : 'signed-out',
        ...(retryable ? { degraded: true } : {}),
        error: errPayload,
        ...(models.length > 0 ? { models } : {}),
        ...(perf !== null ? { perf } : {}),
        settings,
      };
    }
  }

  private updateCreditBaseline(remaining: number): number | undefined {
    if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
    if (CREDIT_BASELINE_SEED > this.maxObservedCredits) {
      this.maxObservedCredits = CREDIT_BASELINE_SEED;
    }
    if (remaining > this.maxObservedCredits) {
      this.maxObservedCredits = remaining;
    }
    return this.maxObservedCredits;
  }

  // ── Device flow login / logout ──────────────────────────────────────────

  getLoginStatus(): LoginStatusResponse {
    return {
      phase: this.loginSlot.phase,
      url: this.loginSlot.url,
      error: this.loginSlot.error,
      account: this.loginSlot.account,
      siteId: this.siteId,
      siteLabel: this.site.label,
    };
  }

  async startLogin(): Promise<LoginStartResponse> {
    if (this.loginSlot.phase === 'pending' && this.loginSlot.url !== null) {
      return { phase: 'pending', url: this.loginSlot.url, siteId: this.siteId };
    }

    // Cancel any stale controller before starting a new flow
    this.loginSlot.controller?.abort('restarted');

    const machineId = await getOrCreateMachineId(this.machineIdPath);
    const { verifier, challenge } = createPkce();
    const nonce = crypto.randomUUID();
    const authUrl = buildAuthUrl({
      siteId: this.siteId,
      challenge,
      nonce,
      machineId,
    });

    const controller = new AbortController();
    const epoch = this.loginSlot.epoch + 1;
    this.loginSlot = {
      phase: 'pending',
      url: authUrl,
      error: null,
      account: null,
      startedAt: Date.now(),
      controller,
      epoch,
    };

    void pollDeviceToken({
      siteId: this.siteId,
      nonce,
      verifier,
      fetchImpl: this.fetchImpl,
      signal: controller.signal,
    })
      .then(async (payload) => {
        if (this.loginSlot.epoch !== epoch) return;
        const cred = credentialFromPollPayload(payload, { siteId: this.siteId, machineId });
        await this.store.write(this.siteId, cred);
        if (this.loginSlot.epoch !== epoch) return;
        this.loginSlot.phase = 'ready';
        this.loginSlot.controller = null;
        this.loginSlot.account = {
          id: cred.user.id,
          name: cred.user.name,
          organizationId: cred.user.organizationId,
          email: cred.user.email,
        };
        this.invalidateAccountCache();
        this.syncAuthState(true, true);
        this.logger?.info?.(`dsh-qwenwork-connect: device login completed (${this.siteId})`);
        void this.refreshCatalog(true);
      })
      .catch((error) => {
        if (this.loginSlot.epoch !== epoch) return;
        this.loginSlot.phase = 'failed';
        this.loginSlot.controller = null;
        this.loginSlot.error = redactSecrets(error, 300);
        this.logger?.warn?.(
          `dsh-qwenwork-connect: device login failed (${this.siteId})`,
          this.loginSlot.error,
        );
      });

    return { phase: 'pending', url: authUrl, siteId: this.siteId };
  }

  resetLogin(): void {
    this.loginSlot.controller?.abort('reset');
    this.loginSlot = {
      phase: 'idle',
      url: null,
      error: null,
      account: null,
      startedAt: null,
      controller: null,
      epoch: this.loginSlot.epoch + 1,
    };
  }

  async logout(): Promise<{ removed: boolean }> {
    this.resetLogin();
    const removed = await this.store.clear(this.siteId);
    this.invalidateAccountCache();
    this.maxObservedCredits = 0;
    this.syncAuthState(false, true);
    this.logger?.info?.(
      `dsh-qwenwork-connect: 已退出登录（${this.site.label}）${removed ? '' : '（凭据原本不存在）'}`,
    );
    return { removed };
  }

  dispose(): void {
    if (this.catalogTimer !== null) {
      clearInterval(this.catalogTimer);
      this.catalogTimer = null;
    }
    this.resetLogin();
    this.gateway.dispose();
  }
}

function pushBounded<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > PERF_WINDOW) arr.shift();
}
