const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');
const { createCloudRelayServer } = require('../src/cloud-relay');

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

test('云端 relay 将手机线程请求转发给同 token 的电脑 Agent', async () => {
  const server = createCloudRelayServer({
    tokens: ['test-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=test-token`);
  const opened = new Promise(resolve => agent.once('open', resolve));
  agent.on('message', data => {
    const message = JSON.parse(data.toString());
    assert.equal(message.action, 'threads');
    agent.send(JSON.stringify({
      id: message.id,
      ok: true,
      result: {
        ok: true,
        threads: [{ id: 'thread-1', name: '远程线程', projectName: 'demo' }],
      },
    }));
  });

  await opened;
  const res = await fetch(`http://127.0.0.1:${port}/codex/threads?token=test-token`);
  const body = await readJson(res);

  assert.equal(res.status, 200);
  assert.deepEqual(body.threads, [{ id: 'thread-1', name: '远程线程', projectName: 'demo' }]);

  agent.close();
  await close(server);
});

test('云端 relay 没有在线 Agent 时返回 503', async () => {
  const server = createCloudRelayServer({
    tokens: ['offline-token'],
    publicDir,
    requestTimeoutMs: 1500,
  });
  const port = await listen(server);

  const res = await fetch(`http://127.0.0.1:${port}/codex/threads?token=offline-token`);
  const body = await readJson(res);

  assert.equal(res.status, 503);
  assert.equal(body.code, 'AGENT_OFFLINE');

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
