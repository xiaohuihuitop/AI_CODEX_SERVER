const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { readBody, sendJson, sendOptions, serveStatic } = require('./http-utils');
const { createCloudSessionCache } = require('./session-cache');

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SYNC_STALE_MS = 10000;
const ALLOWED_ACTIONS = new Set(['threads', 'history', 'status', 'send', 'stop']);
const PUBLIC_ASSET_EXTENSIONS = new Set(['.css', '.ico', '.js', '.json', '.png', '.svg', '.webmanifest']);

function tokenFromRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return url.searchParams.get('token') || req.headers['x-mobile-typer-token'] || '';
}

function createRelayState() {
  return {
    agents: new Map(),
    mobileClients: new Map(),
    syncHealth: new Map(),
    cache: createCloudSessionCache(),
    pending: new Map(),
    nextId: 0,
  };
}

function syncHealthFor(state, token) {
  if (!state.syncHealth.has(token)) {
    state.syncHealth.set(token, { version: 0, lastSyncedAt: '', stale: true, timer: null });
  }
  return state.syncHealth.get(token);
}

function relayStateForToken(state, token) {
  const health = syncHealthFor(state, token);
  return {
    agentOnline: isAgentOnline(state, token),
    syncVersion: health.version,
    lastSyncedAt: health.lastSyncedAt,
    syncFresh: Boolean(isAgentOnline(state, token) && !health.stale && health.lastSyncedAt),
  };
}

function markSessionSynced(state, token, staleMs) {
  const health = syncHealthFor(state, token);
  health.version += 1;
  health.lastSyncedAt = new Date().toISOString();
  health.stale = false;
  if (health.timer) clearTimeout(health.timer);
  const version = health.version;
  health.timer = setTimeout(() => {
    if (health.version !== version || health.stale) return;
    health.stale = true;
    broadcastToMobileClients(state, token, Object.assign({ type: 'sync-status' }, relayStateForToken(state, token)));
  }, staleMs);
  return relayStateForToken(state, token);
}

/**
 * AI:向同一设备 token 的手机实时客户端广播状态事件。
 *
 * @param {object} state Relay 运行状态。
 * @param {string} token 设备 token。
 * @param {object} event 事件内容。
 * @returns {void}
 */
function broadcastToMobileClients(state, token, event) {
  const clients = state.mobileClients.get(token);
  if (!clients) return;
  const body = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(body);
  }
}

/**
 * AI:建立手机实时订阅，连接只接收状态通知，不承载控制命令。
 *
 * @param {object} state Relay 运行状态。
 * @param {object} ws WebSocket 连接。
 * @param {string} token 设备 token。
 * @returns {void}
 */
function attachMobileClient(state, ws, token) {
  if (!state.mobileClients.has(token)) state.mobileClients.set(token, new Set());
  const clients = state.mobileClients.get(token);
  clients.add(ws);
  ws.on('close', () => {
    clients.delete(ws);
    if (!clients.size) state.mobileClients.delete(token);
  });
  ws.send(JSON.stringify({
    type: 'relay-ready',
    ...relayStateForToken(state, token),
    updatedAt: state.cache.threads(token).updatedAt,
  }));
}

function isAgentOnline(state, token) {
  const ws = state.agents.get(token);
  return Boolean(ws && ws.readyState === ws.OPEN);
}

function rejectAgent(ws, code, reason) {
  ws.close(code, reason);
}

/**
 * AI:Agent 断开时结束同 token 的待转发请求，避免手机端等到超时。
 *
 * @param {object} state Relay 运行状态。
 * @param {string} token 设备 token。
 * @returns {void}
 */
function rejectPendingForToken(state, token) {
  for (const [id, pending] of state.pending.entries()) {
    if (!pending || pending.token !== token) continue;
    clearTimeout(pending.timer);
    state.pending.delete(id);
    pending.reject(Object.assign(new Error('电脑 Agent 连接已断开。'), {
      status: 503,
      code: 'AGENT_DISCONNECTED',
    }));
  }
}

function attachAgent(state, ws, token, syncStaleMs) {
  if (isAgentOnline(state, token)) {
    rejectAgent(ws, 1008, 'TOKEN_ALREADY_ONLINE');
    return;
  }
  state.agents.set(token, ws);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  const heartbeat = setInterval(() => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  }, 15000);
  broadcastToMobileClients(state, token, Object.assign({ type: 'agent-status', online: true }, relayStateForToken(state, token)));
  ws.on('message', data => {
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.type === 'session-sync') {
      const result = state.cache.applySync(token, message.payload || {});
      const syncState = markSessionSynced(state, token, syncStaleMs);
      broadcastToMobileClients(state, token, Object.assign({
        type: 'session-updated',
        updatedAt: result.updatedAt,
      }, syncState));
      return;
    }
    const pending = state.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error?.message || 'Agent 请求失败。'), {
      status: message.error?.status || 500,
      code: message.error?.code || 'AGENT_REQUEST_FAILED',
    }));
  });
  ws.on('close', () => {
    clearInterval(heartbeat);
    if (state.agents.get(token) === ws) {
      state.agents.delete(token);
      rejectPendingForToken(state, token);
      const health = syncHealthFor(state, token);
      if (health.timer) clearTimeout(health.timer);
      health.timer = null;
      health.stale = true;
      broadcastToMobileClients(state, token, Object.assign({ type: 'agent-status', online: false }, relayStateForToken(state, token)));
    }
  });
}

function forwardToAgent(state, token, action, payload, timeoutMs) {
  if (!ALLOWED_ACTIONS.has(action)) {
    return Promise.reject(Object.assign(new Error('不支持的 Agent 动作。'), {
      status: 400,
      code: 'ACTION_NOT_ALLOWED',
    }));
  }
  const ws = state.agents.get(token);
  if (!ws || ws.readyState !== ws.OPEN) {
    return Promise.reject(Object.assign(new Error('对应 token 的电脑 Agent 不在线。'), {
      status: 503,
      code: 'AGENT_OFFLINE',
    }));
  }
  const id = String(++state.nextId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(Object.assign(new Error('电脑 Agent 响应超时。'), {
        status: 504,
        code: 'AGENT_TIMEOUT',
      }));
    }, timeoutMs);
    state.pending.set(id, { token, resolve, reject, timer });
    ws.send(JSON.stringify({ id, action, payload }));
  });
}

function sendRelayError(res, error) {
  sendJson(res, error.status || 500, {
    ok: false,
    code: error.code || 'RELAY_FAILED',
    message: error.message || '云端中继请求失败。',
  });
}

/**
 * 判断请求是否为无需 token 的静态资源。
 *
 * @param {import('node:http').IncomingMessage} req HTTP 请求对象。
 * @returns {boolean} 是否为公开静态资源。
 */
function isPublicAssetRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ext = path.extname(url.pathname).toLowerCase();
  return PUBLIC_ASSET_EXTENSIONS.has(ext);
}

function createCloudRelayServer(options = {}) {
  const tokens = new Set(options.tokens || String(process.env.CODEX_CLOUD_TOKENS || process.env.CODEX_CLOUD_TOKEN || '').split(',').map(item => item.trim()).filter(Boolean));
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');
  const requestTimeoutMs = Number(options.requestTimeoutMs || process.env.CODEX_RELAY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const syncStaleMs = Math.max(1000, Number(options.syncStaleMs || process.env.CODEX_RELAY_SYNC_STALE_MS || DEFAULT_SYNC_STALE_MS));
  const state = createRelayState();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return sendOptions(res);
    if (isPublicAssetRequest(req)) return serveStatic(req, res, publicDir);
    const token = tokenFromRequest(req);
    if (!tokens.has(token)) {
      return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
    }
    try {
      if (req.method === 'GET' && req.url.startsWith('/codex/health')) {
        return sendJson(res, 200, {
          ok: true,
          service: 'codex-cloud-relay',
          online: isAgentOnline(state, token),
          ...relayStateForToken(state, token),
          updatedAt: state.cache.threads(token).updatedAt,
        });
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/config')) {
        return sendJson(res, 200, { ok: true, service: 'codex-cloud-relay', localOnly: false });
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/threads')) {
        return sendJson(res, 200, Object.assign(state.cache.threads(token), relayStateForToken(state, token)));
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/history')) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const threadId = url.searchParams.get('thread') || '';
        return sendJson(res, 200, Object.assign(state.cache.history(token, threadId, url.searchParams.get('limit') || 120), relayStateForToken(state, token)));
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/status')) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const threadId = url.searchParams.get('thread') || '';
        return sendJson(res, 200, Object.assign(state.cache.status(token, threadId, url.searchParams.get('since') || ''), relayStateForToken(state, token)));
      }
      if (req.method === 'POST' && req.url.startsWith('/send')) {
        const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}');
        const result = await forwardToAgent(state, token, 'send', {
          text: typeof payload.text === 'string' ? payload.text : '',
          threadId: typeof payload.threadId === 'string' ? payload.threadId : '',
        }, requestTimeoutMs);
        return sendJson(res, 200, Object.assign({}, result, { acceptedSyncVersion: syncHealthFor(state, token).version }));
      }
      if (req.method === 'POST' && req.url.startsWith('/codex/stop')) {
        const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}');
        const result = await forwardToAgent(state, token, 'stop', {
          threadId: typeof payload.threadId === 'string' ? payload.threadId : '',
        }, requestTimeoutMs);
        return sendJson(res, 200, Object.assign({}, result, { acceptedSyncVersion: syncHealthFor(state, token).version }));
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, publicDir);
      return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法。' });
    } catch (error) {
      return sendRelayError(res, error);
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/agent' && url.pathname !== '/mobile') {
      socket.destroy();
      return;
    }
    const token = tokenFromRequest(req);
    wss.handleUpgrade(req, socket, head, ws => {
      if (!tokens.has(token)) {
        rejectAgent(ws, 1008, 'UNAUTHORIZED');
        return;
      }
      if (url.pathname === '/agent') attachAgent(state, ws, token, syncStaleMs);
      else attachMobileClient(state, ws, token);
    });
  });
  server.relayState = state;
  return server;
}

module.exports = {
  attachMobileClient,
  broadcastToMobileClients,
  createCloudRelayServer,
  forwardToAgent,
  markSessionSynced,
  rejectPendingForToken,
  relayStateForToken,
};
