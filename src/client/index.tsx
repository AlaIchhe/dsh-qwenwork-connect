/**
 * DSH Client plugin entry point (compiled by scripts/build.mjs into
 * `window.__ModuleLoader__.load({ id: 'dsh-qwenwork-connect', factory })`).
 */

import {
  registerComposerQuotaSlot,
  registerProviderSettings,
  setPortalRequire,
  type SlotsServiceLike,
} from 'dsh-provider-ui';
import {
  PLUGIN_PACKAGE_NAME,
  type SiteStatusResponse,
} from '../shared/contracts.js';
import type { SiteId } from '../shared/sites.js';
import { ComposerCredits } from './components/ComposerCredits.js';
import { PluginCard } from './components/PluginCard.js';
import { en, zh, type TranslateFn } from './i18n.js';

interface ClientContext {
  effect(fn: () => (() => void) | void, label?: string): () => void;
  locale: {
    register(namespace: string, bundles: Record<string, Record<string, string>>): () => void;
    bind(namespace: string): TranslateFn;
  };
  slots: SlotsServiceLike;
}

export const name = PLUGIN_PACKAGE_NAME;
export const inject = ['slots', 'locale'] as const;
export const __setOptionalRequire = setPortalRequire;

export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.qwenwork';
    ctx.effect(
      () => ctx.locale.register(namespace, { zh, en }),
      'dsh-qwenwork-connect: settings copy',
    );
    const t = ctx.locale.bind(namespace);

    const SettingsPanel = (slotProps?: {
      initialState?: SiteStatusResponse | null;
      initialSite?: SiteId;
    }) => (
      <PluginCard
        t={t}
        {...(slotProps?.initialState !== undefined ? { initialState: slotProps.initialState } : {})}
        {...(slotProps?.initialSite !== undefined ? { initialSite: slotProps.initialSite } : {})}
      />
    );

    registerProviderSettings(
      ctx,
      {
        id: 'qwenwork',
        order: 44,
        label: () => t('title'),
        locale: namespace,
        inject: () => ({ t }),
      },
      SettingsPanel,
    );

    registerComposerQuotaSlot(
      ctx,
      {
        id: 'dsh-qwenwork-connect-composer-credits',
        order: 1004,
        locale: namespace,
        inject: () => ({ t }),
      },
      ComposerCredits,
    );
  } catch (error) {
    console.error('[dsh-qwenwork-connect] client plugin failed to load:', error);
  }
}
