/**
 * 模型 enable/disable 的设置路由：卡片上拨开关走这里。
 *
 * 职责链（每一步都可能失败，失败都有明确状态码）：
 *   1. 环回校验（与其它路由一致，浏览器只允许本机壳访问）；
 *   2. 模型 key 必须在该站点**当前目录**里——写进配置的 key 若来自拼错
 *      或已下架的模型，会永远躺在 disabledModels 里无人察觉；
 *   3. 守卫「本站点至少保留一个可用模型」（见 model-preferences 注释）；
 *   4. 经 DSH 的 configEditor 写入插件 Config（volatile 字段，不重启）；
 *   5. 写成功后 `directory.replace(...)` 重新发布 provider 目录，触发
 *      `llm/adapters-updated`——模型选择器订阅这个事件刷新列表，少了这
 *      一步，开关拨完选择器还挂着旧模型。
 *
 * 持久化不落在本插件自管的文件里：配置编辑器会串行化 profile 写入、
 * 校验候选值、拒绝被上层覆盖的字段——这些边界自己重写一遍只会更弱。
 *
 * @module dsh-qwenwork-connect/models-route
 */

import { loopbackRequest } from './loopback.js';
import { siteFromRequestUrl } from './status-paths.js';
import { siteOf } from './sites.js';
import {
  disabledForSite,
  nextRawConfig,
  wouldLeaveNone,
} from './model-preferences.js';

export const MODELS_TOGGLE_PATH = '/plugins/dsh-qwenwork-connect/models/toggle';

/** body 尺寸上限：这个接口只接受一个小 JSON，超过即拒（防误打/滥用）。 */
const MAX_BODY_BYTES = 4096;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** 读满 body（带尺寸上限）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {any} webCtx 已注入 webServer 的上下文
 * @param {{
 *   rootCtx: any,
 *     插件根 ctx：取 `fiber.entry`（configEditor 的写入目标）与
 *     `get('configEditor')`。
 *   config: any,
 *     插件 Config 对象（读当前 volatile 值）。
 *   catalog: (siteId: string) => Array<{ id: string }>,
 *     该站点当前目录（**未过滤**，用于校验 key 与守卫）。
 *   onPersisted?: (siteId: string) => void,
 *     保存成功后的回调（index.js 用它 replace 目录触发刷新）。
 *   logger?: any,
 * }} deps
 * @returns {() => void} 注销路由
 */
export function registerModelsToggleRoute(webCtx, deps) {
  const handle = async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'loopback only' });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'POST only' });
      return;
    }

    const siteId = siteFromRequestUrl(req.url);
    const site = siteOf(siteId);

    /** @type {{ model?: unknown, enabled?: unknown }} */
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw === '' ? {} : JSON.parse(raw);
    } catch (error) {
      const status = /** @type {any} */ (error)?.status ?? 400;
      json(res, status, {
        error: status === 400 ? '请求体不是合法 JSON' : String(/** @type {any} */ (error)?.message ?? error),
      });
      return;
    }

    const modelKey = typeof payload.model === 'string' ? payload.model.trim() : '';
    const enabled = payload.enabled === true;
    if (modelKey === '' || typeof payload.enabled !== 'boolean') {
      json(res, 400, { error: '需要 { model: string, enabled: boolean }' });
      return;
    }

    // 模型 key 必须在该站点当前目录里（含已停用的——重新启用同样要能找到它）。
    const catalog = deps.catalog(siteId);
    const known = catalog.some((m) => m !== null && typeof m === 'object' && m.id === modelKey);
    if (!known) {
      json(res, 400, {
        error: `${site.label} 当前目录里没有模型 "${modelKey}"（可能拼错或已下架）`,
      });
      return;
    }

    const disabled = disabledForSite(deps.config, siteId);
    if (wouldLeaveNone(catalog, disabled, modelKey, enabled)) {
      json(res, 409, { error: `至少要为 ${site.label} 保留一个可用模型` });
      return;
    }
    if (disabled.includes(modelKey) === !enabled) {
      // 幂等：目标状态与当前一致，不写盘也不刷目录（避免无意义的
      // adapters-updated 让所有客户端重拉一遍模型列表）。
      json(res, 200, { ok: true, unchanged: true, siteId, model: modelKey, enabled });
      return;
    }

    const editor = typeof deps.rootCtx?.get === 'function' ? deps.rootCtx.get('configEditor') : undefined;
    const entry = deps.rootCtx?.fiber?.entry;
    if (editor === undefined || typeof editor.edit !== 'function' || entry === undefined) {
      json(res, 503, { error: '当前环境没有配置编辑器，无法保存模型开关' });
      return;
    }

    try {
      await editor.edit(entry, (current) => nextRawConfig(current, siteId, modelKey, enabled));
    } catch (error) {
      const message = String(/** @type {any} */ (error)?.message ?? error).slice(0, 300);
      deps.logger?.warn?.(`dsh-qwenwork-connect: 保存模型开关失败（${site.label} ${modelKey}）`, message);
      json(res, 500, { error: message });
      return;
    }

    try {
      deps.onPersisted?.(siteId);
    } catch (error) {
      // 目录已保存，刷新事件失败只影响选择器即时性（下一次打开仍会拉到
      // 新状态），不能把已成功的写入判成失败。
      deps.logger?.warn?.('dsh-qwenwork-connect: 模型目录刷新事件失败', error);
    }

    deps.logger?.info?.(
      `dsh-qwenwork-connect: 模型${enabled ? '启用' : '停用'}（${site.label}）${modelKey}`,
    );
    json(res, 200, { ok: true, siteId, model: modelKey, enabled });
  };

  const mount = () => {
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path: MODELS_TOGGLE_PATH,
      handler: handle,
    });
    return () => {
      try {
        dispose?.();
      } catch {
        // 卸载期重复注销不是错误
      }
    };
  };
  // 与状态路由同一套生命周期：优先经 effect 注册（卸载自动 dispose），
  // 没有 effect 的宿主版本直接挂载。
  if (typeof webCtx.effect === 'function') {
    webCtx.effect(mount, 'dsh-qwenwork-connect: model toggle route');
    return () => {};
  }
  return mount();
}
