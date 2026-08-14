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

test('受控运行时只要当前进程持有可用 CDP 就复用，不依赖命令行参数可见', async () => {
  const processManager = {
    inspect: async () => ({
      app: { version: '26.707.3748.0' },
      mainProcess: { pid: 10, commandLine: 'ChatGPT.exe' },
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

  assert.equal(result.restarted, false);
  assert.equal(result.pid, 10);
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

test('受控启动失败后重试不会再次关闭官方客户端', async () => {
  let restartCount = 0;
  const runtime = new ControlledCodexRuntime({
    debugPort: 9230,
    reader: {},
    cdp: createCdp(),
    processManager: {
      inspect: async () => ({ app: { version: '26.707.3748.0' }, mainProcess: { pid: 10, commandLine: 'ChatGPT.exe' } }),
      restart: async () => {
        restartCount += 1;
        throw Object.assign(new Error('CDP 未就绪'), { code: 'CDP_START_FAILED' });
      },
    },
    controller: {},
    portOwnerResolver: async () => null,
    cdpProbe: async () => ({ ok: false }),
  });

  await assert.rejects(() => runtime.start(), error => error.code === 'CDP_START_FAILED');
  await assert.rejects(() => runtime.start(), error => error.code === 'CDP_START_RETRY_BLOCKED');
  assert.equal(restartCount, 1);
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

test('受控运行时在 CDP 短暂断开后自动恢复，不重启官方客户端', async () => {
  const cdp = createCdp();
  let connectCount = 0;
  cdp.connect = async () => {
    connectCount += 1;
  };
  const runtime = new ControlledCodexRuntime({
    reader: {},
    cdp,
    processManager: {},
    controller: {},
    reconnectIntervalMs: 1,
  });
  runtime.state = 'ready';
  const recovered = new Promise(resolve => runtime.once('reconnected', resolve));

  cdp.emit('disconnected', Object.assign(new Error('CDP 连接已关闭：1006'), { code: 'CDP_DISCONNECTED' }));
  const details = await recovered;

  assert.equal(connectCount, 1);
  assert.equal(runtime.state, 'ready');
  assert.equal(details.reconnected, true);
  runtime.stopRuntime();
});
