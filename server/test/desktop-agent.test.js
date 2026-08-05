const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');
const { agentUrlFromServerUrl, createDesktopAgentClient, handleAgentRequest, isRecoverableSocketError, withTimeout } = require('../../desktop/src/desktop-agent-client');
const { DesktopAgentApi } = require('../../desktop/src/desktop-agent-api');
const { selectSyncBatch } = require('../../desktop/src/desktop-sync-batch');

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

test('手机控制后的目标线程优先同步且不打乱常规轮转游标', () => {
  const targets = [
    { threadId: 'thread-1' },
    { threadId: 'thread-2' },
    { threadId: 'thread-3' },
  ];
  const priority = selectSyncBatch(targets, 1, 2, 'thread-3');
  const regular = selectSyncBatch(targets, 1, 2, '');

  assert.equal(priority.prioritized, true);
  assert.deepEqual(priority.targets.map(item => item.threadId), ['thread-3']);
  assert.equal(priority.nextCursor, 1);
  assert.equal(regular.prioritized, false);
  assert.deepEqual(regular.targets.map(item => item.threadId), ['thread-2', 'thread-3']);
  assert.equal(regular.nextCursor, 0);
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

test('desktop-agent 连接后对 socket hang up 只发出重连提示', async () => {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.OPEN = 1;
      this.CLOSED = 3;
      sockets.push(this);
      setImmediate(() => this.emit('open'));
    }

    send() {}

    close() {
      this.readyState = this.CLOSED;
      this.emit('close', 1000, Buffer.from(''));
    }
  }

  const errors = [];
  const warnings = [];
  const client = createDesktopAgentClient({
    serverUrl: 'http://example.test',
    token: 'token',
    api: { handle: async () => ({ ok: true }) },
    WebSocket: FakeWebSocket,
  });
  client.on('error', error => errors.push(error));
  client.on('reconnect-warning', error => warnings.push(error));

  await new Promise(resolve => setImmediate(resolve));
  sockets[0].emit('error', new Error('socket hang up'));
  client.close();

  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(isRecoverableSocketError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
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

test('desktop-agent 收到服务器同步确认后发出确认事件', async () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1;
      this.CLOSED = 3;
      this.readyState = this.OPEN;
      setImmediate(() => this.emit('open'));
    }

    send() {}

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
    syncProvider: async () => null,
  });
  const received = new Promise(resolve => client.once('sync-ack', resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  client.socket.emit('message', Buffer.from(JSON.stringify({
    type: 'session-sync-ack',
    sessionCount: 3,
    updatedAt: '2026-07-29T12:00:00.000Z',
  })));
  const ack = await received;
  client.close();

  assert.equal(ack.sessionCount, 3);
  assert.equal(ack.updatedAt, '2026-07-29T12:00:00.000Z');
});

test('desktop-agent 为手机控制命令发出接收、完成和失败事件', async () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1;
      this.CLOSED = 3;
      this.readyState = this.OPEN;
      setImmediate(() => this.emit('open'));
    }

    send() {}

    close() {
      this.readyState = this.CLOSED;
      this.emit('close', 1000, Buffer.from(''));
    }
  }

  const client = createDesktopAgentClient({
    serverUrl: 'http://example.test',
    token: 'token',
    api: {
      handle: async action => {
        if (action === 'send') return { ok: true };
        const error = new Error('无法停止');
        error.code = 'THREAD_NOT_RUNNING';
        error.status = 409;
        throw error;
      },
    },
    WebSocket: FakeSocket,
    syncProvider: async () => null,
  });
  const received = [];
  const completed = [];
  const failed = [];
  client.on('control-received', event => received.push(event));
  client.on('control-complete', event => completed.push(event));
  client.on('control-failed', event => failed.push(event));

  await new Promise(resolve => setTimeout(resolve, 20));
  client.socket.emit('message', Buffer.from(JSON.stringify({ id: 'send-1', action: 'send', payload: { threadId: 'thread-1', text: 'hello' } })));
  client.socket.emit('message', Buffer.from(JSON.stringify({ id: 'stop-1', action: 'stop', payload: { threadId: 'thread-1' } })));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  client.close();

  assert.deepEqual(received.map(event => event.action), ['send', 'stop']);
  assert.deepEqual(completed.map(event => event.action), ['send']);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].action, 'stop');
  assert.equal(failed[0].error.code, 'THREAD_NOT_RUNNING');
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
    appServer: {
      resumeThread: async () => new Promise(resolve => {
        releaseControl = resolve;
      }),
      startTurn: async () => ({ turn: { id: 'turn-1' } }),
    },
    now: () => Date.parse('2026-06-08T00:00:00.000Z'),
  });

  const sending = api.handle('send', { threadId: 'thread-1', text: '你好' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.isBusy(), true);
  releaseControl();
  await sending;
  assert.equal(api.isBusy(), false);
});
