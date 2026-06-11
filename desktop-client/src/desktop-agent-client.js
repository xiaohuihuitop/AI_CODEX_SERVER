const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');

function agentUrlFromServerUrl(serverUrl, token) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}/agent`;
  url.search = '';
  url.searchParams.set('token', token);
  return url.toString();
}

async function handleAgentRequest(api, message) {
  if (!message || typeof message.id !== 'string' || typeof message.action !== 'string') {
    return {
      id: typeof message?.id === 'string' ? message.id : '',
      ok: false,
      error: { code: 'INVALID_AGENT_REQUEST', message: 'Agent 请求格式不正确。', status: 400 },
    };
  }
  try {
    return {
      id: message.id,
      ok: true,
      result: await api.handle(message.action, message.payload || {}),
    };
  } catch (error) {
    return {
      id: message.id,
      ok: false,
      error: {
        code: error.code || 'AGENT_HANDLER_FAILED',
        message: error.message || 'Agent 执行失败。',
        status: error.status || 500,
      },
    };
  }
}

function createDesktopAgentClient(options) {
  const url = agentUrlFromServerUrl(options.serverUrl, options.token);
  const api = options.api;
  const WebSocketClass = options.WebSocket || WebSocket;
  const reconnectDelayMs = Number.isFinite(Number(options.reconnectDelayMs)) ? Math.max(0, Number(options.reconnectDelayMs)) : 2000;
  const client = new EventEmitter();
  const syncProvider = typeof options.syncProvider === 'function' ? options.syncProvider : null;
  const syncIntervalMs = Number.isFinite(Number(options.syncIntervalMs)) ? Math.max(1000, Number(options.syncIntervalMs)) : 2000;
  let socket = null;
  let reconnectTimer = null;
  let syncTimer = null;
  let syncing = false;
  let stopped = false;

  async function syncSessions() {
    if (!syncProvider || syncing || stopped || !socket || socket.readyState !== socket.OPEN) return;
    syncing = true;
    try {
      const payload = await syncProvider();
      if (payload && socket && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'session-sync', payload }));
      }
    } catch (error) {
      if (client.listenerCount('sync-error') > 0) client.emit('sync-error', error);
    } finally {
      syncing = false;
    }
  }

  function startSyncTimer() {
    if (!syncProvider || syncTimer) return;
    syncSessions();
    syncTimer = setInterval(syncSessions, syncIntervalMs);
  }

  function stopSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function connect() {
    if (stopped) return;
    socket = new WebSocketClass(url);
    client.socket = socket;
    socket.on('open', () => {
      client.emit('open');
      startSyncTimer();
    });
    socket.on('message', async data => {
      let message = null;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const response = await handleAgentRequest(api, message);
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(response));
    });
    socket.on('close', (code, reason) => {
      client.emit('close', code, reason);
      stopSyncTimer();
      scheduleReconnect();
    });
    socket.on('error', error => {
      if (client.listenerCount('error') > 0) client.emit('error', error);
    });
  }

  client.close = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopSyncTimer();
    const closedState = typeof socket?.CLOSED === 'number' ? socket.CLOSED : 3;
    if (socket && socket.readyState !== closedState) socket.close();
  };

  connect();
  return client;
}

module.exports = {
  agentUrlFromServerUrl,
  createDesktopAgentClient,
  handleAgentRequest,
};
