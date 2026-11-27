/**
 * Schemastery plugin Config schema and pure model-preference helpers.
 * All hot-reloadable fields use `.volatile()` so edits take effect immediately
 * without restarting the plugin or disrupting active conversations.
 */

import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_FIRST_CONTENT_TIMEOUT_MS,
  DEFAULT_HEADER_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from '../core/gateway-client.js';
import type { CardModelItem } from '../shared/contracts.js';
import {
  SITE_IDS,
  describeModel,
  parseSiteId,
  type ModelCatalogEntry,
  type SiteId,
} from '../shared/sites.js';

export const PREFS_CONFIG_FIELD = 'disabledModels';
export const DEFAULT_MAX_AUTO_CONTINUES = 2;

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
    trustedHosts,
    timeouts,
    vpc,
    stallGuard,
    debugTrace,
  };
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

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}
