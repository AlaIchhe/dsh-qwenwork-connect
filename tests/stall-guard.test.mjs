import test from 'node:test';
import assert from 'node:assert/strict';
import { installStallGuard } from '../dist/host/index.js';

test('installStallGuard uses sessionProjections fold, steers on stall, and respects config toggle & user abort', async () => {
  let projectionDef = null;
  let stoppingHandler = null;
  const steered = [];

  const mockConfig = {
    stallGuard: { get: () => ({ enabled: true, maxContinues: 2 }) },
  };

  const session = {
    events: [
      { type: 'user/message', data: { source: { kind: 'user' } } },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          message: {
            source: { provider: 'qwenwork' },
            content: [{ type: 'text', text: '我先检查配置文件，然后把对应字段改好：' }],
          },
        },
      },
    ],
  };

  let projectionDisposed = false;
  let stoppingDisposed = false;

  const ctx = {
    logger: { info() {}, debug() {} },
    get(name) {
      if (name === 'sessionProjections') {
        return {
          register(def) {
            projectionDef = def;
            return {
              stateOf(sess) {
                let s = def.init({}, 0);
                for (const ev of sess.events) s = def.apply(s, ev);
                return s;
              },
              async dispose() {
                projectionDisposed = true;
              },
            };
          },
        };
      }
      return undefined;
    },
    on(event, handler) {
      if (event === 'agent/turn-stopping') stoppingHandler = handler;
      return () => {
        stoppingDisposed = true;
      };
    },
  };

  const dispose = installStallGuard(ctx, {
    rawConfig: mockConfig,
    providers: ['qwenwork', 'qwenwork-intl'],
  });
  // Allow projection registration promise to settle
  await new Promise((r) => setImmediate(r));
  assert.ok(projectionDef !== null);

  // Verify pure projection identity preservation on unrelated events
  const s0 = projectionDef.init({}, 0);
  assert.equal(projectionDef.apply(s0, { type: 'unknown/event', data: {} }), s0);

  const agent = {
    session,
    inbox: { hasPending: false },
    steer(msg) {
      steered.push(msg);
      session.events.push({
        type: 'user/message',
        data: { turn: 1, source: msg.source },
      });
    },
  };

  // Turn 1: should detect stall and steer
  await stoppingHandler({ agent, turn: 1 });
  assert.equal(steered.length, 1);

  // If user asks a question, veto must win
  session.events.push({
    type: 'assistant/message',
    data: {
      turn: 1,
      message: {
        source: { provider: 'qwenwork' },
        content: [{ type: 'text', text: '接下来我来修改配置，你确认一下是否继续？' }],
      },
    },
  });
  await stoppingHandler({ agent, turn: 1 });
  assert.equal(steered.length, 1);

  // If turn ends aborted, session is locked until a real user message arrives
  session.events.push({ type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  session.events.push({
    type: 'assistant/message',
    data: {
      turn: 2,
      message: {
        source: { provider: 'qwenwork' },
        content: [{ type: 'text', text: '我先读取文件并立即修改代码：' }],
      },
    },
  });
  await stoppingHandler({ agent, turn: 2 });
  assert.equal(steered.length, 1);

  dispose();
  assert.equal(stoppingDisposed, true);
  assert.equal(projectionDisposed, true);
});
