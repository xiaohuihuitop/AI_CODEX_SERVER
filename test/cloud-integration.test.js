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

test('云端 relay 和 desktop-agent 可以完成一次手机线程请求', async () => {
  const server = createCloudRelayServer({
    tokens: ['integration-token'],
    publicDir,
    requestTimeoutMs: 2000,
  });
  const port = await listen(server);
  const api = {
    handle: async action => {
      assert.equal(action, 'threads');
      return { ok: true, threads: [{ id: 'thread-1', name: '集成线程', projectName: 'demo' }] };
    },
  };
  const ws = createDesktopAgentClient({
    serverUrl: `http://127.0.0.1:${port}`,
    token: 'integration-token',
    api,
  });
  await openSocket(ws);

  const res = await fetch(`http://127.0.0.1:${port}/codex/threads?token=integration-token`);
  const body = JSON.parse(await res.text());

  assert.equal(res.status, 200);
  assert.deepEqual(body.threads, [{ id: 'thread-1', name: '集成线程', projectName: 'demo' }]);

  ws.close();
  await closeServer(server);
});
