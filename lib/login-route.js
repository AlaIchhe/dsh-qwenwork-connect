/**
 * 登录用的两条本地路由：设置卡片上点「登录」走这里。
 *
 * 安全边界与状态路由一致：只接受环回请求；不把 token 回给浏览器，
 * 只回 URL、阶段和账号摘要。
 *
 * ── 站点维度 ──────────────────────────────────────────────────────
 * 两个站点的登录流程**必须各走各的**：client id、deeplink scheme、网关
 * 都不同，而且账号不互通。因此这里按站点维护**独立的登录状态机**
 * （各自 pending / ready / failed 与各自的 epoch），互不干扰：
 * 在 .cn 登录到一半去点国际版的登录，不会把 .cn 的在途结果作废。
 *
 * 站点经 `?site=` 传入（见 status-paths.js 的 siteFromRequestUrl），
 * 缺省 .cn——因此老前端不带参数的请求行为完全不变。
 *
 * @module dsh-qwenwork-connect/login-route
 */

import crypto from 'node:crypto';
import { loopbackRequest } from './loopback.js';
import { siteFromRequestUrl, STATUS_SITE_IDS } from './status-paths.js';
import { DEFAULT_SITE_ID, siteOf } from './sites.js';
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

/** 一条干净的登录状态。 */
function idleState() {
  return { phase: 'idle', url: null, error: null, account: null, startedAt: null };
}

/**
 * @param {any} ctx 已注入 webServer 的上下文
 * @param {{
 *   logger?: any,
 *   credentialPath?: string | Record<string, string>,
 *   onLogin?: (siteId: string) => void,
 * }} [deps]
 *   `credentialPath` 传字符串时对所有站点生效（测试用）；传对象时按站点取。
 */
export function registerDeviceLoginRoute(ctx, deps = {}) {
  /**
   * 每个站点一份登录状态与一个代际号。
   *
   * 代际号的作用与单站点时相同：退出登录时 +1，让尚在途中的 device flow
   * 结果作废——只清 `state` 不够，旧轮询拿到 token 后仍会写盘，把刚退出的
   * 账号又登回去。
   *
   * @type {Map<string, { state: ReturnType<typeof idleState>, epoch: number }>}
   */
  const bySite = new Map(
    STATUS_SITE_IDS.map((id) => [id, { state: idleState(), epoch: 0 }]),
  );

  /** 取（必要时惰性创建）某站点的槽位。 */
  const slotOf = (siteId) => {
    const id = siteOf(siteId).id;
    let slot = bySite.get(id);
    if (slot === undefined) {
      slot = { state: idleState(), epoch: 0 };
      bySite.set(id, slot);
    }
    return slot;
  };

  /** 某站点的凭据文件路径（支持按站点覆盖，便于测试与多账号）。 */
  const credentialPathOf = (siteId) => {
    const override = deps.credentialPath;
    if (typeof override === 'string' && override !== '') {
      return resolveCredentialPath(override, { siteId });
    }
    if (override !== null && typeof override === 'object') {
      return resolveCredentialPath(override[siteId], { siteId });
    }
    return resolveCredentialPath(undefined, { siteId });
  };

  const handle = (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'loopback only' });
      return;
    }
    const url = req.url ?? '';
    const siteId = siteFromRequestUrl(url);
    const site = siteOf(siteId);
    const slot = slotOf(siteId);

    if (url.startsWith(LOGIN_STATUS_PATH)) {
      const s = slot.state;
      json(res, 200, {
        phase: s.phase,
        url: s.url,
        error: s.error,
        account: s.account,
        siteId,
        siteLabel: site.label,
      });
      return;
    }

    if (url.startsWith(LOGIN_START_PATH)) {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST only' });
        return;
      }
      // 同一站点已在等待授权：直接回同一个 URL，不重复开一次 device flow
      // （重复开会让浏览器里出现两个授权页，且先完成的那次才写盘）。
      if (slot.state.phase === 'pending' && typeof slot.state.url === 'string') {
        json(res, 200, { phase: slot.state.phase, url: slot.state.url, siteId });
        return;
      }
      const machineId = resolveMachineId();
      const { verifier, challenge } = createPkce();
      const nonce = crypto.randomUUID();
      // clientId / redirectUri / base 全部由站点预设成对提供——两站的
      // 这两个字段都是必需的，混搭会被网关以 400 INVALID_DEVICE_FLOW 拒绝。
      const authUrl = buildAuthUrl({ challenge, nonce, machineId, siteId });
      slot.state.phase = 'pending';
      slot.state.url = authUrl;
      slot.state.error = null;
      slot.state.account = null;
      slot.state.startedAt = Date.now();

      const loginEpoch = slot.epoch;
      const credentialPath = credentialPathOf(siteId);
      void pollDeviceToken({ nonce, verifier, siteId })
        .then((payload) => {
          if (loginEpoch !== slot.epoch) {
            // 等待期间用户已退出登录：丢弃这次授权结果，不写回凭据。
            return;
          }
          const written = writeCredential(payload, { machineId, credentialPath, siteId });
          slot.state.phase = 'ready';
          slot.state.account = {
            id: written.credential.user.id,
            name: written.credential.user.name,
            organizationId: written.credential.user.organization_id,
            email: written.credential.user.email,
          };
          deps.logger?.info?.(`dsh-qwenwork-connect: device login completed (${siteId})`);
          try {
            deps.onLogin?.(siteId);
          } catch {
            // 登录后的目录刷新失败不应影响登录结果
          }
        })
        .catch((error) => {
          if (loginEpoch !== slot.epoch) return;
          slot.state.phase = 'failed';
          slot.state.error = String(error?.message ?? error).slice(0, 300);
          deps.logger?.warn?.(`dsh-qwenwork-connect: device login failed (${siteId})`, slot.state.error);
        });

      json(res, 200, { phase: 'pending', url: authUrl, siteId });
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

  /**
   * 退出登录时清空登录页状态，并让在途轮询作废。
   *
   * @param {unknown} [siteId] 只重置该站点；省略则重置**全部**站点
   *   （退出登录的路由按站点调用，省略分支仅为兼容旧调用）。
   */
  const reset = (siteId) => {
    const targets = siteId === undefined
      ? [...bySite.keys()]
      : [siteOf(siteId).id];
    for (const id of targets) {
      const slot = slotOf(id);
      slot.epoch += 1;
      slot.state = idleState();
    }
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

/**
 * 站点 id 的对外清单（卡片渲染站点切换时使用）。
 * @returns {string[]}
 */
export function loginSites() {
  return [...STATUS_SITE_IDS];
}

export { DEFAULT_SITE_ID };
