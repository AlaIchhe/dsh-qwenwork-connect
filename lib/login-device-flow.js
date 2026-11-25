/**
 * device flow 登录：给这台机器拿一份千问办公（QwenWork）的桌面端 token。
 *
 * 为什么不用官方桌面客户端：那份凭据在 Windows 上是 DPAPI 加密的
 * `auth-v2.dat`，Linux 上根本没有；而网关只认 `aud=oauth_app` 的 token。
 * 这里复刻的是客户端自己走的授权码 + PKCE 流程，全程只在浏览器里点两下，
 * 不需要安装客户端，也不需要组织邮箱或内网 IP。
 *
 * 流程（实测）：
 *   1. 本地生成 verifier / challenge / nonce / machine_id；
 *   2. 打开 `{gateway}/device/selectAccounts?...`；
 *   3. 浏览器里选账号 → 选团队（企业团队才有企业积分）；
 *   4. 轮询 `{gateway}/api/v1/deviceToken/poll`，未授权时是 404，授权后返回 token。
 *
 * @module dsh-qwenwork-connect/login-device-flow
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SITE_ID,
  defaultCredentialPath,
  resolveSiteCredentialPath,
  siteOf,
} from './sites.js';

/**
 * .cn 站点的客户端 id（取自桌面端产物，是公开值）。
 *
 * **既有导出，行为不变**；多站点场景请用 `siteOf(siteId).clientId`。
 */
export const DEVICE_CLIENT_ID = siteOf(DEFAULT_SITE_ID).clientId;
/** .cn 站点的网关。既有导出；多站点请用 `siteOf(siteId).gateway`。 */
export const DEVICE_BASE = siteOf(DEFAULT_SITE_ID).gateway;

/** .cn 站点的默认凭据路径。既有导出；多站点请用 `defaultCredentialPath(siteId)`。 */
export const DEFAULT_CREDENTIAL_PATH = defaultCredentialPath(DEFAULT_SITE_ID);
/**
 * 机器标识文件。**两站共用同一个**：它标识的是「这台机器」，不是账号，
 * 分站点会让同一台机器在两站被当成两台设备。
 */
export const DEFAULT_MACHINE_ID_PATH = path.join(os.homedir(), '.dsh', 'qwenwork-machine-id');

/**
 * 凭据文件路径的唯一解析口：显式参数 > 站点专属环境变量 > 默认路径。
 *
 * `credentials.js` 的读取侧早就支持这个环境变量；写入侧（登录 / CLI）与
 * 删除侧（退出登录）必须走同一套优先级，否则会出现「登录写 A、读取读 B」
 * 或「退出删 A、实际用的是 B」这种自相矛盾的状态。
 *
 * 站点维度由 `sites.js` 的 `resolveSiteCredentialPath` 统一实现——两站的
 * 凭据**必须分文件**（账号不互通），共用一个文件会把另一站的登录态覆盖掉。
 *
 * @param {string | undefined} explicit
 * @param {{ siteId?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
export function resolveCredentialPath(explicit, opts = {}) {
  return resolveSiteCredentialPath(opts.siteId ?? DEFAULT_SITE_ID, explicit, opts.env);
}

export function createPkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * 机器标识。签名里的 `Cosy-MachineId` 必须和登录时用的那个一致，
 * 否则网关恒定回 403 User identity could not be verified。
 */
export function resolveMachineId(file = DEFAULT_MACHINE_ID_PATH) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    // 首次运行，往下走
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch {
    // 写不下去也不影响本次登录，只是下次会换一个 id
  }
  return id;
}

/**
 * 构造授权页 URL。
 *
 * ⚠️ 国际版与 .cn 的 **client_id 和 deeplink scheme 都不同，且两个字段都
 * 是必需的**（2026-11-16 对活网关实测）：
 *   - `gateway.qwenwork.ai` 收到 .cn 的 client id 或 `qwenwork-cn://`
 *     一律 400 `INVALID_DEVICE_FLOW` / `query not_allowed`；
 *   - 用国际版自己的 client id + `qwenwork://` 才 302 到
 *     `qwenwork.ai/oauth2/auth?...scope=openid+profile+email+offline_access+qwen_work`。
 * 因此这里不再允许「只覆盖 clientId、scheme 仍用 .cn」的半套覆盖——
 * 两字段从站点预设成对取用。
 *
 * @param {{ challenge: string, nonce: string, machineId: string,
 *           clientId?: string, redirectUri?: string, base?: string, siteId?: string }} params
 * @returns {string}
 */
export function buildAuthUrl(params) {
  const site = siteOf(params.siteId ?? DEFAULT_SITE_ID);
  const qs = new URLSearchParams({
    challenge: params.challenge,
    challenge_method: 'S256',
    nonce: params.nonce,
    machine_id: params.machineId,
    client_id: params.clientId ?? site.clientId,
    redirect_uri: params.redirectUri ?? site.redirectUri,
  });
  return (params.base ?? site.gateway) + '/device/selectAccounts?' + qs.toString();
}

export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function toIso(expiresAt) {
  if (typeof expiresAt === 'number') return new Date(expiresAt > 1e12 ? expiresAt : expiresAt * 1000).toISOString();
  if (typeof expiresAt === 'string' && expiresAt.length > 0) {
    const d = new Date(expiresAt);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

/**
 * 轮询 token。404 = 还没在浏览器里确认；200 带 token = 成功。
 */
export async function pollDeviceToken(options = {}) {
  const {
    nonce,
    verifier,
    intervalMs = 2000,
    timeoutMs = 5 * 60 * 1000,
    fetchImpl = globalThis.fetch,
    base = siteOf(options.siteId ?? DEFAULT_SITE_ID).gateway,
    signal,
  } = options;
  const qs = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' });
  const url = base + '/api/v1/deviceToken/poll?' + qs.toString();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('login aborted');
    let response;
    try {
      response = await fetchImpl(url, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      await sleep(intervalMs);
      continue;
    }
    if (response.status === 200) {
      const body = await response.json().catch(() => ({}));
      if (typeof body.token === 'string' && body.token.length > 0) return body;
    } else if (response.status !== 404) {
      const text = await response.text().catch(() => '');
      throw new Error('deviceToken/poll HTTP ' + response.status + (text ? ': ' + text.slice(0, 200) : ''));
    }
    await sleep(intervalMs);
  }
  throw new Error('login timed out after ' + Math.round(timeoutMs / 1000) + 's');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把 poll 的返回值写成插件能直接吃的凭据文件。
 *
 * 字段名沿用上游 `normalizeCredentials` 的契约，换实现时不用改契约。
 */
export function writeCredential(payload, options = {}) {
  const { machineId } = options;
  const siteId = siteOf(options.siteId ?? DEFAULT_SITE_ID).id;
  const credentialPath = resolveCredentialPath(options.credentialPath, { siteId });
  const claims = decodeJwt(payload.token);
  const user = {
    id: payload.user_id ?? claims.user_id ?? claims.sub ?? null,
    name: payload.user_name ?? claims.username ?? null,
    username: claims.username ?? null,
    email: claims.email ?? null,
    organization_id: claims.biz_org_id ?? null,
    data_policy_agreed: true,
  };
  const credential = {
    token: payload.token,
    refreshToken: payload.refresh_token ?? payload.refreshToken ?? '',
    expiresAt: toIso(payload.expires_at) ?? toIso(claims.exp),
    loginDeviceId: machineId,
    user,
    loginMethod: 'device-flow',
    source: 'device-flow',
    // 站点落进凭据：读取侧据此选对网关与客户端版本号，刷新时也不会把
    // 国际版的 refresh token 发到 .cn 网关（那会得到 401，看起来像过期）。
    siteId: siteOf(options.siteId ?? DEFAULT_SITE_ID).id,
  };
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, JSON.stringify(credential, null, 2), { mode: 0o600 });
  return { credentialPath, credential, claims };
}

/**
 * 跑一次完整的 device flow 登录。
 *
 * @param {{ siteId?: string, clientId?: string, base?: string, redirectUri?: string,
 *           credentialPath?: string, machineIdPath?: string, intervalMs?: number,
 *           timeoutMs?: number, fetchImpl?: typeof fetch, signal?: AbortSignal,
 *           onUrl?: (url: string) => void }} [options]
 * @returns {Promise<{ url: string, machineId: string, credentialPath: string,
 *   credential: object, claims: object, siteId: string }>}
 */
export async function startDeviceLogin(options = {}) {
  const siteId = siteOf(options.siteId ?? DEFAULT_SITE_ID).id;
  const site = siteOf(siteId);
  const {
    clientId = site.clientId,
    base = site.gateway,
    redirectUri = site.redirectUri,
    machineIdPath = DEFAULT_MACHINE_ID_PATH,
    intervalMs = 2000,
    timeoutMs = 5 * 60 * 1000,
    fetchImpl = globalThis.fetch,
    signal,
  } = options;
  // 凭据路径必须按站点解析：登录写 A、读取读 B 会让「登录成功但仍是未登录」。
  const credentialPath = resolveCredentialPath(options.credentialPath, { siteId });
  const machineId = resolveMachineId(machineIdPath);
  const { verifier, challenge } = createPkce();
  const nonce = crypto.randomUUID();
  const url = buildAuthUrl({ challenge, nonce, machineId, clientId, redirectUri, base, siteId });

  if (typeof options.onUrl === 'function') options.onUrl(url);

  const payload = await pollDeviceToken({ nonce, verifier, intervalMs, timeoutMs, fetchImpl, base, signal });
  const written = writeCredential(payload, { machineId, credentialPath, siteId });
  return { url, machineId, siteId, ...written };
}
