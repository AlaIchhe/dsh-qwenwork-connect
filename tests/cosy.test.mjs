import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildCosyHeaders,
  decodeBody,
  encodeBody,
  looksEncoded,
  signedPath,
} from '../dist/core/index.js';

test('encodeBody and decodeBody round-trip ASCII, JSON, CJK, and emoji', () => {
  const samples = [
    '',
    'hello',
    JSON.stringify({ msg: '千问办公测试 🚀', nested: [1, 2, 3] }),
    'a'.repeat(1024),
  ];
  for (const sample of samples) {
    const encoded = encodeBody(sample);
    if (sample !== '') {
      assert.notEqual(encoded, sample);
      assert.equal(looksEncoded(encoded), true);
    }
    assert.equal(decodeBody(encoded), sample);
  }
});

test('looksEncoded rejects plain JSON and invalid characters', () => {
  assert.equal(looksEncoded(''), false);
  assert.equal(looksEncoded('{"ok":true}'), false);
  assert.equal(looksEncoded('[1,2,3]'), false);
  assert.equal(looksEncoded('plain text with spaces'), false);
});

test('signedPath strips /algo prefix and query string', () => {
  assert.equal(
    signedPath('https://gateway.qwenwork.cn/algo/api/v2/model/list?Encode=1'),
    '/api/v2/model/list',
  );
  assert.equal(
    signedPath('https://gateway.qwenwork.ai/api/v1/ping?foo=bar'),
    '/api/v1/ping',
  );
});

test('buildCosyHeaders produces valid COSY signature and enterprise headers', () => {
  const credential = {
    schemaVersion: 2,
    siteId: 'cn',
    token: 'tok-abc',
    refreshToken: 'ref-123',
    expiresAt: null,
    refreshTokenExpiresAt: null,
    loginDeviceId: 'machine-xyz',
    loginMethod: 'device-flow',
    user: {
      id: 'user-42',
      name: 'Alice',
      username: 'alice',
      email: 'alice@example.com',
      organizationId: 'org-99',
      dataPolicyAgreed: true,
    },
  };

  const url = 'https://gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1';
  const wireBody = encodeBody('{"hello":"world"}');
  const res = buildCosyHeaders({
    url,
    credential,
    machineId: 'machine-xyz',
    cosyVersion: '1.1.32',
    body: wireBody,
    mode: 'chat',
    modelKey: 'flash',
  });

  assert.equal(res.headers['Cosy-User'], 'user-42');
  assert.equal(res.headers['Cosy-Organization-Id'], 'org-99');
  assert.equal(res.headers['Cosy-Data-Policy'], 'agree');
  assert.equal(res.headers['X-Model-Key'], 'flash');
  assert.equal(res.headers.Accept, 'text/event-stream');

  const expectedSig = crypto
    .createHash('md5')
    .update(`${res.payload}\n${res.headers['Cosy-Key']}\n${res.timestamp}\n${wireBody}\n/api/v2/service/pro/sse/agent_chat_generation`)
    .digest('hex');
  assert.equal(res.signature, expectedSig);
  assert.equal(res.headers.Authorization, `Bearer COSY.${res.payload}.${expectedSig}`);
});
