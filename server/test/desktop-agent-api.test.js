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
      startTurn: async (threadId, text) => {
        calls.push(['start', threadId, text]);
        return { turn: { id: 'turn-9' } };
      },
    }),
    now: () => 1780910000000,
    onControlProgress: event => progress.push(event),
  });

  const result = await api.handle('send', { threadId: 'thread-1', text: '你好' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.watch, {
    threadId: 'thread-1',
    turnId: 'turn-9',
    since: '2026-06-08T09:13:20.000Z',
  });
  assert.deepEqual(calls, [
    ['resume', 'thread-1'],
    ['start', 'thread-1', '你好'],
  ]);
  assert.deepEqual(progress.map(event => event.phase), [
    'send.received',
    'send.resume.started',
    'send.resume.completed',
    'send.turn.started',
    'send.turn.completed',
  ]);
  assert.equal(progress[0].textLength, 2);
});

test('desktop-agent API 在恢复线程失败时返回明确错误', async () => {
  const api = createDesktopAgentApi({
    appServer: createAppServer({
      resumeThread: async () => { throw new Error('thread not found'); },
    }),
  });

  await assert.rejects(
    () => api.handle('send', { threadId: 'thread-1', text: '你好' }),
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
    () => failure.handle('send', { threadId: 'thread-1', text: '你好' }),
    error => error.code === 'TURN_START_FAILED' && error.status === 502 && /request timeout/.test(error.message),
  );
  await assert.rejects(
    () => missingTurn.handle('send', { threadId: 'thread-1', text: '你好' }),
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

  const sending = api.handle('send', { threadId: 'thread-1', text: '正在发送' });
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
