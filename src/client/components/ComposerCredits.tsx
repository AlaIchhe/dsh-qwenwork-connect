import { useState } from 'react';
import { ComposerQuotaPill, resolveQuotaTone } from 'dsh-provider-ui';
import type { SiteStatusResponse } from '../../shared/contracts.js';
import { siteIdOfProvider } from '../../shared/sites.js';
import { formatNumber, siteLabel, type TranslateFn } from '../i18n.js';
import { fetchSiteStatus, useSiteStatus } from '../store.js';
import { PerfSection } from './PerfSection.js';
import { QuotaBar } from './QuotaBar.js';

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
  const [refreshing, setRefreshing] = useState(false);

  const state = useSiteStatus(activeSite ?? 'cn', mine, {
    initialState,
    silentError: true,
  });

  if (!mine || activeSite === undefined) return null;

  const creditsEntry = state?.entitlements?.find((e) => e.key === 'credits');
  const credits = state?.remaining ?? creditsEntry?.remain;
  const total = creditsEntry?.size ?? state?.total;
  const denom =
    typeof total === 'number' && total > 0
      ? total
      : typeof state?.creditBaseline === 'number' && state.creditBaseline > 0
        ? state.creditBaseline
        : undefined;
  const percent =
    typeof credits === 'number' && denom !== undefined
      ? Math.max(0, Math.min(100, Math.round((credits / denom) * 100)))
      : undefined;

  const hasNumber = typeof credits === 'number';
  const value = hasNumber
    ? formatNumber(credits)
    : state?.status === 'signed-in'
      ? t('creditsDegraded')
      : t('creditsUnavailable');

  const tone = !hasNumber
    ? 'warn'
    : percent !== undefined
      ? resolveQuotaTone(percent)
      : 'ok';

  const siteText = siteLabel(t, activeSite);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetchSiteStatus(activeSite, { force: true, silentError: true });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <ComposerQuotaPill
      label={siteText}
      value={value}
      ariaLabel={`${siteText} · ${value}`}
      title={t('composerTooltip')}
      tone={tone}
      dot={percent === undefined}
      miniBars={
        percent !== undefined
          ? [{ pct: percent, label: `${siteText} ${t('credits')}` }]
          : undefined
      }
      popoverTitle={state?.tierName ? `${siteText} · ${state.tierName}` : siteText}
      onRefresh={() => { void handleRefresh(); }}
      refreshing={refreshing}
      refreshLabel={t('refresh')}
      refreshingLabel={t('refreshing')}
      closeLabel={t('close')}
    >
      {hasNumber ? (
        <QuotaBar
          remaining={credits}
          total={total}
          baseline={state?.creditBaseline}
          t={t}
        />
      ) : (
        <span className="dpui-muted">{value}</span>
      )}
      {state?.perf !== undefined ? <PerfSection perf={state.perf} t={t} /> : null}
    </ComposerQuotaPill>
  );
}
