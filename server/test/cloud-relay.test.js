const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');
const { createCloudRelayServer } = require('../src/cloud-relay');
const { createCloudSessionCache } = require('../src/session-cache');

const publicDir = path.join(__dirname, '..', 'public');

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function readJson(res) {
  return JSON.parse(await res.text());
}

test('云端 relay 手机线程请求读取服务器缓存', async () => {
  const server = createCloudRelayServer({
    tokens: ['test-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=test-token`);
  const opened = new Promise(resolve => agent.once('open', resolve));

  await opened;
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: {
      openThreadIds: ['thread-1'],
      sessions: [{
        threadId: 'thread-1',
        threadName: '远程线程',
        projectName: 'demo',
        reset: true,
        lines: [
          JSON.stringify({ timestamp: '2026-06-08T00:00:00.000Z', type: 'session_meta', payload: { cwd: 'C:\\demo' } }),
        ],
      }],
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const res = await fetch(`http://127.0.0.1:${port}/codex/threads?token=test-token`);
  const body = await readJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.cached, true);
  assert.equal(body.agentOnline, true);
  assert.deepEqual(body.threads.map(row => ({ id: row.id, name: row.name, projectName: row.projectName })), [
    { id: 'thread-1', name: '远程线程', projectName: 'demo' },
  ]);

  agent.close();
  await close(server);
});

test('云端 relay 没有缓存时线程列表返回空数组', async () => {
  const server = createCloudRelayServer({
    tokens: ['offline-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);

  const res = await fetch(`http://127.0.0.1:${port}/codex/threads?token=offline-token`);
  const body = await readJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.cached, true);
  assert.equal(body.agentOnline, false);
  assert.deepEqual(body.threads, []);

  await close(server);
});

test('云端 relay 允许不带 token 加载公开静态脚本', async () => {
  const server = createCloudRelayServer({
    tokens: ['asset-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);

  const script = await fetch(`http://127.0.0.1:${port}/markdown.js?v=1`);
  const scriptText = await script.text();
  const home = await fetch(`http://127.0.0.1:${port}/`);
  const api = await fetch(`http://127.0.0.1:${port}/codex/health`);

  assert.equal(script.status, 200);
  assert.match(scriptText, /CodexMarkdown/);
  assert.equal(home.status, 401);
  assert.equal(api.status, 401);

  await close(server);
});

test('云端 relay 拒绝错误 token 的 Agent 连接', async () => {
  const server = createCloudRelayServer({
    tokens: ['right-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=wrong-token`);

  const closeEvent = await new Promise(resolve => {
    agent.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  assert.equal(closeEvent.code, 1008);
  assert.equal(closeEvent.reason, 'UNAUTHORIZED');

  await close(server);
});

test('云端 relay 将手机发送请求转发给 Agent', async () => {
  const server = createCloudRelayServer({
    tokens: ['send-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=send-token`);
  const opened = new Promise(resolve => agent.once('open', resolve));
  agent.on('message', data => {
    const message = JSON.parse(data.toString());
    assert.equal(message.action, 'send');
    assert.deepEqual(message.payload, { text: '你好', threadId: 'thread-1' });
    agent.send(JSON.stringify({
      id: message.id,
      ok: true,
      result: { ok: true, watch: { threadId: 'thread-1', since: '2026-06-08T00:00:00.000Z' } },
    }));
  });

  await opened;
  const res = await fetch(`http://127.0.0.1:${port}/send?token=send-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好', threadId: 'thread-1' }),
  });
  const body = await readJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.watch.threadId, 'thread-1');

  agent.close();
  await close(server);
});

test('云端 relay 从服务器缓存返回历史和状态', async () => {
  const server = createCloudRelayServer({
    tokens: ['cache-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=cache-token`);
  await new Promise(resolve => agent.once('open', resolve));
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: {
      openThreadIds: ['thread-1'],
      sessions: [{
        threadId: 'thread-1',
        threadName: '缓存线程',
        projectName: 'demo',
        reset: true,
        lines: [
          JSON.stringify({ timestamp: '2026-06-08T00:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
          JSON.stringify({ timestamp: '2026-06-08T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '你好' } }),
          JSON.stringify({ timestamp: '2026-06-08T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '我在处理' } }),
          JSON.stringify({ timestamp: '2026-06-08T00:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ text: '完成' }] } }),
        ],
      }],
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 20));

  const historyRes = await fetch(`http://127.0.0.1:${port}/codex/history?token=cache-token&thread=thread-1`);
  const statusRes = await fetch(`http://127.0.0.1:${port}/codex/status?token=cache-token&thread=thread-1`);
  const history = await readJson(historyRes);
  const status = await readJson(statusRes);

  assert.equal(historyRes.status, 200);
  assert.equal(statusRes.status, 200);
  assert.equal(history.cached, true);
  assert.equal(history.agentOnline, true);
  assert.deepEqual(history.messages.map(row => ({ role: row.role, text: row.text })), [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '完成' },
  ]);
  assert.equal(status.cached, true);
  assert.equal(status.agentOnline, true);
  assert.equal(status.status, 'complete');
  assert.equal(status.turns[0].steps[0].text, '我在处理');

  agent.close();
  await close(server);
});

test('云端缓存支持渲染为用户消息、处理过程、最终回复顺序', () => {
  const cache = createCloudSessionCache();
  cache.applySync('order-token', {
    openThreadIds: ['thread-order'],
    sessions: [{
      threadId: 'thread-order',
      threadName: '顺序线程',
      projectName: 'demo',
      reset: true,
      lines: [
        JSON.stringify({ timestamp: '2026-06-08T00:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-order' } }),
        JSON.stringify({ timestamp: '2026-06-08T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '先显示用户消息' } }),
        JSON.stringify({ timestamp: '2026-06-08T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '中间显示处理过程' } }),
        JSON.stringify({ timestamp: '2026-06-08T00:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ text: '最后显示结果' }] } }),
      ],
    }],
  });

  const history = cache.history('order-token', 'thread-order');
  const status = cache.status('order-token', 'thread-order');
  const turnsById = {};
  for (const turn of status.turns) turnsById[turn.turnId] = turn;
  const timeline = [];
  for (const row of history.messages) {
    if (row.role === 'assistant' && row.turnId && turnsById[row.turnId]) timeline.push(`process:${turnsById[row.turnId].steps[0].text}`);
    timeline.push(`${row.role}:${row.text}`);
  }

  assert.deepEqual(timeline, [
    'user:先显示用户消息',
    'process:中间显示处理过程',
    'assistant:最后显示结果',
  ]);
});

test('云端会话缓存只在同步入站时解析常规历史和状态', () => {
  let parseCount = 0;
  const cache = createCloudSessionCache({
    parseSession: (lines, threadId, since = '') => {
      parseCount += 1;
      return {
        messages: [{ role: 'user', text: `${threadId}:${lines.length}` }],
        status: { active: false, status: since ? `idle:${since}` : 'idle', steps: [], turns: [] },
      };
    },
  });

  cache.applySync('token', {
    openThreadIds: ['thread-1'],
    sessions: [{ threadId: 'thread-1', threadName: '缓存线程', reset: true, lines: ['{}'] }],
  });
  assert.equal(parseCount, 1);

  cache.threads('token');
  cache.history('token', 'thread-1');
  cache.status('token', 'thread-1');
  assert.equal(parseCount, 1);

  assert.equal(cache.status('token', 'thread-1', '2026-06-08T00:00:00.000Z').status, 'idle:2026-06-08T00:00:00.000Z');
  assert.equal(cache.status('token', 'thread-1', '2026-06-08T00:00:00.000Z').status, 'idle:2026-06-08T00:00:00.000Z');
  assert.equal(parseCount, 2);

  cache.applySync('token', {
    openThreadIds: ['thread-1'],
    sessions: [{ threadId: 'thread-1', threadName: '缓存线程', reset: false, lines: ['{}'] }],
  });
  assert.equal(parseCount, 4);
});
