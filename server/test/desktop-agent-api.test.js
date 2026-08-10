const assert = require('node:assert/strict');
const test = require('node:test');
const { createDesktopAgentApi } = require('../../desktop/src/desktop-agent-api');

function createAppServer(overrides = {}) {
  return Object.assign({
    resumeThread: async () => ({ thread: { id: 'thread-1' } }),
    startTurn: async () => ({ turn: { id: 'turn-1' } }),
    interruptTurn: async () => ({ ok: true }),
  }, overrides);
}

test('desktop-agent API 将 threads 动作映射到 Desktop 线程目录', async () => {
  const api = createDesktopAgentApi({
    listThreads: async () => ({ threads: [{ id: 'thread-1', name: '线程' }], nextCursor: 'next' }),
  });

  assert.deepEqual(await api.handle('threads', {}), {
    ok: true,
    threads: [{ id: 'thread-1', name: '线程' }],
    nextCursor: 'next',
  });
});

test('desktop-agent API 缺少 Desktop 线程目录时明确拒绝读取列表', async () => {
  const api = createDesktopAgentApi({});

  await assert.rejects(
    () => api.handle('threads', {}),
    error => error.code === 'THREAD_CATALOG_UNAVAILABLE' && error.status === 503,
  );
});

test('desktop-agent API 通过 App Server 恢复并启动目标线程', async () => {
  const calls = [];
  const progress = [];
  const api = createDesktopAgentApi({
    appServer: createAppServer({
      resumeThread: async threadId => calls.push(['resume', threadId]),
      startTurn: async (threadId, text, clientUserMessageId) => {
        calls.push(['start', threadId, text, clientUserMessageId]);
        return { turn: { id: 'turn-9' } };
      },
    }),
    now: () => 1780910000000,
    onControlProgress: event => progress.push(event),
  });

  const result = await api.handle('send', {
    threadId: 'thread-1',
    text: '你好',
    clientUserMessageId: 'message-9',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.watch, {
    threadId: 'thread-1',
    turnId: 'turn-9',
    clientUserMessageId: 'message-9',
    since: '2026-06-08T09:13:20.000Z',
  });
  assert.deepEqual(calls, [
    ['resume', 'thread-1'],
    ['start', 'thread-1', '你好', 'message-9'],
  ]);
  assert.deepEqual(progress.map(event => event.phase), [
    'send.received',
    'send.resume.started',
    'send.resume.completed',
    'send.turn.started',
    'send.turn.completed',
  ]);
  assert.equal(progress[0].textLength, 2);
  assert.equal(progress[0].clientUserMessageId, 'message-9');
});

test('desktop-agent API 对相同消息标识只启动一个回合', async () => {
  const calls = [];
  const api = createDesktopAgentApi({
    appServer: createAppServer({
      startTurn: async (threadId, text, clientUserMessageId) => {
        calls.push([threadId, text, clientUserMessageId]);
        return { turn: { id: 'turn-idempotent' } };
      },
    }),
    now: () => 1780910000000,
  });
  const payload = {
    threadId: 'thread-1',
    text: '只执行一次',
    clientUserMessageId: 'message-idempotent',
  };

  const first = await api.handle('send', payload);
  const repeated = await api.handle('send', payload);

  assert.deepEqual(repeated, first);
  assert.deepEqual(calls, [['thread-1', '只执行一次', 'message-idempotent']]);
});

test('desktop-agent API 在恢复线程失败时返回明确错误', async () => {
  const api = createDesktopAgentApi({
    appServer: createAppServer({
      resumeThread: async () => { throw new Error('thread not found'); },
    }),
  });

  await assert.rejects(
    () => api.handle('send', { threadId: 'thread-1', text: '你好', clientUserMessageId: 'message-resume-failed' }),
    error => error.code === 'THREAD_RESUME_FAILED' && error.status === 409 && /thread not found/.test(error.message),
  );
});

test('desktop-agent API 在启动回合失败或缺少回合标识时返回明确错误', async () => {
  const failure = createDesktopAgentApi({
    appServer: createAppServer({
      startTurn: async () => { throw new Error('request timeout'); },
    }),
  });
  const missingTurn = createDesktopAgentApi({
    appServer: createAppServer({ startTurn: async () => ({ turn: {} }) }),
  });

  await assert.rejects(
    () => failure.handle('send', { threadId: 'thread-1', text: '你好', clientUserMessageId: 'message-start-failed' }),
    error => error.code === 'TURN_START_FAILED' && error.status === 502 && /request timeout/.test(error.message),
  );
  await assert.rejects(
    () => missingTurn.handle('send', { threadId: 'thread-1', text: '你好', clientUserMessageId: 'message-missing-turn' }),
    error => error.code === 'TURN_START_FAILED' && error.status === 502 && /未返回回合标识/.test(error.message),
  );
});

test('desktop-agent API 按指定线程停止 App Server 回合', async () => {
  const calls = [];
  const api = createDesktopAgentApi({
    appServer: createAppServer({ interruptTurn: async threadId => calls.push(threadId) }),
  });

  await assert.rejects(
    () => api.handle('stop', {}),
    error => error.code === 'THREAD_ID_REQUIRED' && error.status === 400,
  );
  const result = await api.handle('stop', { threadId: 'thread-1' });

  assert.deepEqual(result, { ok: true, threadId: 'thread-1' });
  assert.deepEqual(calls, ['thread-1']);
});

test('desktop-agent API 拒绝未知动作和空发送内容', async () => {
  const api = createDesktopAgentApi({ appServer: createAppServer() });

  await assert.rejects(
    () => api.handle('unknown', {}),
    error => error.code === 'ACTION_NOT_ALLOWED' && error.status === 400,
  );
  await assert.rejects(
    () => api.handle('send', { threadId: 'thread-1', text: ' ' }),
    error => error.code === 'EMPTY_TEXT' && error.status === 400,
  );
});

test('desktop-agent API 在控制命令执行期间仍可读取本地历史和状态', async () => {
  let releaseSend;
  let markSendStarted;
  const sendStarted = new Promise(resolve => { markSendStarted = resolve; });
  const api = createDesktopAgentApi({
    reader: {
      parseHistory: (threadId, limit, before) => ({
        ok: true,
        available: true,
        threadId,
        messages: [{ role: 'user', text: `第 ${before || '末'} 页`, turnId: 'turn-1' }],
        hasMore: false,
        nextBefore: '',
        limit,
      }),
      parseStatus: options => ({
        ok: true,
        available: true,
        threadId: options.threadId,
        active: false,
        status: 'complete',
        final: '已完成',
        steps: [],
        turns: [],
      }),
    },
    appServer: createAppServer({
      startTurn: async () => {
        markSendStarted();
        await new Promise(resolve => { releaseSend = resolve; });
        return { turn: { id: 'turn-1' } };
      },
    }),
  });

  const sending = api.handle('send', {
    threadId: 'thread-1',
    text: '正在发送',
    clientUserMessageId: 'message-reading-during-send',
  });
  await sendStarted;
  const history = await api.handle('history', { threadId: 'thread-1', limit: 10, before: '5' });
  const status = await api.handle('status', { threadId: 'thread-1', since: '2026-08-05T00:00:00.000Z' });
  releaseSend();
  await sending;

  assert.equal(history.ok, true);
  assert.equal(history.threadId, 'thread-1');
  assert.equal(history.messages[0].text, '第 5 页');
  assert.equal(status.status, 'complete');
  assert.equal(status.threadId, 'thread-1');
});

test('desktop-agent API 在线状态叠加同线程 App Server 运行态', async () => {
  const api = createDesktopAgentApi({
    reader: {
      parseStatus: () => ({
        ok: true,
        available: true,
        threadId: 'thread-1',
        active: false,
        status: 'complete',
        final: '上一轮回复',
        turns: [{ turnId: 'old-turn', status: 'complete', steps: [] }],
      }),
    },
    appServer: createAppServer({
      getThreadRuntime: () => ({ state: 'running', turnId: 'new-turn', observedAt: '2026-08-10T10:00:00.000Z' }),
    }),
  });

  const status = await api.handle('status', { threadId: 'thread-1' });

  assert.equal(status.active, true);
  assert.equal(status.status, 'running');
  assert.equal(status.final, '');
});

test('desktop-agent API 对 JSONL 进行中状态执行 App Server 权威校验', async () => {
  const calls = [];
  let runtime = { state: 'unknown', turnId: '', observedAt: '' };
  const api = createDesktopAgentApi({
    reader: {
      parseStatus: () => ({
        ok: true,
        available: true,
        threadId: 'thread-1',
        active: true,
        status: 'running',
        final: '',
        turns: [{ turnId: 'turn-1', status: 'running', steps: [] }],
      }),
    },
    appServer: createAppServer({
      getThreadRuntime: () => runtime,
      refreshThreadRuntime: async threadId => {
        calls.push(threadId);
        runtime = {
          state: 'complete',
          turnId: 'turn-1',
          turnStatus: 'completed',
          observedAt: '2026-08-10T12:00:00.000Z',
        };
        return runtime;
      },
    }),
  });

  const status = await api.handle('status', { threadId: 'thread-1' });

  assert.deepEqual(calls, ['thread-1']);
  assert.equal(status.active, false);
  assert.equal(status.status, 'complete');
  assert.equal(status.turns[0].status, 'complete');
});

test('desktop-agent API 权威状态校验失败时不返回陈旧运行态', async () => {
  const api = createDesktopAgentApi({
    reader: {
      parseStatus: () => ({
        ok: true,
        available: true,
        threadId: 'thread-1',
        active: true,
        status: 'running',
        final: '',
        turns: [{ turnId: 'turn-1', status: 'running', steps: [] }],
      }),
    },
    appServer: createAppServer({
      getThreadRuntime: () => ({ state: 'unknown', turnId: '', observedAt: '' }),
      refreshThreadRuntime: async () => { throw new Error('thread/read timeout'); },
    }),
  });

  await assert.rejects(
    () => api.handle('status', { threadId: 'thread-1' }),
    error => error.code === 'APP_SERVER_STATUS_FAILED'
      && error.status === 503
      && /thread\/read timeout/.test(error.message),
  );
});
