const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  CodexAppServerClient,
  findDesktopCodexExecutable,
  resolveAppServerLaunch,
} = require('../../desktop/src/codex-app-server-client');

function createChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', 0, null);
  };
  return child;
}

function respond(child, id, result) {
  child.stdout.write(`${JSON.stringify({ id: String(id), result })}\n`);
}

function createTestClient(child, options = {}) {
  return new CodexAppServerClient({
    spawnProcess: () => child,
    launchResolver: () => ({ command: 'codex-test.exe', args: ['app-server'], source: 'test' }),
    ...options,
  });
}

test('Windows 优先选择最新 Codex Desktop 内置程序', () => {
  const localAppData = 'C:\\Users\\tester\\AppData\\Local';
  const root = 'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin';
  const filesystem = {
    readdirSync: directory => {
      assert.equal(directory, root);
      return [
        { name: 'old', isDirectory: () => true },
        { name: 'current', isDirectory: () => true },
      ];
    },
    statSync: file => ({
      isFile: () => true,
      mtimeMs: file.includes('current') ? 20 : 10,
    }),
  };

  const executable = findDesktopCodexExecutable({ localAppData, filesystem });
  assert.equal(executable, `${root}\\current\\codex.exe`);
  assert.deepEqual(resolveAppServerLaunch({ platform: 'win32', localAppData, filesystem }), {
    command: executable,
    args: ['app-server'],
    source: 'desktop',
  });
});

test('Windows 找不到 Codex Desktop 内置程序时明确失败', () => {
  const filesystem = {
    readdirSync: () => [],
    statSync: () => ({ isFile: () => false, mtimeMs: 0 }),
  };
  assert.throws(
    () => resolveAppServerLaunch({ platform: 'win32', localAppData: 'C:\\missing', filesystem }),
    error => error.code === 'APP_SERVER_EXECUTABLE_NOT_FOUND',
  );
});

test('app-server 客户端初始化后按未归档更新时间读取线程', async () => {
  const child = createChild();
  const writes = [];
  child.stdin.on('data', data => {
    const message = JSON.parse(String(data));
    writes.push(message);
    if (message.method === 'initialize') respond(child, message.id, { userAgent: 'test' });
    if (message.method === 'thread/list') respond(child, message.id, {
      data: [{ id: 'thread-1', name: '线程', status: { type: 'idle' } }],
      nextCursor: 'next',
    });
  });
  const client = createTestClient(child);

  const result = await client.listThreads();

  assert.equal(writes[0].method, 'initialize');
  assert.deepEqual(writes[1], {
    id: '2',
    method: 'thread/list',
    params: { archived: false, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', cursor: null },
  });
  assert.equal(result.threads[0].id, 'thread-1');
  assert.equal(result.nextCursor, 'next');
  assert.equal(client.getThreadRuntime('thread-1').state, 'idle');
  client.stop();
});

test('app-server 客户端按同一 threadId 恢复、发起和中断回合', async () => {
  const child = createChild();
  const writes = [];
  child.stdin.on('data', data => {
    const message = JSON.parse(String(data));
    writes.push(message);
    if (message.method === 'initialize') respond(child, message.id, {});
    if (message.method === 'thread/resume') respond(child, message.id, { thread: { id: 'thread-1' } });
    if (message.method === 'turn/start') respond(child, message.id, { turn: { id: 'turn-1' } });
    if (message.method === 'turn/interrupt') respond(child, message.id, {});
  });
  const client = createTestClient(child);

  await client.resumeThread('thread-1');
  await client.startTurn('thread-1', '来自手机的消息');
  await client.interruptTurn('thread-1');

  assert.deepEqual(writes.slice(1), [
    { id: '2', method: 'thread/resume', params: { threadId: 'thread-1', excludeTurns: true } },
    { id: '3', method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: '来自手机的消息' }] } },
    { id: '4', method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } },
  ]);
  client.stop();
});

test('app-server 通知统一更新线程运行状态', async () => {
  const client = new CodexAppServerClient();
  const updates = [];
  client.on('runtime', update => updates.push(update));

  client.applyNotification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
  client.applyNotification('thread/status/changed', { threadId: 'thread-1', status: { type: 'active' } });
  client.applyNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });

  assert.equal(updates.length, 3);
  assert.deepEqual(client.getThreadRuntime('thread-1').state, 'idle');
  assert.equal(client.getThreadRuntime('thread-1').turnId, 'turn-1');
  assert.equal(client.getThreadRuntime('unseen-thread').state, 'unknown');
});

test('app-server 请求超时和异常退出会清理待处理请求', async () => {
  const child = createChild();
  child.stdin.on('data', data => {
    const message = JSON.parse(String(data));
    if (message.method === 'initialize') respond(child, message.id, {});
  });
  const client = createTestClient(child, { requestTimeoutMs: 20 });
  await client.start();
  await assert.rejects(() => client.request('thread/list', {}), error => error.code === 'APP_SERVER_TIMEOUT');
  const pending = client.request('thread/read', {});
  child.emit('close', 1, null);
  await assert.rejects(() => pending, error => error.code === 'APP_SERVER_EXITED');
  assert.equal(client.pending.size, 0);
});
