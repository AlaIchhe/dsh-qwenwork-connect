/**
 * Single source of truth for QwenWork site presets and model metadata helpers.
 * Shared across host, core, CLI, and browser client bundles.
 */

export const SITE_CN = 'cn' as const;
export const SITE_INTL = 'intl' as const;
export const SITE_IDS = [SITE_CN, SITE_INTL] as const;

export type SiteId = (typeof SITE_IDS)[number];

export const MAX_INPUT_TOKENS = 1_000_000;
export const MAX_OUTPUT_TOKENS = 32_000;

export interface ModelCatalogEntry {
  readonly id: string;
  readonly displayNameId?: string;
  readonly shortName: string;
  readonly description?: string;
  readonly billingRate: number | null;
  readonly supportsImages: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly isDefault?: boolean;
  readonly isRecommended?: boolean;
  readonly isNew?: boolean;
}

export interface SitePreset {
  readonly id: SiteId;
  readonly label: string;
  readonly provider: string;
  readonly gateway: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly cosyVersion: string;
  readonly appVersion: string;
  readonly appReleaseVersion: string;
  readonly appBuild: string;
  readonly credentialFile: string;
  readonly envCredentialFile: string;
  readonly machineIdFile: string;
  readonly wallets: boolean;
  readonly fallbackModels: readonly ModelCatalogEntry[];
}

const CN_FALLBACK_MODELS: readonly ModelCatalogEntry[] = Object.freeze([
  Object.freeze({
    id: 'pro',
    shortName: '高级',
    billingRate: 1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isDefault: true,
  }),
  Object.freeze({
    id: 'flash',
    displayNameId: 'qwen3.8-flash',
    shortName: '标准｜Qwen3.8-Flash',
    billingRate: 0.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isRecommended: true,
  }),
  Object.freeze({
    id: 'frontier-1',
    shortName: 'Qwen4-Max 预览',
    billingRate: 0.4,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isNew: true,
  }),
  Object.freeze({
    id: 'qwen3.8-max-preview',
    shortName: 'Qwen3.8-Max',
    billingRate: 1.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isNew: true,
  }),
]);

const INTL_FALLBACK_MODELS: readonly ModelCatalogEntry[] = Object.freeze([
  Object.freeze({
    id: 'qwork-advanced',
    shortName: 'Pro',
    billingRate: null,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isDefault: true,
  }),
  Object.freeze({
    id: 'qwork-auto',
    shortName: 'Standard｜Qwen3.8-Flash',
    billingRate: null,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    isRecommended: true,
  }),
  Object.freeze({
    id: 'qwork-ultimate',
    shortName: 'Flagship',
    billingRate: null,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
  }),
]);

export const SITES: Readonly<Record<SiteId, SitePreset>> = Object.freeze({
  [SITE_CN]: Object.freeze({
    id: SITE_CN,
    label: 'QwenWork',
    provider: 'qwenwork',
    gateway: 'https://gateway.qwenwork.cn',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    redirectUri: 'qwenwork-cn://',
    cosyVersion: '1.1.32',
    appVersion: '1.0.5',
    appReleaseVersion: '1.0.5-26090806',
    appBuild: '26090806',
    credentialFile: 'qwenwork-desktop.json',
    envCredentialFile: 'QWENWORK_CREDENTIAL_FILE',
    machineIdFile: 'qwenwork-machine-id',
    wallets: true,
    fallbackModels: CN_FALLBACK_MODELS,
  }),
  [SITE_INTL]: Object.freeze({
    id: SITE_INTL,
    label: 'QwenWork Global',
    provider: 'qwenwork-intl',
    gateway: 'https://gateway.qwenwork.ai',
    clientId: 'cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a',
    redirectUri: 'qwenwork://',
    cosyVersion: '1.1.71',
    appVersion: '1.4.1',
    appReleaseVersion: '1.4.1-26111002',
    appBuild: '26111002',
    credentialFile: 'qwenwork-global.json',
    envCredentialFile: 'QWENWORK_INTL_CREDENTIAL_FILE',
    machineIdFile: 'qwenwork-machine-id',
    wallets: false,
    fallbackModels: INTL_FALLBACK_MODELS,
  }),
});

const SITE_ALIASES: Readonly<Record<string, SiteId>> = Object.freeze({
  cn: SITE_CN,
  china: SITE_CN,
  qwenwork: SITE_CN,
  'qwenwork-cn': SITE_CN,
  intl: SITE_INTL,
  global: SITE_INTL,
  ai: SITE_INTL,
  international: SITE_INTL,
  'qwenwork-intl': SITE_INTL,
  'qwenwork-global': SITE_INTL,
});

export function parseSiteId(value: unknown): SiteId | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toLowerCase();
  return raw === '' ? undefined : SITE_ALIASES[raw];
}

export function normalizeSiteId(value: unknown, fallback: SiteId = SITE_CN): SiteId {
  return parseSiteId(value) ?? fallback;
}

export function isKnownSite(value: unknown): boolean {
  return parseSiteId(value) !== undefined;
}

export function siteOf(siteId: SiteId): SitePreset {
  return SITES[siteId];
}

export function siteIdOfProvider(provider: unknown): SiteId | undefined {
  if (typeof provider !== 'string') return undefined;
  return SITE_IDS.find((id) => SITES[id].provider === provider);
}

export function allProviderIds(sites: readonly SiteId[] = SITE_IDS): string[] {
  return sites.map((id) => SITES[id].provider);
}

export function formatBillingRate(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  if (rate === 0) return '免费';
  return `x${rate.toFixed(2)}`;
}

export function formatModelDisplayName(entry: ModelCatalogEntry): string {
  const parts = [entry.shortName || entry.id];
  const rate = formatBillingRate(entry.billingRate);
  if (rate !== '') parts.push(rate);
  if (entry.isDefault === true) parts.push('默认');
  if (entry.isRecommended === true) parts.push('推荐');
  if (entry.isNew === true) parts.push('新');
  return parts.join(' · ');
}

export function describeModel(entry: ModelCatalogEntry): string {
  const rate = formatBillingRate(entry.billingRate);
  const ctx = entry.contextWindow >= 1_000_000
    ? '1M'
    : `${Math.round(entry.contextWindow / 1000)}K`;
  return [
    entry.supportsImages ? '视觉' : '仅文本',
    ctx,
    rate === '' ? undefined : rate,
  ]
    .filter((item): item is string => typeof item === 'string' && item !== '')
    .join(' · ');
}

export function normalizeModelKey(
  model: string,
  catalog: readonly ModelCatalogEntry[],
): string {
  const hit = catalog.find((entry) => entry.id === model || entry.displayNameId === model);
  return hit?.id ?? model;
}
