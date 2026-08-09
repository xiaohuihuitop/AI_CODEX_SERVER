const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');
const { createCloudRelayServer } = require('../src/cloud-relay');
const { createCloudSessionCache } = require('../src/session-cache');
const { closeRelayServer } = require('../test-utils/relay-server');

const publicDir = path.join(__dirname, '..', 'public');

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function readJson(res) {
  return JSON.parse(await res.text());
}

test('云端手机网页端通过实时通道接收状态更新，不使用固定轮询', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  assert.match(html, /function openRealtimeSocket\(\)/);
  assert.match(html, /new WebSocket\(url\)/);
  assert.match(html, /\/mobile\?token=/);
  assert.match(html, /data\.type === 'session-updated'/);
  assert.doesNotMatch(html, /setInterval\(/);
});

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
  assert.equal(body.syncFresh, true);
  assert.equal(body.syncVersion, 1);
  assert.ok(body.lastSyncedAt);
  assert.deepEqual(body.threads.map(row => ({ id: row.id, name: row.name, projectName: row.projectName })), [
    { id: 'thread-1', name: '远程线程', projectName: 'demo' },
  ]);

  agent.close();
  await closeRelayServer(server);
});

test('云端 relay 向同 token 手机推送 Agent 状态和会话更新事件', async () => {
  const server = createCloudRelayServer({
    tokens: ['realtime-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const events = [];
  const mobile = new WebSocket(`ws://127.0.0.1:${port}/mobile`, {
    headers: { 'x-mobile-typer-token': 'realtime-token' },
  });
  mobile.on('message', data => events.push(JSON.parse(data.toString())));
  await new Promise(resolve => mobile.once('open', resolve));
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=realtime-token`);
  await new Promise(resolve => agent.once('open', resolve));
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: { openThreadIds: [], sessions: [] },
  }));
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(events.some(event => event.type === 'relay-ready'), true);
  assert.equal(events.some(event => event.type === 'agent-status' && event.online === true), true);
  assert.equal(events.some(event => event.type === 'session-updated' && event.agentOnline === true), true);

  agent.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.some(event => event.type === 'agent-status' && event.online === false), true);

  mobile.close();
  await closeRelayServer(server);
});

test('云端 relay 在 Agent 未继续同步时标记状态过期并冻结版本', async () => {
  const server = createCloudRelayServer({
    tokens: ['stale-token'],
    publicDir,
    requestTimeoutMs: 1500,
    syncStaleMs: 1000,
  });
  const port = await listen(server);
  const events = [];
  const mobile = new WebSocket(`ws://127.0.0.1:${port}/mobile?token=stale-token`);
  mobile.on('message', data => events.push(JSON.parse(data.toString())));
  await new Promise(resolve => mobile.once('open', resolve));
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=stale-token`);
  await new Promise(resolve => agent.once('open', resolve));
  agent.send(JSON.stringify({ type: 'session-sync', payload: { openThreadIds: [], sessions: [] } }));
  await new Promise(resolve => setTimeout(resolve, 1100));

  const staleEvent = events.find(event => event.type === 'sync-status');
  assert.ok(staleEvent);
  assert.equal(staleEvent.syncFresh, false);
  assert.equal(staleEvent.syncVersion, 1);
  const health = await readJson(await fetch(`http://127.0.0.1:${port}/codex/health?token=stale-token`));
  assert.equal(health.syncFresh, false);
  assert.equal(health.syncVersion, 1);

  agent.close();
  mobile.close();
  await closeRelayServer(server);
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

  await closeRelayServer(server);
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

  await closeRelayServer(server);
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

  await closeRelayServer(server);
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
  await closeRelayServer(server);
});

test('云端 relay 在 Agent 断开时立即结束待转发请求', async () => {
  const server = createCloudRelayServer({
    tokens: ['disconnect-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=disconnect-token`);

  agent.on('message', () => {
    agent.close();
  });
  await new Promise(resolve => agent.once('open', resolve));

  const res = await fetch(`http://127.0.0.1:${port}/send?token=disconnect-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好', threadId: 'thread-1' }),
  });
  const body = await readJson(res);

  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'AGENT_DISCONNECTED');

  await closeRelayServer(server);
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

  const agentClosed = new Promise(resolve => agent.once('close', resolve));
  agent.close();
  await agentClosed;

  const historyRes = await fetch(`http://127.0.0.1:${port}/codex/history?token=cache-token&thread=thread-1`);
  const statusRes = await fetch(`http://127.0.0.1:${port}/codex/status?token=cache-token&thread=thread-1`);
  const history = await readJson(historyRes);
  const status = await readJson(statusRes);

  assert.equal(historyRes.status, 200);
  assert.equal(statusRes.status, 200);
  assert.equal(history.cached, true);
  assert.equal(history.agentOnline, false);
  assert.deepEqual(history.messages.map(row => ({ role: row.role, text: row.text })), [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '完成' },
  ]);
  assert.equal(status.cached, true);
  assert.equal(status.agentOnline, false);
  assert.equal(status.status, 'complete');
  assert.equal(status.turns[0].steps[0].text, '我在处理');

  agent.close();
  await closeRelayServer(server);
});

test('云端 relay 在 Agent 在线时直接读取本机历史页，避免截断缓存遗漏消息', async () => {
  const server = createCloudRelayServer({
    tokens: ['history-direct-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=history-direct-token`);
  await new Promise(resolve => agent.once('open', resolve));
  agent.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.action !== 'history') return;
    assert.deepEqual(message.payload, { threadId: 'thread-1', limit: '10', before: '20' });
    agent.send(JSON.stringify({
      id: message.id,
      ok: true,
      result: {
        ok: true,
        available: true,
        threadId: 'thread-1',
        sessionFile: 'thread-1.jsonl',
        messages: [{ role: 'user', text: '来自本机的更早消息', turnId: 'turn-1' }],
        hasMore: true,
        nextBefore: '10',
      },
    }));
  });

  const res = await fetch(`http://127.0.0.1:${port}/codex/history?token=history-direct-token&thread=thread-1&limit=10&before=20`);
  const body = await readJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.cached, false);
  assert.equal(body.available, true);
  assert.deepEqual(body.messages.map(item => item.text), ['来自本机的更早消息']);
  assert.equal(body.nextBefore, '10');

  await closeRelayServer(server);
});

test('云端 relay 在 Agent 在线时直接读取本机状态，避免快照缓存返回旧完成态', async () => {
  const server = createCloudRelayServer({
    tokens: ['status-direct-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=status-direct-token`);
  await new Promise(resolve => agent.once('open', resolve));
  agent.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.action !== 'status') return;
    assert.deepEqual(message.payload, { threadId: 'thread-1', since: '2026-08-05T00:00:00.000Z' });
    agent.send(JSON.stringify({
      id: message.id,
      ok: true,
      result: {
        ok: true,
        available: true,
        threadId: 'thread-1',
        sessionFile: 'thread-1.jsonl',
        active: true,
        status: 'running',
        preview: '正在处理',
        final: '',
        steps: [{ kind: 'reasoning', text: '本机正在处理' }],
        turns: [{ turnId: 'turn-2', status: 'running', steps: [] }],
      },
    }));
  });

  const res = await fetch(`http://127.0.0.1:${port}/codex/status?token=status-direct-token&thread=thread-1&since=2026-08-05T00%3A00%3A00.000Z`);
  const body = await readJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.cached, false);
  assert.equal(body.agentOnline, true);
  assert.equal(body.status, 'running');
  assert.equal(body.active, true);
  assert.equal(body.steps[0].text, '本机正在处理');

  agent.close();
  await closeRelayServer(server);
});

test('云端缓存保留只含元数据的打开线程', () => {
  const cache = createCloudSessionCache();
  cache.applySync('metadata-token', {
    openThreadIds: ['thread-meta'],
    sessions: [{
      threadId: 'thread-meta',
      threadName: '待回填线程',
      projectName: 'demo',
      sessionFile: 'rollout-thread-meta.jsonl',
      metadataOnly: true,
    }],
  });

  const threads = cache.threads('metadata-token');
  assert.deepEqual(threads.threads.map(thread => ({ id: thread.id, name: thread.name, projectName: thread.projectName })), [{
    id: 'thread-meta',
    name: '待回填线程',
    projectName: 'demo',
  }]);
  assert.equal(cache.history('metadata-token', 'thread-meta').available, true);
});

test('云端缓存保存紧凑快照并按页面返回历史', () => {
  const cache = createCloudSessionCache();
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `消息 ${index + 1}`,
    turnId: `turn-${Math.floor(index / 2) + 1}`,
  }));
  cache.applySync('snapshot-token', {
    openThreadIds: ['thread-snapshot'],
    sessions: [{
      threadId: 'thread-snapshot',
      threadName: '快照线程',
      snapshot: {
        messages,
        status: { active: false, status: 'complete', preview: '已完成', final: '消息 12', steps: [], turns: [] },
      },
    }],
  });

  const newest = cache.history('snapshot-token', 'thread-snapshot', 4);
  const older = cache.history('snapshot-token', 'thread-snapshot', 4, newest.nextBefore);
  assert.deepEqual(newest.messages.map(row => row.text), ['消息 9', '消息 10', '消息 11', '消息 12']);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.nextBefore, '8');
  assert.deepEqual(older.messages.map(row => row.text), ['消息 5', '消息 6', '消息 7', '消息 8']);
  assert.equal(cache.status('snapshot-token', 'thread-snapshot').status, 'complete');
  assert.equal(cache.status('snapshot-token', 'thread-snapshot', '2026-07-29T12:00:00.000Z').status, 'complete');
});

test('云端缓存接收较短的新快照时保留已缓存的更早历史', () => {
  const cache = createCloudSessionCache();
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `消息 ${index + 1}`,
    timestamp: `2026-08-05T00:00:0${index}.000Z`,
    turnId: `turn-${Math.floor(index / 2) + 1}`,
  }));
  cache.applySync('merge-snapshot-token', {
    openThreadIds: ['thread-snapshot'],
    sessions: [{
      threadId: 'thread-snapshot',
      threadName: '完整快照线程',
      snapshot: {
        messages,
        status: { active: false, status: 'complete', preview: '完成', final: '消息 8', steps: [], turns: [] },
      },
    }],
  });
  cache.applySync('merge-snapshot-token', {
    openThreadIds: ['thread-snapshot'],
    sessions: [{
      threadId: 'thread-snapshot',
      threadName: '完整快照线程',
      snapshot: {
        messages: messages.slice(-3).concat([{
          role: 'user',
          text: '消息 9',
          timestamp: '2026-08-05T00:00:09.000Z',
          turnId: 'turn-5',
        }]),
        status: { active: true, status: 'running', preview: '处理中', final: '', steps: [], turns: [] },
      },
    }],
  });

  const history = cache.history('merge-snapshot-token', 'thread-snapshot', 20);
  assert.deepEqual(history.messages.map(item => item.text), [
    '消息 1', '消息 2', '消息 3', '消息 4', '消息 5', '消息 6', '消息 7', '消息 8', '消息 9',
  ]);
  assert.equal(cache.status('merge-snapshot-token', 'thread-snapshot').status, 'running');
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
    timeline.push(`${row.role}:${row.text}`);
    if (row.role === 'user' && row.turnId && turnsById[row.turnId]) timeline.push(`process:${turnsById[row.turnId].steps[0].text}`);
  }

  assert.deepEqual(timeline, [
    'user:先显示用户消息',
    'process:中间显示处理过程',
    'assistant:最后显示结果',
  ]);
});

test('云端缓存对同一轮最终回复双记录只保留一个步骤', () => {
  const cache = createCloudSessionCache();
  cache.applySync('final-dedup-token', {
    openThreadIds: ['thread-final-dedup'],
    sessions: [{
      threadId: 'thread-final-dedup',
      threadName: '最终回复去重线程',
      projectName: 'demo',
      reset: true,
      lines: [
        JSON.stringify({ timestamp: '2026-08-05T02:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: '测试最终回复去重' } }),
        JSON.stringify({ timestamp: '2026-08-05T02:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-final-dedup' } }),
        JSON.stringify({ timestamp: '2026-08-05T02:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: '最终回复' } }),
        JSON.stringify({ timestamp: '2026-08-05T02:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ text: '最终回复' }] } }),
        JSON.stringify({ timestamp: '2026-08-05T02:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-final-dedup', last_agent_message: '最终回复' } }),
      ],
    }],
  });

  const status = cache.status('final-dedup-token', 'thread-final-dedup');
  const finalSteps = status.turns[0].steps.filter(item => item.kind === 'final');
  assert.equal(finalSteps.length, 1);
  assert.equal(finalSteps[0].text, '最终回复');
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
