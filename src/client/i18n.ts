import { SITE_CN, type SiteId } from '../shared/sites.js';

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

export const zh: Record<string, string> = {
  title: '千问办公',
  subtitle: '设备码登录，原生直连千问办公网关',
  siteCn: '国内版 .cn',
  siteIntl: '国际版 .ai',
  notSignedIn: '未登录',
  signedIn: '已登录',
  signedInAs: '已登录：{name}',
  loading: '正在读取状态…',
  refresh: '刷新',
  refreshing: '刷新中…',
  login: '登录',
  loggingIn: '等待授权…',
  loginHint: '尚未登录。点「登录」后，在浏览器里选择账号与团队。',
  loginWaiting: '已打开授权页，等待你在浏览器里完成授权…',
  loginTimeout: '登录超时，请重试',
  loginFailed: '登录失败',
  logout: '退出登录',
  loggingOut: '正在退出…',
  logoutConfirm: '确定要退出 {site} 的登录吗？该站点的本机凭据会被删除，可随时重新登录。',
  logoutFailed: '退出登录失败',
  accountHeading: '账号',
  credits: '积分',
  models: '可选模型',
  perfHeading: '上游速度',
  ttft: '首 token 延迟',
  speed: '输出速率',
  ms: '{value} 毫秒',
  charsPerSec: '{value} 字/秒',
  perfSampleNote: '基于最近 {count} 次对话实测',
  requestFailed: '读取插件状态失败',
  percentRemaining: '剩余 {percent}%',
  exactRemaining: '剩余 {remain} / {size}',
  peakLevel: '较峰值 {percent}%',
  creditBalance: '当前余额 {value}',
  modelSwitchLabel: '启用/停用',
  modelSwitchHint: '停用后该模型从模型选择器消失；进行中的会话改选其它模型',
  toggleFailed: '模型开关保存失败',
  badgeDefault: '默认',
  badgeRecommended: '推荐',
  badgeNew: '新',
  creditsUnavailable: '未登录',
  creditsDegraded: '积分暂不可用',
  composerTooltip: '千问办公剩余积分 · 打开左侧「插件」→ dsh-qwenwork-connect 查看详情',
};

export const en: Record<string, string> = {
  title: 'QwenWork',
  subtitle: 'Device-code sign-in, native QwenWork gateway adapter',
  siteCn: 'China (.cn)',
  siteIntl: 'Global (.ai)',
  notSignedIn: 'Not signed in',
  signedIn: 'Signed in',
  signedInAs: 'Signed in: {name}',
  loading: 'Reading status…',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  login: 'Sign in',
  loggingIn: 'Waiting for authorization…',
  loginHint: 'Not signed in. Click "Sign in" and choose an account and team in the browser.',
  loginWaiting: 'Authorization page opened; waiting for you to finish in the browser…',
  loginTimeout: 'Sign-in timed out. Please try again.',
  loginFailed: 'Sign-in failed',
  logout: 'Sign out',
  loggingOut: 'Signing out…',
  logoutConfirm:
    "Sign out of {site}? That site's local credentials will be removed; you can sign in again anytime.",
  logoutFailed: 'Sign-out failed',
  accountHeading: 'Account',
  credits: 'Credits',
  models: 'Available models',
  perfHeading: 'Upstream speed',
  ttft: 'First token',
  speed: 'Output rate',
  ms: '{value} ms',
  charsPerSec: '{value} chars/s',
  perfSampleNote: 'Measured over the last {count} conversations',
  requestFailed: 'Failed to read plugin status',
  percentRemaining: '{percent}% remaining',
  exactRemaining: '{remain} / {size} remaining',
  peakLevel: 'peak {percent}%',
  creditBalance: 'Current balance {value}',
  modelSwitchLabel: 'enable/disable',
  modelSwitchHint:
    'Disabling removes the model from the picker; switch active sessions to another model',
  toggleFailed: 'Failed to save the model switch',
  badgeDefault: 'Default',
  badgeRecommended: 'Recommended',
  badgeNew: 'New',
  creditsUnavailable: 'Signed out',
  creditsDegraded: 'Quota unavailable',
  composerTooltip: 'QwenWork credits remaining · see Plugins → dsh-qwenwork-connect',
};

export function siteLabel(t: TranslateFn, siteId: SiteId): string {
  return siteId === SITE_CN ? t('siteCn') : t('siteIntl');
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
