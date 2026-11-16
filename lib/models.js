/**
 * 静态内置的模型目录（按站点）。
 *
 * 来源：两站桌面 App 的真实返回，未臆造任何字段。
 *   · .cn（`QwenWorkCN.app` 日志的 `rawModels`）：
 *       pro / flash / frontier-1 / qwen3.8-max-preview
 *   · .ai 国际版（`GET gateway.qwenwork.ai/algo/api/v2/model/list?Encode=1`
 *     的 200 响应，2026-11-16 实测）：
 *       qwork-auto / qwork-advanced / qwork-ultimate
 *
 * 阶段 B 不依赖 upstream 动态拉取，保证离线 / 首次拉取成功前 provider 不会是空的。
 *
 * ── 为什么目录必须按站点分开 ──────────────────────────────────────
 * 两站的模型 **key 完全不同**：拿 .cn 的 `flash` 去请求 .ai 网关会得到
 * 「模型不存在」，反之亦然。因此这里不存在「一份目录服务两个站点」的写法，
 * 每个站点各持一份，由 `modelsForSite()` 取用。
 *
 * @module dsh-qwenwork-connect/models
 */

import {
  DEFAULT_SITE_ID,
  SITE_IDS,
  providerOf,
  siteIdOfProvider,
  siteOf,
} from './sites.js';

/**
 * .cn 站点的 provider 路由 id（保持既有值：已持久化的模型选择记录不失效）。
 * @deprecated 新代码请用 `providerOf(siteId)`；本常量仅为向后兼容保留。
 */
export const QWENWORK_PROVIDER = providerOf(DEFAULT_SITE_ID);

/**
 * 本插件拥有的**全部** provider 路由 id，顺序与 SITE_IDS 一致。
 * 用于 `ctx.llm.registerAdapter()` 与 stall-guard 的归属判断。
 */
export const QWENWORK_PROVIDERS = Object.freeze(SITE_IDS.map((id) => providerOf(id)));

/**
 * 上下文窗口与输出上限。
 *
 * ⚠️ **`MAX_INPUT_TOKENS` 必须与发给上游的 `model_config.max_input_tokens` 一致**
 * （见 `signer-session.js` 的 `buildInferBody`）。
 *
 * 真实上限的确定过程（教训记录）：
 *   1. App 日志表格列标注「1M」
 *   2. Buddy2api 的 `model_config.max_input_tokens` 写 180000
 *   3. 曾照搬 180000 —— **实测证明是错的**：
 *      probe-context-limit*.mjs 的对照实验显示
 *      ≈150K/200K/400K/700K/850K/1.0M/1.2M tokens 全部被上游接受，
 *      ≈1.5M 才被拒（"Error in upstream response"）。
 *      → 真实上限在 1.2M~1.5M 之间，「1M」是保守而合理的声明值。
 *
 * 声明与实现不一致是本项目反复出现的一类缺陷；这次是**照搬外部值未实测**。
 *
 * ⚠️ 国际版目录里 `max_input_tokens` 为 180000，`context_config` 的默认档是
 * 1M —— 与 .cn 同一套取值策略，因此这里沿用同一常量（见 catalog.js 的
 * `defaultContextWindow`：缺省时取 context_config 最大档）。
 */
export const MAX_INPUT_TOKENS = 1_000_000;
/** 单次回复的输出上限（与 `parameters.max_tokens` 一致）。 */
export const MAX_OUTPUT_TOKENS = 32000;

/**
 * 把 sites.js 的极简条目补全成完整的目录条目。
 *
 * sites.js 只声明「站点之间不同的东西」（id / 名称 / 倍率 / 能力 / 徽章），
 * 上下文窗口与输出上限是两站共用的，因此在这一层补上——这样
 * 「加一个站点」只需要动 sites.js 一处，不必在每个站点表里重复抄两个数字。
 *
 * @param {ReadonlyArray<any>} entries
 * @returns {Array<any>}
 */
function hydrate(entries) {
  return entries.map((entry) => ({
    contextWindow: MAX_INPUT_TOKENS,
    maxTokens: MAX_OUTPUT_TOKENS,
    ...entry,
  }));
}

/**
 * 按站点取内置目录（每次返回新数组，调用方可安全修改/过滤）。
 *
 * @param {unknown} [siteId] 站点 id；缺省为 .cn（向后兼容）
 * @returns {Array<any>}
 */
export function modelsForSite(siteId) {
  return hydrate(siteOf(siteId).fallbackModels);
}

/**
 * .cn 站点的内置目录（既有导出名，行为不变）。
 *
 * @type {Array<{
 *   id: string,
 *   name?: string,
 *   shortName?: string,
 *   description?: string,
 *   billingRate: number,
 *   supportsImages: boolean,
 *   contextWindow: number,
 *   maxTokens: number,
 *   isDefault?: boolean,
 *   isRecommended?: boolean,
 *   isNew?: boolean,
 * }>}
 */
export const FALLBACK_QWENWORK_MODELS = modelsForSite(DEFAULT_SITE_ID);

/**
 * 把宿主传来的模型标识归一化回**上游 model_config.key**。
 *
 * 背景：部分宿主（如 pi）的选择器只渲染描述符 `id`，因此目录条目允许声明
 * `displayNameId`（人类可读全名，如 `qwen3.8-flash`）作为对外 id；请求进
 * shim 后必须换回上游认得的短 key（`flash`）。未声明 displayNameId 的模型
 * 两种写法（短 key 与自身 id）都接受；目录里查不到的一律原样透传，
 * 交给上游自行裁决（不吞新模型的接入路径）。
 *
 * 两站共用本函数但目录不同：先查本站点目录，未命中时再查其它站点，
 * 这样「在 .cn 目录里选了模型、随后切到国际版」也不会把 key 归一化错。
 *
 * @param {string} model 宿主 id（displayNameId 或上游 key）
 * @param {unknown} [siteId] 优先按该站点的目录归一化
 * @returns {string} 上游 model_config.key
 */
export function normalizeModelKey(model, siteId) {
  if (typeof model !== 'string' || model === '') return model;
  const own = modelsForSite(siteId).find(
    (m) => m.id === model || m.displayNameId === model,
  );
  if (own !== undefined) return own.id;
  for (const id of SITE_IDS) {
    if (id === siteOf(siteId).id) continue;
    const other = modelsForSite(id).find(
      (m) => m.id === model || m.displayNameId === model,
    );
    if (other !== undefined) return other.id;
  }
  return model;
}

/**
 * 把倍率格式化成选择器里显示的文本。
 *
 * 形态对齐 WorkBuddy（`Hy3 · x0.00 · 限时免费`）：
 *   - 0 倍率 → `免费`
 *   - 其它   → `x1.00` / `x0.10` / `x1.10`
 *
 * @param {number} rate
 * @returns {string}
 */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  if (rate === 0) return '免费';
  return `x${rate.toFixed(2)}`;
}

/**
 * 生成模型选择器里显示的名字：`名称 · 倍率 · 标记`。
 *
 * ⚠️ 这是**唯一的显示名来源**——DSH 的模型选择器渲染的就是 pi-ai 模型描述符
 * 的 `name` 字段（见 dsh-workbuddy-connect 的 `toPiModel`，它直接透传
 * 上游 `name`，而该值本身就形如 `Hy3 · x0.00 · 限时免费`）。
 * 倍率必须拼进 `name` 才会出现在选择器里；单独放 `billingRate` 字段
 * 只有设置卡片能看到。
 *
 * @param {any} info
 * @returns {string}
 */
export function displayName(info) {
  const parts = [info.shortName ?? info.id];
  const rate = formatRate(info.billingRate);
  if (rate !== '') parts.push(rate);
  if (info.isDefault === true) parts.push('默认');
  if (info.isRecommended === true) parts.push('推荐');
  if (info.isNew === true) parts.push('新');
  return parts.join(' · ');
}

/**
 * 卡片与选择器共用的描述文案。
 *
 * @param {any} info
 * @returns {string}
 */
function describeModel(info) {
  const rate = formatRate(info.billingRate);
  const ctx = info.contextWindow >= 1000000 ? '1M' : `${Math.round(info.contextWindow / 1000)}K`;
  return [
    info.supportsImages === true ? '视觉' : '仅文本',
    ctx,
    rate === '' ? undefined : rate === '免费' ? '免费' : rate,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 供卡片展示的精简模型行。 */
export function catalogForCard(models) {
  const list = Array.isArray(models) ? models : FALLBACK_QWENWORK_MODELS;
  return list.map((model) => ({
    id: model.id,
    // 卡片显示短名（倍率已单独成列），选择器则用带倍率的长名。
    name: model.shortName ?? model.id,
    description: describeModel(model),
    rate: model.billingRate,
    ...(model.isDefault === true ? { isDefault: true } : {}),
    ...(model.isRecommended === true ? { isRecommended: true } : {}),
    ...(model.isNew === true ? { isNew: true } : {}),
  }));
}

/**
 * 把静态目录条目转成 pi-ai 的模型描述符。
 *
 * `name` 是**模型选择器显示的那一行文本**——因此这里用 `displayName()`
 * 把倍率拼进去（形如 `高级 · x1.00 · 默认`），否则选择器只会显示干巴巴的
 * 名称，用户看不到谁贵谁便宜。
 *
 * @param {any} info
 * @param {string} baseUrl 该 provider 的请求基址
 * @param {{ supportsImages?: boolean, displayId?: boolean, provider?: string }} [opts]
 *        `supportsImages` 覆盖：**由调用方按附件服务是否可用传入**。
 *        不传则沿用目录里的声明。这样当宿主没有附件服务时，模态会退回
 *        `['text']`，避免 DSH 走图片路径后抛
 *        `pi-ai image input requires the durable attachment service`。
 *        `provider` 覆盖：多站点时各站点必须声明自己的 provider id，
 *        否则两个站点的模型会被归到同一分组。
 */
export function toPiModel(info, baseUrl, opts = {}) {
  const supportsImages = opts.supportsImages ?? info.supportsImages === true;
  return {
    // 部分宿主（pi）的选择器只渲染描述符 `id`，这类宿主传 `displayId: true`
    // 换用人类可读全名；请求回落到 shim 时由 normalizeModelKey() 换回上游
    // 认识的短 key，两侧契约都不破。DSH 侧选择器显示的是 `name`，故保持
    // 原 id 不变，不动已持久化的模型选择记录。
    id: opts.displayId === true ? (info.displayNameId ?? info.id) : info.id,
    name: displayName(info),
    api: 'openai-completions',
    provider: opts.provider ?? QWENWORK_PROVIDER,
    baseUrl,
    input: supportsImages ? ['text', 'image'] : ['text'],
    /**
     * 上游确实返回思维链（`reasoning_content`），但 pi-ai 把它解析成独立
     * thinking 块**不依赖这个标志**：openai-completions 的解析分支无条件读取
     * `reasoning_content`（实测 reasoning:false 时 thinking 块照常产出）。
     *
     * 这里置 false 只有一个目的：让 DSH 不生成「推理等级」菜单。
     *
     * 原因：上游模型目录里所有模型的 `thinking_config` 都是 null，没有声明
     * 任何 effort 档位。DSH 对 `reasoning:true` 且没有 `thinkingLevelMap`
     * 的模型会自动补出 off/minimal/low/medium/high，但上游并不认这些档位，
     * 属于假开关。置 false 后 DSH 的 `reasoningInfo` 返回空，UI 不再出现
     * 推理等级；把 `thinkingLevelMap` 全设 null 反而会得到空 efforts，
     * dsh-llm 会直接抛 `INVALID_MODEL_REASONING`。
     *
     * 思考本身固定开启：请求体 `parameters.enable_thinking` 恒为 true
     * （见 signer-session.js 的 buildInferBody），不提供开关、不做回退。
     * 国际版目录的 `is_reasoning` 同为 false，策略一致。
     */
    reasoning: false,
    /**
     * 思考开关握手（QwenWork 网关不支持，2026-11-08 实测；国际版同一套
     * 网关实现，2026-11-16 对 .ai 的 200 响应结构与 .cn 完全一致）：
     *
     * pi-ai 对 openai-completions API 按 `compat.thinkingFormat` 决定发不发
     * `enable_thinking`（qwen / qwen-chat-template 两种格式）。不声明时
     * auto-detect 会因 baseUrl 是 127.0.0.1 环回 shim 而落到默认 openai，
     * 宿主设 thinking="off" 只是不发 reasoning_effort，请求体里没有任何
     * 关思考字段。
     *
     * 实测（research/buddy2api-probes/probe-disable-thinking.mjs：5 变体对照；
     * probe-flash-thinking.mjs：flash 模型 3 变体）：QwenWork 网关对
     * `enable_thinking:false`、`chat_template_kwargs.enable_thinking:false`、
     * `reasoning_effort:"none"`、`is_reasoning:false` 全部无视，思考照发。
     * 所以这里**刻意不声明** compat.thinkingLevelMap / thinkingFormat，并且把
     * `reasoning` 置 false，避免 DSH 自动补出上游并不支持的通用档位：发了
     * 也是无效字段，反而让 pi-ai 以为关思考已生效。上游强制思考，
     * 宿主端的正确姿态是容忍 thinking 通道（pi-hermes-memory 的
     * thinking-channel recovery 那样从 thinking 块恢复答案）。
     */
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  };
}

/**
 * provider id → 站点 id。供 shim / stall-guard 判断「这条请求属于哪个站点」。
 * @param {unknown} provider
 */
export { siteIdOfProvider };
