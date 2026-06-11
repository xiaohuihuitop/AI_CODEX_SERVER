const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createCloudRelayServer } = require('../server/src/cloud-relay');
const { createDesktopAgentClient } = require('../desktop-client/src/desktop-agent-client');

const publicDir = path.join(__dirname, '..', 'server', 'public');

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function openSocket(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

test('云端 relay 和 desktop-agent 通过服务器缓存完成手机线程请求', async () => {
  const server = createCloudRelayServer({
    tokens: ['integration-token'],
    publicDir,
    requestTimeoutMs: 2000,
  });
  const port = await listen(server);
  const ws = createDesktopAgentClient({
    serverUrl: `http://127.0.0.1:${port}`,
    token: 'integration-token',
    api: { handle: async () => ({ ok: true }) },
    syncProvider: async () => ({
      openThreadIds: ['thread-1'],
      sessions: [{
        threadId: 'thread-1',
        threadName: '集成线程',
        projectName: 'demo',
        reset: true,
        lines: [
          JSON.stringify({ timestamp: '2026-06-08T00:00:00.000Z', type: 'session_meta', payload: { cwd: 'C:\\demo' } }),
        ],
      }],
    }),
  });
  await openSocket(ws);
  await new Promise(resolve => setTimeout(resolve, 30));

  const res = await fetch(`http://127.0.0.1:${port}/codex/threads?token=integration-token`);
  const body = JSON.parse(await res.text());

  assert.equal(res.status, 200);
  assert.equal(body.cached, true);
  assert.deepEqual(body.threads.map(row => ({ id: row.id, name: row.name, projectName: row.projectName })), [
    { id: 'thread-1', name: '集成线程', projectName: 'demo' },
  ]);

  ws.close();
  await closeServer(server);
});
