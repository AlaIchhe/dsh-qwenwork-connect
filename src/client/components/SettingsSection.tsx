import { useEffect, useState } from 'react';
import {
  Card,
  Chip,
  DirtyBar,
  Field,
  Notice,
  Section,
  SwitchRow,
  TextInput,
} from 'dsh-provider-ui';
import {
  SETTINGS_PATH,
  type PluginSettingsPatch,
  type PluginSettingsSnapshot,
  type SettingsResponse,
} from '../../shared/contracts.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../shared/sites.js';
import type { TranslateFn } from '../i18n.js';

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

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <span className="dpui-muted">{t('settingsSubtitle')}</span>

      {error !== null ? <Notice kind="error">{error}</Notice> : null}
      {savedNotice ? <Notice kind="ok">{t('settingsSaved')}</Notice> : null}

      <Card>
        <Field label={t('settingsMaxOutputTokens')} description={t('settingsMaxOutputHint')}>
          <TextInput
            type="number"
            min={0}
            max={393216}
            step={1024}
            disabled={saving}
            value={draft.maxOutputTokens}
            onChange={(e) => handleNumber('maxOutputTokens', e.target.value)}
          />
        </Field>
        <div className="dpui-row">
          {OUTPUT_TOKEN_PRESETS.map((preset) => (
            <Chip
              key={preset.value}
              active={draft.maxOutputTokens === preset.value}
              disabled={saving}
              onClick={() => updateField('maxOutputTokens', preset.value)}
            >
              {t(preset.labelKey)}
            </Chip>
          ))}
        </div>
      </Card>

      <Card>
        <SwitchRow
          label={t('settingsStallGuard')}
          description={t('settingsStallGuardHint')}
          checked={draft.stallGuardEnabled}
          disabled={saving}
          onChange={(checked) => updateField('stallGuardEnabled', checked)}
        />
        {draft.stallGuardEnabled ? (
          <Field label={t('settingsStallMaxContinues')}>
            <TextInput
              type="number"
              min={0}
              max={10}
              step={1}
              disabled={saving}
              value={draft.stallGuardMaxContinues}
              onChange={(e) => handleNumber('stallGuardMaxContinues', e.target.value)}
            />
          </Field>
        ) : null}
      </Card>

      <Card>
        <Section title={t('settingsTimeoutsHeading')}>
          <div className="dpui-grid-2">
            <Field label={t('settingsHeaderTimeout')}>
              <TextInput
                type="number"
                min={5}
                max={3600}
                step={5}
                disabled={saving}
                value={draft.headerTimeoutSec}
                onChange={(e) => handleNumber('headerTimeoutSec', e.target.value)}
              />
            </Field>
            <Field label={t('settingsFirstContentTimeout')}>
              <TextInput
                type="number"
                min={5}
                max={3600}
                step={5}
                disabled={saving}
                value={draft.firstContentTimeoutSec}
                onChange={(e) => handleNumber('firstContentTimeoutSec', e.target.value)}
              />
            </Field>
            <Field label={t('settingsIdleTimeout')}>
              <TextInput
                type="number"
                min={5}
                max={3600}
                step={10}
                disabled={saving}
                value={draft.idleTimeoutSec}
                onChange={(e) => handleNumber('idleTimeoutSec', e.target.value)}
              />
            </Field>
          </div>
        </Section>
      </Card>

      <Card>
        <Section title={t('settingsImagesHeading')}>
          <div className="dpui-grid-2">
            <Field label={t('settingsImagePerMiB')}>
              <TextInput
                type="number"
                min={1}
                max={16}
                step={1}
                disabled={saving}
                value={draft.imageMaxPerImageMiB}
                onChange={(e) => handleNumber('imageMaxPerImageMiB', e.target.value)}
              />
            </Field>
            <Field label={t('settingsImageTotalMiB')}>
              <TextInput
                type="number"
                min={1}
                max={64}
                step={1}
                disabled={saving}
                value={draft.imageMaxTotalMiB}
                onChange={(e) => handleNumber('imageMaxTotalMiB', e.target.value)}
              />
            </Field>
            <Field label={t('settingsImageMaxCount')}>
              <TextInput
                type="number"
                min={1}
                max={64}
                step={1}
                disabled={saving}
                value={draft.imageMaxCount}
                onChange={(e) => handleNumber('imageMaxCount', e.target.value)}
              />
            </Field>
          </div>
          <div className="dpui-field">
            <span className="dpui-field-desc">{t('settingsImagePixels')}</span>
            <div className="dpui-row">
              {PIXEL_PRESETS.map((preset) => (
                <Chip
                  key={preset.value}
                  active={draft.imageMaxPixels === preset.value}
                  disabled={saving}
                  onClick={() => updateField('imageMaxPixels', preset.value)}
                >
                  {preset.label}
                </Chip>
              ))}
            </div>
          </div>
        </Section>
      </Card>

      <SwitchRow
        label={t('settingsDebugTrace')}
        description={t('settingsDebugTraceHint')}
        checked={draft.debugTraceEnabled}
        disabled={saving}
        onChange={(checked) => updateField('debugTraceEnabled', checked)}
      />

      <DirtyBar
        dirty={dirty}
        saving={saving}
        saveLabel={t('settingsSave')}
        savingLabel={t('settingsSaving')}
        discardLabel={t('discard')}
        resetLabel={t('settingsReset')}
        onSave={() => { void submitPatch(draft); }}
        onDiscard={() => setDraft(effective)}
        onReset={() => { void submitPatch(DEFAULT_SNAPSHOT); }}
      />
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
