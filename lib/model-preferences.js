/**
 * 模型 enable/disable 偏好（纯函数层，无 IO、无宿主依赖）。
 *
 * ── 存储位置：本插件的 Config ────────────────────────────────────────
 * 字段 `disabledModels` 在 `index.js` 的 Config schema 里以
 * `.volatile()` 声明，持久化走 DSH 的 configEditor（写入 profile 的
 * cordis.patch.yml）。volatile 的语义正是这个功能要的：**只改值、不重启
 * 插件**——切换模型时 provider 注册、shim 监听、登录态、目录缓存全部
 * 原地保留（cordis-plugin-loader 的 `_commitVolatile` 会把新值更新进
 * 运行中的引用，`config.disabledModels.get()` 立即可见）。
 *
 * ── 数据形状 ────────────────────────────────────────────────────────
 * 按站点分组的「停用列表」（键 = 站点 id，值 = 该站点已停用的模型 key）：
 *
 *   { "cn": ["flash"], "intl": ["qwork-ultimate"] }
 *
 * 为什么记「停用」而不是「启用」：
 *   - 新模型默认可用——目录 5 分钟刷新一次，若记启用列表，每个新模型
 *     都会凭空消失，用户根本不知道去哪找它；
 *   - 上游下架模型时不需要迁移或清理数据，读取时按当前目录过滤即可；
 *   - 空列表 = 全部启用，是稳定缺省，老用户的 patch.yml 没有这个字段
 *     也完全不受影响。
 *
 * @module dsh-qwenwork-connect/model-preferences
 */

import { DEFAULT_SITE_ID, siteOf } from './sites.js';

/** Config 中的字段名（schema 与编辑器写入必须一致）。 */
export const PREFS_CONFIG_FIELD = 'disabledModels';

/**
 * 取原始停用字典：兼容三种来源——
 *   1. 运行中的 volatile 包装（`{ get() }`）；
 *   2. 已解析的普通对象（测试 / configEditor 回调里的 current）；
 *   3. undefined/null/脏值 → 空字典。
 *
 * @param {any} config 插件 config（或 raw config）
 * @returns {Record<string, string[]>}
 */
export function disabledDict(config) {
  const field = config === null || config === undefined
    ? undefined
    : config[PREFS_CONFIG_FIELD];
  if (field === null || field === undefined) return {};
  const value = typeof field.get === 'function' ? field.get() : field;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [siteId, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const keys = list.filter((k) => typeof k === 'string' && k !== '');
    if (keys.length > 0) out[siteId] = [...new Set(keys)];
  }
  return out;
}

/**
 * 某站点的停用模型 key 列表。
 *
 * @param {any} config 插件 config
 * @param {unknown} [siteId] 缺省 .cn（向后兼容）
 * @returns {string[]}
 */
export function disabledForSite(config, siteId) {
  return disabledDict(config)[siteOf(siteId ?? DEFAULT_SITE_ID).id] ?? [];
}

/**
 * 生成写入用的**下一份 raw config**（configEditor 回调的返回值）。
 *
 * 保留 current 的其它字段（用户可能在同一 entry 上配了别的东西）；
 * 某站点列表清空时删掉该键，字典为空时删掉整个字段——patch.yml 里
 * 只留真正生效的差异。
 *
 * @param {any} currentRaw configEditor 回调收到的当前 raw config
 * @param {unknown} siteId 站点 id
 * @param {string} modelKey 模型 key
 * @param {boolean} enabled true=启用（从停用列表移除），false=停用
 * @returns {Record<string, any>} 新的 raw config
 */
export function nextRawConfig(currentRaw, siteId, modelKey, enabled) {
  const base = currentRaw !== null && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
    ? { ...currentRaw }
    : {};
  const dict = disabledDict(base);
  const site = siteOf(siteId ?? DEFAULT_SITE_ID).id;
  const list = [...(dict[site] ?? [])];
  const at = list.indexOf(modelKey);
  if (enabled) {
    if (at >= 0) list.splice(at, 1);
  } else if (at < 0) {
    list.push(modelKey);
  }
  if (list.length === 0) delete dict[site];
  else dict[site] = list;
  if (Object.keys(dict).length === 0) delete base[PREFS_CONFIG_FIELD];
  else base[PREFS_CONFIG_FIELD] = dict;
  return base;
}

/**
 * 按停用列表过滤模型目录（保持目录原顺序）。
 *
 * @param {Array<{ id: string }>} models 目录条目
 * @param {string[]} disabled 停用 key 列表
 * @returns {Array<{ id: string }>}
 */
export function filterEnabledModels(models, disabled) {
  if (!Array.isArray(models)) return [];
  if (!Array.isArray(disabled) || disabled.length === 0) return models;
  const set = new Set(disabled);
  return models.filter((m) => m !== null && typeof m === 'object' && !set.has(m.id));
}

/**
 * 「把 modelKey 置为 enabled」之后，该站点是否还有可用模型。
 *
 * 守卫放在服务端而不是只放 UI：绕过卡片直接 POST 也绝不能把一个站点的
 * provider 清空——零模型的 provider 分组在选择器里不可选，用户唯一的
 * 恢复路径是去翻 patch.yml，这远超「一个开关」应有的破坏半径。
 *
 * @param {Array<{ id: string }>} models 该站点当前目录（**未过滤**）
 * @param {string[]} disabled 当前停用列表
 * @param {string} modelKey 目标模型
 * @param {boolean} enabled 目标状态
 * @returns {boolean} true = 会清空，必须拒绝
 */
export function wouldLeaveNone(models, disabled, modelKey, enabled) {
  if (enabled) return false;
  const set = new Set(disabled);
  if (set.has(modelKey)) return false; // 本来就停用，再停一次不减少
  return models.filter((m) => m !== null && typeof m === 'object' && !set.has(m.id)).length <= 1;
}
