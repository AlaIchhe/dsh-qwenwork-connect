import type { SiteStatusResponse } from '../../shared/contracts.js';
import { siteIdOfProvider } from '../../shared/sites.js';
import { formatNumber, siteLabel, type TranslateFn } from '../i18n.js';
import { useSiteStatus } from '../store.js';
import { COMPOSER_CSS } from '../styles.js';

interface ModelSelectionProjection {
  readonly next?: { readonly provider?: string };
  readonly lastUsed?: { readonly provider?: string };
}

export function ComposerCredits(props: {
  readonly t: TranslateFn;
  readonly useProjection?: (key: string) => ModelSelectionProjection | undefined;
  readonly initialState?: SiteStatusResponse | null;
}) {
  const { t, useProjection, initialState } = props;
  const projection = useProjection ? useProjection('modelSelection') : undefined;
  const provider = (projection?.next ?? projection?.lastUsed)?.provider;
  const activeSite = siteIdOfProvider(provider);
  const mine = activeSite !== undefined;

  const state = useSiteStatus(activeSite ?? 'cn', mine, {
    initialState,
    silentError: true,
  });

  if (!mine || activeSite === undefined) return null;

  const creditsEntry = state?.entitlements?.find((e) => e.key === 'credits');
  const credits = state?.remaining ?? creditsEntry?.remain;

  return (
    <>
      <style>{COMPOSER_CSS}</style>
      <div className="dsm-qwenwork-composer-credits" title={t('composerTooltip')}>
        <span className="dsm-qwenwork-composer-credits-text">
          <span className="dsm-qwenwork-composer-credits-name">{siteLabel(t, activeSite)}</span>
          <span>·</span>
          {typeof credits === 'number' ? (
            <span>{formatNumber(credits)}</span>
          ) : state?.status === 'signed-in' ? (
            <span className="dsm-qwenwork-composer-credits-warn">{t('creditsDegraded')}</span>
          ) : (
            <span className="dsm-qwenwork-composer-credits-warn">{t('creditsUnavailable')}</span>
          )}
        </span>
      </div>
    </>
  );
}
