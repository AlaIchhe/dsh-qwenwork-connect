/**
 * host 侧插件入口：按站点各注册一个 provider，并挂载设置卡片的状态路由。
 *
 * ── 多站点结构（本版本新增）────────────────────────────────────────
 * 本插件同时服务千问办公的两个云端：
 *
 *   provider id       站点      网关
 *   ----------------  --------  ---------------------------
 *   qwenwork          .cn       https://gateway.qwenwork.cn
 *   qwenwork-intl     国际版    https://gateway.qwenwork.ai
 *
 * 两站的**账号不互通**、模型 key 不重叠、客户端版本号不同，因此不是
 * 「一个 provider 换域名」而是**两套并行的 provider**：
 *   - 每个站点一份凭据文件、一个模型目录缓存、一个聊天 shim 实例；
 *   - 模型选择器里出现两个分组，用户各登各的。
 *
 * 站点差异全部收敛在 `./sites.js`，其余模块只读预设。
 *
 * ── 既有约束（不变）────────────────────────────────────────────────
 *  - provider 路由以**本地登录态**驱动（非 API Key 型），token 由
 *    `./credentials-seam.js` 按需取得，绝不落盘到本插件。
 *  - 任何一步失败都不得抛出到 DSH loader —— 抛出去会触发红色
 *    "Failed to load plugins" 横幅，并连累设置卡片一起不可见。
 *  - 一个站点注册失败不得影响另一个站点：两站各自 try/catch。
 *
 * @module dsh-qwenwork-connect
 */

import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

import {
  FALLBACK_QWENWORK_MODELS,
  QWENWORK_PROVIDERS,
  catalogForCard,
  modelsForSite,
  toPiModel,
} from './models.js';
import {
  getAccountContext,
  getValidCredential,
  isWired,
} from './credentials-seam.js';
import { CATALOG_TTL_MS, createCatalogStore } from './catalog.js';
import { relaxTlsForVpc, resolveGatewayEndpoint } from './endpoint.js';
import { registerQwenWorkStatusRoute } from './web-status.js';
import { registerDeviceLoginRoute } from './login-route.js';
import { registerLogoutRoute } from './logout-route.js';
import { perfSummary } from './perf.js';
import { installStallGuard } from './stall-guard.js';
import { DEFAULT_SITE_ID, SITE_IDS, siteOf } from './sites.js';
import { disabledForSite, filterEnabledModels } from './model-preferences.js';
import { registerModelsToggleRoute } from './models-route.js';

/** 稳定的 Cordis 插件名。 */
export const name = 'llm-qwenwork';

/** provider 注册前必须就绪的模型注册表。 */
export const inject = ['llm'];

/** 拥有设置卡片的设置命名空间。 */
export const QWENWORK_SETTINGS_NS = 'qwenwork';

/**
 * 插件 Config schema（cordis 从 `runtime.Config` 读取，即本模块的导出）。
 *
 * `disabledModels` 声明为 `.volatile()`：DSH 的配置编辑器写入后**只更新
 * 运行中的引用、不重启插件**（cordis-plugin-loader `_commitVolatile`），
 * 所以拨动模型开关不会打断 shim 监听、登录态或进行中的对话。
 * 形状：`{ cn: ['flash'], intl: ['qwork-auto'] }`（停用列表，见
 * model-preferences.js 的语义说明）。读取用 `config.disabledModels.get()`。
 */
export const Config = z.object({
  disabledModels: z.dict(z.array(z.string())).default({}).volatile(),
});

/** 单个流读取挂起时的空闲上限。 */
export const QWENWORK_STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * pi-ai 的认证面置为惰性：本路由的凭据完全来自 `resolveApiKey`（它在每次
 * 请求时向接缝索取最新 token），pi-ai 自身的凭据生命周期与环境发现都不得
 * 为其凭空制造出一个凭据。
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error('dsh-qwenwork-connect: the qwenwork route has no pi-ai credential lifecycle');
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

/** 订阅制额度无法给出按 token 计价，报零。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 阶段 A-2：聊天数据面已接通。
 *
 * `baseUrl` 现在指向**本插件的环回 shim**（`./chat-shim.js`）。shim 负责：
 *   1. 把 pi-ai 的 OpenAI 协议请求转成 QwenWork 的推理请求；
 *   2. 用 COSY 信封签名（`Authorization: Bearer COSY.<...>`）并编码 body；
 *   3. 把上游的双层信封 SSE 转回标准 OpenAI SSE。
 *
 * ⚠️ `baseUrl` 在 shim 真正监听成功前是 `null`；此时 `createProvider` 会
 * 拿到一个不可达地址，模型仍会出现在选择器里（不阻断设置卡片），但发起
 * 对话会明确失败——**不会静默失败**。
 *
 * 之所以用 shim 而非直接 fetch 上游：pi-ai 只说 OpenAI 协议，而签名与
 * 加密只能在 Node 侧完成，且签名头绝不能被 `Bearer <accessToken>` 覆盖。
 */
const SHIM_UNAVAILABLE_BASE_URL = 'http://127.0.0.1:1/qwenwork-shim-unavailable';

/**
 * 单次请求的图片预算（聚合 base64 字节数 / 张数）。
 *
 * 取值依据（dsh-qwenwork-connector issue #4 的实测）：
 *   · 6.3 MB 原图（base64 约 8.4 MB）→ 正常返回；
 *   · 15.7 MB 原图（50 张）→ 网关 NGHTTP2_ENHANCE_YOUR_CALM 掐断；
 *   · 实际长跑在上下文约 12.8 MB 图片时开始每轮必死。
 *
 * 这里取 6 MB / 32 张，给文本 body 和协议开销留余量。超过时 pi-ai 抛
 * `IMAGE_OFFLOAD_REQUIRED`，宿主的 dsh-compaction-image-offload 会把最旧的
 * 图片标记为 offloaded 后重试——不会再出现「整轮 UNKNOWN」。
 */
const MAX_REQUEST_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REQUEST_IMAGES = 32;

/**
 * 取宿主附件服务（每次调用都现取）。
 *
 * ⚠️ 不能在插件启动时取一次就缓存（issue #1/#5 的根因）：第三方 bundle 的
 * 加载早于宿主 provision `attachments`，启动那一枪经常打空；一旦把
 * `undefined` 固定进闭包，整个进程周期里图片都读不出来，只能重启赌时序。
 *
 * @param {any} ctx DSH 插件上下文
 * @returns {any | undefined} 附件服务；未就绪或接口不合时返回 undefined
 */
function readAttachments(ctx) {
  try {
    if (typeof ctx?.get !== 'function') return undefined;
    const attachments = ctx.get('attachments');
    if (attachments === null || attachments === undefined) return undefined;
    return typeof attachments.readImageRequest === 'function' ? attachments : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从 DSH 上下文取图片链路所需的服务。
 *
 * 与官方 provider 完全同构：
 *   - `ctx.get('attachments')`            → 持久化附件服务
 *   - `resolveImageAttachmentAccess(...)` → 把附件引用映射成可读文本
 *
 * `resolveAttachments` 是**惰性解析器**：pi-ai 在真正发图时才会调用它，
 * 这时附件服务通常已经就绪。服务始终不存在时，pi-ai 会抛
 * `pi-ai image input requires the durable attachment service`——只影响
 * 带图请求，纯文本对话不受牵连。
 *
 * @param {any} ctx DSH 插件上下文
 * @returns {{ resolveAttachments: () => any, resolveImageAccess: Function }}
 */
function imageDepsFrom(ctx) {
  return {
    resolveAttachments: () => readAttachments(ctx),
    resolveImageAccess: (svc, ref) => {
      // ctx.get('fs') 可能不存在（取决于宿主配置）；缺失时只给附件 id，
      // 不影响图片数据本身的读取（readImageRequest 走 attachments）。
      const mapHostPath =
        typeof ctx?.get === 'function'
          ? (hostPath) => ctx.get('fs')?.processPathFromHostPath?.(hostPath)
          : undefined;
      return resolveImageAttachmentAccess(svc, mapHostPath, ref);
    },
  };
}

/**
 * 组装某个站点的 provider。`getModels` 每次读取都重建列表，因此后续接入
 * 动态目录时无需重建 provider 实例。
 *
 * @param {string} siteId 站点 id
 * @param {() => string} getBaseUrl 返回当前 shim 的 baseUrl
 * @param {() => (string | null) | Promise<string | null>} getSharedSecret
 *        返回 shim 的共享密钥；未就绪时可为 `null`。允许返回 Promise——
 *        调用方会在未就绪时等待 shim 启动，而不是拿 null 去发无鉴权请求。
 * @param {{ resolveAttachments: () => any, resolveImageAccess: (attachments: any, ref: any) => string }} [image]
 *        图片链路接入点。由 apply() 从 ctx 取 DSH 的附件服务后传入
 *        （与官方 provider 的做法一致：`ctx.get('attachments')`）。
 *        `resolveAttachments` 是惰性解析器，pi-ai 在发图时才调用。
 * @param {() => Array<any>} [getCatalog] 当前模型目录（动态缓存 + 内置种子）
 */
function createQwenWorkAdapter(
  siteId,
  getBaseUrl,
  getSharedSecret,
  image = {},
  getCatalog = () => modelsForSite(siteId),
) {
  const site = siteOf(siteId);
  const providerId = site.provider;
  // 图片能力由**上游模型**决定（catalog 里 is_vl: true）；附件服务是否就绪
  // 交给 pi-ai 在发图时调用 `resolveAttachments()` 现取。启动时序不再影响
  // 图片声明——这是 connector issue #1/#5 的教训。
  const imagesAvailable = typeof image.resolveAttachments === 'function';
  const buildModels = () =>
    getCatalog().map((info) =>
      toPiModel(info, getBaseUrl(), { supportsImages: imagesAvailable, provider: providerId }),
    );

  const provider = {
    ...createProvider({
      id: providerId,
      name: site.label,
      auth: {
        apiKey: {
          name: `${site.label} desktop session`,
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: site.label };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const buildProfile = () => ({
    provider: providerId,
    displayName: site.label,
    streamIdleTimeoutMs: QWENWORK_STREAM_IDLE_TIMEOUT_MS,
    // ⚠️ 显式对齐所有超时点（曾排查「长思考必超时」）：
    //   - timeoutMs                  —— OpenAI SDK 的请求级超时（未设时虽不生效，
    //                                  但显式给出可排除「某层默认 30-120s」的嫌疑）
    //   - websocketConnectTimeoutMs  —— SDK 若走 WS 通道的连接超时
    //   - streamIdleTimeoutMs        —— 流内空闲看门狗
    // 长思考请求总时长可达 1-2 分钟（高峰期响应头都可能 >60s），
    // 任何一层短于此都会把「慢但能成」的请求掐成 TIMEOUT。
    timeoutMs: 300_000,
    websocketConnectTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-qwen-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    // 图片链路限额：模型声明支持 image 后，pi-ai 会按这些上限决定
    // 「原样内联」还是抛出 IMAGE_OFFLOAD_REQUIRED 交给宿主卸载最旧的图。
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    maxRequestImages: MAX_REQUEST_IMAGES,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    piProvider: provider,
  });

  let profiles = new Map([[providerId, buildProfile()]]);

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    /**
     * 返回 shim 共享密钥而非 access token：pi-ai 会把它放进
     * `Authorization: Bearer`，shim 用它做进程级鉴别。这样 access token
     * 完全不经过 pi-ai 层，只在 shim 内部使用。
     *
     * ⚠️ **绝不能在 shim 未就绪时返回 `null`**：
     * `dsh-llm-pi-ai` 的 `profileOptions()` 只对 `undefined` 省略 apiKey
     * （`apiKey === void 0 ? {} : { apiKey }`），`null` 会被原样传给 SDK，
     * 于是请求不带鉴权头 → shim 返回 401 → **所有模型全部失败**
     * （表现为 "All models failed"）。
     *
     * 因此这里在未就绪时**等待** shim 就绪；确实起不来才抛错，
     * 让失败原因明确可见，而不是退化成「无密钥」。
     */
    resolveApiKey: async () => {
      const ready = await getSharedSecret();
      if (typeof ready !== 'string' || ready === '') {
        throw new Error(
          'dsh-qwenwork-connect: chat shim is not ready; cannot obtain the shared secret for pi-ai',
        );
      }
      return ready;
    },
    /**
     * 图片链路：把 DSH 的「持久化附件服务」接给 pi-ai。
     *
     * pi-ai 在消息含图片时要求 `resolveAttachments()` 返回附件服务，
     * 否则直接抛 `pi-ai image input requires the durable attachment service`。
     * 官方 provider（dsh-llm-pi-ai / dsh-llm-deepseek）就是这么接的：
     *   resolveAttachments: () => ctx.get('attachments')
     *   resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(...)
     *
     * 只有**同时**声明模型支持 image，这条链路才会被走到；
     * 声明由上游能力决定，服务在发图时现取——启动时附件服务没就绪不再
     * 导致「整个进程周期都用不了图」。
     */
    resolveAttachments: () =>
      typeof image.resolveAttachments === 'function' ? image.resolveAttachments() : undefined,
    ...(typeof image.resolveImageAccess === 'function'
      ? {
          resolveImageAccess: (attachments, ref) => image.resolveImageAccess(attachments, ref),
        }
      : {}),
  });

  return {
    adapter,
    invalidate: () => {
      profiles = new Map([[providerId, buildProfile()]]);
    },
  };
}

/**
 * shim 的**按站点**单例表。每个站点各占一个监听端口，互不共用：
 * 一个 shim 只服务一个站点（模型 key 与网关都不同），共用会把国际版的请求
 * 签成 .cn 的站点参数。
 *
 * @type {Map<string, Promise<{ baseUrl: string, port: number, sharedSecret: string, close: () => Promise<void> }>>}
 */
const shimPromises = new Map();
/** 各站点 shim 就绪后缓存的 baseUrl；未就绪为 null。 */
const shimBaseUrls = new Map();
/** 各站点 shim 就绪后缓存的共享密钥；未就绪为 null（绝不下发浏览器）。 */
const shimSharedSecrets = new Map();

/**
 * 惰性启动某站点的环回聊天 shim。
 *
 * 失败不抛出：provider 仍要注册（否则模型不会出现在选择器里，设置卡片也
 * 会因 provider 缺失而信息不全），但 `shimBaseUrls` 保持 null，发起对话时
 * 会得到明确错误而非静默失败。
 *
 * @param {{ logger?: any, siteId?: string, isDisabled?: (modelKey: string) => boolean }} [opts]
 * @returns {Promise<string | null>}
 */
export async function ensureChatShim(opts = {}) {
  const siteId = siteOf(opts.siteId ?? DEFAULT_SITE_ID).id;
  const cached = shimBaseUrls.get(siteId);
  if (cached !== undefined && cached !== null) return cached;
  if (!shimPromises.has(siteId)) {
    const promise = (async () => {
      // 从约定入口导入（实现在 chat-shim.js，signer-shim.js 是稳定转发层）
      const { startChatShim } = await import('./signer-shim.js');
      const { getValidCredential } = await import('./credentials-seam.js');
      return startChatShim({
        siteId,
        // 走 t1 接缝而非直读磁盘：接缝内部处理 token 过期自动刷新与
        // refresh-token 轮换回写，避免与 t1 形成两套凭据代际。
        // siteId 决定读哪一份凭据文件（两站账号不互通）。
        getCredential: async () => getValidCredential({ siteId }),
        // 模型开关守卫（wireSite 传入；独立调用缺省全部可用）。
        isDisabled: opts.isDisabled,
        // 端点不在此固定：chat-shim 的 getSession 每次随凭据解析
        // （resolveGatewayEndpoint，VPC 租户自动走租户网关）。
        logger: opts.logger,
      });
    })();
    shimPromises.set(siteId, promise);
    promise.catch((error) => {
      opts.logger?.warn?.(`dsh-qwenwork-connect: chat shim failed to start (${siteId})`, error);
      shimPromises.delete(siteId);
    });
  }
  try {
    const shim = await shimPromises.get(siteId);
    shimBaseUrls.set(siteId, shim.baseUrl);
    shimSharedSecrets.set(siteId, shim.sharedSecret ?? null);
    opts.logger?.info?.(
      `dsh-qwenwork-connect: chat shim listening on 127.0.0.1:${shim.port} (${siteId})`,
    );
    return shim.baseUrl;
  } catch {
    return null;
  }
}

/** 供测试/卸载使用：关闭全部站点的 shim 并清空单例。 */
export async function stopChatShim() {
  const pending = [...shimPromises.entries()];
  shimPromises.clear();
  shimBaseUrls.clear();
  shimSharedSecrets.clear();
  await Promise.all(
    pending.map(async ([, promise]) => {
      try {
        const shim = await promise;
        await shim.close();
      } catch {
        /* 已失败或已关闭 */
      }
    }),
  );
}

/**
 * 当前某站点 shim 的 baseUrl（未就绪返回 null）。
 * @param {unknown} [siteId] 缺省 .cn（向后兼容）
 */
export function chatShimBaseUrl(siteId) {
  return shimBaseUrls.get(siteOf(siteId ?? DEFAULT_SITE_ID).id) ?? null;
}

/**
 * 当前某站点 shim 的共享密钥（未就绪返回 null）。
 * 仅供进程内 resolveApiKey 使用，绝不下发。
 * @param {unknown} [siteId] 缺省 .cn（向后兼容）
 */
export function chatShimSharedSecret(siteId) {
  return shimSharedSecrets.get(siteOf(siteId ?? DEFAULT_SITE_ID).id) ?? null;
}

/**
 * 为一个站点装配：模型目录刷新、shim、provider 注册。
 *
 * 每个站点独立 try/catch——一个站点出错（比如国际版目录 404）绝不能把
 * 另一个站点一起拖下水。
 *
 * @param {any} ctx
 * @param {string} siteId
 * @param {any} config 插件 Config（读 volatile 的 disabledModels）
 * @returns {{ catalogStore: any, refreshCatalog: (force?: boolean) => Promise<Array<any>>,
 *            refreshDirectory: () => void }}
 */
function wireSite(ctx, siteId, config) {
  const site = siteOf(siteId);
  /** 该站点当前停用列表（每次调用现读 volatile，开关拨完立即生效）。 */
  const disabledNow = () => disabledForSite(config, siteId);
  /** 目录 + 停用偏好 → provider 实际对外声明的模型列表。 */
  const visibleCatalog = () => filterEnabledModels(catalogStore.models(), disabledNow());

  // ---- 动态模型目录 --------------------------------------------------
  // 目录来自上游 `/algo/api/v2/model/list`（COSY 签名），5 分钟 TTL；
  // 刷新失败保留上一次成功的快照，首次成功前用 sites.js 的内置目录。
  //
  // ⚠️ 每个站点**各建一个 store**：两站的模型 key 不重叠，共用一个会让
  // 后刷新的站点覆盖前一个，选择器里就会出现「选了 A 站模型、请求打到
  // B 站网关」这种必失败组合。
  const catalogStore = createCatalogStore({ siteId });
  /** 未登录导致的目录拉取失败只提示一次，避免每 5 分钟刷一条日志。 */
  let catalogAuthNoticed = false;
  const refreshCatalog = async (force = false) => {
    if (!catalogStore.shouldRefresh(force)) return catalogStore.models();
    try {
      if (!(await isWired({ siteId }))) return catalogStore.models();
      const credential = await getValidCredential({ siteId });
      const endpoint = resolveGatewayEndpoint(credential, siteId);
      const models = await catalogStore.refresh({
        credential,
        endpoint,
        fetchImpl: relaxTlsForVpc(endpoint),
      });
      catalogAuthNoticed = false;
      ctx.logger?.info?.(
        `dsh-qwenwork-connect: 模型目录已刷新（${site.id}，${models.length} 个）`,
      );
      return models;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      const expected =
        code === 'CREDENTIALS_MISSING'
        || code === 'TOKEN_EXPIRED_NO_REFRESH'
        || code === 'REFRESH_REJECTED'
        || code === 'UNSUPPORTED_PLATFORM';
      if (expected) {
        if (!catalogAuthNoticed) {
          catalogAuthNoticed = true;
          ctx.logger?.info?.(
            `dsh-qwenwork-connect: ${site.label} 尚未登录，模型目录先用内置快照`,
          );
        }
      } else {
        ctx.logger?.warn?.(
          `dsh-qwenwork-connect: ${site.label} 模型目录刷新失败，沿用上次快照`,
          error instanceof Error ? error.message : String(error),
        );
      }
      return catalogStore.models();
    }
  };
  void refreshCatalog();
  const catalogTimer = setInterval(() => {
    void refreshCatalog();
  }, CATALOG_TTL_MS);
  catalogTimer.unref?.();
  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => clearInterval(catalogTimer),
      `dsh-qwenwork-connect: model catalog refresh timer (${site.id})`,
    );
  }

  // ---- shim 与 provider 注册 -----------------------------------------
  //
  // 先启动 shim，再注册 provider：`getModels()` 才能拿到真实 baseUrl。
  // 即便 shim 启动失败，也照常注册 provider —— 让模型
  // 仍出现在选择器、设置卡片信息完整，同时对话请求给出明确错误。
  void ensureChatShim({
    logger: ctx.logger,
    siteId,
    // shim 侧的停用守卫：会话里持久化的模型选择可能在开关拨动前就指向
    // 了这个模型，请求要在进入上游前被明确拒绝（而不是签名后才 4xx）。
    isDisabled: (modelKey) => disabledNow().includes(modelKey),
  })
    .then((baseUrl) => {
      if (baseUrl === null) {
        ctx.logger?.warn?.(
          `dsh-qwenwork-connect: chat shim unavailable (${site.id}); its models will be listed but chat requests will fail`,
        );
      }
    })
    .catch(() => {
      /* ensureChatShim 内部已兜底 */
    });

  // 图片链路：附件服务按请求现取（issue #1/#5 的启动时序竞态）。
  // 启动时没就绪只记一条 info，不再据此永久关掉图片能力。
  const imageDeps = imageDepsFrom(ctx);
  /** registerConfigurableProviders 的句柄与条目（模型开关后 replace 重发布用）。 */
  let directoryHandle;
  const directoryEntries = [
    {
      provider: site.provider,
      displayName: site.label,
      settingsNs: QWENWORK_SETTINGS_NS,
      settingsPath: [],
      declared: true,
    },
  ];

  try {
    const { adapter } = createQwenWorkAdapter(
      siteId,
      () => shimBaseUrls.get(siteId) ?? SHIM_UNAVAILABLE_BASE_URL,
      // 等待 shim 就绪后再取密钥：ensureChatShim() 是异步的，
      // 而 pi-ai 可能在它就绪前就调用 resolveApiKey。返回 null 会让请求
      // 丢掉鉴权头（见 resolveApiKey 处注释），因此这里必须 await。
      async () => {
        const cached = shimSharedSecrets.get(siteId);
        if (cached !== undefined && cached !== null) return cached;
        await ensureChatShim({ logger: ctx.logger, siteId }).catch(() => null);
        return shimSharedSecrets.get(siteId) ?? null;
      },
      imageDeps,
      visibleCatalog,
    );
    let releaseAdapter;
    let releaseDirectory;
    try {
      releaseAdapter = ctx.llm.registerAdapter([site.provider], adapter);
      releaseDirectory = ctx.llm.registerConfigurableProviders(directoryEntries);
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        releaseAdapter?.();
        releaseDirectory?.();
      }
    }
    try {
      ctx.effect(() => () => {
        releaseAdapter?.();
        releaseDirectory?.();
      });
    } catch {
      releaseAdapter?.();
      releaseDirectory?.();
    }
    ctx.logger?.info?.(
      `dsh-qwenwork-connect: ${site.label} provider registered (${site.provider}, shim-backed)`,
    );
    directoryHandle = releaseDirectory;
  } catch (error) {
    ctx.logger?.error(
      `dsh-qwenwork-connect: ${site.label} provider registration failed`,
      error,
    );
  }

  return {
    catalogStore,
    refreshCatalog,
    /**
     * 重新发布本站的 configurable provider 目录。
     *
     * `directory.replace()` 会提交同一份条目并 publish
     * `llm/adapters-updated`——模型选择器订阅这个事件刷新列表。少了这一步，
     * 开关拨完选择器还挂着旧模型；它也是本插件唯一能公开触达该事件的路径
     * （emitAdaptersUpdated 是 LlmRuntime 私有方法）。
     */
    refreshDirectory: () => {
      try {
        directoryHandle?.replace?.(directoryEntries);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-qwenwork-connect: 目录刷新失败（${site.id}）`, error);
      }
    },
  };
}

/**
 * 插件装配。
 *
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  /** @type {Map<string, { catalogStore: any, refreshCatalog: Function, refreshDirectory: Function }>} */
  const wired = new Map();
  for (const siteId of SITE_IDS) {
    try {
      wired.set(siteId, wireSite(ctx, siteId, config));
    } catch (error) {
      // 单个站点装配失败不得影响其它站点（更不得抛进 DSH loader）。
      ctx.logger?.error?.(`dsh-qwenwork-connect: 站点 ${siteId} 装配失败`, error);
    }
  }

  /** 刷新指定站点（未给则全部）的模型目录。 */
  const refreshCatalog = (force = false, siteId) => {
    const targets = siteId === undefined ? [...wired.values()] : [wired.get(siteOf(siteId).id)];
    return Promise.all(
      targets.filter(Boolean).map((entry) => entry.refreshCatalog(force)),
    );
  };

  // ---- 设置卡片数据源 ------------------------------------------------
  // 无论 provider 是否注册成功，卡片都要能显示——它是阶段 B 的主要可见成果。
  ctx.inject(['webServer'], (webCtx) => {
    const loginRoutes = registerDeviceLoginRoute(webCtx, {
      logger: ctx.logger,
      onLogin: (siteId) => {
        void refreshCatalog(true, siteId);
      },
    });
    registerLogoutRoute(webCtx, {
      logger: ctx.logger,
      // 清掉该站点登录页缓存，避免退出后 /login/status 仍回上一次的账号摘要。
      onLogout: (siteId) => loginRoutes?.reset?.(siteId),
    });
    registerModelsToggleRoute(webCtx, {
      rootCtx: ctx,
      config,
      // 校验与守卫用**未过滤**目录：已停用的 key 也要能被重新启用。
      catalog: (siteId) => wired.get(siteId)?.catalogStore.models() ?? modelsForSite(siteId),
      onPersisted: (siteId) => wired.get(siteId)?.refreshDirectory?.(),
    });
    registerQwenWorkStatusRoute(webCtx, {
      getAccountContext: (opts) => getAccountContext(opts),
      tokenAvailable: (opts) => isWired(opts),
      models: (opts) => {
        const siteId = siteOf(opts?.siteId ?? DEFAULT_SITE_ID).id;
        const entry = wired.get(siteId);
        // 卡片要能列出**已停用**的模型（否则没有重新启用的入口），所以这里
        // 不做过滤，只给每条标注 enabled；provider 侧的过滤在 wireSite。
        return catalogForCard(
          entry?.catalogStore.models() ?? modelsForSite(siteId),
          disabledForSite(config, siteId),
        );
      },
      // 上游实测性能（首 token 延迟 / 输出速率）——由 shim 采样累积。
      perf: perfSummary,
    });
  });

  // ---- 设置命名空间（卡片配置面） -------------------------------------
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      // DSH 0.2.x 起 settings 服务改用 configure(presentation, fiber)，
      // 旧的 installSection 已被移除；两者都试一下，缺哪个都不影响 provider。
      if (typeof settingsCtx.settings.installSection === 'function') {
        settingsCtx.settings.installSection(ctx, QWENWORK_SETTINGS_NS, Config, config ?? {}, {
          setSource() {},
          onChange() {},
        });
      } else if (typeof settingsCtx.settings.configure === 'function') {
        settingsCtx.settings.configure({}, ctx.fiber);
      }
    } catch (error) {
      ctx.logger?.warn('dsh-qwenwork-connect: settings section unavailable', error);
    }
  });

  // ---- 「只说不做」自动续跑守卫 ----------------------------------------
  // 挂在 agent/turn-stopping 上，对本插件的**全部站点**生效
  // （漏掉一个站点会让该站点的「只说不做」不再被续跑）。
  try {
    installStallGuard(ctx, { logger: ctx.logger, provider: QWENWORK_PROVIDERS });
  } catch (error) {
    ctx.logger?.warn?.('dsh-qwenwork-connect: stall-guard installation failed', error);
  }
}

export {
  FALLBACK_QWENWORK_MODELS,
  QWENWORK_PROVIDERS,
  createQwenWorkAdapter,
  installStallGuard,
  SHIM_UNAVAILABLE_BASE_URL,
};
