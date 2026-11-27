/**
 * DSH Client plugin entry point (compiled by scripts/build.mjs into
 * `window.__ModuleLoader__.load({ id: 'dsh-qwenwork-connect', factory })`).
 */

import {
  PLUGIN_CORDIS_NAME,
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
  slots: {
    inject(slotName: string, factory: () => () => void): () => void;
    register(meta: Record<string, unknown>, renderer: (props: any) => unknown): () => void;
  };
}

export const name = PLUGIN_PACKAGE_NAME;
export const inject = ['slots', 'locale'] as const;

export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.qwenwork';
    ctx.effect(
      () => ctx.locale.register(namespace, { zh, en }),
      'dsh-qwenwork-connect: settings copy',
    );
    const t = ctx.locale.bind(namespace);

    const renderConfig = (slotProps?: {
      view?: string;
      initialState?: SiteStatusResponse | null;
      initialSite?: SiteId;
    }) =>
      slotProps?.view === 'summary' ? (
        t('subtitle')
      ) : (
        <PluginCard
          t={t}
          initialOpen
          {...(slotProps?.initialState !== undefined ? { initialState: slotProps.initialState } : {})}
          {...(slotProps?.initialSite !== undefined ? { initialSite: slotProps.initialSite } : {})}
        />
      );

    for (const [slot, key] of [
      ['plugins.bundle.config', PLUGIN_PACKAGE_NAME],
      ['plugins.row.config', `${PLUGIN_PACKAGE_NAME}#${PLUGIN_CORDIS_NAME}`],
    ] as const) {
      try {
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key }, renderConfig));
      } catch (error) {
        console.error(`[dsh-qwenwork-connect] ${slot} config slot failed to register:`, error);
      }
    }

    try {
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'dsh-qwenwork-connect-composer-credits',
            order: 4,
            locale: namespace,
            inject: () => ({ t }),
          },
          ComposerCredits,
        ),
      );
    } catch (error) {
      console.error('[dsh-qwenwork-connect] composer credits slot failed to register:', error);
    }
  } catch (error) {
    console.error('[dsh-qwenwork-connect] client plugin failed to load:', error);
  }
}
