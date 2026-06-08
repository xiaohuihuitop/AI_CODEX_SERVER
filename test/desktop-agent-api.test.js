const assert = require('node:assert/strict');
const test = require('node:test');
const { createDesktopAgentApi } = require('../src/desktop-agent-api');

test('desktop-agent API 将 threads 动作映射到本机读取和状态解析', async () => {
  const controller = {
    listOpenThreads: async () => [{ projectName: 'demo', threadName: '线程' }],
  };
  const reader = {
    listOpenThreads: targets => ({
      ok: true,
      threads: targets.map((target, index) => ({ id: `thread-${index}`, name: target.threadName })),
    }),
  };
  const api = createDesktopAgentApi({ reader, controller });

  assert.deepEqual(await api.handle('threads', {}), {
    ok: true,
    threads: [{ id: 'thread-0', name: '线程' }],
  });
});

test('desktop-agent API 将 send 动作映射到本机发送', async () => {
  const calls = [];
  const controller = {
    sendToThread: async (target, text) => calls.push({ target, text }),
  };
  const reader = {
    getThreadTarget: threadId => ({
      available: true,
      threadId,
      projectName: 'demo',
      threadName: '线程',
    }),
  };
  const api = createDesktopAgentApi({ reader, controller, now: () => 1780910000000 });

  const result = await api.handle('send', { threadId: 'thread-1', text: '你好' });

  assert.equal(result.ok, true);
  assert.equal(result.watch.threadId, 'thread-1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    target: { available: true, threadId: 'thread-1', projectName: 'demo', threadName: '线程' },
    text: '你好',
  });
});

test('desktop-agent API 拒绝未知动作和空发送内容', async () => {
  const api = createDesktopAgentApi({ reader: {}, controller: {} });

  await assert.rejects(
    () => api.handle('unknown', {}),
    error => error.code === 'ACTION_NOT_ALLOWED' && error.status === 400,
  );
  await assert.rejects(
    () => api.handle('send', { threadId: 'thread-1', text: ' ' }),
    error => error.code === 'EMPTY_TEXT' && error.status === 400,
  );
});
