import { KeyValueRow, Section } from 'dsh-provider-ui';
import type { PerfSummary } from '../../shared/contracts.js';
import { formatNumber, type TranslateFn } from '../i18n.js';

export function PerfSection(props: {
  readonly perf: PerfSummary;
  readonly t: TranslateFn;
}) {
  const { perf, t } = props;
  return (
    <div style={{ paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))' }}>
      <Section title={t('perfHeading')}>
        <KeyValueRow label={t('ttft')} value={t('ms', { value: formatNumber(perf.ttftMs) })} />
        <KeyValueRow label={t('speed')} value={t('charsPerSec', { value: formatNumber(perf.charsPerSec) })} />
        <div className="dpui-field-desc">
          {t('perfSampleNote', { count: perf.samples })}
        </div>
      </Section>
    </div>
  );
}
