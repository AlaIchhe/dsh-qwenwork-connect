import type { CSSProperties } from 'react';

export const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
};

export const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

export const headTextStyle: CSSProperties = {
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: 3,
};

export const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 };

export const descriptionStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
};

export const chevronStyle: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 18,
  lineHeight: 1,
  transition: 'transform 120ms ease',
};

export const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  padding: '13px 14px',
};

export const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  flexWrap: 'wrap',
};

export const siteTabsStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: 2,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06))',
};

export function siteTabStyle(active: boolean): CSSProperties {
  return {
    border: 0,
    borderRadius: 6,
    padding: '4px 10px',
    font: 'inherit',
    fontSize: 12,
    lineHeight: '18px',
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
    background: active ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
    boxShadow: active ? '0 1px 2px rgba(0, 0, 0, 0.08)' : 'none',
  };
}

export const actionButtonStyle: CSSProperties = {
  flex: '0 0 auto',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '5px 12px',
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
};

export const primaryButtonStyle: CSSProperties = {
  ...actionButtonStyle,
  borderColor: 'var(--dsw-alias-brand-primary, #1677ff)',
  background: 'var(--dsw-alias-brand-primary, #1677ff)',
  color: '#fff',
};

export const logoutButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  padding: '3px 9px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

export const noticePanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06))',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
};

export const loginLinkStyle: CSSProperties = {
  color: 'var(--dsw-alias-brand-primary, #1677ff)',
  wordBreak: 'break-all',
  textDecoration: 'underline',
};

export const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingTop: 2,
};

export const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
};

export const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 13,
  lineHeight: '18px',
};

export const labelStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)' };

export const valueStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontVariantNumeric: 'tabular-nums',
  textAlign: 'right',
};

export const errorStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'pre-wrap',
};

export const accountRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
};

export function statusDotStyle(status: string): CSSProperties {
  return {
    width: 9,
    height: 9,
    borderRadius: '50%',
    flex: '0 0 auto',
    background:
      status === 'signed-in'
        ? 'var(--dsw-alias-state-success-primary, #22a06b)'
        : status === 'error'
          ? 'var(--dsw-alias-state-error-primary, #d92d20)'
          : 'var(--dsw-alias-label-dimmed, #9aa0a6)',
  };
}

export const quotaLabelStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary)',
};

export const progressTrackStyle: CSSProperties = {
  height: 8,
  overflow: 'hidden',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))',
};

export function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-brand-primary, #1677ff)',
  };
}

export function modelSwitchStyle(checked: boolean, disabled: boolean): CSSProperties {
  return {
    flex: '0 0 auto',
    width: 30,
    height: 18,
    padding: 2,
    border: 0,
    borderRadius: 999,
    cursor: disabled ? 'default' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: checked ? 'flex-end' : 'flex-start',
    background: checked
      ? 'var(--dsw-alias-state-success-primary, #22a06b)'
      : 'var(--dsw-alias-bg-control, rgba(127,127,127,.28))',
    opacity: disabled ? 0.55 : 1,
    transition: 'background 120ms ease',
  };
}

export const modelSwitchKnobStyle: CSSProperties = {
  display: 'block',
  width: 14,
  height: 14,
  borderRadius: '50%',
  background: 'var(--dsw-alias-bg-module-platform, #fff)',
  boxShadow: '0 1px 2px rgba(0,0,0,.18)',
};

export const badgeStyle: CSSProperties = {
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
};

export const COMPOSER_CSS = `
.dsm-qwenwork-composer-credits{display:inline-flex;align-items:center;min-width:0}
.dsm-qwenwork-composer-credits-text{
  display:inline-flex;align-items:center;gap:5px;
  padding:2px 6px;border-radius:6px;
  font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);
  white-space:nowrap;font-variant-numeric:tabular-nums;
}
.dsm-qwenwork-composer-credits-text:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-qwenwork-composer-credits-name{overflow:hidden;text-overflow:ellipsis}
.dsm-qwenwork-composer-credits-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
`;
