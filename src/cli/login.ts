/**
 * Headless CLI for QwenWork device-flow login / logout / status.
 *
 * Usage:
 *   npx dsh-qwenwork-connect login [--site cn|intl] [--credential <path>]
 *   npx dsh-qwenwork-connect logout [--site cn|intl] [--credential <path>]
 *   npx dsh-qwenwork-connect status [--site cn|intl] [--credential <path>]
 */

import {
  FileCredentialStore,
  resolveSiteCredentialPath,
} from '../core/credentials.js';
import { startDeviceLogin } from '../core/device-flow.js';
import { GatewayClient } from '../core/gateway-client.js';
import {
  SITE_CN,
  SITE_IDS,
  isKnownSite,
  normalizeSiteId,
  siteOf,
} from '../shared/sites.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'login';

function readFlag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return typeof value === 'string' && !value.startsWith('--') ? value : undefined;
}

if (command === '--help' || command === 'help' || command === '-h') {
  console.log(
    [
      '用法: dsh-qwenwork-connect <login|logout|status> [选项]',
      '',
      '选项:',
      '  --site <cn|intl>     选择站点（默认 cn）',
      '                       cn   = 千问办公 .cn 公有云（gateway.qwenwork.cn）',
      '                       intl = 千问办公国际版（gateway.qwenwork.ai）',
      '  --credential <path>  覆盖凭据文件路径',
      '',
      '示例:',
      '  npx dsh-qwenwork-connect login --site intl',
      '  npx dsh-qwenwork-connect status --site cn',
      '  npx dsh-qwenwork-connect logout --site intl',
    ].join('\n'),
  );
  process.exit(0);
}

if (command !== 'login' && command !== 'logout' && command !== 'status') {
  console.error(`未知命令: ${command}（可用: login / logout / status）`);
  process.exit(1);
}

const rawSite = readFlag('--site');
if (rawSite !== undefined && !isKnownSite(rawSite)) {
  console.error(`未知站点: ${rawSite}（可用: ${SITE_IDS.join(' / ')}）`);
  process.exit(1);
}

const siteId = normalizeSiteId(rawSite, SITE_CN);
const site = siteOf(siteId);
const explicitPath = readFlag('--credential');
const credentialPath = resolveSiteCredentialPath(siteId, explicitPath);
const store = new FileCredentialStore({ pathForSite: () => credentialPath });

if (command === 'logout') {
  const removed = await store.clear(siteId);
  if (removed) {
    console.log(`已退出登录（${site.label}），删除 ${credentialPath}`);
  } else {
    console.log(`当前未登录（${site.label}，凭据文件不存在）`);
  }
  process.exit(0);
}

if (command === 'status') {
  const cred = await store.read(siteId);
  if (!cred) {
    console.log(`未登录（${site.label}，路径: ${credentialPath}）`);
    process.exit(0);
  }
  const client = new GatewayClient({ siteId, store });
  try {
    const overview = await client.fetchAccountOverview();
    console.log(`站点: ${site.label}（${site.gateway}）`);
    console.log(`账号: ${overview.user?.name ?? cred.user.name ?? '(未知)'}`);
    if (overview.plan?.name) console.log(`套餐: ${overview.plan.name}`);
    if (overview.quota.remaining !== null) console.log(`剩余积分: ${overview.quota.remaining}`);
  } catch (error) {
    console.error(`读取账号状态失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    client.dispose();
  }
  process.exit(0);
}

console.log(`站点: ${site.label}（${site.gateway}）\n`);
console.log('打开下面的链接，用已登录该站点的浏览器继续：\n');

const result = await startDeviceLogin({
  siteId,
  store,
  onUrl: (url) => console.log(`${url}\n`),
});

console.log(`已写入 ${credentialPath}`);
console.log(
  `账号: ${result.credential.user.name ?? '(未知)'}${
    result.credential.user.organizationId ? ` / 组织 ${result.credential.user.organizationId}` : ''
  }`,
);
console.log(`到期: ${result.credential.expiresAt ?? '(未知)'}`);
