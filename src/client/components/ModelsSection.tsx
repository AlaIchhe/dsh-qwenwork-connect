import type { CardModelItem } from '../../shared/contracts.js';
import type { TranslateFn } from '../i18n.js';
import {
  badgeStyle,
  modelSwitchKnobStyle,
  modelSwitchStyle,
  sectionStyle,
  sectionTitleStyle,
} from '../styles.js';

export function ModelsSection(props: {
  readonly models: readonly CardModelItem[];
  readonly busy: boolean;
  readonly onToggle: (model: CardModelItem) => void;
  readonly t: TranslateFn;
}) {
  const { models, busy, onToggle, t } = props;
  if (models.length === 0) return null;

  const enabledCount = models.filter((m) => m.enabled !== false).length;

  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('models')}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {models.map((model) => {
          const enabled = model.enabled !== false;
          const canToggle = !enabled || enabledCount > 1;
          const badges: string[] = [];
          if (model.isDefault) badges.push(t('badgeDefault'));
          if (model.isRecommended) badges.push(t('badgeRecommended'));
          if (model.isNew) badges.push(t('badgeNew'));

          return (
            <div
              key={model.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                opacity: enabled ? 1 : 0.55,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  fontSize: 13,
                  lineHeight: '18px',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>
                    {model.name}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                    {model.description}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${model.name} ${t('modelSwitchLabel')}`}
                  disabled={!canToggle || busy}
                  title={canToggle ? t('modelSwitchHint') : undefined}
                  style={modelSwitchStyle(enabled, !canToggle || busy)}
                  onClick={() => {
                    if (canToggle && !busy) onToggle(model);
                  }}
                >
                  <span style={modelSwitchKnobStyle} />
                </button>
              </div>
              {badges.length > 0 ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {badges.map((label) => (
                    <span key={label} style={badgeStyle}>
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
