import { formatNumber, type TranslateFn } from '../i18n.js';
import { progressFillStyle, progressTrackStyle, quotaLabelStyle, sectionStyle } from '../styles.js';

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
    <div style={sectionStyle}>
      <div style={quotaLabelStyle}>
        <span>{t('credits')}</span>
        {rightLabel !== '' ? <span>{rightLabel}</span> : null}
      </div>
      {percent !== undefined ? (
        <div style={progressTrackStyle}>
          <div style={progressFillStyle(percent)} />
        </div>
      ) : null}
      <div
        style={{
          fontSize: 12,
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-tertiary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {detailText}
      </div>
    </div>
  );
}
