import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUpstreamFailure,
  parseUpstreamFailureText,
  redactSecrets,
} from '../dist/core/index.js';

test('parseUpstreamFailureText unwraps nested JSON message and details', () => {
  const raw = JSON.stringify({
    statusCodeValue: 403,
    code: '403',
    message: JSON.stringify({ code: '10605', message: 'busy', retryAfterSeconds: 18 }),
  });
  const parsed = parseUpstreamFailureText(raw);
  assert.equal(parsed.status, 403);
  assert.equal(parsed.code, '10605');
  assert.equal(parsed.message, 'busy');
  assert.equal(parsed.queue?.retryAfterSeconds, 18);
});

test('classifyUpstreamFailure maps business codes to structured DSH LLM failure codes', () => {
  const queued = classifyUpstreamFailure({
    code: '10605',
    message: 'model busy',
    queue: { isQueued: true, retryAfterSeconds: 12 },
  });
  assert.equal(queued.llmCode, 'SERVER');
  assert.equal(queued.status, 503);
  assert.equal(queued.retryAfterMs, 12_000);

  const quota = classifyUpstreamFailure({ code: '112', message: 'no credits' });
  assert.equal(quota.llmCode, 'QUOTA');
  assert.equal(quota.status, 429);

  const auth = classifyUpstreamFailure({ status: 401, message: 'token expired' });
  assert.equal(auth.llmCode, 'AUTH');
  assert.equal(auth.status, 401);

  const rate = classifyUpstreamFailure({ status: 429, message: 'slow down' });
  assert.equal(rate.llmCode, 'RATE_LIMIT');
  assert.equal(rate.retryAfterMs, 30_000);

  // HTTP 400 with generic "Error in upstream response" must stay INVALID_REQUEST (never retry as 502)
  const badParam = classifyUpstreamFailure({
    status: 400,
    code: '400',
    message: 'Error in upstream response',
  });
  assert.equal(badParam.llmCode, 'INVALID_REQUEST');
  assert.equal(badParam.status, 400);

  // HTTP 402 (plan/credits mismatch) maps to QUOTA
  const paymentReq = classifyUpstreamFailure({
    status: 402,
    code: '402',
    message: 'model not included in plan',
  });
  assert.equal(paymentReq.llmCode, 'QUOTA');
  assert.equal(paymentReq.status, 402);

  // Non-400 "Error in upstream response" still maps to retryable 502 SERVER
  const upstream502 = classifyUpstreamFailure({
    status: 500,
    message: 'Error in upstream response',
  });
  assert.equal(upstream502.llmCode, 'SERVER');
  assert.equal(upstream502.status, 502);
});

test('redactSecrets strips JWTs, Bearer headers, and secret query parameters', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123';
  const input = `Failed with Authorization: Bearer secretToken123 token=${jwt}&refresh_token=r999`;
  const redacted = redactSecrets(input);
  assert.equal(redacted.includes(jwt), false);
  assert.equal(redacted.includes('secretToken123'), false);
  assert.equal(redacted.includes('r999'), false);
  assert.equal(redacted.includes('[redacted]'), true);
});
