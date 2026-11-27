import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm';
import { decodeBody } from '../dist/core/index.js';
import { QwenWorkLlmAdapter, SiteRuntime } from '../dist/host/index.js';

function createMemoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async read(siteId) {
      return map.get(siteId);
    },
    async write(siteId, cred) {
      map.set(siteId, cred);
    },
    async update(siteId, mutate) {
      const next = await mutate(map.get(siteId));
      if (next !== undefined) map.set(siteId, next);
      return map.get(siteId);
    },
    async clear(siteId) {
      return map.delete(siteId);
    },
  };
}

function makeCredential(siteId = 'cn') {
  return {
    schemaVersion: 2,
    siteId,
    token: 'tok-valid',
    refreshToken: 'ref-valid',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshTokenExpiresAt: null,
    loginDeviceId: 'machine-1',
    loginMethod: 'device-flow',
    user: {
      id: 'uid-1',
      name: 'Tester',
      username: 'tester',
      email: 't@example.com',
      organizationId: null,
      dataPolicyAgreed: true,
    },
  };
}

function sseResponse(envelopes, headers = {}) {
  const text = envelopes.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-123', ...headers },
  });
}

test('QwenWorkLlmAdapter streams reasoning, text, parallel tool calls, and disjoint usage directly into BlockAssembler', async () => {
  let capturedBody = null;
  let capturedHeaders = null;

  const mockFetch = async (_url, init) => {
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(decodeBody(String(init.body)));
    return sseResponse([
      { statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { reasoning_content: 'Step 1. ' }, finish_reason: null }] }) },
      { statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: 'Working on it.' }, finish_reason: null }] }) },
      // Parallel Claude-pool quirk: both tool calls carry index=0
      { statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":' } }] }, finish_reason: null }] }) },
      { statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null }] }) },
      { statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'read', arguments: '{"path":"b.txt"}' } }] }, finish_reason: null }] }) },
      {
        statusCodeValue: 200,
        body: JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 50,
            total_tokens: 250,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }),
      },
    ]);
  };

  const store = createMemoryStore({ cn: makeCredential('cn') });
  const cnRuntime = new SiteRuntime({ siteId: 'cn', store, rawConfig: {}, fetchImpl: mockFetch });
  const intlRuntime = new SiteRuntime({ siteId: 'intl', store, rawConfig: {}, fetchImpl: mockFetch });
  const adapter = new QwenWorkLlmAdapter({
    runtimes: new Map([
      ['cn', cnRuntime],
      ['intl', intlRuntime],
    ]),
  });

  const assembler = new BlockAssembler();
  const prepared = await adapter.prepareCall('qwenwork', 'qwen3.8-flash');
  assert.equal(prepared.model.id, 'flash'); // displayNameId normalized back to upstream key

  for await (const chunk of prepared.stream({
    provider: 'qwenwork',
    model: 'qwen3.8-flash',
    system: 'Be concise.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Read two files' }] }],
    tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
  })) {
    assembler.push(chunk);
  }

  // Verify QwenWork 1.2.0 wire payload contract
  assert.equal(capturedBody.model_config.key, 'flash');
  assert.equal(capturedBody.business.product, 'qoder_work');
  assert.equal(capturedBody.business.type, 'agent');
  assert.equal(capturedBody.tools.length, 1);
  assert.equal(capturedBody.chat_context.imageUrls, null);
  assert.ok(String(capturedHeaders.Authorization).startsWith('Bearer COSY.'));

  // Verify BlockAssembler reconstructed every block faithfully
  const blocks = assembler.blocks();
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[0], { type: 'reasoning', text: 'Step 1. ' });
  assert.deepEqual(blocks[1], { type: 'text', text: 'Working on it.' });
  assert.equal(blocks[2].type, 'tool-call');
  assert.equal(blocks[2].id, 'call_1');
  assert.equal(blocks[2].name, 'read');
  assert.equal(blocks[2].arguments, '{"path":"a.txt"}');
  assert.equal(blocks[3].type, 'tool-call');
  assert.equal(blocks[3].id, 'call_2');
  assert.equal(blocks[3].arguments, '{"path":"b.txt"}');

  assert.deepEqual(assembler.finish, { kind: 'tool-calls' });
  assert.deepEqual(assembler.usage, {
    inputTokens: 120,
    outputTokens: 50,
    totalTokens: 250,
    cacheReadTokens: 80,
  });

  // Verify perf is isolated to cn and not leaked to intl
  assert.equal(cnRuntime.perfSummary()?.samples, 1);
  assert.equal(cnRuntime.perfSummary('flash')?.samples, 1);
  assert.equal(intlRuntime.perfSummary(), null);

  cnRuntime.dispose();
  intlRuntime.dispose();
});

test('QwenWorkLlmAdapter maps upstream 10605 queued error into structured LlmError with providerRetryAfterMs', async () => {
  const mockFetch = async () =>
    sseResponse([
      {
        statusCodeValue: 200,
        body: JSON.stringify({
          code: '10605',
          message: 'pool queued',
          queue: { isQueued: true, retryAfterSeconds: 22 },
        }),
      },
    ]);

  const store = createMemoryStore({ cn: makeCredential('cn') });
  const cnRuntime = new SiteRuntime({ siteId: 'cn', store, rawConfig: {}, fetchImpl: mockFetch });
  const adapter = new QwenWorkLlmAdapter({ runtimes: new Map([['cn', cnRuntime]]) });

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: 'qwenwork',
        model: 'pro',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        /* drain */
      }
    },
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'SERVER');
      assert.equal(err.failure.status, 503);
      assert.equal(err.failure.providerRetryAfterMs, 22_000);
      return true;
    },
  );
  cnRuntime.dispose();
});

test('QwenWorkLlmAdapter rejects disabled model before any network call', async () => {
  let fetchCalled = false;
  const store = createMemoryStore({ cn: makeCredential('cn') });
  const cnRuntime = new SiteRuntime({
    siteId: 'cn',
    store,
    rawConfig: { disabledModels: { cn: ['flash'] } },
    fetchImpl: async () => {
      fetchCalled = true;
      return sseResponse([]);
    },
  });
  const adapter = new QwenWorkLlmAdapter({ runtimes: new Map([['cn', cnRuntime]]) });

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: 'qwenwork',
        model: 'flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        /* drain */
      }
    },
    (err) => err instanceof LlmError && err.code === 'INVALID_REQUEST',
  );
  assert.equal(fetchCalled, false);
  cnRuntime.dispose();
});

test('QwenWorkLlmAdapter enforces image budget and throws IMAGE_OFFLOAD_REQUIRED', async () => {
  const store = createMemoryStore({ cn: makeCredential('cn') });
  const cnRuntime = new SiteRuntime({ siteId: 'cn', store, rawConfig: {} });

  // Return 4 MiB per image → 2 images in base64 (~10.6 MiB) exceeds 6 MiB budget
  const bigBytes = new Uint8Array(4 * 1024 * 1024);
  const mockAttachments = {
    async readImageRequest(ref) {
      return {
        bytes: bigBytes,
        mediaType: 'image/png',
        width: ref.width,
        height: ref.height,
      };
    },
  };

  const adapter = new QwenWorkLlmAdapter({
    runtimes: new Map([['cn', cnRuntime]]),
    getAttachments: () => mockAttachments,
  });

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        provider: 'qwenwork',
        model: 'pro',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', attachment: { id: 'img-1', mediaType: 'image/png', byteLength: 4_000_000, width: 1000, height: 1000 } },
              { type: 'image', attachment: { id: 'img-2', mediaType: 'image/png', byteLength: 4_000_000, width: 1000, height: 1000 } },
              { type: 'text', text: 'compare' },
            ],
          },
        ],
      })) {
        /* drain */
      }
    },
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'IMAGE_OFFLOAD_REQUIRED');
      assert.ok(typeof err.failure.offloadImages === 'number' && err.failure.offloadImages > 0);
      return true;
    },
  );
  cnRuntime.dispose();
});
