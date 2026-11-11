#!/usr/bin/env node
/**
 * `dsh-qwenwork-connect login` —— 在终端里跑一次 device flow。
 *
 * 打印授权链接，等你在浏览器里选完账号和团队，把 token 写到
 * `~/.dsh/qwenwork-desktop.json`，插件的下一次请求就会用它。
 */

import { startDeviceLogin, DEFAULT_CREDENTIAL_PATH } from '../lib/login-device-flow.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'login';

if (command === '--help' || command === 'help') {
  console.log('用法: dsh-qwenwork-connect login [--credential <path>]');
  process.exit(0);
}

if (command !== 'login') {
  console.error('未知命令: ' + command);
  process.exit(1);
}

const flagIndex = args.indexOf('--credential');
const credentialPath = flagIndex >= 0 ? args[flagIndex + 1] : DEFAULT_CREDENTIAL_PATH;

console.log('打开下面的链接，用已登录千问办公的浏览器继续：\n');
const result = await startDeviceLogin({
  credentialPath,
  onUrl: (url) => console.log(url + '\n'),
});
const { credential } = result;
console.log('已写入 ' + result.credentialPath);
console.log('账号: ' + (credential.user.name ?? '(未知)') + (credential.user.organization_id ? ' / 组织 ' + credential.user.organization_id : ''));
console.log('到期: ' + (credential.expiresAt ?? '(未知)'));
