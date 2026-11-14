/**
 * 登录用的两条本地路由：设置卡片上点「登录」走这里。
 *
 * 安全边界与状态路由一致：只接受环回请求；不把 token 回给浏览器，
 * 只回 URL、阶段和账号摘要。
 *
 * @module dsh-qwenwork-connect/login-route
 */

import crypto from 'node:crypto';
import { loopbackRequest } from './loopback.js';
import {
  buildAuthUrl,
  createPkce,
  pollDeviceToken,
  resolveCredentialPath,
  resolveMachineId,
  writeCredential,
} from './login-device-flow.js';

export const LOGIN_START_PATH = '/plugins/dsh-qwenwork-connect/login/start';
export const LOGIN_STATUS_PATH = '/plugins/dsh-qwenwork-connect/login/status';

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
 * @param {{ logger?: any, credentialPath?: string, onLogin?: () => void }} [deps]
 */
export function registerDeviceLoginRoute(ctx, deps = {}) {
  const credentialPath = resolveCredentialPath(deps.credentialPath);
  const state = { phase: 'idle', url: null, error: null, account: null, startedAt: null };
  /**
   * 登录轮询的代际号：退出登录时 +1，让尚在途中的 device flow 结果作废。
   * 只改 `state` 不够——旧轮询拿到 token 后仍会写盘，把刚退出的账号又登回去。
   */
  let epoch = 0;

  const handle = (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'loopback only' });
      return;
    }
    const url = req.url ?? '';

    if (url.startsWith(LOGIN_STATUS_PATH)) {
      json(res, 200, { phase: state.phase, url: state.url, error: state.error, account: state.account });
      return;
    }

    if (url.startsWith(LOGIN_START_PATH)) {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST only' });
        return;
      }
      if (state.phase === 'pending' && typeof state.url === 'string') {
        json(res, 200, { phase: state.phase, url: state.url });
        return;
      }
      const machineId = resolveMachineId();
      const { verifier, challenge } = createPkce();
      const nonce = crypto.randomUUID();
      const authUrl = buildAuthUrl({ challenge, nonce, machineId });
      state.phase = 'pending';
      state.url = authUrl;
      state.error = null;
      state.account = null;
      state.startedAt = Date.now();

      const loginEpoch = epoch;
      void pollDeviceToken({ nonce, verifier })
        .then((payload) => {
          if (loginEpoch !== epoch) {
            // 等待期间用户已退出登录：丢弃这次授权结果，不写回凭据。
            return;
          }
          const written = writeCredential(payload, { machineId, credentialPath });
          state.phase = 'ready';
          state.account = {
            id: written.credential.user.id,
            name: written.credential.user.name,
            organizationId: written.credential.user.organization_id,
            email: written.credential.user.email,
          };
          deps.logger?.info?.('dsh-qwenwork-connect: device login completed');
          try {
            deps.onLogin?.();
          } catch {
            // 登录后的目录刷新失败不应影响登录结果
          }
        })
        .catch((error) => {
          if (loginEpoch !== epoch) return;
          state.phase = 'failed';
          state.error = String(error?.message ?? error).slice(0, 300);
          deps.logger?.warn?.('dsh-qwenwork-connect: device login failed', state.error);
        });

      json(res, 200, { phase: 'pending', url: authUrl });
      return;
    }

    json(res, 404, { error: 'not found' });
  };

  const mount = () => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: LOGIN_START_PATH, handler: handle }),
      ctx.webServer.register({ kind: 'exact', path: LOGIN_STATUS_PATH, handler: handle }),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          // 卸载期重复注销不是错误
        }
      }
    };
  };

  /** 退出登录时清空登录页状态，并让在途轮询作废。 */
  const reset = () => {
    epoch += 1;
    state.phase = 'idle';
    state.url = null;
    state.error = null;
    state.account = null;
    state.startedAt = null;
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => mount(), 'dsh-qwenwork-connect: device login routes');
    return { reset };
  }
  try {
    mount();
  } catch (error) {
    void error;
  }
  return { reset };
}
