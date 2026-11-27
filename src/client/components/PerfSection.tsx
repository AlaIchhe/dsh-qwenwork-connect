import type { PerfSummary } from '../../shared/contracts.js';
import { formatNumber, type TranslateFn } from '../i18n.js';
import { labelStyle, rowStyle, sectionStyle, sectionTitleStyle, valueStyle } from '../styles.js';

export function PerfSection(props: {
  readonly perf: PerfSummary;
  readonly t: TranslateFn;
}) {
  const { perf, t } = props;
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('perfHeading')}</h3>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('ttft')}</span>
        <span style={valueStyle}>{t('ms', { value: formatNumber(perf.ttftMs) })}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('speed')}</span>
        <span style={valueStyle}>{t('charsPerSec', { value: formatNumber(perf.charsPerSec) })}</span>
      </div>
      <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {t('perfSampleNote', { count: perf.samples })}
      </div>
    </div>
  );
}
