const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { readBody, sendJson, sendOptions, serveStatic } = require('./http-utils');

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const ALLOWED_ACTIONS = new Set(['threads', 'history', 'status', 'send', 'stop']);
const PUBLIC_ASSET_EXTENSIONS = new Set(['.css', '.ico', '.js', '.json', '.png', '.svg', '.webmanifest']);

function tokenFromRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return url.searchParams.get('token') || req.headers['x-mobile-typer-token'] || '';
}

function createRelayState() {
  return {
    agents: new Map(),
    pending: new Map(),
    nextId: 0,
  };
}

function rejectAgent(ws, code, reason) {
  ws.close(code, reason);
}

function attachAgent(state, ws, token) {
  if (state.agents.has(token)) {
    rejectAgent(ws, 1008, 'TOKEN_ALREADY_ONLINE');
    return;
  }
  state.agents.set(token, ws);
  ws.on('message', data => {
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch {
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
    if (state.agents.get(token) === ws) state.agents.delete(token);
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
    state.pending.set(id, { resolve, reject, timer });
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
        return sendJson(res, 200, { ok: true, service: 'codex-cloud-relay', online: state.agents.has(token) });
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/config')) {
        return sendJson(res, 200, { ok: true, service: 'codex-cloud-relay', localOnly: false });
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/threads')) {
        const result = await forwardToAgent(state, token, 'threads', {}, requestTimeoutMs);
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/history')) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const result = await forwardToAgent(state, token, 'history', {
          threadId: url.searchParams.get('thread') || '',
          limit: url.searchParams.get('limit') || 120,
        }, requestTimeoutMs);
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/status')) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const result = await forwardToAgent(state, token, 'status', {
          threadId: url.searchParams.get('thread') || '',
          since: url.searchParams.get('since') || '',
        }, requestTimeoutMs);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && req.url.startsWith('/send')) {
        const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}');
        const result = await forwardToAgent(state, token, 'send', {
          text: typeof payload.text === 'string' ? payload.text : '',
          threadId: typeof payload.threadId === 'string' ? payload.threadId : '',
        }, requestTimeoutMs);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && req.url.startsWith('/codex/stop')) {
        const result = await forwardToAgent(state, token, 'stop', {}, requestTimeoutMs);
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, publicDir);
      return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法。' });
    } catch (error) {
      return sendRelayError(res, error);
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/agent')) {
      socket.destroy();
      return;
    }
    const token = tokenFromRequest(req);
    wss.handleUpgrade(req, socket, head, ws => {
      if (!tokens.has(token)) {
        rejectAgent(ws, 1008, 'UNAUTHORIZED');
        return;
      }
      attachAgent(state, ws, token);
    });
  });
  server.relayState = state;
  return server;
}

module.exports = {
  createCloudRelayServer,
  forwardToAgent,
};
