/**
 * DSH Host plugin entry point for dsh-qwenwork-connect (v1.0.0).
 *
 * Registers:
 * - Per-site SiteRuntime instances (cn & intl by default)
 * - Native QwenWorkLlmAdapter (direct COSY streaming, zero local HTTP shim)
 * - Configurable provider directory entries
 * - Unified WebServer prefix routes (`/plugins/dsh-qwenwork-connect/*`)
 * - Configurable session-projection-backed stall guard
 *
 * Every resource is tied to `ctx.effect` so unload / HMR leaves zero leaks.
 */

import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm';
import { PLUGIN_CORDIS_NAME } from '../shared/contracts.js';
import type { SiteId } from '../shared/sites.js';
import { QwenWorkLlmAdapter } from './adapter.js';
import { Config, readPluginConfig } from './config.js';
import { HybridCredentialStore } from './dsh-credential-store.js';
import type {
  HostContext,
  OptionalAttachmentsService,
  OptionalCredentialsService,
  OptionalFsService,
} from './dsh-services.js';
import { registerPluginRoutes } from './routes.js';
import { SiteRuntime } from './site-runtime.js';
import { installStallGuard } from './stall-guard.js';
import { DebugTracer } from './trace.js';

export const name = PLUGIN_CORDIS_NAME;
export const inject = ['llm'] as const;
export { Config };

export function apply(ctx: HostContext, config?: unknown): void {
  const initialConfig = readPluginConfig(config);

  const credentialStore = new HybridCredentialStore(
    () => ctx.get?.<OptionalCredentialsService>('credentials'),
  );

  const tracer = new DebugTracer(() => readPluginConfig(config).debugTrace);

  let directoryHandle: { replace?: (entries: readonly LlmConfigurableProvider[]) => void } | null =
    null;
  const directoryEntries: LlmConfigurableProvider[] = [];

  const publishModelsChanged = () => {
    try {
      directoryHandle?.replace?.(directoryEntries);
    } catch (error) {
      ctx.logger?.warn?.('dsh-qwenwork-connect: 目录刷新通知失败', error);
    }
  };

  const settingsNs = ctx.fiber?.entry?.options?.id ?? name;
  const runtimes = new Map<SiteId, SiteRuntime>();
  for (const siteId of initialConfig.enabledSites) {
    try {
      const runtime = new SiteRuntime({
        siteId,
        store: credentialStore,
        rawConfig: config,
        logger: ctx.logger,
        onCatalogChanged: () => publishModelsChanged(),
      });
      runtime.startBackgroundCatalogSync();
      runtimes.set(siteId, runtime);
      directoryEntries.push({
        provider: runtime.site.provider,
        displayName: runtime.site.label,
        settingsNs,
        settingsPath: [],
      });
    } catch (error) {
      ctx.logger?.error?.(`dsh-qwenwork-connect: 站点 ${siteId} 初始化失败`, error);
    }
  }

  ctx.effect(() => () => {
    for (const runtime of runtimes.values()) {
      try {
        runtime.dispose();
      } catch {
        /* ignore cleanup errors */
      }
    }
    runtimes.clear();
  }, 'dsh-qwenwork-connect: site runtimes');

  // ---- Native LlmAdapter + configurable provider directory ----
  const providers = [...runtimes.values()].map((r) => r.site.provider);
  if (providers.length > 0) {
    try {
      const adapter = new QwenWorkLlmAdapter({
        runtimes,
        getAttachments: () => {
          const svc = ctx.get?.<OptionalAttachmentsService>('attachments');
          return svc !== undefined && typeof svc.readImageRequest === 'function' ? svc : undefined;
        },
        getFs: () => ctx.get?.<OptionalFsService>('fs'),
        tracer,
      });

      const releaseAdapter = ctx.llm.registerAdapter(providers, adapter);
      let releaseDirectory: (() => void) & {
        replace?: (entries: readonly LlmConfigurableProvider[]) => void;
      };
      try {
        releaseDirectory = ctx.llm.registerConfigurableProviders(directoryEntries);
      } catch (error) {
        releaseAdapter();
        throw error;
      }

      directoryHandle = releaseDirectory;
      ctx.effect(() => () => {
        directoryHandle = null;
        releaseAdapter();
        releaseDirectory();
      }, 'dsh-qwenwork-connect: llm adapter & directory');

      ctx.logger?.info?.(
        `dsh-qwenwork-connect: native LlmAdapter registered (${providers.join(', ')})`,
      );
    } catch (error) {
      ctx.logger?.error?.('dsh-qwenwork-connect: LLM adapter registration failed', error);
    }
  }

  // ---- Unified WebServer routes for settings card & composer readout ----
  ctx.inject(['webServer'], (webCtx) => {
    registerPluginRoutes(webCtx, {
      rootCtx: ctx,
      rawConfig: config,
      runtimes,
      onModelsChanged: () => publishModelsChanged(),
      logger: ctx.logger,
    });
  });

  // ---- Configurable stall-guard (properly disposed via ctx.effect) ----
  if (providers.length > 0) {
    try {
      const disposeGuard = installStallGuard(ctx, {
        rawConfig: config,
        providers,
        logger: ctx.logger,
      });
      ctx.effect(() => disposeGuard, 'dsh-qwenwork-connect: stall-guard');
    } catch (error) {
      ctx.logger?.warn?.('dsh-qwenwork-connect: stall-guard installation failed', error);
    }
  }
}

export {
  QwenWorkLlmAdapter,
  SiteRuntime,
  HybridCredentialStore,
  installStallGuard,
};
export {
  SETTINGS_BOUNDS,
  defaultSettingsSnapshot,
  nextSettingsRawConfig,
  readPluginConfig,
  settingsSnapshotOf,
  validateSettingsPatch,
} from './config.js';
