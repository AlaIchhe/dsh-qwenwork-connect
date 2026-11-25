#!/usr/bin/env node
/**
 * `dsh-qwenwork-connect login`   —— 在终端里跑一次 device flow。
 * `dsh-qwenwork-connect logout`  —— 删除本机凭据，退出登录。
 *
 * 登录会打印授权链接，等你在浏览器里选完账号和团队，把 token 写到
 * 该站点的凭据文件，插件的下一次请求就会用它。
 *
 * 两站账号不互通，因此**凭据分文件**：
 *   --site cn    → ~/.dsh/qwenwork-desktop.json   （.cn 公有云，默认）
 *   --site intl  → ~/.dsh/qwenwork-global.json    （.ai 国际版）
 *
 * 退出只删除凭据文件，保留 `~/.dsh/qwenwork-machine-id`（两站共用同一个
 * 机器标识：它标识的是这台机器，不是账号）。
 */

import fs from 'node:fs';
import { startDeviceLogin, resolveCredentialPath } from '../lib/login-device-flow.js';
import { SITE_IDS, siteOf, normalizeSiteId, isKnownSite } from '../lib/sites.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'login';

/** 取 `--flag value` 形态的参数值。 */
function flag(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return typeof value === 'string' && !value.startsWith('--') ? value : undefined;
}

if (command === '--help' || command === 'help' || command === '-h') {
  console.log(
    [
      '用法: dsh-qwenwork-connect <login|logout> [选项]',
      '',
      '选项:',
      '  --site <cn|intl>     选择站点（默认 cn）',
      '                       cn   = 千问办公 .cn 公有云（gateway.qwenwork.cn）',
      '                       intl = 千问办公国际版（gateway.qwenwork.ai）',
      '  --credential <path>  覆盖凭据文件路径',
      '',
      '示例:',
      '  npx dsh-qwenwork-connect login --site intl',
      '  npx dsh-qwenwork-connect logout --site intl',
    ].join('\n'),
  );
  process.exit(0);
}

if (command !== 'login' && command !== 'logout') {
  console.error('未知命令: ' + command + '（可用: login / logout）');
  process.exit(1);
}

const rawSite = flag('--site');
// CLI 与运行时不同：运行时对未知站点**静默回落**（不该因为一个参数拼错就
// 打断请求链路），但命令行里必须**明确报错**——否则用户以为登录了国际版，
// 实际写进了 .cn 的凭据文件。
if (rawSite !== undefined && !isKnownSite(rawSite)) {
  console.error('未知站点: ' + rawSite + '（可用: ' + SITE_IDS.join(' / ') + '）');
  process.exit(1);
}

const siteId = normalizeSiteId(rawSite);
const site = siteOf(siteId);
const credentialPath = resolveCredentialPath(flag('--credential'), { siteId });

if (command === 'logout') {
  try {
    fs.unlinkSync(credentialPath);
    console.log(`已退出登录（${site.label}），删除 ` + credentialPath);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      console.log(`当前未登录（${site.label}，凭据文件不存在）`);
    } else {
      console.error('退出登录失败: ' + error.message);
      process.exit(1);
    }
  }
  process.exit(0);
}

console.log(`站点: ${site.label}（${site.gateway}）\n`);
console.log('打开下面的链接，用已登录该站点的浏览器继续：\n');
const result = await startDeviceLogin({
  siteId,
  credentialPath,
  onUrl: (url) => console.log(url + '\n'),
});
const { credential } = result;
console.log('已写入 ' + result.credentialPath);
console.log('账号: ' + (credential.user.name ?? '(未知)') + (credential.user.organization_id ? ' / 组织 ' + credential.user.organization_id : ''));
console.log('到期: ' + (credential.expiresAt ?? '(未知)'));
