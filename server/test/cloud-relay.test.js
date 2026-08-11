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
  assert.match(html, /function applyRealtimeThreadEvent\(event\)/);
  assert.match(html, /data\.type === 'thread-event'/);
  assert.match(html, /data\.type === 'event-resync-required'/);
  assert.match(html, /payload\.type === 'turn\.started'/);
  assert.match(html, /payload\.type === 'turn\.completed'/);
  assert.match(html, /function reconcileRealtimeThreadState\(status\)/);
  assert.match(html, /confirmedControlTurnIds/);
  assert.match(html, /confirmedTurnIds\.includes\(pendingWatch\.turnId\)/);
  assert.doesNotMatch(html, /setInterval\(/);
});

test('云端手机网页端以 Agent 直接终态清除迟到的实时运行覆盖', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const source = html.match(/function reconcileRealtimeThreadState\(status\) \{([\s\S]*?)\n    \}/)?.[0] || '';
  const realtimeThreadStates = new Map([['threadA', {
    threadId: 'threadA',
    turnId: 'turn-running',
    status: 'running',
    active: true,
    observedAt: '2026-08-11T04:15:50.000Z',
  }]]);
  const renderedHistoryRows = [];
  const reconcile = new Function(
    'realtimeThreadStates',
    'renderedHistoryRows',
    `${source}\nreturn reconcileRealtimeThreadState;`,
  )(realtimeThreadStates, renderedHistoryRows);

  reconcile({
    threadId: 'threadA',
    active: false,
    status: 'complete',
    cached: false,
    completedAt: '2026-08-11T04:14:33.181Z',
    turns: [{ turnId: 'turn-terminal', status: 'complete' }],
  });
  assert.equal(realtimeThreadStates.has('threadA'), false);
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

test('云端 relay 转发 App Server 事件并去重且检测序号空洞', async () => {
  const server = createCloudRelayServer({
    tokens: ['event-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const mobile = new WebSocket(`ws://127.0.0.1:${port}/mobile?token=event-token`);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=event-token`);
  const received = [];
  mobile.on('message', data => received.push(JSON.parse(data.toString())));
  await Promise.all([
    new Promise(resolve => mobile.once('open', resolve)),
    new Promise(resolve => agent.once('open', resolve)),
  ]);

  const base = {
    streamId: 'stream-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    source: 'agent-app-server',
    observedAt: '2026-08-10T00:00:00.000Z',
    payload: { threadId: 'thread-1', turn: { id: 'turn-1' } },
  };
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: {
      openThreadIds: ['thread-1'],
      sessions: [{ threadId: 'thread-1', threadName: '事件线程', metadataOnly: true }],
    },
  }));
  agent.send(JSON.stringify({
    type: 'event-stream-state',
    payload: { streamId: 'stream-1', lastSeq: 0, deviceId: 'device-1', appServerState: 'ready' },
  }));
  agent.send(JSON.stringify({
    type: 'app-server-event',
    event: { ...base, seq: 1, eventId: 'stream-1:1', type: 'turn.started' },
  }));
  agent.send(JSON.stringify({
    type: 'app-server-event',
    event: { ...base, seq: 1, eventId: 'stream-1:1', type: 'turn.started' },
  }));
  agent.send(JSON.stringify({
    type: 'app-server-event',
    event: { ...base, seq: 3, eventId: 'stream-1:3', type: 'turn.completed' },
  }));
  await new Promise(resolve => setTimeout(resolve, 50));

  mobile.terminate();
  agent.terminate();
  await new Promise(resolve => setTimeout(resolve, 20));
  await closeRelayServer(server);

  const events = received.filter(item => item.type === 'thread-event');
  const resync = received.filter(item => item.type === 'event-resync-required');
  const streamStates = received.filter(item => item.type === 'event-stream-state');
  assert.deepEqual(events.map(item => item.event.seq), [1, 3]);
  assert.equal(streamStates.some(item => item.appServerState === 'ready' && item.eventStreamId === 'stream-1'), true);
  assert.equal(resync.some(item => item.threadId === 'thread-1' && item.reason === 'sequence-gap'), true);
  assert.equal(events.at(-1).appServerState, 'ready');
});

test('云端 relay 对空权威目录清理也返回同步确认', async () => {
  const server = createCloudRelayServer({
    tokens: ['empty-ack-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=empty-ack-token`);
  await new Promise(resolve => agent.once('open', resolve));

  try {
    const acknowledged = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('空权威目录同步未收到确认')), 300);
      agent.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'session-sync-ack') return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    agent.send(JSON.stringify({
      type: 'session-sync',
      payload: { openThreadIds: [], sessions: [] },
    }));
    const ack = await acknowledged;

    assert.equal(ack.sessionCount, 0);
    assert.equal(ack.appliedSessionCount, 0);
    assert.equal(ack.removedSessionCount, 0);
    assert.ok(ack.updatedAt);
  } finally {
    agent.close();
    await closeRelayServer(server);
  }
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
  let forwardedPayload = null;
  agent.on('message', data => {
    const message = JSON.parse(data.toString());
    if (!message.action) return;
    assert.equal(message.action, 'send');
    forwardedPayload = message.payload;
    agent.send(JSON.stringify({
      id: message.id,
      ok: true,
      result: { ok: true, watch: { threadId: 'thread-1', since: '2026-06-08T00:00:00.000Z' } },
    }));
  });

  await opened;
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: {
      openThreadIds: ['thread-1'],
      sessions: [{ threadId: 'thread-1', threadName: '发送线程', metadataOnly: true }],
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const res = await fetch(`http://127.0.0.1:${port}/send?token=send-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好', threadId: 'thread-1', clientUserMessageId: 'message-send-1' }),
  });
  const body = await readJson(res);

  agent.close();
  await closeRelayServer(server);

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.watch.threadId, 'thread-1');
  assert.deepEqual(forwardedPayload, {
    text: '你好',
    threadId: 'thread-1',
    clientUserMessageId: 'message-send-1',
  });

});

test('云端 relay 拒绝缺少客户端消息标识的发送请求', async () => {
  const server = createCloudRelayServer({
    tokens: ['send-id-required-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=send-id-required-token`);
  await new Promise(resolve => agent.once('open', resolve));
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: {
      openThreadIds: ['thread-1'],
      sessions: [{ threadId: 'thread-1', threadName: '发送线程', metadataOnly: true }],
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 20));

  const res = await fetch(`http://127.0.0.1:${port}/send?token=send-id-required-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好', threadId: 'thread-1' }),
  });
  const body = await readJson(res);

  agent.close();
  await closeRelayServer(server);

  assert.equal(res.status, 400);
  assert.equal(body.code, 'CLIENT_USER_MESSAGE_ID_REQUIRED');

});

test('云端 relay 在 Agent 断开时立即结束待转发请求', async () => {
  const server = createCloudRelayServer({
    tokens: ['disconnect-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=disconnect-token`);

  agent.on('message', data => {
    const message = JSON.parse(data.toString());
    if (!message.action) return;
    agent.close();
  });
  await new Promise(resolve => agent.once('open', resolve));
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: {
      openThreadIds: ['thread-1'],
      sessions: [{ threadId: 'thread-1', threadName: '断线线程', metadataOnly: true }],
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 20));

  const res = await fetch(`http://127.0.0.1:${port}/send?token=disconnect-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好', threadId: 'thread-1', clientUserMessageId: 'message-disconnect-1' }),
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
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: {
      openThreadIds: ['thread-1'],
      sessions: [{ threadId: 'thread-1', threadName: '历史线程', metadataOnly: true }],
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 20));
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
  agent.send(JSON.stringify({
    type: 'session-sync',
    payload: {
      openThreadIds: ['thread-1'],
      sessions: [{ threadId: 'thread-1', threadName: '状态线程', metadataOnly: true }],
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 20));
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

test('云端 relay 清理归档线程后拒绝历史状态和控制请求穿透到在线 Agent', async () => {
  const server = createCloudRelayServer({
    tokens: ['archived-route-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const forwardedActions = [];
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=archived-route-token`);
  await new Promise(resolve => agent.once('open', resolve));
  agent.on('message', data => {
    const message = JSON.parse(data.toString());
    if (!message.id || !message.action) return;
    forwardedActions.push(message.action);
    const result = message.action === 'history'
      ? { ok: true, available: true, threadId: 'thread-archived', messages: [{ role: 'user', text: '旧内容' }] }
      : message.action === 'status'
        ? { ok: true, available: true, threadId: 'thread-archived', active: false, status: 'complete', steps: [], turns: [] }
        : { ok: true, threadId: 'thread-archived', turnId: 'stale-turn' };
    agent.send(JSON.stringify({ id: message.id, ok: true, result }));
  });

  try {
    agent.send(JSON.stringify({
      type: 'session-sync',
      payload: {
        openThreadIds: ['thread-archived'],
        sessions: [{ threadId: 'thread-archived', threadName: '即将归档', metadataOnly: true }],
      },
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    agent.send(JSON.stringify({
      type: 'session-sync',
      payload: { openThreadIds: [], sessions: [] },
    }));
    await new Promise(resolve => setTimeout(resolve, 20));

    const historyRes = await fetch(`http://127.0.0.1:${port}/codex/history?token=archived-route-token&thread=thread-archived`);
    const statusRes = await fetch(`http://127.0.0.1:${port}/codex/status?token=archived-route-token&thread=thread-archived`);
    const sendRes = await fetch(`http://127.0.0.1:${port}/send?token=archived-route-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-archived', text: '不应发送' }),
    });
    const stopRes = await fetch(`http://127.0.0.1:${port}/codex/stop?token=archived-route-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-archived' }),
    });
    const [history, status, send, stop] = await Promise.all([
      readJson(historyRes), readJson(statusRes), readJson(sendRes), readJson(stopRes),
    ]);

    assert.equal(history.available, false);
    assert.equal(status.available, false);
    assert.equal(sendRes.status, 409);
    assert.equal(send.code, 'THREAD_NOT_OPEN');
    assert.equal(stopRes.status, 409);
    assert.equal(stop.code, 'THREAD_NOT_OPEN');
    assert.deepEqual(forwardedActions, []);
  } finally {
    agent.close();
    await closeRelayServer(server);
  }
});

test('云端 relay 只用目标回合证据确认手机发送而不接受无关同步版本', async () => {
  const server = createCloudRelayServer({
    tokens: ['control-confirm-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=control-confirm-token`);
  await new Promise(resolve => agent.once('open', resolve));
  agent.on('message', data => {
    const message = JSON.parse(data.toString());
    if (!message.action) return;
    if (message.action === 'send') {
      agent.send(JSON.stringify({
        id: message.id,
        ok: true,
        result: { ok: true, watch: { threadId: 'thread-1', turnId: 'turn-control-1', since: '2026-08-09T00:00:00.000Z' } },
      }));
      return;
    }
    if (message.action === 'status') {
      agent.send(JSON.stringify({
        id: message.id,
        ok: true,
        result: { ok: true, available: true, threadId: 'thread-1', active: false, status: 'complete', steps: [], turns: [] },
      }));
    }
  });

  try {
    agent.send(JSON.stringify({
      type: 'session-sync',
      payload: {
        openThreadIds: ['thread-1'],
        sessions: [{ threadId: 'thread-1', threadName: '控制确认线程', metadataOnly: true }],
      },
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const send = await readJson(await fetch(`http://127.0.0.1:${port}/send?token=control-confirm-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1', text: '开始测试', clientUserMessageId: 'message-control-1' }),
    }));

    agent.send(JSON.stringify({
      type: 'session-sync',
      payload: { openThreadIds: ['thread-1'], sessions: [] },
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const unrelated = await readJson(await fetch(`http://127.0.0.1:${port}/codex/status?token=control-confirm-token&thread=thread-1`));

    agent.send(JSON.stringify({
      type: 'session-sync',
      payload: {
        openThreadIds: ['thread-1'],
        sessions: [],
        confirmedControlTurnIds: ['turn-control-1'],
      },
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const confirmed = await readJson(await fetch(`http://127.0.0.1:${port}/codex/status?token=control-confirm-token&thread=thread-1`));

    assert.equal(send.watch.turnId, 'turn-control-1');
    assert.equal(unrelated.syncVersion > send.acceptedSyncVersion, true);
    assert.equal((unrelated.confirmedControlTurnIds || []).includes('turn-control-1'), false);
    assert.equal((confirmed.confirmedControlTurnIds || []).includes('turn-control-1'), true);
  } finally {
    agent.close();
    await closeRelayServer(server);
  }
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

test('云端缓存收到权威线程列表后物理删除已归档线程', () => {
  const cache = createCloudSessionCache();
  cache.applySync('archive-token', {
    openThreadIds: ['thread-keep', 'thread-archive'],
    sessions: [
      {
        threadId: 'thread-keep',
        threadName: '保留线程',
        snapshot: {
          messages: [{ role: 'user', text: '保留内容' }],
          status: { active: false, status: 'complete', preview: '保留内容', final: '', steps: [], turns: [] },
        },
      },
      {
        threadId: 'thread-archive',
        threadName: '归档线程',
        snapshot: {
          messages: [{ role: 'user', text: '必须删除的内容' }],
          status: { active: false, status: 'complete', preview: '必须删除的内容', final: '', steps: [], turns: [] },
        },
      },
    ],
  });

  cache.applySync('archive-token', {
    openThreadIds: ['thread-keep'],
    sessions: [{ threadId: 'thread-keep', threadName: '保留线程', metadataOnly: true }],
  });

  assert.deepEqual(cache.threads('archive-token').threads.map(thread => thread.id), ['thread-keep']);
  assert.equal(cache.history('archive-token', 'thread-archive').available, false);
  assert.equal(cache.status('archive-token', 'thread-archive').available, false);
  assert.equal(cache.bucket('archive-token').sessions.has('thread-archive'), false);
});

test('云端缓存区分空权威列表与不含目录字段的增量同步', () => {
  const cache = createCloudSessionCache();
  cache.applySync('empty-list-token', {
    openThreadIds: ['thread-1', 'thread-2'],
    sessions: [
      { threadId: 'thread-1', threadName: '线程 1', metadataOnly: true },
      { threadId: 'thread-2', threadName: '线程 2', metadataOnly: true },
    ],
  });

  cache.applySync('empty-list-token', {
    sessions: [{ threadId: 'thread-1', threadName: '线程 1 已更新', metadataOnly: true }],
  });
  assert.deepEqual(cache.threads('empty-list-token').threads.map(thread => thread.id), ['thread-1', 'thread-2']);
  assert.equal(cache.bucket('empty-list-token').sessions.size, 2);

  cache.applySync('empty-list-token', { openThreadIds: [], sessions: [] });
  assert.deepEqual(cache.threads('empty-list-token').threads, []);
  assert.equal(cache.bucket('empty-list-token').sessions.size, 0);
});

test('云端缓存清理后忽略已归档线程的迟到增量', () => {
  const cache = createCloudSessionCache();
  cache.applySync('late-increment-token', {
    openThreadIds: ['thread-archived'],
    sessions: [{ threadId: 'thread-archived', threadName: '归档前', metadataOnly: true }],
  });
  cache.applySync('late-increment-token', { openThreadIds: [], sessions: [] });
  cache.applySync('late-increment-token', {
    sessions: [{
      threadId: 'thread-archived',
      threadName: '不应复活',
      snapshot: {
        messages: [{ role: 'user', text: '迟到内容' }],
        status: { active: false, status: 'complete', preview: '迟到内容', final: '', steps: [], turns: [] },
      },
    }],
  });

  assert.equal(cache.bucket('late-increment-token').sessions.has('thread-archived'), false);
  assert.equal(cache.history('late-increment-token', 'thread-archived').available, false);
  assert.deepEqual(cache.threads('late-increment-token').threads, []);
});

test('云端缓存清理按 Key 隔离且重新打开线程后可重建缓存', () => {
  const cache = createCloudSessionCache();
  for (const token of ['computer-a', 'computer-b']) {
    cache.applySync(token, {
      openThreadIds: ['shared-thread-id'],
      sessions: [{
        threadId: 'shared-thread-id',
        threadName: token,
        snapshot: {
          messages: [{ role: 'user', text: token }],
          status: { active: false, status: 'complete', preview: token, final: '', steps: [], turns: [] },
        },
      }],
    });
  }

  cache.applySync('computer-a', { openThreadIds: [], sessions: [] });
  assert.equal(cache.history('computer-a', 'shared-thread-id').available, false);
  assert.equal(cache.history('computer-b', 'shared-thread-id').messages[0].text, 'computer-b');

  cache.applySync('computer-a', {
    openThreadIds: ['shared-thread-id'],
    sessions: [{
      threadId: 'shared-thread-id',
      threadName: '重新打开',
      snapshot: {
        messages: [{ role: 'user', text: '重新同步的新内容' }],
        status: { active: true, status: 'running', preview: '重新同步', final: '', steps: [], turns: [] },
      },
    }],
  });
  assert.deepEqual(cache.history('computer-a', 'shared-thread-id').messages.map(message => message.text), ['重新同步的新内容']);
  assert.equal(cache.status('computer-a', 'shared-thread-id').status, 'running');
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
  assert.deepEqual(newest.messages.map(row => row.text), ['消息 5', '消息 6', '消息 7', '消息 8', '消息 9', '消息 10', '消息 11', '消息 12']);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.nextBefore, 'turn:turn-3');
  assert.deepEqual(older.messages.map(row => row.text), ['消息 1', '消息 2', '消息 3', '消息 4']);
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

test('云端缓存增量收到 turn_aborted 后刷新普通状态和 since 状态', () => {
  const cache = createCloudSessionCache();
  const threadId = 'thread-aborted';
  const since = '2026-08-11T08:00:00.000Z';
  const startedLines = [
    JSON.stringify({ timestamp: '2026-08-11T08:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-aborted' } }),
    JSON.stringify({ timestamp: '2026-08-11T08:00:01.000Z', type: 'event_msg', payload: { type: 'agent_reasoning', text: '正在处理' } }),
  ];
  cache.applySync('abort-token', {
    openThreadIds: [threadId],
    sessions: [{ threadId, reset: true, lines: startedLines }],
  });
  assert.equal(cache.status('abort-token', threadId).status, 'running');
  assert.equal(cache.status('abort-token', threadId, since).status, 'running');

  cache.applySync('abort-token', {
    openThreadIds: [threadId],
    sessions: [{
      threadId,
      lines: [JSON.stringify({
        timestamp: '2026-08-11T08:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', reason: 'interrupted' },
      })],
    }],
  });

  for (const status of [cache.status('abort-token', threadId), cache.status('abort-token', threadId, since)]) {
    assert.equal(status.active, false);
    assert.equal(status.status, 'complete');
    assert.equal(status.turns[0].status, 'interrupted');
    assert.equal(status.turns[0].interruptionReason, '用户停止');
  }
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
