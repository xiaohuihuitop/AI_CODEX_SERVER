const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');
const { agentUrlFromServerUrl, createDesktopAgentClient, handleAgentRequest, isRecoverableSocketError, withTimeout } = require('../../desktop/src/desktop-agent-client');
const { DesktopAgentApi } = require('../../desktop/src/desktop-agent-api');
const { reconcileDesktopCatalog } = require('../../desktop/src/desktop-catalog-reconcile');
const { advanceControlSyncState, inspectControlSyncEvidence, selectSyncBatch } = require('../../desktop/src/desktop-sync-batch');

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

test('Desktop 目录轻量检测在归档后立即移除目标且不扫描 JSONL', () => {
  let discoveryCount = 0;
  const result = reconcileDesktopCatalog({
    previousCatalogThreadIds: ['thread-1', 'thread-2'],
    previousTargets: [{ threadId: 'thread-1' }, { threadId: 'thread-2' }],
    threads: [{ id: 'thread-2' }],
    discoverTargets: () => {
      discoveryCount += 1;
      return [];
    },
  });

  assert.deepEqual(result.catalogThreadIds, ['thread-2']);
  assert.deepEqual(result.targets.map(item => item.threadId), ['thread-2']);
  assert.equal(result.removedCount, 1);
  assert.deepEqual(result.removedThreadIds, ['thread-1']);
  assert.equal(result.addedCount, 0);
  assert.equal(result.discovered, false);
  assert.equal(discoveryCount, 0);
});

test('Desktop 目录检测在新增线程或定期刷新时执行完整映射', () => {
  const discoveredInputs = [];
  const discoverTargets = threads => {
    discoveredInputs.push(threads.map(item => item.id));
    return threads.map(item => ({ threadId: item.id }));
  };
  const added = reconcileDesktopCatalog({
    previousCatalogThreadIds: ['thread-1'],
    previousTargets: [{ threadId: 'thread-1' }],
    threads: [{ id: 'thread-1' }, { id: 'thread-2' }],
    discoverTargets,
  });
  const forced = reconcileDesktopCatalog({
    previousCatalogThreadIds: added.catalogThreadIds,
    previousTargets: [{ threadId: 'thread-1' }],
    threads: [{ id: 'thread-1' }, { id: 'thread-2' }],
    discoverTargets,
    forceDiscovery: true,
  });

  assert.equal(added.addedCount, 1);
  assert.equal(added.discovered, true);
  assert.equal(forced.membershipChanged, false);
  assert.equal(forced.discovered, true);
  assert.deepEqual(forced.unresolvedThreadIds, ['thread-2']);
  assert.deepEqual(discoveredInputs, [
    ['thread-1', 'thread-2'],
    ['thread-1', 'thread-2'],
  ]);
});

test('Desktop 目录稳定时只按侧栏顺序重排且不重复扫描 JSONL', () => {
  let discoveryCount = 0;
  const result = reconcileDesktopCatalog({
    previousCatalogThreadIds: ['thread-1', 'thread-2'],
    previousTargets: [{ threadId: 'thread-1' }, { threadId: 'thread-2' }],
    threads: [{ id: 'thread-2' }, { id: 'thread-1' }],
    discoverTargets: () => {
      discoveryCount += 1;
      return [];
    },
    forceDiscovery: true,
  });

  assert.equal(result.membershipChanged, false);
  assert.equal(result.orderChanged, true);
  assert.equal(result.discovered, false);
  assert.equal(discoveryCount, 0);
  assert.deepEqual(result.targets.map(item => item.threadId), ['thread-2', 'thread-1']);
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

test('手机发送目标分别确认用户消息落盘和同一回合完成', () => {
  const turnId = 'turn-1';
  assert.deepEqual(inspectControlSyncEvidence([], 'thread-1', turnId), { accepted: false, completed: false });
  assert.deepEqual(
    inspectControlSyncEvidence([{ threadId: 'thread-1', metadataOnly: true }], 'thread-1', turnId),
    { accepted: false, completed: false },
  );
  assert.deepEqual(
    inspectControlSyncEvidence([{
      threadId: 'thread-1',
      snapshot: {
        messages: [{ role: 'user', turnId, text: '手机消息' }],
        status: { turns: [{ turnId, status: 'running', final: '' }] },
      },
    }], 'thread-1', turnId),
    { accepted: true, completed: false },
  );
  assert.deepEqual(
    inspectControlSyncEvidence([{
      threadId: 'thread-1',
      snapshot: {
        messages: [
          { role: 'user', turnId, text: '手机消息' },
          { role: 'assistant', turnId, text: '电脑回复' },
        ],
        status: { turns: [{ turnId, status: 'complete', final: '电脑回复' }] },
      },
    }], 'thread-1', turnId),
    { accepted: true, completed: true },
  );
});

test('手机发送增量同步只接受同一回合证据', () => {
  const userLine = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    },
  });
  const completeLine = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '电脑回复' },
  });

  assert.deepEqual(
    inspectControlSyncEvidence([{ threadId: 'thread-1', lines: [userLine] }], 'thread-1', 'turn-1'),
    { accepted: true, completed: false },
  );
  assert.deepEqual(
    inspectControlSyncEvidence([{ threadId: 'thread-1', lines: [userLine, completeLine] }], 'thread-1', 'turn-1'),
    { accepted: true, completed: true },
  );
  assert.deepEqual(
    inspectControlSyncEvidence([{ threadId: 'thread-1', lines: [completeLine] }], 'thread-1', 'turn-2'),
    { accepted: false, completed: false },
  );
});

test('手机停止命令仍以目标线程出现新同步内容作为完成证据', () => {
  assert.deepEqual(inspectControlSyncEvidence([], 'thread-1'), { accepted: false, completed: false });
  assert.deepEqual(
    inspectControlSyncEvidence([{ threadId: 'thread-1', lines: ['{"type":"event_msg"}'] }], 'thread-1'),
    { accepted: true, completed: true },
  );
});

test('手机发送在落盘确认后继续优先同步直到同一回合完成', () => {
  const initial = { threadId: 'thread-1', turnId: 'turn-1', accepted: false, deadline: 2000 };
  const accepted = advanceControlSyncState(initial, { accepted: true, completed: false }, 1000);
  const completed = advanceControlSyncState(accepted.state, { accepted: true, completed: true }, 1500);

  assert.deepEqual(accepted.state, { threadId: 'thread-1', turnId: 'turn-1', accepted: true, deadline: 2000 });
  assert.deepEqual(accepted.confirmedTurnIds, ['turn-1']);
  assert.equal(accepted.acceptedNow, true);
  assert.equal(accepted.completedNow, false);
  assert.equal(accepted.timedOut, false);
  assert.equal(completed.state, null);
  assert.deepEqual(completed.confirmedTurnIds, []);
  assert.equal(completed.completedNow, true);
});

test('手机发送只有在尚未落盘时应用确认超时', () => {
  const pending = { threadId: 'thread-1', turnId: 'turn-1', accepted: false, deadline: 2000 };
  const timedOut = advanceControlSyncState(pending, { accepted: false, completed: false }, 2000);
  const acceptedLongTurn = advanceControlSyncState(
    { threadId: 'thread-1', turnId: 'turn-1', accepted: true, deadline: 2000 },
    { accepted: true, completed: false },
    5000,
  );

  assert.equal(timedOut.state, null);
  assert.equal(timedOut.timedOut, true);
  assert.deepEqual(acceptedLongTurn.state, { threadId: 'thread-1', turnId: 'turn-1', accepted: true, deadline: 2000 });
  assert.equal(acceptedLongTurn.timedOut, false);
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
  assert.deepEqual(completed[0].result, { ok: true });
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
      resumeThread: async () => {},
      startTurn: async () => new Promise(resolve => {
        releaseControl = resolve;
      }),
      interruptTurn: async () => {},
    },
    now: () => Date.parse('2026-06-08T00:00:00.000Z'),
  });

  const sending = api.handle('send', { threadId: 'thread-1', text: '你好' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.isBusy(), true);
  releaseControl({ turn: { id: 'turn-1' } });
  await sending;
  assert.equal(api.isBusy(), false);
});
