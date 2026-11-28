/**
 * Schemastery plugin Config schema and pure model-preference / runtime-settings helpers.
 * All hot-reloadable fields use `.volatile()` so edits take effect immediately
 * without restarting the plugin or disrupting active conversations.
 */

import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_FIRST_CONTENT_TIMEOUT_MS,
  DEFAULT_HEADER_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from '../core/gateway-client.js';
import type {
  CardModelItem,
  PluginSettingsPatch,
  PluginSettingsSnapshot,
} from '../shared/contracts.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  HARD_MAX_OUTPUT_TOKENS,
  SITE_IDS,
  describeModel,
  parseSiteId,
  type ModelCatalogEntry,
  type SiteId,
} from '../shared/sites.js';

export const PREFS_CONFIG_FIELD = 'disabledModels';
export const DEFAULT_MAX_AUTO_CONTINUES = 2;

export const DEFAULT_IMAGE_MAX_TOTAL_BYTES = 6 * 1024 * 1024;
export const DEFAULT_IMAGE_MAX_PER_IMAGE_BYTES = 1 * 1024 * 1024;
export const DEFAULT_IMAGE_MAX_COUNT = 32;
export const DEFAULT_IMAGE_PIXEL_BUDGET = 4_194_304; // 2048 x 2048

export const SETTINGS_BOUNDS = Object.freeze({
  minOutputTokens: 256,
  maxOutputTokens: HARD_MAX_OUTPUT_TOKENS,
  maxStallContinues: 10,
  minTimeoutSec: 5,
  maxTimeoutSec: 3600,
  minImageTotalMiB: 1,
  maxImageTotalMiB: 64,
  minImagePerMiB: 1,
  maxImagePerMiB: 16,
  minImageCount: 1,
  maxImageCount: 64,
  minImagePixels: 262_144, // 512 x 512
  maxImagePixels: 16_777_216, // 4096 x 4096
});

const BYTES_PER_MIB = 1024 * 1024;

export const Config = z.object({
  enabledSites: z
    .array(z.union([z.const('cn'), z.const('intl')]))
    .default(['cn', 'intl'])
    .description('启用的千问办公站点（cn = 国内版，intl = 国际版）'),
  disabledModels: z
    .dict(z.array(z.string()))
    .default({})
    .volatile()
    .description('按站点记录已停用的模型 key（如 { cn: ["flash"] }）'),
  generation: z
    .object({
      maxOutputTokens: z.number().default(DEFAULT_MAX_OUTPUT_TOKENS),
    })
    .default({ maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS })
    .volatile()
    .description('生成参数：maxOutputTokens（0 = 不传 max_tokens 由上游决定；默认 131072，思考与正文共享）'),
  images: z
    .object({
      maxTotalBytes: z.number().default(DEFAULT_IMAGE_MAX_TOTAL_BYTES),
      maxPerImageBytes: z.number().default(DEFAULT_IMAGE_MAX_PER_IMAGE_BYTES),
      maxImages: z.number().default(DEFAULT_IMAGE_MAX_COUNT),
      pixelBudget: z.number().default(DEFAULT_IMAGE_PIXEL_BUDGET),
    })
    .default({
      maxTotalBytes: DEFAULT_IMAGE_MAX_TOTAL_BYTES,
      maxPerImageBytes: DEFAULT_IMAGE_MAX_PER_IMAGE_BYTES,
      maxImages: DEFAULT_IMAGE_MAX_COUNT,
      pixelBudget: DEFAULT_IMAGE_PIXEL_BUDGET,
    })
    .volatile()
    .description('视觉请求图片预算：单次总字节、单张字节、最大张数与单图像素预算'),
  trustedHosts: z
    .array(z.string())
    .default([])
    .volatile()
    .description('额外信任的反向代理 Host 域名列表（本地插件 HTTP 路由放行用）'),
  timeouts: z
    .object({
      headerMs: z.number().default(DEFAULT_HEADER_TIMEOUT_MS),
      firstContentMs: z.number().default(DEFAULT_FIRST_CONTENT_TIMEOUT_MS),
      idleMs: z.number().default(DEFAULT_IDLE_TIMEOUT_MS),
    })
    .default({
      headerMs: DEFAULT_HEADER_TIMEOUT_MS,
      firstContentMs: DEFAULT_FIRST_CONTENT_TIMEOUT_MS,
      idleMs: DEFAULT_IDLE_TIMEOUT_MS,
    })
    .volatile()
    .description('上游响应头 / 首帧 / 流空闲超时（毫秒）'),
  vpc: z
    .object({
      caCertPath: z.string().default(''),
      insecureTls: z.boolean().default(false),
    })
    .default({ caCertPath: '', insecureTls: false })
    .volatile()
    .description('企业 VPC 网关 TLS 配置：推荐配置自签根证书路径 caCertPath，或显式开启 insecureTls'),
  stallGuard: z
    .object({
      enabled: z.boolean().default(true),
      maxContinues: z.number().default(DEFAULT_MAX_AUTO_CONTINUES),
    })
    .default({ enabled: true, maxContinues: DEFAULT_MAX_AUTO_CONTINUES })
    .volatile()
    .description('「只说不做」自动续跑守卫开关与单轮最大续跑次数'),
  debugTrace: z
    .object({
      enabled: z.boolean().default(false),
      logPath: z.string().default(''),
    })
    .default({ enabled: false, logPath: '' })
    .volatile()
    .description('请求级异步诊断日志（默认关闭）'),
});

export interface ResolvedPluginConfig {
  readonly enabledSites: readonly SiteId[];
  readonly disabledModels: Readonly<Record<string, readonly string[]>>;
  readonly generation: {
    /** 0 = omit `parameters.max_tokens` (defer to upstream model default). */
    readonly maxOutputTokens: number;
  };
  readonly images: {
    readonly maxTotalBytes: number;
    readonly maxPerImageBytes: number;
    readonly maxImages: number;
    readonly pixelBudget: number;
  };
  readonly trustedHosts: readonly string[];
  readonly timeouts: {
    readonly headerMs: number;
    readonly firstContentMs: number;
    readonly idleMs: number;
  };
  readonly vpc: {
    readonly caCertPath: string;
    readonly insecureTls: boolean;
  };
  readonly stallGuard: {
    readonly enabled: boolean;
    readonly maxContinues: number;
  };
  readonly debugTrace: {
    readonly enabled: boolean;
    readonly logPath: string;
  };
}

function unwrap<T>(field: unknown): T | undefined {
  if (field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get: () => T }).get();
  }
  return field as T | undefined;
}

export function readPluginConfig(rawConfig: unknown): ResolvedPluginConfig {
  const cfg = (rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}) as Record<string, unknown>;

  const rawSites = unwrap<unknown[]>(cfg.enabledSites);
  const enabledSites: SiteId[] = Array.isArray(rawSites)
    ? [...new Set(rawSites.map((s) => parseSiteId(s)).filter((s): s is SiteId => s !== undefined))]
    : [...SITE_IDS];

  const disabledModels = disabledDict(rawConfig);

  const rawGeneration = unwrap<Record<string, unknown>>(cfg.generation) ?? {};
  const generation = {
    maxOutputTokens: maxOutputTokensOr(rawGeneration.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
  };

  const rawImages = unwrap<Record<string, unknown>>(cfg.images) ?? {};
  const maxPerImageBytes = positiveIntOr(rawImages.maxPerImageBytes, DEFAULT_IMAGE_MAX_PER_IMAGE_BYTES);
  const maxTotalBytes = Math.max(
    maxPerImageBytes,
    positiveIntOr(rawImages.maxTotalBytes, DEFAULT_IMAGE_MAX_TOTAL_BYTES),
  );
  const images = {
    maxTotalBytes,
    maxPerImageBytes,
    maxImages: positiveIntOr(rawImages.maxImages, DEFAULT_IMAGE_MAX_COUNT),
    pixelBudget: positiveIntOr(rawImages.pixelBudget, DEFAULT_IMAGE_PIXEL_BUDGET),
  };

  const rawHosts = unwrap<unknown[]>(cfg.trustedHosts);
  const trustedHosts = Array.isArray(rawHosts)
    ? rawHosts.filter((h): h is string => typeof h === 'string' && h.trim() !== '').map((h) => h.trim().toLowerCase())
    : [];

  const rawTimeouts = unwrap<Record<string, unknown>>(cfg.timeouts) ?? {};
  const timeouts = {
    headerMs: positiveOr(rawTimeouts.headerMs, DEFAULT_HEADER_TIMEOUT_MS),
    firstContentMs: positiveOr(rawTimeouts.firstContentMs, DEFAULT_FIRST_CONTENT_TIMEOUT_MS),
    idleMs: positiveOr(rawTimeouts.idleMs, DEFAULT_IDLE_TIMEOUT_MS),
  };

  const rawVpc = unwrap<Record<string, unknown>>(cfg.vpc) ?? {};
  const vpc = {
    caCertPath: typeof rawVpc.caCertPath === 'string' ? rawVpc.caCertPath.trim() : '',
    insecureTls: rawVpc.insecureTls === true,
  };

  const rawStall = unwrap<Record<string, unknown>>(cfg.stallGuard) ?? {};
  const stallGuard = {
    enabled: rawStall.enabled !== false,
    maxContinues: nonNegIntOr(rawStall.maxContinues, DEFAULT_MAX_AUTO_CONTINUES),
  };

  const rawTrace = unwrap<Record<string, unknown>>(cfg.debugTrace) ?? {};
  const debugTrace = {
    enabled: rawTrace.enabled === true,
    logPath: typeof rawTrace.logPath === 'string' ? rawTrace.logPath.trim() : '',
  };

  return {
    enabledSites: enabledSites.length > 0 ? enabledSites : [...SITE_IDS],
    disabledModels,
    generation,
    images,
    trustedHosts,
    timeouts,
    vpc,
    stallGuard,
    debugTrace,
  };
}

export function defaultSettingsSnapshot(): PluginSettingsSnapshot {
  return settingsSnapshotOf(readPluginConfig({}));
}

export function settingsSnapshotOf(cfg: ResolvedPluginConfig): PluginSettingsSnapshot {
  return {
    maxOutputTokens: cfg.generation.maxOutputTokens,
    stallGuardEnabled: cfg.stallGuard.enabled,
    stallGuardMaxContinues: cfg.stallGuard.maxContinues,
    headerTimeoutSec: Math.max(1, Math.round(cfg.timeouts.headerMs / 1000)),
    firstContentTimeoutSec: Math.max(1, Math.round(cfg.timeouts.firstContentMs / 1000)),
    idleTimeoutSec: Math.max(1, Math.round(cfg.timeouts.idleMs / 1000)),
    imageMaxTotalMiB: Math.max(1, Math.round(cfg.images.maxTotalBytes / BYTES_PER_MIB)),
    imageMaxPerImageMiB: Math.max(1, Math.round(cfg.images.maxPerImageBytes / BYTES_PER_MIB)),
    imageMaxCount: cfg.images.maxImages,
    imageMaxPixels: cfg.images.pixelBudget,
    debugTraceEnabled: cfg.debugTrace.enabled,
  };
}

export type SettingsPatchValidation =
  | { readonly ok: true; readonly patch: PluginSettingsPatch }
  | { readonly ok: false; readonly error: string };

export function validateSettingsPatch(input: unknown): SettingsPatchValidation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const rec = input as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if ('maxOutputTokens' in rec) {
    const n = rec.maxOutputTokens;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      (n !== 0 && (n < SETTINGS_BOUNDS.minOutputTokens || n > SETTINGS_BOUNDS.maxOutputTokens))
    ) {
      return {
        ok: false,
        error: `maxOutputTokens 必须为 0（上游默认）或 ${SETTINGS_BOUNDS.minOutputTokens}–${SETTINGS_BOUNDS.maxOutputTokens} 之间的整数`,
      };
    }
    patch.maxOutputTokens = n;
  }

  if ('stallGuardEnabled' in rec) {
    if (typeof rec.stallGuardEnabled !== 'boolean') {
      return { ok: false, error: 'stallGuardEnabled 必须是布尔值' };
    }
    patch.stallGuardEnabled = rec.stallGuardEnabled;
  }

  if ('stallGuardMaxContinues' in rec) {
    const n = rec.stallGuardMaxContinues;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > SETTINGS_BOUNDS.maxStallContinues) {
      return {
        ok: false,
        error: `stallGuardMaxContinues 必须是 0–${SETTINGS_BOUNDS.maxStallContinues} 之间的整数`,
      };
    }
    patch.stallGuardMaxContinues = n;
  }

  for (const field of ['headerTimeoutSec', 'firstContentTimeoutSec', 'idleTimeoutSec'] as const) {
    if (field in rec) {
      const n = rec[field];
      if (
        typeof n !== 'number' ||
        !Number.isInteger(n) ||
        n < SETTINGS_BOUNDS.minTimeoutSec ||
        n > SETTINGS_BOUNDS.maxTimeoutSec
      ) {
        return {
          ok: false,
          error: `${field} 必须是 ${SETTINGS_BOUNDS.minTimeoutSec}–${SETTINGS_BOUNDS.maxTimeoutSec} 秒之间的整数`,
        };
      }
      patch[field] = n;
    }
  }

  if ('imageMaxPerImageMiB' in rec) {
    const n = rec.imageMaxPerImageMiB;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < SETTINGS_BOUNDS.minImagePerMiB ||
      n > SETTINGS_BOUNDS.maxImagePerMiB
    ) {
      return {
        ok: false,
        error: `imageMaxPerImageMiB 必须是 ${SETTINGS_BOUNDS.minImagePerMiB}–${SETTINGS_BOUNDS.maxImagePerMiB} 之间的整数`,
      };
    }
    patch.imageMaxPerImageMiB = n;
  }

  if ('imageMaxTotalMiB' in rec) {
    const n = rec.imageMaxTotalMiB;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < SETTINGS_BOUNDS.minImageTotalMiB ||
      n > SETTINGS_BOUNDS.maxImageTotalMiB
    ) {
      return {
        ok: false,
        error: `imageMaxTotalMiB 必须是 ${SETTINGS_BOUNDS.minImageTotalMiB}–${SETTINGS_BOUNDS.maxImageTotalMiB} 之间的整数`,
      };
    }
    patch.imageMaxTotalMiB = n;
  }

  if ('imageMaxCount' in rec) {
    const n = rec.imageMaxCount;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < SETTINGS_BOUNDS.minImageCount ||
      n > SETTINGS_BOUNDS.maxImageCount
    ) {
      return {
        ok: false,
        error: `imageMaxCount 必须是 ${SETTINGS_BOUNDS.minImageCount}–${SETTINGS_BOUNDS.maxImageCount} 之间的整数`,
      };
    }
    patch.imageMaxCount = n;
  }

  if ('imageMaxPixels' in rec) {
    const n = rec.imageMaxPixels;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < SETTINGS_BOUNDS.minImagePixels ||
      n > SETTINGS_BOUNDS.maxImagePixels
    ) {
      return {
        ok: false,
        error: `imageMaxPixels 必须是 ${SETTINGS_BOUNDS.minImagePixels}–${SETTINGS_BOUNDS.maxImagePixels} 之间的整数`,
      };
    }
    patch.imageMaxPixels = n;
  }

  if ('debugTraceEnabled' in rec) {
    if (typeof rec.debugTraceEnabled !== 'boolean') {
      return { ok: false, error: 'debugTraceEnabled 必须是布尔值' };
    }
    patch.debugTraceEnabled = rec.debugTraceEnabled;
  }

  if (
    typeof patch.imageMaxPerImageMiB === 'number' &&
    typeof patch.imageMaxTotalMiB === 'number' &&
    patch.imageMaxTotalMiB < patch.imageMaxPerImageMiB
  ) {
    return { ok: false, error: '图片总大小上限不能小于单张上限' };
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: '未提供任何可更新的参数字段' };
  }

  return { ok: true, patch: patch as PluginSettingsPatch };
}

export function nextSettingsRawConfig(
  currentRaw: unknown,
  patch: PluginSettingsPatch,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    currentRaw !== null && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
      ? { ...(currentRaw as Record<string, unknown>) }
      : {};
  const resolved = readPluginConfig(base);

  if (patch.maxOutputTokens !== undefined) {
    const prev = asPlainObject(unwrap(base.generation));
    base.generation = { ...prev, maxOutputTokens: patch.maxOutputTokens };
  }

  if (patch.stallGuardEnabled !== undefined || patch.stallGuardMaxContinues !== undefined) {
    const prev = asPlainObject(unwrap(base.stallGuard));
    base.stallGuard = {
      ...prev,
      enabled: patch.stallGuardEnabled ?? resolved.stallGuard.enabled,
      maxContinues: patch.stallGuardMaxContinues ?? resolved.stallGuard.maxContinues,
    };
  }

  if (
    patch.headerTimeoutSec !== undefined ||
    patch.firstContentTimeoutSec !== undefined ||
    patch.idleTimeoutSec !== undefined
  ) {
    const prev = asPlainObject(unwrap(base.timeouts));
    base.timeouts = {
      ...prev,
      headerMs:
        patch.headerTimeoutSec !== undefined
          ? patch.headerTimeoutSec * 1000
          : resolved.timeouts.headerMs,
      firstContentMs:
        patch.firstContentTimeoutSec !== undefined
          ? patch.firstContentTimeoutSec * 1000
          : resolved.timeouts.firstContentMs,
      idleMs:
        patch.idleTimeoutSec !== undefined
          ? patch.idleTimeoutSec * 1000
          : resolved.timeouts.idleMs,
    };
  }

  if (
    patch.imageMaxTotalMiB !== undefined ||
    patch.imageMaxPerImageMiB !== undefined ||
    patch.imageMaxCount !== undefined ||
    patch.imageMaxPixels !== undefined
  ) {
    const prev = asPlainObject(unwrap(base.images));
    const perBytes =
      patch.imageMaxPerImageMiB !== undefined
        ? patch.imageMaxPerImageMiB * BYTES_PER_MIB
        : resolved.images.maxPerImageBytes;
    const rawTotalBytes =
      patch.imageMaxTotalMiB !== undefined
        ? patch.imageMaxTotalMiB * BYTES_PER_MIB
        : resolved.images.maxTotalBytes;
    base.images = {
      ...prev,
      maxPerImageBytes: perBytes,
      maxTotalBytes: Math.max(perBytes, rawTotalBytes),
      maxImages: patch.imageMaxCount ?? resolved.images.maxImages,
      pixelBudget: patch.imageMaxPixels ?? resolved.images.pixelBudget,
    };
  }

  if (patch.debugTraceEnabled !== undefined) {
    const prev = asPlainObject(unwrap(base.debugTrace));
    base.debugTrace = {
      ...prev,
      enabled: patch.debugTraceEnabled,
    };
  }

  return base;
}

export function disabledDict(config: unknown): Record<string, string[]> {
  if (config === null || config === undefined || typeof config !== 'object') return {};
  const field = (config as Record<string, unknown>)[PREFS_CONFIG_FIELD];
  const value = unwrap<unknown>(field);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [siteId, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const keys = list.filter((k): k is string => typeof k === 'string' && k !== '');
    if (keys.length > 0) out[siteId] = [...new Set(keys)];
  }
  return out;
}

export function disabledForSite(config: unknown, siteId: SiteId): string[] {
  return disabledDict(config)[siteId] ?? [];
}

export function nextRawConfig(
  currentRaw: unknown,
  siteId: SiteId,
  modelKey: string,
  enabled: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    currentRaw !== null && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
      ? { ...(currentRaw as Record<string, unknown>) }
      : {};
  const dict = disabledDict(base);
  const list = [...(dict[siteId] ?? [])];
  const at = list.indexOf(modelKey);
  if (enabled) {
    if (at >= 0) list.splice(at, 1);
  } else if (at < 0) {
    list.push(modelKey);
  }
  if (list.length === 0) delete dict[siteId];
  else dict[siteId] = list;
  if (Object.keys(dict).length === 0) delete base[PREFS_CONFIG_FIELD];
  else base[PREFS_CONFIG_FIELD] = dict;
  return base;
}

export function filterEnabledModels(
  models: readonly ModelCatalogEntry[],
  disabled: readonly string[],
): ModelCatalogEntry[] {
  if (disabled.length === 0) return [...models];
  const set = new Set(disabled);
  return models.filter((m) => !set.has(m.id));
}

export function wouldLeaveNone(
  models: readonly ModelCatalogEntry[],
  disabled: readonly string[],
  modelKey: string,
  enabled: boolean,
): boolean {
  if (enabled) return false;
  const set = new Set(disabled);
  if (set.has(modelKey)) return false;
  return models.filter((m) => !set.has(m.id)).length <= 1;
}

export function catalogForCard(
  models: readonly ModelCatalogEntry[],
  disabled: readonly string[],
): CardModelItem[] {
  const off = new Set(disabled);
  return models.map((model) => ({
    id: model.id,
    name: model.shortName || model.id,
    description: describeModel(model),
    rate: model.billingRate,
    enabled: !off.has(model.id),
    ...(model.isDefault === true ? { isDefault: true } : {}),
    ...(model.isRecommended === true ? { isRecommended: true } : {}),
    ...(model.isNew === true ? { isNew: true } : {}),
  }));
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function maxOutputTokensOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value === 0) return 0;
  if (value >= SETTINGS_BOUNDS.minOutputTokens && value <= SETTINGS_BOUNDS.maxOutputTokens) {
    return value;
  }
  return fallback;
}
