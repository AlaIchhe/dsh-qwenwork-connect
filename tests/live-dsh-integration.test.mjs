/**
 * Real-device end-to-end integration tests against the installed DSH host
 * runtime (Cordis, LlmRuntime, LocalCredentials, LocalAttachmentStore,
 * WebServer, Session, SessionProjectionRegistry) and live QwenWork gateway
 * using the local machine's real credentials.
 *
 * Safety:
 * - Reads real local credentials via DSH LocalCredentials + FileCredentialStore
 *   (so rotating refresh tokens persist cleanly back to disk).
 * - NEVER logs secrets and NEVER invokes logout / clear on real credentials.
 * - Uses an isolated temporary directory for LocalAttachmentStore image files.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as plugin from '../dist/host/index.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  FileCredentialStore,
  SETTINGS_PATH,
  STATUS_PATH,
  pathForSite,
} from '../dist/core/index.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot = process.env.DSH_ROOT || '/usr/lib/node_modules/@deepseek-ai/dsh';

async function importDsh(pkg) {
  const entry = path.join(dshRoot, 'node_modules', pkg, 'lib', 'index.js');
  return import(pathToFileURL(entry).href);
}

/** Generate a minimal valid RGBA PNG (width x height) filled with a solid color. */
function makeSolidPng(width, height, r, g, b, a = 255) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: None
    for (let x = 0; x < width; x += 1) {
      const px = row + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rawHttpGet({ host, port, reqPath, hostHeader }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path: reqPath,
        method: 'GET',
        headers: {
          Host: hostHeader,
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('Real DSH host + live QwenWork gateway integration (status, text stream, multi-image vision, tool-result image, stall-guard)', { timeout: 180_000 }, async (t) => {
  const hasDshHost = await fs
    .access(path.join(dshRoot, 'package.json'))
    .then(() => true)
    .catch(() => false);
  if (!hasDshHost) {
    if (process.env.CI) {
      t.skip(`Skipping real-device DSH integration test in CI (DSH host not installed at ${dshRoot})`);
      return;
    }
    assert.fail(`DSH host runtime not found at ${dshRoot}. Set DSH_ROOT to run real-device tests.`);
  }

  const [
    { Context },
    dshLlm,
    { default: LocalAttachmentStore },
    { default: LocalCredentials },
    { default: WebServer },
    dshSession,
    { SessionProjectionRegistry },
  ] = await Promise.all([
    importDsh('@deepseek-ai/cordis'),
    importDsh('@deepseek-ai/dsh-llm'),
    importDsh('@deepseek-ai/dsh-attachment-local'),
    importDsh('@deepseek-ai/dsh-credentials-local'),
    importDsh('@deepseek-ai/dsh-host-webserver'),
    importDsh('@deepseek-ai/dsh-session'),
    importDsh('@deepseek-ai/dsh-session-projection'),
  ]);

  const { LlmRuntime, BlockAssembler, createUserMessage, ToolCallId } = dshLlm;
  const { Session, SessionId } = dshSession;

  const tmpAttachHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwenwork-live-attach-'));
  const ctx = new Context();

  // Mount real DSH services (same stack as real host)
  const fCreds = ctx.plugin(LocalCredentials, { watch: false });
  const fLlm = ctx.plugin(LlmRuntime);
  const fAttach = ctx.plugin(LocalAttachmentStore, { dshHome: tmpAttachHome });
  const fWeb = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const peerAc = new AbortController();
  const disposeAuth = ctx.on('webserver/authorize', () => ({
    kind: 'allow',
    peer: { signal: peerAc.signal },
  }));
  const fProj = ctx.plugin(SessionProjectionRegistry);
  const fPlugin = ctx.plugin(plugin, {
    enabledSites: ['cn', 'intl'],
    trustedHosts: ['trusted.local.test'],
    stallGuard: { enabled: true, maxContinues: 2 },
  });

  await Promise.all([
    fCreds.ready,
    fLlm.ready,
    fAttach.ready,
    fWeb.ready,
    fProj.ready,
    fPlugin.ready,
  ]);
  // Give async sessionProjections.register() inside installStallGuard one tick to settle
  await new Promise((r) => setImmediate(r));

  // Detect which site has real credentials on this machine (without exposing secrets)
  const fileStore = new FileCredentialStore();
  let activeSite = null;
  for (const siteId of ['cn', 'intl']) {
    const dshRec = await ctx.credentials.readRecord(`llm-qwenwork/${siteId}`);
    const fileRec = await fileStore.read(siteId);
    if ((dshRec?.kind === 'grant' && dshRec?.payload?.token) || fileRec?.token) {
      activeSite = siteId;
      break;
    }
  }
  assert.ok(
    activeSite !== null,
    'No real local QwenWork credential found (~/.dsh/.credentials.yaml or ~/.dsh/qwenwork-desktop.json). Please sign in first.',
  );

  const provider = activeSite === 'intl' ? 'qwenwork-intl' : 'qwenwork';
  const origin = ctx.webServer.getOrigin();
  const port = ctx.webServer.port;
  assert.ok(typeof port === 'number' && port > 0);

  let vlModelId = null;

  try {
    await t.test('1. Real HTTP /status, live catalog sync, Host guard, and configurable provider metadata', async () => {
      // Untrusted Host must be rejected with 403 over real HTTP
      const denied = await rawHttpGet({
        host: '127.0.0.1',
        port,
        reqPath: pathForSite(STATUS_PATH, activeSite),
        hostHeader: 'evil.example.com',
      });
      assert.equal(denied.status, 403);
      assert.deepEqual(JSON.parse(denied.text), { error: 'request-not-trusted' });

      // Real loopback status request triggers live token refresh (if needed), account overview & catalog sync
      const res = await fetch(`${origin}${pathForSite(STATUS_PATH, activeSite)}?force=1`, {
        headers: { accept: 'application/json' },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'signed-in', `Expected signed-in status, got: ${JSON.stringify(body.error ?? body.status)}`);
      assert.equal(body.provider, provider);
      assert.ok(Array.isArray(body.models) && body.models.length > 0, 'Expected non-empty live model catalog');
      assert.equal(body.settings?.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);

      // GET /settings returns live runtime settings snapshot; invalid POST /settings fails with 400
      const settingsRes = await fetch(`${origin}${SETTINGS_PATH}`, {
        headers: { accept: 'application/json' },
      });
      assert.equal(settingsRes.status, 200);
      const settingsBody = await settingsRes.json();
      assert.equal(settingsBody.ok, true);
      assert.equal(settingsBody.settings.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);

      const badSettingsRes = await fetch(`${origin}${SETTINGS_PATH}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ maxOutputTokens: 100 }),
      });
      assert.equal(badSettingsRes.status, 400);

      // Real LlmRuntime.listModels() reflects live signed-in catalog
      const models = await ctx.llm.listModels(provider);
      assert.ok(models.length > 0, 'ctx.llm.listModels should expose live models');
      const vlModel =
        models.find((m) => m.id === 'flash' && m.inputModalities?.includes('image')) ??
        models.find((m) => m.inputModalities?.includes('image'));
      assert.ok(vlModel, 'Expected at least one live vision-capable model in QwenWork catalog');
      vlModelId = vlModel.id;

      // Configurable providers must NOT be marked declared: true and must use entry id / cordis name
      const directory = ctx.llm.listConfigurableProviders();
      const entry = directory.find((e) => e.provider === provider);
      assert.ok(entry, `Provider ${provider} missing from configurable directory`);
      assert.equal(entry.settingsNs, 'llm-qwenwork');
      assert.notEqual(entry.declared, true);
    });

    await t.test('2. Real live text stream via ctx.llm.stream() and BlockAssembler', async () => {
      assert.ok(vlModelId);
      const assembler = new BlockAssembler();
      let finishReason = null;
      let usage = null;

      for await (const chunk of ctx.llm.stream({
        provider,
        model: vlModelId,
        maxTokens: 256,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Reply with exactly the word PONG and nothing else.' }],
          },
        ],
      })) {
        assembler.push(chunk);
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') finishReason = chunk.reason;
      }

      const msg = assembler.message({ provider, model: vlModelId });
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      assert.ok(text.length > 0, 'Expected non-empty live model text response');
      assert.equal(finishReason?.kind, 'stop');
      if (usage !== null) {
        assert.ok(usage.outputTokens > 0, 'Expected positive outputTokens');
      }
    });

    await t.test('3. Real live multi-image vision request via real LocalAttachmentStore (Issue #5 + data + attachmentId)', async () => {
      assert.ok(vlModelId);
      const redRef = await ctx.attachments.saveImage({
        data: new Uint8Array(makeSolidPng(32, 32, 240, 20, 20)),
        mediaType: 'image/png',
        name: 'red-square.png',
      });
      const blueRef = await ctx.attachments.saveImage({
        data: new Uint8Array(makeSolidPng(32, 32, 20, 60, 240)),
        mediaType: 'image/png',
        name: 'blue-square.png',
      });
      assert.notEqual(redRef.attachmentId, blueRef.attachmentId);

      // Verify imageRequestTarget returns exact DSH 0.2.3 shape and passes real LocalAttachmentStore validation
      const target = ctx.llm.imageRequestTarget(provider, vlModelId, redRef);
      assert.ok(Number.isSafeInteger(target.width) && target.width > 0);
      assert.ok(Number.isSafeInteger(target.height) && target.height > 0);
      assert.ok(Number.isSafeInteger(target.maxImageBytes) && target.maxImageBytes > 0);
      assert.ok(Number.isSafeInteger(target.imageTargetBytes) && target.imageTargetBytes > 0);
      assert.ok(target.imageTargetBytes <= target.maxImageBytes);
      assert.equal('maxBytes' in target, false);

      const loaded = await ctx.attachments.readImageRequest(redRef, target);
      assert.ok(loaded.data instanceof Uint8Array && loaded.data.byteLength > 0);
      assert.equal(typeof loaded.bytes, 'number');

      // Live multi-image request through real LlmRuntime -> QwenWorkLlmAdapter -> real QwenWork gateway
      const assembler = new BlockAssembler();
      let finishReason = null;
      for await (const chunk of ctx.llm.stream({
        provider,
        model: vlModelId,
        maxTokens: 256,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', attachment: redRef },
              { type: 'image', attachment: blueRef },
              { type: 'text', text: 'What are the solid colors of the first image and the second image? Answer in one short sentence.' },
            ],
          },
        ],
      })) {
        assembler.push(chunk);
        if (chunk.type === 'finish') finishReason = chunk.reason;
      }

      const msg = assembler.message({ provider, model: vlModelId });
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      assert.ok(text.length > 0, 'Expected non-empty live vision response');
      assert.equal(finishReason?.kind, 'stop');
      assert.match(text, /red|红/i, `Expected vision model to recognize red image, got: ${text}`);
      assert.match(text, /blue|蓝/i, `Expected vision model to recognize blue image, got: ${text}`);
    });

    await t.test('4. Real live read_image tool-result image request via real LocalAttachmentStore', async () => {
      assert.ok(vlModelId);
      const greenRef = await ctx.attachments.saveImage({
        data: new Uint8Array(makeSolidPng(32, 32, 20, 220, 40)),
        mediaType: 'image/png',
        name: 'green-square.png',
      });

      const callId = ToolCallId('call_read_image_live_1');
      const assembler = new BlockAssembler();
      let finishReason = null;
      for await (const chunk of ctx.llm.stream({
        provider,
        model: vlModelId,
        maxTokens: 256,
        tools: [
          {
            name: 'read_image',
            description: 'Read a local image file and return its contents.',
            parameters: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Please inspect green-square.png and tell me its color.' }],
          },
          {
            role: 'assistant',
            id: 'msg-asst-1',
            source: { kind: 'model', provider, model: vlModelId },
            content: [
              { type: 'tool-call', id: callId, name: 'read_image', arguments: '{"file_path":"green-square.png"}' },
            ],
          },
          {
            role: 'tool',
            id: 'msg-tool-1',
            toolCallId: callId,
            source: { kind: 'tool', callId },
            content: [{ type: 'image', attachment: greenRef }],
          },
        ],
      })) {
        assembler.push(chunk);
        if (chunk.type === 'finish') finishReason = chunk.reason;
      }

      const msg = assembler.message({ provider, model: vlModelId });
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      assert.ok(text.length > 0, 'Expected non-empty response after tool-result image');
      assert.equal(finishReason?.kind, 'stop');
      assert.match(text, /green|绿/i, `Expected vision model to recognize green tool image, got: ${text}`);
    });

    await t.test('5. Real DSH Session + SessionProjectionRegistry + Inbox stall-guard integration', async () => {
      const session = Session.create(SessionId(`live-stall-${Date.now()}`));
      const appendAndDrive = (type, data, opts) => {
        const ev = opts === undefined ? session.append(type, data) : session.append(type, data, opts);
        ctx.emit('session/event', session, ev);
        return ev;
      };

      const userPrompt = createUserMessage({
        content: [{ type: 'text', text: '帮我检查并修改配置' }],
        source: { kind: 'user' },
      });

      appendAndDrive('turn/start', { turn: 1 });
      appendAndDrive('user/message', userPrompt, { surfaceOp: 'append' });
      appendAndDrive(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            id: 'asst-stall-1',
            role: 'assistant',
            source: { kind: 'model', provider, model: vlModelId },
            content: [{ type: 'text', text: '我先检查配置文件，然后把对应字段改好：' }],
          },
          stream: [],
        },
        { surfaceOp: 'append' },
      );

      const steered = [];
      const realInbox = {
        nextStep: [],
        nextTurn: [
          createUserMessage({
            content: [{ type: 'text', text: '先等等，我有补充' }],
            source: { kind: 'user' },
          }),
        ],
      };
      const agent = {
        session,
        inbox: realInbox,
        steer(msg) {
          steered.push(msg);
          // Prove the steered message passes REAL Session.append validation
          appendAndDrive('user/message', msg, { surfaceOp: 'append' });
        },
      };

      // 5a. When real inbox.nextTurn is non-empty, stall-guard MUST NOT steer
      await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
      assert.equal(steered.length, 0, 'stall-guard must skip when inbox.nextTurn has queued user work');

      // 5b. Clear inbox -> stall-guard MUST steer and track turn 1 continue count via turn/start (no user/message.turn)
      realInbox.nextTurn = [];
      await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
      assert.equal(steered.length, 1, 'stall-guard should steer once on stall with empty inbox');

      // Second stall in same turn -> allowed up to maxContinues (2)
      await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
      assert.equal(steered.length, 2, 'stall-guard should steer a second time up to maxContinues=2');

      // Third attempt in same turn -> blocked by maxContinues
      await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
      assert.equal(steered.length, 2, 'stall-guard must stop after reaching maxContinues');

      // 5c. Fallback without sessionProjections works via real Session.snapshotEvents()
      const bareCtx = new Context();
      const disposeBare = plugin.installStallGuard(bareCtx, {
        rawConfig: { stallGuard: { enabled: true, maxContinues: 2 } },
        providers: [provider],
      });
      const bareSession = Session.create(SessionId(`live-stall-bare-${Date.now()}`));
      bareSession.append('turn/start', { turn: 1 });
      bareSession.append('user/message', userPrompt, { surfaceOp: 'append' });
      bareSession.append(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            id: 'asst-stall-bare-1',
            role: 'assistant',
            source: { kind: 'model', provider, model: vlModelId },
            content: [{ type: 'text', text: '我接下来先读取配置并立即修改代码：' }],
          },
          stream: [],
        },
        { surfaceOp: 'append' },
      );
      const bareSteered = [];
      await bareCtx.serial('agent/turn-stopping', {
        agent: {
          session: bareSession,
          inbox: { nextStep: [], nextTurn: [] },
          steer(msg) {
            bareSteered.push(msg);
          },
        },
        turn: 1,
        signal: new AbortController().signal,
      });
      assert.equal(bareSteered.length, 1, 'fallback without sessionProjections must read real Session.snapshotEvents()');
      disposeBare();
    });
  } finally {
    disposeAuth();
    peerAc.abort();
    await fPlugin.dispose();
    await fWeb.dispose();
    await fAttach.dispose();
    await fLlm.dispose();
    await fProj.dispose();
    await fCreds.dispose();
    await fs.rm(tmpAttachHome, { recursive: true, force: true });
  }
});

test('Client bundle loads via window.__ModuleLoader__ and registers all 3 DSH UI slots', async () => {
  const clientCode = await fs.readFile(path.join(rootDir, 'dist/client/index.js'), 'utf8');
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(clientCode, sandbox);
  assert.ok(loadedDef && loadedDef.id === 'dsh-qwenwork-connect');

  const mod = loadedDef.factory((id) => {
    if (id === 'react') {
      return { useState: () => [null, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useRef: () => ({ current: null }) };
    }
    if (id === 'react/jsx-runtime') {
      return { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') };
    }
    throw new Error(`unexpected client require: ${id}`);
  });

  assert.equal(mod.name, 'dsh-qwenwork-connect');
  assert.deepEqual([...mod.inject], ['slots', 'locale']);

  const registeredSlots = [];
  const clientCtx = {
    effect(fn) {
      fn();
      return () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (k) => k,
    },
    slots: {
      inject(_name, factory) {
        factory();
        return () => {};
      },
      register(meta) {
        registeredSlots.push(meta.name);
        return () => {};
      },
    },
  };
  mod.apply(clientCtx);
  assert.deepEqual(registeredSlots, [
    'plugins.bundle.config',
    'plugins.row.config',
    'conversation.input.left',
  ]);
});
