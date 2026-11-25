/**
 * host 侧同源状态路由 + 浏览器侧卡片共用的常量。
 *
 * 该模块**不得引入任何 Node 或浏览器专属依赖**：host 半与 client 半都会
 * import 它（client.js 是 `__ModuleLoader__.load` 包装，会内联一份常量）。
 * 因此站点 id 的清单也在这里内联一份——两站的路由后缀由它推导，
 * client 半无法 import sites.js 却必须知道同一套 URL。
 *
 * ── 路由形态 ──────────────────────────────────────────────────────
 * 站点作为**路径参数**而不是各起一条路由：
 *   /plugins/dsh-qwenwork-connect/status?site=cn
 *   /plugins/dsh-qwenwork-connect/status?site=intl
 *
 * 为什么用 query 而不是 `/status/intl`：既有卡片与输入框读数已经在用
 * `/status`（无参数），保持同一条路由 + 缺省站点 = .cn，老版本前端
 * 继续可用；新增站点只是多一个参数，不需要前端跟着改路由表。
 *
 * @module dsh-qwenwork-connect/status-paths
 */

/** 本插件拥有的状态端点，供其浏览器半读取。 */
export const QWENWORK_STATUS_PATH = '/plugins/dsh-qwenwork-connect/status';

/** 卡片向 host 拉取状态的轮询间隔。 */
export const QWENWORK_STATUS_POLL_MS = 60_000;

/** 站点 id（与 lib/sites.js 的 SITE_CN / SITE_INTL 一致）。 */
export const STATUS_SITE_CN = 'cn';
export const STATUS_SITE_INTL = 'intl';

/** 站点清单（顺序即卡片里的展示顺序）。 */
export const STATUS_SITE_IDS = [STATUS_SITE_CN, STATUS_SITE_INTL];

/**
 * 给状态 / 登录 / 登出路径附加站点参数。
 *
 * 缺省站点（.cn）**不加参数**：保持既有请求形态不变，便于老版本前端与
 * 任何写死了无参数 URL 的探针继续工作。
 *
 * @param {string} basePath 例如 '/plugins/dsh-qwenwork-connect/status'
 * @param {string} [siteId]
 * @returns {string}
 */
export function statusPathForSite(basePath, siteId) {
  const site = typeof siteId === 'string' && siteId !== '' ? siteId : STATUS_SITE_CN;
  if (site === STATUS_SITE_CN) return basePath;
  return `${basePath}?site=${encodeURIComponent(site)}`;
}

/**
 * 从请求 URL 解析站点参数。缺失或无法识别时回落 .cn。
 *
 * ⚠️ 这里**不 import sites.js**：本模块必须能在浏览器半被内联使用。
 * 站点白名单以 STATUS_SITE_IDS 为准，未知值一律回落缺省站点。
 *
 * @param {string | undefined} rawUrl 例如 '/plugins/.../status?site=intl'
 * @returns {string} 站点 id
 */
export function siteFromRequestUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return STATUS_SITE_CN;
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) return STATUS_SITE_CN;
  let params;
  try {
    params = new URLSearchParams(rawUrl.slice(queryIndex + 1));
  } catch {
    return STATUS_SITE_CN;
  }
  const raw = (params.get('site') ?? '').trim().toLowerCase();
  if (raw === '') return STATUS_SITE_CN;
  // 别名与 sites.js 的 normalizeSiteId 保持一致（这里无法 import 它）。
  if (raw === STATUS_SITE_CN || raw === 'qwenwork' || raw === 'qwenwork-cn' || raw === 'china') {
    return STATUS_SITE_CN;
  }
  if (
    raw === STATUS_SITE_INTL
    || raw === 'global'
    || raw === 'ai'
    || raw === 'international'
    || raw === 'qwenwork-intl'
    || raw === 'qwenwork-global'
  ) {
    return STATUS_SITE_INTL;
  }
  return STATUS_SITE_CN;
}
