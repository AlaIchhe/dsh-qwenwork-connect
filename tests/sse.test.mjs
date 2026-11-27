import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SseParser,
  ToolCallIndexNormalizer,
  encodeBody,
  parseQwenWorkFrame,
  parseUsage,
} from '../dist/core/index.js';

test('SseParser preserves multi-byte UTF-8 across arbitrary byte chunks', () => {
  const parser = new SseParser();
  const full = Buffer.from('data: {"text":"你好世界🌍"}\r\n\r\n: heartbeat\n\ndata: [DONE]\n\n', 'utf8');
  const payloads = [];
  // Split 1 byte at a time to stress-test streaming UTF-8 decoding
  for (let i = 0; i < full.length; i += 1) {
    payloads.push(...parser.push(full.subarray(i, i + 1)));
  }
  payloads.push(...parser.flush());
  assert.equal(parser.done, true);
  assert.deepEqual(payloads, ['{"text":"你好世界🌍"}']);
});

test('parseQwenWorkFrame decodes encoded inner body and extracts disjoint cached usage', () => {
  const inner = JSON.stringify({
    choices: [
      {
        delta: { reasoning_content: '思考中', content: '答案' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 40 },
    },
  });
  const outer = JSON.stringify({
    statusCodeValue: 200,
    headers: { 'X-Model-Name': 'qwen3.8-flash' },
    body: encodeBody(inner),
  });

  const frame = parseQwenWorkFrame(outer);
  assert.equal(frame.kind, 'chunk');
  assert.equal(frame.delta.reasoning, '思考中');
  assert.equal(frame.delta.content, '答案');
  assert.equal(frame.finishReason, 'stop');
  assert.equal(frame.modelName, 'qwen3.8-flash');
  assert.deepEqual(frame.usage, {
    inputTokens: 60,
    outputTokens: 25,
    totalTokens: 125,
    cacheReadTokens: 40,
  });
});

test('parseQwenWorkFrame surfaces in-band business error with queue metadata', () => {
  const outer = JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({
      code: '10605',
      message: 'queued',
      queue: { isQueued: true, retryAfterSeconds: 15 },
    }),
  });
  const frame = parseQwenWorkFrame(outer);
  assert.equal(frame.kind, 'error');
  assert.equal(frame.error.code, '10605');
  assert.equal(frame.error.queue?.retryAfterSeconds, 15);
});

test('parseUsage handles Anthropic fallback fields', () => {
  const usage = parseUsage({
    data: {
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  });
  assert.deepEqual(usage, {
    inputTokens: 50,
    outputTokens: 20,
    totalTokens: 85,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
  });
});

test('ToolCallIndexNormalizer separates parallel claude-pool index=0 calls', () => {
  const normalizer = new ToolCallIndexNormalizer();
  const c1 = normalizer.normalize([{ index: 0, id: 'call_a', function: { name: 'read', arguments: '{"p":' } }]);
  const c1b = normalizer.normalize([{ index: 0, function: { arguments: '"a"}' } }]);
  const c2 = normalizer.normalize([{ index: 0, id: 'call_b', function: { name: 'read', arguments: '{"p":' } }]);
  const c2b = normalizer.normalize([{ index: 0, function: { arguments: '"b"}' } }]);

  assert.equal(c1[0].index, 0);
  assert.equal(c1b[0].index, 0);
  assert.equal(c2[0].index, 1);
  assert.equal(c2b[0].index, 1);
});
