import { useEffect, useState } from 'react';
import {
  SETTINGS_PATH,
  type PluginSettingsPatch,
  type PluginSettingsSnapshot,
  type SettingsResponse,
} from '../../shared/contracts.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../shared/sites.js';
import type { TranslateFn } from '../i18n.js';
import {
  actionButtonStyle,
  logoutButtonStyle,
  modelSwitchKnobStyle,
  modelSwitchStyle,
  noticePanelStyle,
  numberInputStyle,
  presetChipStyle,
  presetRowStyle,
  primaryButtonStyle,
  sectionStyle,
  sectionTitleStyle,
  settingsCellStyle,
  settingsDividerStyle,
  settingsFieldRowStyle,
  settingsGridStyle,
  settingsGroupStyle,
  settingsHintStyle,
  settingsSuccessStyle,
} from '../styles.js';

const DEFAULT_SNAPSHOT: PluginSettingsSnapshot = {
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  stallGuardEnabled: true,
  stallGuardMaxContinues: 2,
  headerTimeoutSec: 180,
  firstContentTimeoutSec: 90,
  idleTimeoutSec: 300,
  imageMaxTotalMiB: 6,
  imageMaxPerImageMiB: 1,
  imageMaxCount: 32,
  imageMaxPixels: 4_194_304,
  debugTraceEnabled: false,
};

const OUTPUT_TOKEN_PRESETS = [
  { value: 0, labelKey: 'settingsPresetAuto' },
  { value: 65_536, labelKey: 'settingsPreset64k' },
  { value: 131_072, labelKey: 'settingsPreset128k' },
  { value: 262_144, labelKey: 'settingsPreset256k' },
] as const;

const PIXEL_PRESETS = [
  { value: 4_194_304, label: '2048² (4MP)' },
  { value: 9_437_184, label: '3072² (9MP)' },
  { value: 16_777_216, label: '4096² (16MP)' },
] as const;

export function SettingsSection(props: {
  readonly settings: PluginSettingsSnapshot | undefined;
  readonly onSaved: (next: PluginSettingsSnapshot) => void;
  readonly t: TranslateFn;
}) {
  const { settings, onSaved, t } = props;
  const effective = settings ?? DEFAULT_SNAPSHOT;

  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<PluginSettingsSnapshot>(effective);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  // Sync draft when server snapshot updates and user isn't currently saving
  useEffect(() => {
    if (settings !== undefined && !saving) {
      setDraft(settings);
    }
  }, [settings, saving]);

  const dirty = !snapshotsEqual(draft, effective);

  const updateField = <K extends keyof PluginSettingsSnapshot>(
    key: K,
    value: PluginSettingsSnapshot[K],
  ) => {
    setSavedNotice(false);
    setError(null);
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleNumber = (
    key:
      | 'maxOutputTokens'
      | 'stallGuardMaxContinues'
      | 'headerTimeoutSec'
      | 'firstContentTimeoutSec'
      | 'idleTimeoutSec'
      | 'imageMaxTotalMiB'
      | 'imageMaxPerImageMiB'
      | 'imageMaxCount'
      | 'imageMaxPixels',
    raw: string,
  ) => {
    const parsed = raw.trim() === '' ? 0 : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    updateField(key, Math.max(0, parsed));
  };

  const submitPatch = async (patch: PluginSettingsPatch) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      const res = await fetch(SETTINGS_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => null)) as
        | (Partial<SettingsResponse> & { error?: string })
        | null;
      if (!res.ok || body?.settings === undefined) {
        throw new Error(body?.error ?? `${t('settingsSaveFailed')} (${res.status})`);
      }
      setDraft(body.settings);
      onSaved(body.settings);
      setSavedNotice(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settingsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    void submitPatch(draft);
  };

  const handleReset = () => {
    void submitPatch(DEFAULT_SNAPSHOT);
  };

  return (
    <div style={{ ...sectionStyle, ...settingsDividerStyle }}>
      <div style={settingsFieldRowStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h3 style={sectionTitleStyle}>{t('settingsHeading')}</h3>
          <span style={settingsHintStyle}>{t('settingsSubtitle')}</span>
        </div>
        <button
          type="button"
          style={logoutButtonStyle}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? t('settingsCollapse') : t('settingsExpand')}
        </button>
      </div>

      {!expanded ? (
        <div style={settingsHintStyle}>
          {`${t('settingsMaxOutputTokens')}: ${
            effective.maxOutputTokens === 0
              ? t('settingsPresetAuto')
              : effective.maxOutputTokens.toLocaleString()
          } · ${t('settingsStallGuard')}: ${
            effective.stallGuardEnabled ? `${effective.stallGuardMaxContinues}x` : 'OFF'
          }`}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Generation: maxOutputTokens */}
          <div style={settingsGroupStyle}>
            <div style={settingsFieldRowStyle}>
              <label htmlFor="qw-max-output-tokens" style={{ fontWeight: 500 }}>
                {t('settingsMaxOutputTokens')}
              </label>
              <input
                id="qw-max-output-tokens"
                type="number"
                min={0}
                max={393216}
                step={1024}
                disabled={saving}
                value={draft.maxOutputTokens}
                style={numberInputStyle}
                onChange={(e) => handleNumber('maxOutputTokens', e.target.value)}
              />
            </div>
            <div style={presetRowStyle}>
              {OUTPUT_TOKEN_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  disabled={saving}
                  style={presetChipStyle(draft.maxOutputTokens === preset.value)}
                  onClick={() => updateField('maxOutputTokens', preset.value)}
                >
                  {t(preset.labelKey)}
                </button>
              ))}
            </div>
            <span style={settingsHintStyle}>{t('settingsMaxOutputHint')}</span>
          </div>

          {/* Stall Guard */}
          <div style={settingsGroupStyle}>
            <div style={settingsFieldRowStyle}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{t('settingsStallGuard')}</span>
                <span style={settingsHintStyle}>{t('settingsStallGuardHint')}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={draft.stallGuardEnabled}
                aria-label={t('settingsStallGuard')}
                disabled={saving}
                style={modelSwitchStyle(draft.stallGuardEnabled, saving)}
                onClick={() => updateField('stallGuardEnabled', !draft.stallGuardEnabled)}
              >
                <span style={modelSwitchKnobStyle} />
              </button>
            </div>
            {draft.stallGuardEnabled ? (
              <div style={settingsFieldRowStyle}>
                <label htmlFor="qw-stall-max" style={settingsHintStyle}>
                  {t('settingsStallMaxContinues')}
                </label>
                <input
                  id="qw-stall-max"
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  disabled={saving}
                  value={draft.stallGuardMaxContinues}
                  style={{ ...numberInputStyle, width: 76 }}
                  onChange={(e) => handleNumber('stallGuardMaxContinues', e.target.value)}
                />
              </div>
            ) : null}
          </div>

          {/* Timeouts */}
          <div style={settingsGroupStyle}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{t('settingsTimeoutsHeading')}</span>
            <div style={settingsGridStyle}>
              <label style={settingsCellStyle}>
                <span>{t('settingsHeaderTimeout')}</span>
                <input
                  type="number"
                  min={5}
                  max={3600}
                  step={5}
                  disabled={saving}
                  value={draft.headerTimeoutSec}
                  style={{ ...numberInputStyle, width: '100%' }}
                  onChange={(e) => handleNumber('headerTimeoutSec', e.target.value)}
                />
              </label>
              <label style={settingsCellStyle}>
                <span>{t('settingsFirstContentTimeout')}</span>
                <input
                  type="number"
                  min={5}
                  max={3600}
                  step={5}
                  disabled={saving}
                  value={draft.firstContentTimeoutSec}
                  style={{ ...numberInputStyle, width: '100%' }}
                  onChange={(e) => handleNumber('firstContentTimeoutSec', e.target.value)}
                />
              </label>
              <label style={settingsCellStyle}>
                <span>{t('settingsIdleTimeout')}</span>
                <input
                  type="number"
                  min={5}
                  max={3600}
                  step={10}
                  disabled={saving}
                  value={draft.idleTimeoutSec}
                  style={{ ...numberInputStyle, width: '100%' }}
                  onChange={(e) => handleNumber('idleTimeoutSec', e.target.value)}
                />
              </label>
            </div>
          </div>

          {/* Vision Images */}
          <div style={settingsGroupStyle}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{t('settingsImagesHeading')}</span>
            <div style={settingsGridStyle}>
              <label style={settingsCellStyle}>
                <span>{t('settingsImagePerMiB')}</span>
                <input
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  disabled={saving}
                  value={draft.imageMaxPerImageMiB}
                  style={{ ...numberInputStyle, width: '100%' }}
                  onChange={(e) => handleNumber('imageMaxPerImageMiB', e.target.value)}
                />
              </label>
              <label style={settingsCellStyle}>
                <span>{t('settingsImageTotalMiB')}</span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  disabled={saving}
                  value={draft.imageMaxTotalMiB}
                  style={{ ...numberInputStyle, width: '100%' }}
                  onChange={(e) => handleNumber('imageMaxTotalMiB', e.target.value)}
                />
              </label>
              <label style={settingsCellStyle}>
                <span>{t('settingsImageMaxCount')}</span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  disabled={saving}
                  value={draft.imageMaxCount}
                  style={{ ...numberInputStyle, width: '100%' }}
                  onChange={(e) => handleNumber('imageMaxCount', e.target.value)}
                />
              </label>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={settingsHintStyle}>{t('settingsImagePixels')}</span>
              <div style={presetRowStyle}>
                {PIXEL_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    disabled={saving}
                    style={presetChipStyle(draft.imageMaxPixels === preset.value)}
                    onClick={() => updateField('imageMaxPixels', preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Debug Trace */}
          <div style={settingsGroupStyle}>
            <div style={settingsFieldRowStyle}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{t('settingsDebugTrace')}</span>
                <span style={settingsHintStyle}>{t('settingsDebugTraceHint')}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={draft.debugTraceEnabled}
                aria-label={t('settingsDebugTrace')}
                disabled={saving}
                style={modelSwitchStyle(draft.debugTraceEnabled, saving)}
                onClick={() => updateField('debugTraceEnabled', !draft.debugTraceEnabled)}
              >
                <span style={modelSwitchKnobStyle} />
              </button>
            </div>
          </div>

          {error !== null ? <div style={noticePanelStyle}>{error}</div> : null}
          {savedNotice ? <div style={settingsSuccessStyle}>{t('settingsSaved')}</div> : null}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={saving}
              style={actionButtonStyle}
              onClick={handleReset}
            >
              {t('settingsReset')}
            </button>
            <button
              type="button"
              disabled={saving || !dirty}
              style={
                saving || !dirty
                  ? { ...primaryButtonStyle, opacity: 0.55, cursor: 'default' }
                  : primaryButtonStyle
              }
              onClick={handleSave}
            >
              {saving ? t('settingsSaving') : t('settingsSave')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function snapshotsEqual(a: PluginSettingsSnapshot, b: PluginSettingsSnapshot): boolean {
  return (
    a.maxOutputTokens === b.maxOutputTokens &&
    a.stallGuardEnabled === b.stallGuardEnabled &&
    a.stallGuardMaxContinues === b.stallGuardMaxContinues &&
    a.headerTimeoutSec === b.headerTimeoutSec &&
    a.firstContentTimeoutSec === b.firstContentTimeoutSec &&
    a.idleTimeoutSec === b.idleTimeoutSec &&
    a.imageMaxTotalMiB === b.imageMaxTotalMiB &&
    a.imageMaxPerImageMiB === b.imageMaxPerImageMiB &&
    a.imageMaxCount === b.imageMaxCount &&
    a.imageMaxPixels === b.imageMaxPixels &&
    a.debugTraceEnabled === b.debugTraceEnabled
  );
}
