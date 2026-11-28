import { KeyValueRow, QuotaProgressBar, resolveQuotaTone } from 'dsh-provider-ui';
import { formatNumber, type TranslateFn } from '../i18n.js';

export function QuotaBar(props: {
  readonly remaining: number;
  readonly total?: number;
  readonly baseline?: number;
  readonly t: TranslateFn;
}) {
  const { remaining, total, baseline, t } = props;
  const hasRealTotal = typeof total === 'number' && total > 0;
  const denom = hasRealTotal ? total : typeof baseline === 'number' && baseline > 0 ? baseline : undefined;
  const percent = denom !== undefined ? Math.max(0, Math.min(100, Math.round((remaining / denom) * 100))) : undefined;

  const rightLabel =
    hasRealTotal && percent !== undefined
      ? t('percentRemaining', { percent })
      : percent !== undefined
        ? t('peakLevel', { percent })
        : '';

  const detailText = hasRealTotal
    ? t('exactRemaining', { remain: formatNumber(remaining), size: formatNumber(total!) })
    : t('creditBalance', { value: formatNumber(remaining) });

  return (
    <div style={{ display: 'grid', gap: 6, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))' }}>
      <KeyValueRow label={<strong>{t('credits')}</strong>} value={rightLabel || formatNumber(remaining)} />
      {percent !== undefined ? (
        <QuotaProgressBar
          pct={percent}
          tone={resolveQuotaTone(percent)}
          label={t('credits')}
        />
      ) : null}
      <div className="dpui-field-desc" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {detailText}
      </div>
    </div>
  );
}
