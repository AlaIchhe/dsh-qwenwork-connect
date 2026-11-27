/**
 * Unified local HTTP routes for the browser settings card & composer readout.
 * Uses a single WebServer prefix mount (`/plugins/dsh-qwenwork-connect`),
 * unified loopback + Config.trustedHosts check (zero per-request disk IO),
 * and consistent JSON / error responses.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactSecrets } from '../core/errors.js';
import {
  LOGIN_START_PATH,
  LOGIN_STATUS_PATH,
  LOGOUT_PATH,
  MODELS_TOGGLE_PATH,
  ROUTE_PREFIX,
  STATUS_PATH,
  siteFromRequestUrl,
} from '../shared/contracts.js';
import type { SiteId } from '../shared/sites.js';
import {
  disabledForSite,
  nextRawConfig,
  readPluginConfig,
  wouldLeaveNone,
} from './config.js';
import type { HostContext, LoggerLike } from './dsh-services.js';
import type { SiteRuntime } from './site-runtime.js';

const MAX_BODY_BYTES = 4096;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isTrustedRequest(
  req: Pick<IncomingMessage, 'headers'>,
  trustedHosts: readonly string[],
): boolean {
  const extra = new Set(trustedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  return isHostAllowed(req.headers.host, extra) && isOriginAllowed(req.headers.origin, extra);
}

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  const colon = hostname.lastIndexOf(':');
  if (
    colon !== -1 &&
    !hostname.slice(0, colon).includes(':') &&
    /^\d+$/.test(hostname.slice(colon + 1))
  ) {
    hostname = hostname.slice(0, colon);
  }
  return hostname;
}

function isHostAllowed(host: string | undefined, extra: ReadonlySet<string>): boolean {
  if (host === undefined || host.trim() === '') return false;
  const hostname = hostnameOfHost(host);
  return LOOPBACK_HOSTS.has(hostname) || extra.has(hostname);
}

function isOriginAllowed(origin: string | undefined, extra: ReadonlySet<string>): boolean {
  if (origin === undefined || origin.trim() === '') return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1' || extra.has(hostname);
  } catch {
    return false;
  }
}

export interface PluginRoutesDeps {
  readonly rootCtx: HostContext;
  readonly rawConfig: unknown;
  readonly runtimes: ReadonlyMap<SiteId, SiteRuntime>;
  readonly onModelsChanged?: (siteId: SiteId) => void;
  readonly logger?: LoggerLike;
}

export function createPluginRoutesHandler(
  deps: PluginRoutesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const cfg = readPluginConfig(deps.rawConfig);
    if (!isTrustedRequest(req, cfg.trustedHosts)) {
      sendJson(res, 403, { error: 'request-not-trusted' });
      return;
    }

    const rawUrl = req.url ?? '';
    const pathname = rawUrl.split('?')[0] ?? '';
    const siteId = siteFromRequestUrl(rawUrl);
    const runtime = deps.runtimes.get(siteId);
    if (runtime === undefined) {
      sendJson(res, 404, { error: `site "${siteId}" is not enabled` });
      return;
    }

    try {
      if (pathname === STATUS_PATH) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const force = /[?&]force=1(?:&|$)/.test(rawUrl);
        sendJson(res, 200, await runtime.buildStatusResponse(force));
        return;
      }

      if (pathname === LOGIN_STATUS_PATH) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        sendJson(res, 200, runtime.getLoginStatus());
        return;
      }

      if (pathname === LOGIN_START_PATH) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' });
          return;
        }
        sendJson(res, 200, await runtime.startLogin());
        return;
      }

      if (pathname === LOGOUT_PATH) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' });
          return;
        }
        const { removed } = await runtime.logout();
        sendJson(res, 200, {
          ok: true,
          removed,
          siteId: runtime.siteId,
          siteLabel: runtime.site.label,
        });
        return;
      }

      if (pathname === MODELS_TOGGLE_PATH) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' });
          return;
        }
        await handleModelsToggle(req, res, deps, runtime);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      deps.logger?.warn?.('dsh-qwenwork-connect: route handler failed', redactSecrets(error));
      sendJson(res, 500, { error: redactSecrets(error, 300) });
    }
  };
}

async function handleModelsToggle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PluginRoutesDeps,
  runtime: SiteRuntime,
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
      return;
    }
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    sendJson(res, status, {
      error: status === 400 ? '请求体不是合法 JSON' : redactSecrets(error, 200),
    });
    return;
  }

  const modelKey = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (modelKey === '' || typeof payload.enabled !== 'boolean') {
    sendJson(res, 400, { error: '需要 { model: string, enabled: boolean }' });
    return;
  }
  const enabled = payload.enabled;

  const catalog = runtime.allModels();
  if (!catalog.some((m) => m.id === modelKey)) {
    sendJson(res, 400, {
      error: `${runtime.site.label} 当前目录里没有模型 "${modelKey}"`,
    });
    return;
  }

  const disabled = disabledForSite(deps.rawConfig, runtime.siteId);
  if (wouldLeaveNone(catalog, disabled, modelKey, enabled)) {
    sendJson(res, 409, { error: `至少要为 ${runtime.site.label} 保留一个可用模型` });
    return;
  }

  if (disabled.includes(modelKey) === !enabled) {
    sendJson(res, 200, {
      ok: true,
      unchanged: true,
      siteId: runtime.siteId,
      model: modelKey,
      enabled,
    });
    return;
  }

  const editor = deps.rootCtx.get?.('configEditor') as
    | { edit?: (entry: unknown, change: (cur: Record<string, unknown>) => Record<string, unknown>) => Promise<void> }
    | undefined;
  const entry = deps.rootCtx.fiber?.entry;
  if (editor === undefined || typeof editor.edit !== 'function' || entry === undefined) {
    sendJson(res, 503, { error: '当前环境没有配置编辑器，无法保存模型开关' });
    return;
  }

  try {
    await editor.edit(entry, (current) => nextRawConfig(current, runtime.siteId, modelKey, enabled));
  } catch (error) {
    const message = redactSecrets(error, 300);
    deps.logger?.warn?.(
      `dsh-qwenwork-connect: 保存模型开关失败（${runtime.site.label} ${modelKey}）`,
      message,
    );
    sendJson(res, 500, { error: message });
    return;
  }

  try {
    deps.onModelsChanged?.(runtime.siteId);
  } catch (error) {
    deps.logger?.warn?.('dsh-qwenwork-connect: 模型目录刷新事件失败', error);
  }

  deps.logger?.info?.(
    `dsh-qwenwork-connect: 模型${enabled ? '启用' : '停用'}（${runtime.site.label}）${modelKey}`,
  );
  sendJson(res, 200, {
    ok: true,
    siteId: runtime.siteId,
    model: modelKey,
    enabled,
  });
}

export function registerPluginRoutes(webCtx: HostContext, deps: PluginRoutesDeps): () => void {
  const handler = createPluginRoutesHandler(deps);
  const mount = () => {
    const dispose = webCtx.webServer?.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    });
    return () => {
      try {
        dispose?.();
      } catch {
        /* ignore double-dispose */
      }
    };
  };

  if (typeof webCtx.effect === 'function') {
    return webCtx.effect(mount, 'dsh-qwenwork-connect: web routes');
  }
  return mount();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
