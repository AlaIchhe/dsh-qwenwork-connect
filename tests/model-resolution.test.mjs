import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import { decodeBody, encodeBody, parseCatalogPayload } from '../dist/core/index.js';
import { QwenWorkLlmAdapter, SiteRuntime } from '../dist/host/index.js';

function createFixture({ rawConfig = {}, fetchImpl } = {}) {
  const credential = {
    schemaVersion: 2,
    siteId: 'cn',
    token: 'tok-test',
    refreshToken: 'ref-test',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    loginDeviceId: 'machine-test',
    loginMethod: 'device-flow',
    user: {
      id: 'user-1',
      name: 'Tester',
      username: 'tester',
      email: 'tester@example.com',
      organizationId: null,
      dataPolicyAgreed: true,
    },
  };
  const memStore = {
    read: async () => credential,
    write: async () => undefined,
    update: async (_siteId, fn) => fn(credential),
    clear: async () => false,
  };
  const runtime = new SiteRuntime({ siteId: 'cn', store: memStore, rawConfig, fetchImpl });
  const adapter = new QwenWorkLlmAdapter({ runtimes: new Map([['cn', runtime]]) });
  return { runtime, adapter };
}

test('parseCatalogPayload does not inject hardcoded displayNameId aliases', () => {
  const parsed = parseCatalogPayload({
    qwork: [
      {
        key: 'flash',
        display_name: '标准',
        enable: true,
        is_vl: true,
        price_factor: 0.1,
      },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'flash');
  assert.equal('displayNameId' in parsed[0], false);
});

test('LlmRuntime resolves catalog and unlisted model IDs with exact requested id', async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(LlmRuntime);
  await fiber.ready;
  const { runtime, adapter } = createFixture();
  ctx.llm.registerAdapter(['qwenwork'], adapter);

  try {
    const canonicalInfo = await ctx.llm.resolveModelInfo('qwenwork', 'flash');
    assert.equal(canonicalInfo.provider, 'qwenwork');
    assert.equal(canonicalInfo.id, 'flash');
    assert.match(canonicalInfo.name, /^标准/);
    assert.deepEqual(canonicalInfo.inputModalities, ['text', 'image']);

    // Unlisted model IDs (including historical names like qwen3.8-flash) pass through
    // with exact id preserved instead of triggering INVALID_MODEL_INFO.
    for (const unlisted of ['qwen3.8-flash', 'custom-unlisted-model']) {
      const info = await ctx.llm.resolveModelInfo('qwenwork', unlisted);
      assert.equal(info.provider, 'qwenwork');
      assert.equal(info.id, unlisted);
      assert.equal(info.name, unlisted);
    }
  } finally {
    runtime.dispose();
    await fiber.dispose();
  }
});

test('prepared calls forward exact model key to gateway and honor disabledModels', async () => {
  const captured = [];

  const fetchImpl = async (_url, init) => {
    const headerKey = new Headers(init?.headers).get('x-model-key');
    let bodyKey = null;
    if (typeof init?.body === 'string') {
      const parsed = JSON.parse(decodeBody(init.body));
      bodyKey = parsed?.model_config?.key ?? null;
    }
    captured.push({ headerKey, bodyKey });

    const inner = JSON.stringify({
      choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
    });
    const outer = JSON.stringify({ statusCodeValue: 200, body: encodeBody(inner) });
    const sse = `data: ${outer}\n\ndata: [DONE]\n\n`;
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const ctx = new Context();
  const fiber = ctx.plugin(LlmRuntime);
  await fiber.ready;
  const rawConfig = { disabledModels: {} };
  const { runtime, adapter } = createFixture({ rawConfig, fetchImpl });
  ctx.llm.registerAdapter(['qwenwork'], adapter);

  try {
    for (const model of ['flash', 'qwen3.8-flash']) {
      const prepared = await ctx.llm.prepareCall({ provider: 'qwenwork', model });
      assert.equal(prepared.config.model, model);

      const chunks = [];
      for await (const chunk of prepared.stream({
        ...prepared.config,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }] })],
      })) {
        chunks.push(chunk);
      }
      assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok'));
    }

    assert.deepEqual(captured, [
      { headerKey: 'flash', bodyKey: 'flash' },
      { headerKey: 'qwen3.8-flash', bodyKey: 'qwen3.8-flash' },
    ]);

    rawConfig.disabledModels = { cn: ['flash'] };
    const blocked = await ctx.llm.prepareCall({ provider: 'qwenwork', model: 'flash' });
    const blockedChunks = [];
    for await (const chunk of blocked.stream({
      ...blocked.config,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }] })],
    })) {
      blockedChunks.push(chunk);
    }
    const finish = blockedChunks.find((c) => c.type === 'finish');
    assert.equal(finish?.reason?.kind, 'error');
    assert.equal(finish?.reason?.failure?.code, 'INVALID_REQUEST');
    assert.match(String(finish?.reason?.failure?.message), /flash/);
  } finally {
    runtime.dispose();
    await fiber.dispose();
  }
});
