const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');
const { agentUrlFromServerUrl, createDesktopAgentClient, handleAgentRequest } = require('../src/desktop-agent-client');

test('desktop-agent 将 HTTPS 云端地址转换为 WSS Agent 地址', () => {
  assert.equal(
    agentUrlFromServerUrl('https://codex.example.com', 'token-1'),
    'wss://codex.example.com/agent?token=token-1',
  );
  assert.equal(
    agentUrlFromServerUrl('http://127.0.0.1:8791/base/', 'token 2'),
    'ws://127.0.0.1:8791/base/agent?token=token+2',
  );
});

test('desktop-agent 只处理带 id 和 action 的请求', async () => {
  const api = {
    handle: async (action, payload) => ({ ok: true, action, payload }),
  };

  assert.deepEqual(
    await handleAgentRequest(api, { id: '1', action: 'threads', payload: { limit: 10 } }),
    { id: '1', ok: true, result: { ok: true, action: 'threads', payload: { limit: 10 } } },
  );

  assert.deepEqual(
    await handleAgentRequest(api, { action: 'threads' }),
    {
      id: '',
      ok: false,
      error: { code: 'INVALID_AGENT_REQUEST', message: 'Agent 请求格式不正确。', status: 400 },
    },
  );
});

test('desktop-agent 将本机 API 错误转换为协议错误', async () => {
  const api = {
    handle: async () => {
      const error = new Error('拒绝访问');
      error.code = 'DENIED';
      error.status = 403;
      throw error;
    },
  };

  assert.deepEqual(
    await handleAgentRequest(api, { id: '2', action: 'send', payload: {} }),
    {
      id: '2',
      ok: false,
      error: { code: 'DENIED', message: '拒绝访问', status: 403 },
    },
  );
});

test('desktop-agent 断线后自动重连', async () => {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.OPEN = 1;
      this.CLOSED = 3;
      this.sent = [];
      sockets.push(this);
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.readyState = this.CLOSED;
      this.emit('close', 1000, Buffer.from('client close'));
    }
  }

  const client = createDesktopAgentClient({
    serverUrl: 'http://127.0.0.1:8008',
    token: 'token-1',
    api: { handle: async action => ({ ok: true, action }) },
    WebSocket: FakeWebSocket,
    reconnectDelayMs: 0,
  });

  assert.equal(sockets.length, 1);
  sockets[0].emit('close', 1006, Buffer.from('server down'));
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, 'ws://127.0.0.1:8008/agent?token=token-1');
  client.close();
});
