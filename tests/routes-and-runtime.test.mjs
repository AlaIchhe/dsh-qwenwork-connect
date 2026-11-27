import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  SiteRuntime,
  apply,
  Config,
} from '../dist/host/index.js';
import {
  LOGIN_START_PATH,
  LOGOUT_PATH,
  MODELS_TOGGLE_PATH,
  STATUS_PATH,
} from '../dist/core/index.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('SiteRuntime isolates creditBaseline between cn and intl and aborts poll on logout', async () => {
  let pollAborted = false;
  const mockFetch = async (url, init) => {
    const s = String(url);
    if (s.includes('/api/v1/deviceToken/poll')) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          pollAborted = true;
          reject(new Error('aborted'));
        });
      });
    }
    if (s.includes('qwenwork.cn')) {
      return new Response(JSON.stringify({ user: { name: 'CN' }, quota: { remaining: 5000, total: null } }), { status: 200 });
    }
    return new Response(JSON.stringify({ user: { name: 'INTL' }, quota: { remaining: 100, total: null } }), { status: 200 });
  };

  const makeCred = (siteId) => ({
    schemaVersion: 2,
    siteId,
    token: 'tok',
    refreshToken: 'ref',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshTokenExpiresAt: null,
    loginDeviceId: 'dev-1',
    loginMethod: 'device-flow',
    user: { id: 'u', name: siteId, username: null, email: null, organizationId: null, dataPolicyAgreed: true },
  });

  const store = createMemoryStore({ cn: makeCred('cn'), intl: makeCred('intl') });
  const cn = new SiteRuntime({ siteId: 'cn', store, rawConfig: {}, fetchImpl: mockFetch });
  const intl = new SiteRuntime({ siteId: 'intl', store, rawConfig: {}, fetchImpl: mockFetch });

  const cnStatus = await cn.buildStatusResponse();
  const intlStatus = await intl.buildStatusResponse();

  assert.equal(cnStatus.creditBaseline, 5000);
  // International baseline must NOT be polluted by CN's 5000 peak
  assert.equal(intlStatus.creditBaseline, 2000);

  await cn.startLogin();
  await new Promise((r) => setTimeout(r, 20));
  await cn.logout();
  assert.equal(pollAborted, true);

  cn.dispose();
  intl.dispose();
});

test('Host apply() wires routes, loopback/trustedHosts guard, model toggle guard, and clean disposal', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-routes-test-'));
  const prevCnEnv = process.env.QWENWORK_CREDENTIAL_FILE;
  const prevIntlEnv = process.env.QWENWORK_INTL_CREDENTIAL_FILE;
  process.env.QWENWORK_CREDENTIAL_FILE = path.join(tmpDir, 'cn.json');
  process.env.QWENWORK_INTL_CREDENTIAL_FILE = path.join(tmpDir, 'intl.json');

  let registeredHandler = null;
  let routeDisposed = false;
  let adapterDisposed = false;
  let directoryDisposed = false;
  let directoryReplaced = 0;

  let currentRawConfig = { trustedHosts: ['dsh.home.local'], disabledModels: {} };
  const effects = [];

  const mockCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fiber: { entry: { id: 'llm-qwenwork' } },
    llm: {
      registerAdapter(_providers, _adapter) {
        return () => {
          adapterDisposed = true;
        };
      },
      registerConfigurableProviders(_entries) {
        const fn = () => {
          directoryDisposed = true;
        };
        fn.replace = () => {
          directoryReplaced += 1;
        };
        return fn;
      },
    },
    get(name) {
      if (name === 'configEditor') {
        return {
          async edit(_entry, mutate) {
            currentRawConfig = mutate(currentRawConfig, {});
          },
        };
      }
      return undefined;
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effects.push(cleanup);
      return () => cleanup?.();
    },
    on() {
      return () => {};
    },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({
          ...mockCtx,
          webServer: {
            register(route) {
              registeredHandler = route.handler;
              return () => {
                routeDisposed = true;
              };
            },
          },
        });
      }
    },
  };

  const volatileConfig = {
    enabledSites: ['cn', 'intl'],
    disabledModels: { get: () => currentRawConfig.disabledModels ?? {} },
    trustedHosts: { get: () => currentRawConfig.trustedHosts ?? [] },
    timeouts: { get: () => ({ headerMs: 180000, firstContentMs: 90000, idleMs: 300000 }) },
    vpc: { get: () => ({ caCertPath: '', insecureTls: false }) },
    stallGuard: { get: () => ({ enabled: true, maxContinues: 2 }) },
    debugTrace: { get: () => ({ enabled: false, logPath: '' }) },
  };

  assert.ok(Config);
  apply(mockCtx, volatileConfig);
  assert.equal(typeof registeredHandler, 'function');

  // Spin up an ephemeral HTTP server using the registered handler
  const server = http.createServer((req, res) => {
    void registeredHandler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // 1. Untrusted Host header rejected with 403
    const evil = await fetch(`http://127.0.0.1:${port}${STATUS_PATH}`, {
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(evil.status, 403);

    // 2. Trusted host allowed
    const ok = await fetch(`http://127.0.0.1:${port}${STATUS_PATH}`, {
      headers: { origin: 'https://dsh.home.local' },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.siteId, 'cn');
    assert.ok(Array.isArray(body.models) && body.models.length >= 4);

    // 3. Toggle unknown model → 400
    const unknown = await fetch(`http://127.0.0.1:${port}${MODELS_TOGGLE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'does-not-exist', enabled: false }),
    });
    assert.equal(unknown.status, 400);

    // 4. Disable a valid model → 200 & triggers directory.replace
    const toggled = await fetch(`http://127.0.0.1:${port}${MODELS_TOGGLE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'flash', enabled: false }),
    });
    assert.equal(toggled.status, 200);
    assert.deepEqual(currentRawConfig.disabledModels, { cn: ['flash'] });
    assert.equal(directoryReplaced, 1);

    // 5. Try disabling all remaining models — last one must return 409
    for (const id of ['pro', 'frontier-1']) {
      const r = await fetch(`http://127.0.0.1:${port}${MODELS_TOGGLE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id, enabled: false }),
      });
      assert.equal(r.status, 200);
    }
    const last = await fetch(`http://127.0.0.1:${port}${MODELS_TOGGLE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max-preview', enabled: false }),
    });
    assert.equal(last.status, 409);

    // 6. Start login and immediately logout (verifies routes are live)
    const loginRes = await fetch(`http://127.0.0.1:${port}${LOGIN_START_PATH}?site=intl`, {
      method: 'POST',
    });
    assert.equal(loginRes.status, 200);
    const loginBody = await loginRes.json();
    assert.ok(loginBody.url.startsWith('https://gateway.qwenwork.ai/device/selectAccounts'));

    const logoutRes = await fetch(`http://127.0.0.1:${port}${LOGOUT_PATH}?site=intl`, {
      method: 'POST',
    });
    assert.equal(logoutRes.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const cleanup of effects) cleanup();
    if (prevCnEnv === undefined) delete process.env.QWENWORK_CREDENTIAL_FILE;
    else process.env.QWENWORK_CREDENTIAL_FILE = prevCnEnv;
    if (prevIntlEnv === undefined) delete process.env.QWENWORK_INTL_CREDENTIAL_FILE;
    else process.env.QWENWORK_INTL_CREDENTIAL_FILE = prevIntlEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  assert.equal(routeDisposed, true);
  assert.equal(adapterDisposed, true);
  assert.equal(directoryDisposed, true);
});

test('Client bundle loads cleanly via window.__ModuleLoader__ and registers all 3 slots', async () => {
  const code = await fs.readFile(path.join(rootDir, 'dist/client/index.js'), 'utf8');
  let loadedDef = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(def) {
          loadedDef = def;
        },
      },
    },
    console,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(code, sandbox);

  assert.equal(loadedDef?.id, 'dsh-qwenwork-connect');
  const mod = loadedDef.factory((spec) => {
    if (spec === 'react') return { useState: () => [null, () => {}], useEffect: () => {} };
    if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
    throw new Error(`unexpected require: ${spec}`);
  });

  assert.equal(mod.name, 'dsh-qwenwork-connect');
  assert.deepEqual([...mod.inject], ['slots', 'locale']);

  const registeredSlots = [];
  let registeredLocaleNs = null;
  mod.apply({
    effect(fn) {
      fn();
      return () => {};
    },
    locale: {
      register(ns) {
        registeredLocaleNs = ns;
        return () => {};
      },
      bind: () => (k) => k,
    },
    slots: {
      inject(slot, factory) {
        registeredSlots.push(slot);
        factory();
        return () => {};
      },
      register() {
        return () => {};
      },
    },
  });

  assert.equal(registeredLocaleNs, 'settings.qwenwork');
  assert.deepEqual(registeredSlots, [
    'plugins.bundle.config',
    'plugins.row.config',
    'conversation.input.left',
  ]);
});
