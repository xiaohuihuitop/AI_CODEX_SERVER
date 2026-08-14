const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { CodexCdpClient } = require('../../desktop/src/codex-cdp-client');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }
}

test('CDP 客户端复用单一 WebSocket 并按请求 ID 关联响应', async () => {
  const socket = new FakeSocket();
  const client = new CodexCdpClient({
    debugPort: 9230,
    fetchImpl: async url => {
      assert.equal(url, 'http://127.0.0.1:9230/json/list');
      return { ok: true, json: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://target' }] };
    },
    webSocketFactory: url => {
      assert.equal(url, 'ws://target');
      queueMicrotask(() => socket.open());
      return socket;
    },
  });

  await client.connect();
  const first = client.request('Runtime.evaluate', { expression: '1 + 1' });
  const second = client.request('Page.bringToFront');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.sent.length, 2);
  socket.emit('message', Buffer.from(JSON.stringify({ id: socket.sent[1].id, result: { ok: 'second' } })));
  socket.emit('message', Buffer.from(JSON.stringify({ id: socket.sent[0].id, result: { result: { value: 2 } } })));

  assert.deepEqual(await first, { result: { value: 2 } });
  assert.deepEqual(await second, { ok: 'second' });
  assert.equal(client.isConnected(), true);
  client.close();
});

test('CDP 客户端将协议错误和断线传递给等待请求', async () => {
  const socket = new FakeSocket();
  const client = new CodexCdpClient({
    fetchImpl: async () => ({ ok: true, json: async () => [{ url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://target' }] }),
    webSocketFactory: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  await client.connect();
  const failed = client.request('Runtime.evaluate', { expression: 'throw 1' });
  await new Promise(resolve => setImmediate(resolve));
  socket.emit('message', Buffer.from(JSON.stringify({ id: socket.sent[0].id, error: { message: 'boom' } })));
  await assert.rejects(() => failed, error => error.code === 'CDP_PROTOCOL_ERROR' && /boom/.test(error.message));

  const disconnected = client.request('Runtime.evaluate', { expression: '2 + 2' });
  await new Promise(resolve => setImmediate(resolve));
  socket.readyState = 3;
  socket.emit('close', 1006, Buffer.from('lost'));
  await assert.rejects(() => disconnected, error => error.code === 'CDP_DISCONNECTED');
});

test('CDP evaluate 返回页面表达式的按值结果', async () => {
  const socket = new FakeSocket();
  const client = new CodexCdpClient({
    fetchImpl: async () => ({ ok: true, json: async () => [{ url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://target' }] }),
    webSocketFactory: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  await client.connect();
  const evaluated = client.evaluate('document.title');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.sent[0], {
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: 'document.title', awaitPromise: true, returnByValue: true },
  });
  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, result: { result: { value: 'Codex' } } })));
  assert.equal(await evaluated, 'Codex');
  client.close();
});

test('CDP 请求超时会废弃半开连接并拒绝全部等待请求', async () => {
  const socket = new FakeSocket();
  const client = new CodexCdpClient({
    requestTimeoutMs: 20,
    fetchImpl: async () => ({ ok: true, json: async () => [{ url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://target' }] }),
    webSocketFactory: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const disconnected = new Promise(resolve => client.once('disconnected', resolve));

  await client.connect();
  const timedOut = client.request('Runtime.evaluate', { expression: '1 + 1' });
  const pending = client.request('Page.bringToFront');

  await assert.rejects(() => timedOut, error => error.code === 'CDP_TIMEOUT');
  await assert.rejects(() => pending, error => error.code === 'CDP_TIMEOUT');
  assert.equal((await disconnected).code, 'CDP_TIMEOUT');
  assert.equal(client.isConnected(), false);
  assert.equal(client.pending.size, 0);
  assert.equal(socket.readyState, 3);
});
