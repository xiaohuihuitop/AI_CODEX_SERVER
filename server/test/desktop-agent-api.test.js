const assert = require('node:assert/strict');
const test = require('node:test');
const { createDesktopAgentApi } = require('../../desktop/src/desktop-agent-api');

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
  const api = createDesktopAgentApi({ appServer: {} });

  await assert.rejects(
    () => api.handle('threads', {}),
    error => error.code === 'THREAD_CATALOG_UNAVAILABLE' && error.status === 503,
  );
});

test('desktop-agent API 恢复同一 threadId 后再发起回合', async () => {
  const calls = [];
  const progress = [];
  const appServer = {
    resumeThread: async threadId => calls.push(['resume', threadId]),
    startTurn: async (threadId, text) => {
      calls.push(['start', threadId, text]);
      return { turn: { id: 'turn-1' } };
    },
  };
  const api = createDesktopAgentApi({
    appServer,
    now: () => 1780910000000,
    onControlProgress: event => progress.push(event),
  });

  const result = await api.handle('send', { threadId: 'thread-1', text: '你好' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.watch, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    since: '2026-06-08T09:13:20.000Z',
  });
  assert.deepEqual(calls, [['resume', 'thread-1'], ['start', 'thread-1', '你好']]);
  assert.deepEqual(progress.map(event => event.phase), [
    'send.received',
    'send.resume.started',
    'send.resume.completed',
    'send.turn.started',
  ]);
  assert.equal(progress[0].textLength, 2);
  assert.equal(progress[3].turnId, 'turn-1');
});

test('desktop-agent API 恢复失败不会创建替代回合', async () => {
  const appServer = {
    resumeThread: async () => { throw new Error('thread missing'); },
    startTurn: async () => { throw new Error('不应调用'); },
  };
  const api = createDesktopAgentApi({ appServer });

  await assert.rejects(
    () => api.handle('send', { threadId: 'thread-1', text: '你好' }),
    error => error.code === 'THREAD_RESUME_FAILED' && error.status === 409,
  );
});

test('desktop-agent API 按指定线程停止 app-server 活动回合', async () => {
  const calls = [];
  const api = createDesktopAgentApi({
    appServer: { interruptTurn: async threadId => calls.push(threadId) },
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
  const api = createDesktopAgentApi({ appServer: {} });

  await assert.rejects(
    () => api.handle('unknown', {}),
    error => error.code === 'ACTION_NOT_ALLOWED' && error.status === 400,
  );
  await assert.rejects(
    () => api.handle('send', { threadId: 'thread-1', text: ' ' }),
    error => error.code === 'EMPTY_TEXT' && error.status === 400,
  );
});
