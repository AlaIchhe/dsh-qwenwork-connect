import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenWorkLlmAdapter } from '../dist/host/index.js';

const alias = {
  id: 'flash',
  displayNameId: 'qwen3.8-flash',
  shortName: 'Flash alias',
  supportsImages: false,
  contextWindow: 128_000,
  maxTokens: 8_192,
  billingRate: 0,
};
const exact = {
  id: 'qwen3.8-flash',
  shortName: 'Exact upstream model',
  supportsImages: true,
  contextWindow: 256_000,
  maxTokens: 16_384,
  billingRate: 0,
};

function adapterWith(catalog) {
  const runtime = {
    allModels: () => catalog,
    findModel: (id) => catalog.find((entry) => entry.id === id),
    disabledModels: () => [],
  };
  return new QwenWorkLlmAdapter({ runtimes: new Map([['cn', runtime]]) });
}

test('exact model IDs take priority over display-name aliases', () => {
  const adapter = adapterWith([alias, exact]);
  const snapshot = adapter.buildSnapshot('qwenwork', 'qwen3.8-flash');

  assert.equal(snapshot.modelKey, 'qwen3.8-flash');
  assert.equal(snapshot.resolvedModel.id, 'qwen3.8-flash');
  assert.equal(snapshot.resolvedModel.name, 'Exact upstream model · 免费');
});

test('display-name aliases retain the requested metadata ID and alias routing key', () => {
  const adapter = adapterWith([alias]);
  const snapshot = adapter.buildSnapshot('qwenwork', 'qwen3.8-flash');

  assert.equal(snapshot.modelKey, 'flash');
  assert.equal(snapshot.resolvedModel.id, 'qwen3.8-flash');
  assert.equal(snapshot.resolvedModel.name, 'Flash alias · 免费');
});

test('canonical model IDs keep their existing routing and metadata', () => {
  const adapter = adapterWith([alias, exact]);
  const snapshot = adapter.buildSnapshot('qwenwork', 'flash');

  assert.equal(snapshot.modelKey, 'flash');
  assert.equal(snapshot.resolvedModel.id, 'flash');
  assert.equal(snapshot.resolvedModel.name, 'Flash alias · 免费');
});
