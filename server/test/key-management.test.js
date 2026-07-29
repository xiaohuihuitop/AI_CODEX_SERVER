const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCloudRelayServer } = require('../src/cloud-relay');
const { createKeyStore } = require('../src/key-store');
const { closeRelayServer } = require('../test-utils/relay-server');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function json(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('Key 管理后台创建、禁用和持久化设备 Key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-key-store-'));
  const keyStore = createKeyStore(path.join(dir, 'keys.json'));
  const server = createCloudRelayServer({ keyStore, adminPassword: 'other-password' });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const adminPage = await fetch(`${origin}/admin`);
    assert.equal(adminPage.status, 200);
    assert.match(await adminPage.text(), /Codex Bridge Key 管理/);

    const unauthorized = await json(`${origin}/admin/api/keys`);
    assert.equal(unauthorized.response.status, 401);

    const login = await json(`${origin}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'xiaohuihui' }),
    });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get('set-cookie').split(';')[0];

    const created = await json(`${origin}/admin/api/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ note: '办公室电脑' }),
    });
    assert.equal(created.response.status, 201);
    assert.match(created.body.token, /^cdb_/);
    assert.equal(created.body.key.note, '办公室电脑');
    assert.equal(keyStore.has(created.body.token), true);
    const reloadedStore = createKeyStore(path.join(dir, 'keys.json'));
    assert.equal(reloadedStore.has(created.body.token), true);

    const health = await json(`${origin}/codex/health?token=${encodeURIComponent(created.body.token)}`);
    assert.equal(health.response.status, 200);

    const disabled = await json(`${origin}/admin/api/keys/${created.body.key.id}/disable`, {
      method: 'POST', headers: { cookie },
    });
    assert.equal(disabled.response.status, 200);
    const rejected = await json(`${origin}/codex/health?token=${encodeURIComponent(created.body.token)}`);
    assert.equal(rejected.response.status, 401);
  } finally {
    await closeRelayServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
