/**
 * Shared route paths and HTTP DTO contracts between host routes and browser client.
 */

import { SITE_CN, normalizeSiteId, type SiteId } from './sites.js';

export const PLUGIN_PACKAGE_NAME = 'dsh-qwenwork-connect';
export const PLUGIN_CORDIS_NAME = 'llm-qwenwork';
export const PLUGIN_SETTINGS_NS = 'qwenwork';

export const ROUTE_PREFIX = '/plugins/dsh-qwenwork-connect';
export const STATUS_PATH = `${ROUTE_PREFIX}/status`;
export const LOGIN_START_PATH = `${ROUTE_PREFIX}/login/start`;
export const LOGIN_STATUS_PATH = `${ROUTE_PREFIX}/login/status`;
export const LOGOUT_PATH = `${ROUTE_PREFIX}/logout`;
export const MODELS_TOGGLE_PATH = `${ROUTE_PREFIX}/models/toggle`;
export const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`;

export const STATUS_POLL_INTERVAL_MS = 60_000;
export const LOGIN_POLL_INTERVAL_MS = 2_000;
export const LOGIN_WAIT_TIMEOUT_MS = 180_000;

export function pathForSite(basePath: string, siteId: SiteId): string {
  return siteId === SITE_CN
    ? basePath
    : `${basePath}?site=${encodeURIComponent(siteId)}`;
}

export function siteFromRequestUrl(rawUrl: string | undefined): SiteId {
  if (typeof rawUrl !== 'string' || rawUrl === '') return SITE_CN;
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return SITE_CN;
  try {
    const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
    return normalizeSiteId(params.get('site'), SITE_CN);
  } catch {
    return SITE_CN;
  }
}

export interface StatusErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly recovery?: string;
  readonly retryable?: boolean;
}

export interface EntitlementItem {
  readonly key: string;
  readonly label: string;
  readonly remain?: number;
  readonly size?: number;
  readonly unit?: string;
}

export interface CardModelItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rate: number | null;
  readonly enabled: boolean;
  readonly isDefault?: boolean;
  readonly isRecommended?: boolean;
  readonly isNew?: boolean;
}

export interface PerfSummary {
  readonly samples: number;
  readonly ttftMs: number;
  readonly charsPerSec: number;
  readonly totalMs: number;
  readonly lastTtftMs: number;
  readonly lastCharsPerSec: number;
}

export interface PluginSettingsSnapshot {
  /** 0 = omit `parameters.max_tokens` and defer to upstream model default. */
  readonly maxOutputTokens: number;
  readonly stallGuardEnabled: boolean;
  readonly stallGuardMaxContinues: number;
  readonly headerTimeoutSec: number;
  readonly firstContentTimeoutSec: number;
  readonly idleTimeoutSec: number;
  readonly imageMaxTotalMiB: number;
  readonly imageMaxPerImageMiB: number;
  readonly imageMaxCount: number;
  readonly imageMaxPixels: number;
  readonly debugTraceEnabled: boolean;
}

export type PluginSettingsPatch = Partial<PluginSettingsSnapshot>;

export interface SettingsResponse {
  readonly ok: true;
  readonly settings: PluginSettingsSnapshot;
}

export interface SiteStatusResponse {
  readonly status: 'signed-in' | 'signed-out' | 'unavailable';
  readonly provider: string;
  readonly siteId: SiteId;
  readonly siteLabel: string;
  readonly gateway: string;
  readonly degraded?: boolean;
  readonly nickname?: string;
  readonly account?: string;
  readonly remaining?: number;
  readonly used?: number;
  readonly total?: number;
  readonly tierName?: string;
  readonly tier?: string | number;
  readonly isPersonal?: boolean;
  readonly nextDueDate?: string;
  readonly entitlements?: readonly EntitlementItem[];
  readonly creditBaseline?: number;
  readonly models?: readonly CardModelItem[];
  readonly perf?: PerfSummary;
  readonly settings?: PluginSettingsSnapshot;
  readonly error?: StatusErrorPayload;
}

export type LoginPhase = 'idle' | 'pending' | 'ready' | 'failed';

export interface LoginAccountSummary {
  readonly id: string | null;
  readonly name: string | null;
  readonly organizationId: string | null;
  readonly email: string | null;
}

export interface LoginStatusResponse {
  readonly phase: LoginPhase;
  readonly url: string | null;
  readonly error: string | null;
  readonly account: LoginAccountSummary | null;
  readonly siteId: SiteId;
  readonly siteLabel: string;
}

export interface LoginStartResponse {
  readonly phase: LoginPhase;
  readonly url: string;
  readonly siteId: SiteId;
}

export interface LogoutResponse {
  readonly ok: true;
  readonly removed: boolean;
  readonly siteId: SiteId;
  readonly siteLabel: string;
}

export interface ToggleModelRequest {
  readonly model: string;
  readonly enabled: boolean;
}

export interface ToggleModelResponse {
  readonly ok: true;
  readonly unchanged?: boolean;
  readonly siteId: SiteId;
  readonly model: string;
  readonly enabled: boolean;
}
