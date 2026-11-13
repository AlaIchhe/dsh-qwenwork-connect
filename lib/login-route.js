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
  resolveMachineId,
  writeCredential,
  DEFAULT_CREDENTIAL_PATH,
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
  const credentialPath = deps.credentialPath ?? DEFAULT_CREDENTIAL_PATH;
  const state = { phase: 'idle', url: null, error: null, account: null, startedAt: null };

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

      void pollDeviceToken({ nonce, verifier })
        .then((payload) => {
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

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => mount(), 'dsh-qwenwork-connect: device login routes');
    return;
  }
  try {
    mount();
  } catch (error) {
    void error;
  }
}
