const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ControlledCodexRuntime } = require('../../desktop/src/controlled-codex-runtime');

function createCdp() {
  const cdp = new EventEmitter();
  cdp.connect = async () => {};
  cdp.close = () => {};
  return cdp;
}

test('受控运行时复用已经正确启动的官方客户端', async () => {
  const processManager = {
    inspect: async () => ({
      app: { version: '26.707.3748.0' },
      mainProcess: { pid: 10, commandLine: 'ChatGPT.exe --remote-debugging-port=9230' },
    }),
    restart: async () => { throw new Error('不应重启'); },
  };
  const runtime = new ControlledCodexRuntime({
    debugPort: 9230,
    reader: {},
    cdp: createCdp(),
    processManager,
    controller: {},
    portOwnerResolver: async () => ({ pid: 10 }),
    cdpProbe: async () => ({ ok: true }),
  });
  const result = await runtime.start();
  assert.deepEqual(result, { restarted: false, debugPort: 9230, pid: 10, version: '26.707.3748.0' });
  assert.equal(runtime.state, 'ready');
});

test('受控运行时发现普通官方客户端时执行受控重启', async () => {
  const calls = [];
  const runtime = new ControlledCodexRuntime({
    debugPort: 9230,
    reader: {},
    cdp: createCdp(),
    processManager: {
      inspect: async () => ({ app: { version: '26.707.3748.0' }, mainProcess: { pid: 10, commandLine: 'ChatGPT.exe' } }),
      restart: async options => {
        calls.push(options);
        return { app: { version: '26.707.3748.0' }, mainProcess: { pid: 20 } };
      },
    },
    controller: {},
    portOwnerResolver: async () => null,
    cdpProbe: async () => ({ ok: false }),
  });

  const result = await runtime.start();
  assert.equal(result.restarted, true);
  assert.equal(result.pid, 20);
  assert.deepEqual(calls, [{ debugPort: 9230 }]);
});

test('受控运行时将发送、停止和状态读取交给同一官方客户端控制器', async () => {
  const calls = [];
  const runtime = new ControlledCodexRuntime({
    reader: {},
    cdp: createCdp(),
    processManager: {},
    controller: {
      sendMessage: async (...args) => { calls.push(['send', ...args]); return { turnId: 'turn-1' }; },
      stop: async (...args) => { calls.push(['stop', ...args]); return { status: 'interrupted' }; },
      getThreadRuntime: async (...args) => { calls.push(['status', ...args]); return { state: 'idle' }; },
    },
  });
  runtime.state = 'ready';

  assert.deepEqual(await runtime.sendMessage('thread-1', '消息'), { turnId: 'turn-1' });
  assert.deepEqual(await runtime.stop('thread-1'), { status: 'interrupted' });
  assert.deepEqual(await runtime.getThreadRuntime('thread-1'), { state: 'idle' });
  assert.deepEqual(calls, [
    ['send', 'thread-1', '消息'],
    ['stop', 'thread-1'],
    ['status', 'thread-1'],
  ]);
});

test('受控运行时未就绪时拒绝所有控制操作', async () => {
  const runtime = new ControlledCodexRuntime({ reader: {}, cdp: createCdp(), processManager: {}, controller: {} });
  await assert.rejects(() => runtime.sendMessage('thread-1', '消息'), error => error.code === 'CONTROLLED_CODEX_NOT_READY');
});
