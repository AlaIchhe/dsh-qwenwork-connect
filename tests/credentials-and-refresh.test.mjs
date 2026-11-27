import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FileCredentialStore,
  GatewayClient,
  resolveGatewayEndpoint,
} from '../dist/core/index.js';
import { HybridCredentialStore } from '../dist/host/index.js';

function fakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.sig`;
}

test('FileCredentialStore writes atomically with mode 0600 and reads/clears cleanly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-cred-test-'));
  try {
    const store = new FileCredentialStore({ homeDir: tmpDir });
    const cred = {
      schemaVersion: 2,
      siteId: 'cn',
      token: fakeJwt({ sub: 'u1', username: 'bob' }),
      refreshToken: 'ref-init',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenExpiresAt: null,
      loginDeviceId: 'dev-1',
      loginMethod: 'device-flow',
      user: {
        id: 'u1',
        name: 'Bob',
        username: 'bob',
        email: null,
        organizationId: null,
        dataPolicyAgreed: true,
      },
    };
    await store.write('cn', cred);

    const filePath = store.filePathFor('cn');
    const stat = await fs.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);

    const loaded = await store.read('cn');
    assert.equal(loaded?.token, cred.token);
    assert.equal(loaded?.user.id, 'u1');

    assert.equal(await store.clear('cn'), true);
    assert.equal(await store.clear('cn'), false);
    assert.equal(await store.read('cn'), undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('GatewayClient.getValidCredential deduplicates concurrent token refreshes and rotates refresh_token', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-refresh-test-'));
  try {
    const store = new FileCredentialStore({ homeDir: tmpDir });
    await store.write('cn', {
      schemaVersion: 2,
      siteId: 'cn',
      token: fakeJwt({ sub: 'u1' }),
      refreshToken: 'old-refresh-token',
      expiresAt: new Date(Date.now() - 10_000).toISOString(), // expired
      refreshTokenExpiresAt: null,
      loginDeviceId: 'dev-1',
      loginMethod: 'device-flow',
      user: {
        id: 'u1',
        name: 'Bob',
        username: 'bob',
        email: null,
        organizationId: null,
        dataPolicyAgreed: true,
      },
    });

    let refreshCalls = 0;
    const newToken = fakeJwt({ sub: 'u1', fresh: true });
    const mockFetch = async (url, init) => {
      refreshCalls += 1;
      assert.equal(String(url), 'https://gateway.qwenwork.cn/api/v1/deviceToken/refresh');
      assert.deepEqual(JSON.parse(String(init.body)), { refresh_token: 'old-refresh-token' });
      await new Promise((r) => setTimeout(r, 25));
      return new Response(
        JSON.stringify({
          device_token: newToken,
          refresh_token: 'rotated-refresh-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const client = new GatewayClient({ siteId: 'cn', store, fetchImpl: mockFetch });
    const results = await Promise.all([
      client.getValidCredential(),
      client.getValidCredential(),
      client.getValidCredential(),
      client.getValidCredential(),
      client.getValidCredential(),
    ]);

    assert.equal(refreshCalls, 1);
    for (const r of results) {
      assert.equal(r.token, newToken);
      assert.equal(r.refreshToken, 'rotated-refresh-token');
    }

    const persisted = await store.read('cn');
    assert.equal(persisted?.refreshToken, 'rotated-refresh-token');
    client.dispose();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('HybridCredentialStore uses DSH credentials modifyRecord and falls back to CLI file store', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-hybrid-test-'));
  try {
    const fileStore = new FileCredentialStore({ homeDir: tmpDir });
    const records = new Map();
    const mockDshCreds = {
      async readRecord(key) {
        return records.get(key);
      },
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key));
        if (next !== undefined) records.set(key, next);
        return records.get(key);
      },
      async deleteRecord(key) {
        records.delete(key);
      },
    };

    const hybrid = new HybridCredentialStore(() => mockDshCreds, fileStore);
    const cliCred = {
      schemaVersion: 2,
      siteId: 'intl',
      token: fakeJwt({ sub: 'intl-u' }),
      refreshToken: 'intl-ref',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenExpiresAt: null,
      loginDeviceId: 'dev-intl',
      loginMethod: 'device-flow',
      user: {
        id: 'intl-u',
        name: 'IntlUser',
        username: 'intl',
        email: null,
        organizationId: null,
        dataPolicyAgreed: true,
      },
    };
    // Simulate CLI writing to file store
    await fileStore.write('intl', cliCred);
    const readFromCli = await hybrid.read('intl');
    assert.equal(readFromCli?.token, cliCred.token);

    // Updating via hybrid writes to DSH credentials record
    await hybrid.update('intl', async (cur) => ({ ...cur, token: 'updated-tok' }));
    assert.equal(records.get('llm-qwenwork/intl')?.kind, 'grant');
    assert.equal((await hybrid.read('intl'))?.token, 'updated-tok');

    // Clear removes both
    assert.equal(await hybrid.clear('intl'), true);
    assert.equal(await hybrid.read('intl'), undefined);
    assert.equal(await fileStore.read('intl'), undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveGatewayEndpoint detects enterprise VPC iss claim', () => {
  const vpcToken = fakeJwt({ iss: 'https://acme.vpc.qwenwork.cn/realms/qwenwork' });
  assert.equal(
    resolveGatewayEndpoint({ token: vpcToken, siteId: 'cn' }, 'cn'),
    'https://acme.vpc.qwenwork.cn',
  );
  const pubToken = fakeJwt({ iss: 'https://auth.qwenwork.ai/realms/qwenwork' });
  assert.equal(
    resolveGatewayEndpoint({ token: pubToken, siteId: 'intl' }, 'intl'),
    'https://gateway.qwenwork.ai',
  );
});
