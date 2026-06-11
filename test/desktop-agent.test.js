const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');
const { agentUrlFromServerUrl, createDesktopAgentClient, handleAgentRequest, withTimeout } = require('../desktop-client/src/desktop-agent-client');
const { DesktopAgentApi } = require('../desktop-client/src/desktop-agent-api');

test('desktop-agent 将 HTTPS 云端地址转换为 WSS Agent 地址', () => {
  assert.equal(
    agentUrlFromServerUrl('https://codex.example.com', 'token-1'),
    'wss://codex.example.com/agent?token=token-1',
  );
  assert.equal(
    agentUrlFromServerUrl('http://127.0.0.1:8791/base/', 'token 2'),
    'ws://127.0.0.1:8791/base/agent?token=token+2',
  );
});

test('desktop-agent 只处理带 id 和 action 的请求', async () => {
  const api = {
    handle: async (action, payload) => ({ ok: true, action, payload }),
  };

  assert.deepEqual(
    await handleAgentRequest(api, { id: '1', action: 'threads', payload: { limit: 10 } }),
    { id: '1', ok: true, result: { ok: true, action: 'threads', payload: { limit: 10 } } },
  );

  assert.deepEqual(
    await handleAgentRequest(api, { action: 'threads' }),
    {
      id: '',
      ok: false,
      error: { code: 'INVALID_AGENT_REQUEST', message: 'Agent 请求格式不正确。', status: 400 },
    },
  );
});

test('desktop-agent 将本机 API 错误转换为协议错误', async () => {
  const api = {
    handle: async () => {
      const error = new Error('拒绝访问');
      error.code = 'DENIED';
      error.status = 403;
      throw error;
    },
  };

  assert.deepEqual(
    await handleAgentRequest(api, { id: '2', action: 'send', payload: {} }),
    {
      id: '2',
      ok: false,
      error: { code: 'DENIED', message: '拒绝访问', status: 403 },
    },
  );
});

test('desktop-agent 断线后自动重连', async () => {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.OPEN = 1;
      this.CLOSED = 3;
      this.sent = [];
      sockets.push(this);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.readyState = this.CLOSED;
      this.emit('close', 1000, Buffer.from('client close'));
    }
  }

  const client = createDesktopAgentClient({
    serverUrl: 'http://127.0.0.1:8008',
    token: 'token-1',
    api: { handle: async action => ({ ok: true, action }) },
    WebSocket: FakeWebSocket,
    reconnectDelayMs: 0,
  });

  assert.equal(sockets.length, 1);
  sockets[0].emit('close', 1006, Buffer.from('server down'));
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, 'ws://127.0.0.1:8008/agent?token=token-1');
  client.close();
});

test('desktop-agent 连接后主动上传会话同步快照', async () => {
  const messages = [];
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1;
      this.CLOSED = 3;
      this.readyState = this.OPEN;
      setImmediate(() => this.emit('open'));
    }

    send(message) {
      messages.push(JSON.parse(message));
    }

    close() {
      this.readyState = this.CLOSED;
      this.emit('close', 1000, Buffer.from(''));
    }
  }

  let syncCount = 0;
  const client = createDesktopAgentClient({
    serverUrl: 'http://example.test',
    token: 'token',
    api: { handle: async () => ({ ok: true }) },
    WebSocket: FakeSocket,
    syncIntervalMs: 1000,
    syncProvider: async () => {
      syncCount += 1;
      return { openThreadIds: ['thread-1'], sessions: [] };
    },
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  client.close();

  assert.equal(syncCount, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'session-sync');
  assert.deepEqual(messages[0].payload.openThreadIds, ['thread-1']);
});

test('desktop-agent 同步快照为空时不上传会话同步消息', async () => {
  const messages = [];
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1;
      this.CLOSED = 3;
      this.readyState = this.OPEN;
      setImmediate(() => this.emit('open'));
    }

    send(message) {
      messages.push(JSON.parse(message));
    }

    close() {
      this.readyState = this.CLOSED;
      this.emit('close', 1000, Buffer.from(''));
    }
  }

  const client = createDesktopAgentClient({
    serverUrl: 'http://example.test',
    token: 'token',
    api: { handle: async () => ({ ok: true }) },
    WebSocket: FakeSocket,
    syncIntervalMs: 1000,
    syncProvider: async () => null,
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  client.close();

  assert.equal(messages.length, 0);
});

test('desktop-agent 同步任务超时后会释放后续同步', async () => {
  const messages = [];
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1;
      this.CLOSED = 3;
      this.readyState = this.OPEN;
      setImmediate(() => this.emit('open'));
    }

    send(message) {
      messages.push(JSON.parse(message));
    }

    close() {
      this.readyState = this.CLOSED;
      this.emit('close', 1000, Buffer.from(''));
    }
  }

  let syncCount = 0;
  const errors = [];
  const client = createDesktopAgentClient({
    serverUrl: 'http://example.test',
    token: 'token',
    api: { handle: async () => ({ ok: true }) },
    WebSocket: FakeSocket,
    syncIntervalMs: 1000,
    syncTimeoutMs: 20,
    syncProvider: async () => {
      syncCount += 1;
      if (syncCount === 1) return new Promise(() => {});
      return { openThreadIds: ['thread-1'], sessions: [] };
    },
  });
  client.on('sync-error', error => errors.push(error));

  await new Promise(resolve => setTimeout(resolve, 1250));
  client.close();

  assert.equal(errors.length >= 1, true);
  assert.equal(errors[0].code, 'SYNC_TIMEOUT');
  assert.equal(messages.length >= 1, true);
  assert.equal(messages[0].type, 'session-sync');
});

test('withTimeout 超时后返回明确错误码', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 1, '同步超时'),
    error => error.code === 'SYNC_TIMEOUT' && error.message === '同步超时',
  );
});

test('desktop-agent API 控制 Codex 时暴露 busy 状态', async () => {
  let releaseControl;
  const api = new DesktopAgentApi({
    reader: {
      getThreadTarget: () => ({
        available: true,
        projectName: 'demo',
        threadName: '测试线程',
      }),
    },
    controller: {
      sendToThread: async () => new Promise(resolve => {
        releaseControl = resolve;
      }),
    },
    now: () => Date.parse('2026-06-08T00:00:00.000Z'),
  });

  const sending = api.send({ threadId: 'thread-1', text: '你好' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.isBusy(), true);
  releaseControl();
  await sending;
  assert.equal(api.isBusy(), false);
});
