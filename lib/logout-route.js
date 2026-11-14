/**
 * 退出登录：设置卡片上点「退出登录」走这里。
 *
 * 只做一件事——删掉本机凭据文件，让下一次请求重新回到「未登录」。
 * 不吊销上游 token（千问办公没有公开的吊销接口），但 token 离开本机后
 * 已经无法再被本插件使用；设备标识 `~/.dsh/qwenwork-machine-id` 刻意保留，
 * 这样重新登录不会换设备。
 *
 * 安全边界与登录 / 状态路由一致：只接受环回请求；错误文本不回显凭据内容。
 *
 * @module dsh-qwenwork-connect/logout-route
 */

import fs from 'node:fs';
import { loopbackRequest } from './loopback.js';
import { resolveCredentialPath } from './login-device-flow.js';

export const LOGOUT_PATH = '/plugins/dsh-qwenwork-connect/logout';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * @param {any} ctx 已注入 webServer 的上下文
 * @param {{ logger?: any, credentialPath?: string, onLogout?: () => void }} [deps]
 */
export function registerLogoutRoute(ctx, deps = {}) {
  const credentialPath = resolveCredentialPath(deps.credentialPath);

  const handle = (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'loopback only' });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'POST only' });
      return;
    }

    try {
      let removed = false;
      try {
        fs.unlinkSync(credentialPath);
        removed = true;
      } catch (error) {
        // 已经退出过 / 从来没登录过：幂等成功，不把「文件不存在」当失败。
        if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
      }

      try {
        deps.onLogout?.();
      } catch {
        // 内存态清理失败不应把「凭据已删除」判成退出失败。
      }

      deps.logger?.info?.(`dsh-qwenwork-connect: 已退出登录${removed ? '' : '（凭据文件原本不存在）'}`);
      json(res, 200, { ok: true, removed });
    } catch (error) {
      const message = String(/** @type {any} */ (error)?.message ?? error).slice(0, 300);
      deps.logger?.warn?.('dsh-qwenwork-connect: 退出登录失败', message);
      json(res, 500, { error: message });
    }
  };

  const mount = () => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: LOGOUT_PATH,
      handler: handle,
    });
    return dispose;
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => mount(), 'dsh-qwenwork-connect: device logout route');
    return;
  }
  try {
    mount();
  } catch (error) {
    void error;
  }
}
