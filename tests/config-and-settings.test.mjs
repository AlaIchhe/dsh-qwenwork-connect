import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  SETTINGS_PATH,
  buildInferBody,
  parseCatalogPayload,
} from '../dist/core/index.js';
import {
  QwenWorkLlmAdapter,
  SiteRuntime,
  defaultSettingsSnapshot,
  nextSettingsRawConfig,
  readPluginConfig,
  settingsSnapshotOf,
  validateSettingsPatch,
} from '../dist/host/index.js';

test('buildInferBody supports 128K default, custom >32K limits, omitting max_tokens, and isReasoning=false', () => {
  const defaultBody = JSON.parse(
    buildInferBody({
      messages: [{ role: 'user', content: 'hi' }],
      modelKey: 'deepseek-flash',
      sessionId: 's1',
    }),
  );
  assert.equal(defaultBody.parameters.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(defaultBody.parameters.enable_thinking, true);

  const highBody = JSON.parse(
    buildInferBody({
      messages: [{ role: 'user', content: 'hi' }],
      modelKey: 'deepseek-flash',
      sessionId: 's2',
      maxOutputTokens: 262_144,
    }),
  );
  assert.equal(highBody.parameters.max_tokens, 262_144);

  const omittedBody = JSON.parse(
    buildInferBody({
      messages: [{ role: 'user', content: 'hi' }],
      modelKey: 'deepseek-flash',
      sessionId: 's3',
      maxOutputTokens: null,
      isReasoning: false,
    }),
  );
  assert.equal('max_tokens' in omittedBody.parameters, false);
  assert.equal(omittedBody.parameters.enable_thinking, false);
  assert.equal(omittedBody.model_config.is_reasoning, false);
});

test('parseCatalogPayload respects context_config.is_default, is_reasoning, and optional max_output_tokens', () => {
  const parsed = parseCatalogPayload({
    qwork: [
      {
        key: 'custom-model',
        display_name: 'Custom',
        enable: true,
        is_vl: true,
        is_reasoning: false,
        price_factor: 0.2,
        max_input_tokens: 1_000_000,
        max_output_tokens: 65_536,
        context_config: {
          '200K': { token_count: 200_000, is_default: true },
          '1M': { token_count: 1_000_000 },
        },
      },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].contextWindow, 200_000);
  assert.equal(parsed[0].isReasoning, false);
  assert.equal(parsed[0].maxTokens, 65_536);
});

test('validateSettingsPatch and nextSettingsRawConfig preserve unrelated keys and enforce bounds', () => {
  const valid = validateSettingsPatch({
    maxOutputTokens: 0,
    stallGuardEnabled: false,
    stallGuardMaxContinues: 4,
    headerTimeoutSec: 240,
    firstContentTimeoutSec: 120,
    idleTimeoutSec: 600,
    imageMaxPerImageMiB: 2,
    imageMaxTotalMiB: 12,
    imageMaxCount: 16,
    imageMaxPixels: 9_437_184,
    debugTraceEnabled: true,
  });
  assert.equal(valid.ok, true);

  const raw = {
    disabledModels: { cn: ['pro'] },
    trustedHosts: ['dsh.internal'],
    vpc: { caCertPath: '/etc/ssl/custom.pem', insecureTls: false },
  };
  const updated = nextSettingsRawConfig(raw, valid.patch);
  assert.deepEqual(updated.disabledModels, { cn: ['pro'] });
  assert.deepEqual(updated.trustedHosts, ['dsh.internal']);
  assert.deepEqual(updated.vpc, { caCertPath: '/etc/ssl/custom.pem', insecureTls: false });

  const snap = settingsSnapshotOf(readPluginConfig(updated));
  assert.equal(snap.maxOutputTokens, 0);
  assert.equal(snap.stallGuardEnabled, false);
  assert.equal(snap.stallGuardMaxContinues, 4);
  assert.equal(snap.headerTimeoutSec, 240);
  assert.equal(snap.firstContentTimeoutSec, 120);
  assert.equal(snap.idleTimeoutSec, 600);
  assert.equal(snap.imageMaxPerImageMiB, 2);
  assert.equal(snap.imageMaxTotalMiB, 12);
  assert.equal(snap.imageMaxCount, 16);
  assert.equal(snap.imageMaxPixels, 9_437_184);
  assert.equal(snap.debugTraceEnabled, true);

  assert.equal(validateSettingsPatch({ maxOutputTokens: 100 }).ok, false);
  assert.equal(validateSettingsPatch({ maxOutputTokens: 999_999 }).ok, false);
  assert.equal(validateSettingsPatch({ imageMaxPerImageMiB: 8, imageMaxTotalMiB: 4 }).ok, false);
  assert.equal(validateSettingsPatch({}).ok, false);
});

test('QwenWorkLlmAdapter dynamically honors hot-reloaded generation and image settings', async () => {
  const rawConfig = {
    generation: { maxOutputTokens: 131_072 },
    images: {
      maxTotalBytes: 12 * 1024 * 1024,
      maxPerImageBytes: 2 * 1024 * 1024,
      maxImages: 16,
      pixelBudget: 16_777_216,
    },
  };
  const memStore = {
    read: async () => undefined,
    write: async () => undefined,
    update: async () => undefined,
    clear: async () => false,
  };
  const runtime = new SiteRuntime({ siteId: 'cn', store: memStore, rawConfig });
  const adapter = new QwenWorkLlmAdapter({ runtimes: new Map([['cn', runtime]]) });

  const resolved128k = await adapter.resolveModel('qwenwork', 'deepseek-flash');
  assert.equal(resolved128k.defaultMaxTokens, 131_072);

  // Hot-update to 0 (auto / omit max_tokens)
  rawConfig.generation.maxOutputTokens = 0;
  const resolvedAuto = await adapter.resolveModel('qwenwork', 'deepseek-flash');
  assert.equal(resolvedAuto.defaultMaxTokens, undefined);

  // Image request target reflects hot-updated pixelBudget & maxPerImageBytes
  const target = adapter.imageRequestTarget('qwenwork', 'deepseek-flash', {
    attachmentId: 'sha256:test',
    mediaType: 'image/png',
    width: 4000,
    height: 4000,
    bytes: 500_000,
  });
  assert.equal(target.width, 4000);
  assert.equal(target.height, 4000);
  assert.equal(target.maxImageBytes, 2 * 1024 * 1024);

  runtime.dispose();
  assert.equal(SETTINGS_PATH, '/plugins/dsh-qwenwork-connect/settings');
  assert.equal(defaultSettingsSnapshot().maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
});
