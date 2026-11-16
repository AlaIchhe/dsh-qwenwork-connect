/**
 * 站点预设：把「千问办公」两套云端（.cn 公有云 / .ai 国际版）的差异集中到
 * 一处，其余模块只读预设、不再散落 if (region) 分支。
 *
 * ── 为什么要做这个抽象 ────────────────────────────────────────────
 * 国际版不是另一套协议，而是**同一协议的另一个站点**：同样的 COSY 信封、
 * 同样的 body 编码、同样的 device flow 端点、同样的 `qwork` scene、同样的
 * 内置 RSA 公钥。真正不同的只有几处常量（网关域名、OAuth client id、
 * deeplink scheme、客户端版本号、模型 key、凭据文件名）。
 *
 * ── 事实来源（2026-11-16 实测，不是推断）──────────────────────────
 * 国际版的取值读自官方发行包 `QwenWork.app` 1.4.1
 * （`assets.qwenwork.ai/release/latest/qwenwork-darwin-arm64.dmg`）：
 *   - `gatewayDomain: "gateway.qwenwork.ai"`、`authBaseUrl` 同值；
 *   - `CONFIGURED_OAUTH_CLIENT_ID="cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a"`；
 *   - `brand.deeplinkScheme: "qwenwork"`，且 Info.plist 只有这一个 URL scheme；
 *   - `Info.plist` 的 `CFBundleShortVersionString = 1.4.1`、
 *     `CFBundleVersion = 26111002`。
 *
 * 并已对活网关逐条验证（本文件里的断言都能复现）：
 *   - `GET https://gateway.qwenwork.ai/device/selectAccounts` 带本预设的
 *     client id + `qwenwork://` → **302** 到
 *     `qwenwork.ai/oauth2/auth?...scope=openid+profile+email+offline_access+qwen_work`；
 *   - 换成 .cn 的 client id 或 `qwenwork-cn://` → **400 INVALID_DEVICE_FLOW**
 *     （两个字段都是必需的，缺一不可）；
 *   - 用本插件手写的 COSY 信封签名 `GET /algo/api/v2/model/list?Encode=1`
 *     → **200**，`qwork` 目录含 `qwork-auto` / `qwork-advanced` /
 *     `qwork-ultimate`（.cn 网关对同样请求回 401 `code 105 Login expired`，
 *     说明签名链路本身是通的，只是 token 不通用）。
 *
 * ── 不可退让的事实 ────────────────────────────────────────────────
 *  1. 两站的**账号不互通**：.ai 的 token 打 .cn 网关无效，反之亦然。
 *     因此凭据必须**分文件存放**，不能共用一份。
 *  2. 国际版**没有 wallets 端点**（`/api/v1/adapter/user/wallets` 在 .ai 上
 *     404，在 .cn 上是 401 INVALID_TOKEN，即后者是有的）。卡片因此不展示
 *     每日/每月/长期分池，只展示 account-context 的 remaining。
 *
 * @module dsh-qwenwork-connect/sites
 */

import os from 'node:os';
import path from 'node:path';

/** 站点 id。作为 provider 后缀、路由参数与凭据文件名的唯一键。 */
export const SITE_CN = 'cn';
export const SITE_INTL = 'intl';

/**
 * 站点预设。键是站点 id，值是**冻结的**常量表。
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   provider: string,
 *   gateway: string,
 *   clientId: string,
 *   redirectUri: string,
 *   cosyVersion: string,
 *   appVersion: string,
 *   appReleaseVersion: string,
 *   appBuild: string,
 *   credentialFile: string,
 *   machineIdFile: string,
 *   envCredentialFile: string,
 *   wallets: boolean,
 *   fallbackModels: Array<any>,
 * }} Site
 */

/**
 * .cn 公有云（既有行为，**一个字段都不改**）。
 *
 * cosyVersion / app 版本沿用本插件早已实测可用的值；之所以不换成
 * 桌面端最新版本，是因为 .cn 站点已在真实链路上跑通（HTTP 200），
 * 换版本属于另一次改动，不在「新增国际版」的范围内。
 */
const CN_MODELS = Object.freeze([
  Object.freeze({
    id: 'pro',
    shortName: '高级',
    billingRate: 1,
    supportsImages: true,
    isDefault: true,
  }),
  Object.freeze({
    id: 'flash',
    displayNameId: 'qwen3.8-flash',
    shortName: '标准｜Qwen3.8-Flash',
    billingRate: 0.1,
    supportsImages: true,
    isRecommended: true,
  }),
  Object.freeze({
    id: 'frontier-1',
    shortName: 'Qwen4-Max 预览',
    billingRate: 0.4,
    supportsImages: true,
    isNew: true,
  }),
  Object.freeze({
    id: 'qwen3.8-max-preview',
    shortName: 'Qwen3.8-Max',
    billingRate: 1.1,
    supportsImages: true,
    isNew: true,
  }),
]);

/**
 * 国际版目录（**登录前**的回退列表）。
 *
 * key 与显示名逐条取自 `GET gateway.qwenwork.ai/algo/api/v2/model/list?Encode=1`
 * 的真实响应（2026-11-16，HTTP 200）：
 *   qwork-auto     → "Standard｜Qwen3.8-Flash"，is_default: true
 *   qwork-advanced → "Pro"
 *   qwork-ultimate → "Flagship"
 *
 * 三者 `is_vl` 均为 true（视觉可用）。
 *
 * ⚠️ `price_factor` 在未登录视角恒为 0，那是「无账号视图」的占位值、
 * **不是免费**。因此这里把 `billingRate` 写成 `null`（未知），让选择器
 * 不显示任何倍率——显示「免费」是编造，显示 `x0.00` 同样误导。
 * 登录后目录会给出真实 `price_factor`（catalog.js 按上游值取数）。
 *
 * 登录后 `listAllModels` 会用账号自己的目录替换本表（`enable: true` 的那份），
 * 因此这里只需要覆盖「首次拉取成功前」这一小段时间。
 */
const INTL_MODELS = Object.freeze([
  Object.freeze({
    id: 'qwork-advanced',
    shortName: 'Pro',
    billingRate: null,
    supportsImages: true,
    isDefault: true,
  }),
  Object.freeze({
    id: 'qwork-auto',
    shortName: 'Standard｜Qwen3.8-Flash',
    billingRate: null,
    supportsImages: true,
    isRecommended: true,
  }),
  Object.freeze({
    id: 'qwork-ultimate',
    shortName: 'Flagship',
    billingRate: null,
    supportsImages: true,
  }),
]);

/**
 * 站点表。
 *
 * `provider` 就是 DSH 里模型选择器的分组 id：.cn 保持 `qwenwork`（既有用户
 * 的模型选择记录不失效），国际版用 `qwenwork-intl`。
 *
 * @type {Record<string, Site>}
 */
export const SITES = Object.freeze({
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
    machineIdFile: 'qwenwork-machine-id',
    envCredentialFile: 'QWENWORK_CREDENTIAL_FILE',
    wallets: true,
    fallbackModels: CN_MODELS,
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
    machineIdFile: 'qwenwork-machine-id',
    envCredentialFile: 'QWENWORK_INTL_CREDENTIAL_FILE',
    wallets: false,
    fallbackModels: INTL_MODELS,
  }),
});

/** 站点 id 的规范顺序（.cn 在前：它是既有用户的主站点）。 */
export const SITE_IDS = Object.freeze([SITE_CN, SITE_INTL]);

/** 默认站点：不传站点参数时的一切行为都等同 .cn（向后兼容）。 */
export const DEFAULT_SITE_ID = SITE_CN;

/**
 * 归一化站点 id。无法识别时回落到默认站点而不是抛错——
 * 站点选择失败只应降级，不应打断登录 / 请求链路。
 *
 * 接受的写法（大小写不敏感）：`cn`、`intl`、`global`、`ai`、`qwenwork`、
 * `qwenwork-intl`、`qwenwork-cn`。
 *
 * @param {unknown} value
 * @returns {string} 站点 id
 */
export function normalizeSiteId(value) {
  if (typeof value !== 'string') return DEFAULT_SITE_ID;
  const raw = value.trim().toLowerCase();
  if (raw === '') return DEFAULT_SITE_ID;
  if (raw === SITE_CN || raw === 'qwenwork' || raw === 'qwenwork-cn' || raw === 'china') return SITE_CN;
  if (
    raw === SITE_INTL
    || raw === 'global'
    || raw === 'ai'
    || raw === 'international'
    || raw === 'qwenwork-intl'
    || raw === 'qwenwork-global'
  ) {
    return SITE_INTL;
  }
  return DEFAULT_SITE_ID;
}

/**
 * 该字符串是否是**可识别**的站点标识（大小写与别名都算）。
 *
 * 与 `normalizeSiteId` 的区别：后者对未知值静默回落，本函数如实回答
 * 「认不认识」。命令行这类**需要报错**的场景用它，避免把「拼错站点」
 * 静默当成默认站点。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isKnownSite(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim().toLowerCase();
  if (raw === '') return false;
  return raw === SITE_CN
    || raw === SITE_INTL
    || raw === 'qwenwork'
    || raw === 'qwenwork-cn'
    || raw === 'china'
    || raw === 'global'
    || raw === 'ai'
    || raw === 'international'
    || raw === 'qwenwork-intl'
    || raw === 'qwenwork-global';
}

/**
 * 取站点预设。永不抛错：未知 id 回落默认站点。
 *
 * @param {unknown} siteId
 * @returns {Site}
 */
export function siteOf(siteId) {
  return SITES[normalizeSiteId(siteId)] ?? SITES[DEFAULT_SITE_ID];
}

/** 全部站点（按 SITE_IDS 顺序）。 */
export function allSites() {
  return SITE_IDS.map((id) => SITES[id]);
}

/**
 * 站点对应的 provider id（模型选择器里的分组）。
 * @param {unknown} siteId
 */
export function providerOf(siteId) {
  return siteOf(siteId).provider;
}

/**
 * 从 provider id 反查站点 id。用于「DSH 传来的 provider 名 → 该用哪套站点」。
 * @param {unknown} provider
 * @returns {string} 站点 id；认不出时回落默认站点
 */
export function siteIdOfProvider(provider) {
  if (typeof provider !== 'string') return DEFAULT_SITE_ID;
  const hit = SITE_IDS.find((id) => SITES[id].provider === provider);
  return hit ?? DEFAULT_SITE_ID;
}

/**
 * 站点凭据文件的默认绝对路径。
 *
 * 两站账号不互通，凭据必须分开存：共用一个文件会导致「登录国际版后
 * .cn 的登录态被覆盖」，而且 token 打错网关只会得到 401。
 *
 * @param {unknown} siteId
 * @returns {string}
 */
export function defaultCredentialPath(siteId) {
  return path.join(os.homedir(), '.dsh', siteOf(siteId).credentialFile);
}

/**
 * 解析站点凭据文件路径，优先级：显式参数 > 站点专属环境变量 > 默认路径。
 *
 * 与 login-device-flow 的 resolveCredentialPath 是同一套优先级；放在这里
 * 是为了让「站点 → 路径」只有一个定义处，避免写入侧与读取侧各算一次。
 *
 * @param {unknown} siteId
 * @param {string | undefined} explicit
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveSiteCredentialPath(siteId, explicit, env = process.env) {
  const site = siteOf(siteId);
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const fromEnv = env[site.envCredentialFile];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  // .cn 站点额外兼容历史上通用的 QWENWORK_CREDENTIAL_FILE（既有用户可能设过）。
  if (site.id === SITE_CN) {
    const legacy = env.QWENWORK_CREDENTIAL_FILE;
    if (typeof legacy === 'string' && legacy.trim() !== '') return legacy.trim();
  }
  return defaultCredentialPath(site.id);
}
