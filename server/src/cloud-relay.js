const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { readBody, sendJson, sendOptions, serveStatic } = require('./http-utils');
const { createCloudSessionCache } = require('./session-cache');
const { createKeyStore } = require('./key-store');

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SYNC_STALE_MS = 10000;
const ALLOWED_ACTIONS = new Set(['threads', 'history', 'status', 'send', 'stop']);
const PUBLIC_ASSET_EXTENSIONS = new Set(['.css', '.ico', '.js', '.json', '.png', '.svg', '.webmanifest']);
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_PASSWORD = 'xiaohuihui';
const CONTROL_COMMAND_TTL_MS = 30 * 60 * 1000;
const MAX_CONTROL_COMMANDS_PER_DEVICE = 500;

function tokenFromRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return url.searchParams.get('token') || req.headers['x-mobile-typer-token'] || '';
}

function createRelayState() {
  return {
    agents: new Map(),
    mobileClients: new Map(),
    syncHealth: new Map(),
    eventStreams: new Map(),
    cache: createCloudSessionCache(),
    pending: new Map(),
    controlCommands: new Map(),
    nextId: 0,
  };
}

function eventStreamFor(state, token) {
  if (!state.eventStreams.has(token)) {
    state.eventStreams.set(token, {
      streamId: '',
      lastSeq: 0,
      eventIds: new Map(),
      appServerState: 'unknown',
      updatedAt: '',
    });
  }
  return state.eventStreams.get(token);
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return '';
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function legacyKeyStore(tokens) {
  const allowed = new Set(tokens || []);
  const resolve = token => allowed.has(token)
    ? { id: `legacy-${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24)}`, note: '' }
    : null;
  return { has: token => Boolean(resolve(token)), resolve, matches: () => false, list: () => [], create: () => { throw new Error('不支持 Key 管理。'); }, disable: () => false, remove: () => false };
}

function resolveDevice(keyStore, token) {
  if (typeof keyStore.resolve === 'function') return keyStore.resolve(token);
  return keyStore.has(token) ? { id: `legacy-${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24)}`, note: '' } : null;
}

function syncHealthFor(state, token) {
  if (!state.syncHealth.has(token)) {
    state.syncHealth.set(token, {
      version: 0,
      lastSyncedAt: '',
      stale: true,
      timer: null,
      confirmedControlTurns: new Map(),
    });
  }
  return state.syncHealth.get(token);
}

function relayStateForToken(state, token) {
  const health = syncHealthFor(state, token);
  const events = eventStreamFor(state, token);
  return {
    deviceId: token,
    agentOnline: isAgentOnline(state, token),
    syncVersion: health.version,
    lastSyncedAt: health.lastSyncedAt,
    syncFresh: Boolean(isAgentOnline(state, token) && !health.stale && health.lastSyncedAt),
    confirmedControlTurnIds: Array.from(health.confirmedControlTurns.keys()),
    appServerState: events.appServerState,
    appServerUpdatedAt: events.updatedAt,
    eventStreamId: events.streamId,
    eventSeq: events.lastSeq,
  };
}

/**
 * AI:应用 Agent 声明的事件流状态，并在 relay 缺少历史事件时要求客户端对账。
 *
 * @param {object} state Relay 状态。
 * @param {string} token 设备 token。
 * @param {object} payload Agent 事件流状态。
 * @returns {void}
 */
function applyEventStreamState(state, token, payload = {}) {
  const streamId = String(payload.streamId || '').trim();
  const declaredSeq = Math.max(0, Number(payload.lastSeq) || 0);
  if (!streamId) return;
  const current = eventStreamFor(state, token);
  const streamChanged = Boolean(current.streamId && current.streamId !== streamId);
  const relayMissedEvents = current.streamId === streamId && declaredSeq > current.lastSeq;
  if (current.streamId !== streamId) current.eventIds.clear();
  current.streamId = streamId;
  current.lastSeq = declaredSeq;
  current.appServerState = String(payload.appServerState || current.appServerState || 'unknown');
  current.updatedAt = new Date().toISOString();
  if (streamChanged || relayMissedEvents) {
    broadcastToMobileClients(state, token, Object.assign({
      type: 'event-resync-required',
      threadId: '',
      reason: streamChanged ? 'stream-changed' : 'relay-gap',
    }, relayStateForToken(state, token)));
  }
  broadcastToMobileClients(state, token, Object.assign({ type: 'event-stream-state' }, relayStateForToken(state, token)));
}

/**
 * AI:校验、去重并广播单条 App Server 线程事件。
 *
 * @param {object} state Relay 状态。
 * @param {string} token 设备 token。
 * @param {object} event Agent 线程事件。
 * @returns {boolean} 事件被接受时返回 true。
 */
function applyAppServerEvent(state, token, event = {}) {
  const streamId = String(event.streamId || '').trim();
  const eventId = String(event.eventId || '').trim();
  const threadId = String(event.threadId || '').trim();
  const seq = Number(event.seq);
  if (!streamId || !eventId || !threadId || !Number.isInteger(seq) || seq < 1) return false;

  const current = eventStreamFor(state, token);
  if (current.eventIds.has(eventId)) return false;
  if (current.streamId && current.streamId !== streamId) {
    current.eventIds.clear();
    current.lastSeq = 0;
    broadcastToMobileClients(state, token, Object.assign({
      type: 'event-resync-required',
      threadId,
      reason: 'stream-changed',
    }, relayStateForToken(state, token)));
  }
  current.streamId = streamId;
  if (seq > current.lastSeq + 1) {
    broadcastToMobileClients(state, token, Object.assign({
      type: 'event-resync-required',
      threadId,
      reason: 'sequence-gap',
      expectedSeq: current.lastSeq + 1,
      receivedSeq: seq,
    }, relayStateForToken(state, token)));
  } else if (seq <= current.lastSeq) {
    broadcastToMobileClients(state, token, Object.assign({
      type: 'event-resync-required',
      threadId,
      reason: 'out-of-order',
      expectedSeq: current.lastSeq + 1,
      receivedSeq: seq,
    }, relayStateForToken(state, token)));
    return false;
  }
  current.lastSeq = seq;
  current.updatedAt = String(event.observedAt || new Date().toISOString());
  current.eventIds.set(eventId, seq);
  while (current.eventIds.size > 500) current.eventIds.delete(current.eventIds.keys().next().value);
  broadcastToMobileClients(state, token, Object.assign({
    type: 'thread-event',
    event,
  }, relayStateForToken(state, token)));
  return true;
}

function markSessionSynced(state, token, staleMs, confirmedControlTurnIds = [], advanceVersion = true) {
  const health = syncHealthFor(state, token);
  if (advanceVersion) health.version += 1;
  health.lastSyncedAt = new Date().toISOString();
  health.stale = false;
  for (const turnId of Array.from(new Set((confirmedControlTurnIds || []).map(item => String(item || '').trim()).filter(Boolean)))) {
    health.confirmedControlTurns.delete(turnId);
    health.confirmedControlTurns.set(turnId, health.version);
  }
  while (health.confirmedControlTurns.size > 20) {
    health.confirmedControlTurns.delete(health.confirmedControlTurns.keys().next().value);
  }
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
  for (const command of controlCommandsFor(state, token).values()) {
    if (command.status === 'completed') ws.send(JSON.stringify(controlResultEvent(state, token, command)));
  }
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

function disconnectToken(state, token) {
  const agent = state.agents.get(token);
  if (agent) agent.close(1008, 'TOKEN_REVOKED');
  const clients = state.mobileClients.get(token);
  if (clients) {
    for (const ws of clients) ws.close(1008, 'TOKEN_REVOKED');
  }
  rejectPendingForToken(state, token);
}

function disconnectKey(state, keyStore, keyId) {
  disconnectToken(state, keyId);
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
      const health = syncHealthFor(state, token);
      const confirmedControlTurnIds = Array.from(new Set((message.payload && message.payload.confirmedControlTurnIds || [])
        .map(item => String(item || '').trim())
        .filter(turnId => turnId && !health.confirmedControlTurns.has(turnId))));
      const changed = Boolean(result.changed || confirmedControlTurnIds.length);
      const wasStale = health.stale;
      const syncState = markSessionSynced(
        state,
        token,
        syncStaleMs,
        confirmedControlTurnIds,
        changed,
      );
      ws.send(JSON.stringify({
        type: 'session-sync-ack',
        changed,
        sessionCount: result.sessionCount,
        appliedSessionCount: result.appliedSessionCount,
        removedSessionCount: result.removedSessionCount,
        updatedAt: result.updatedAt,
      }));
      if (changed) {
        broadcastToMobileClients(state, token, Object.assign({
          type: 'session-updated',
          updatedAt: result.updatedAt,
          catalogChanged: result.catalogChanged,
          changedThreadIds: result.changedThreadIds,
        }, syncState));
      } else if (wasStale) {
        broadcastToMobileClients(state, token, Object.assign({ type: 'sync-status' }, syncState));
      }
      return;
    }
    if (message.type === 'session-heartbeat') {
      const health = syncHealthFor(state, token);
      if (!health.lastSyncedAt) return;
      const wasStale = health.stale;
      const syncState = markSessionSynced(state, token, syncStaleMs, [], false);
      if (wasStale) broadcastToMobileClients(state, token, Object.assign({ type: 'sync-status' }, syncState));
      return;
    }
    if (message.type === 'event-stream-state') {
      applyEventStreamState(state, token, message.payload || {});
      return;
    }
    if (message.type === 'app-server-event') {
      applyAppServerEvent(state, token, message.event || {});
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

function controlCommandsFor(state, deviceId) {
  if (!state.controlCommands.has(deviceId)) state.controlCommands.set(deviceId, new Map());
  const commands = state.controlCommands.get(deviceId);
  const expiredBefore = Date.now() - CONTROL_COMMAND_TTL_MS;
  for (const [id, command] of commands.entries()) {
    if (Date.parse(command.updatedAt || command.createdAt || '') < expiredBefore) commands.delete(id);
  }
  while (commands.size > MAX_CONTROL_COMMANDS_PER_DEVICE) commands.delete(commands.keys().next().value);
  return commands;
}

function trimControlCommands(commands) {
  while (commands.size > MAX_CONTROL_COMMANDS_PER_DEVICE) commands.delete(commands.keys().next().value);
}

function controlCommandFingerprint(payload) {
  return crypto.createHash('sha256')
    .update(`${String(payload.threadId || '')}\n${String(payload.text || '')}`)
    .digest('hex');
}

function controlResultEvent(state, deviceId, command) {
  return Object.assign({
    type: 'control-result',
    action: command.action,
    ok: command.ok,
    status: command.status,
    threadId: command.threadId,
    clientUserMessageId: command.clientUserMessageId,
    acceptedSyncVersion: command.acceptedSyncVersion,
    result: command.result || undefined,
    error: command.error || undefined,
    completedAt: command.completedAt || '',
  }, relayStateForToken(state, deviceId));
}

function recordRelayControl(event, deviceId, command, details = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: 'relay',
    event,
    deviceId,
    commandId: command.clientUserMessageId,
    threadId: command.threadId,
    ...details,
  }));
}

function publicControlCommand(state, deviceId, command) {
  return {
    ok: true,
    accepted: true,
    deviceId,
    status: command.status,
    watch: {
      threadId: command.threadId,
      clientUserMessageId: command.clientUserMessageId,
    },
    acceptedSyncVersion: command.acceptedSyncVersion,
    controlResult: command.status === 'completed' ? controlResultEvent(state, deviceId, command) : null,
  };
}

/**
 * AI:异步执行手机发送命令，并通过手机实时通道回传唯一的最终控制结果。
 *
 * @param {object} state Relay 运行状态。
 * @param {string} token 设备 token。
 * @param {object} payload Agent 发送负载。
 * @param {number} timeoutMs Agent 控制超时。
 * @returns {object} 可立即返回给手机的受理结果。
 */
function acceptSendCommand(state, token, payload, timeoutMs) {
  const commands = controlCommandsFor(state, token);
  const fingerprint = controlCommandFingerprint(payload);
  const existing = commands.get(payload.clientUserMessageId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw Object.assign(new Error('客户端消息标识已用于另一条发送内容。'), {
        status: 409,
        code: 'CLIENT_USER_MESSAGE_ID_CONFLICT',
      });
    }
    return publicControlCommand(state, token, existing);
  }
  const ws = state.agents.get(token);
  if (!ws || ws.readyState !== ws.OPEN) {
    throw Object.assign(new Error('对应 token 的电脑 Agent 不在线。'), {
      status: 503,
      code: 'AGENT_OFFLINE',
    });
  }
  const acceptedSyncVersion = syncHealthFor(state, token).version;
  const now = new Date().toISOString();
  const command = {
    action: 'send',
    status: 'accepted',
    ok: null,
    threadId: payload.threadId,
    clientUserMessageId: payload.clientUserMessageId,
    fingerprint,
    acceptedSyncVersion,
    createdAt: now,
    updatedAt: now,
  };
  commands.set(payload.clientUserMessageId, command);
  trimControlCommands(commands);
  recordRelayControl('control.accepted', token, command);
  forwardToAgent(state, token, 'send', payload, timeoutMs).then(result => {
    command.status = 'completed';
    command.ok = true;
    command.result = result;
    command.completedAt = new Date().toISOString();
    command.updatedAt = command.completedAt;
    recordRelayControl('control.completed', token, command, { ok: true, turnId: String(result && result.watch && result.watch.turnId || '') });
    broadcastToMobileClients(state, token, controlResultEvent(state, token, command));
  }).catch(error => {
    command.status = 'completed';
    command.ok = false;
    command.error = {
      code: error.code || 'AGENT_REQUEST_FAILED',
      message: error.message || '电脑 Agent 发送失败。',
      status: error.status || 500,
    };
    command.completedAt = new Date().toISOString();
    command.updatedAt = command.completedAt;
    recordRelayControl('control.completed', token, command, { ok: false, errorCode: command.error.code });
    broadcastToMobileClients(state, token, controlResultEvent(state, token, command));
  });
  return publicControlCommand(state, token, command);
}

/**
 * AI:校验控制请求只能作用于电脑当前打开的线程。
 *
 * @param {object} state Relay 运行状态。
 * @param {string} token 设备 token。
 * @param {string} threadId 线程 ID。
 * @returns {string} 规范化线程 ID。
 */
function requireOpenThread(state, token, threadId) {
  const id = String(threadId || '').trim();
  if (!id) {
    throw Object.assign(new Error('缺少对话标识。'), {
      status: 400,
      code: 'THREAD_ID_REQUIRED',
    });
  }
  if (!state.cache.hasOpenThread(token, id)) {
    throw Object.assign(new Error('目标对话已归档、删除或不在电脑当前线程列表中。'), {
      status: 409,
      code: 'THREAD_NOT_OPEN',
    });
  }
  return id;
}

/**
 * AI:校验客户端生成的用户消息标识，确保重试可复用同一幂等键。
 *
 * @param {string} clientUserMessageId 客户端用户消息标识。
 * @returns {string} 规范化消息标识。
 */
function requireClientUserMessageId(clientUserMessageId) {
  const id = String(clientUserMessageId || '').trim();
  if (!id) {
    throw Object.assign(new Error('缺少客户端用户消息标识。'), {
      status: 400,
      code: 'CLIENT_USER_MESSAGE_ID_REQUIRED',
    });
  }
  if (id.length > 128) {
    throw Object.assign(new Error('客户端用户消息标识过长。'), {
      status: 400,
      code: 'CLIENT_USER_MESSAGE_ID_INVALID',
    });
  }
  return id;
}

function isAdminRequest(url) {
  return url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/api/');
}

function isAdminAuthorized(req, state) {
  const sessionId = cookieValue(req, 'codexBridgeAdmin');
  const expiresAt = state.adminSessions.get(sessionId);
  if (!expiresAt || expiresAt <= Date.now()) {
    state.adminSessions.delete(sessionId);
    return false;
  }
  return true;
}

function sendAdminSession(res, sessionId) {
  res.setHeader('set-cookie', `codexBridgeAdmin=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`);
}

function clearAdminSession(res) {
  res.setHeader('set-cookie', 'codexBridgeAdmin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
}

function createCloudRelayServer(options = {}) {
  const bootstrapTokens = String(process.env.CODEX_CLOUD_TOKENS || process.env.CODEX_CLOUD_TOKEN || '').split(',').map(item => item.trim()).filter(Boolean);
  const keyStore = options.keyStore || (options.tokens ? legacyKeyStore(options.tokens) : createKeyStore(options.keyStorePath || process.env.CODEX_CLOUD_KEY_STORE_PATH || '/data/keys.json', bootstrapTokens));
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');
  const requestTimeoutMs = Number(options.requestTimeoutMs || process.env.CODEX_RELAY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const syncStaleMs = Math.max(1000, Number(options.syncStaleMs || process.env.CODEX_RELAY_SYNC_STALE_MS || DEFAULT_SYNC_STALE_MS));
  const state = createRelayState();
  state.adminSessions = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return sendOptions(res);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (isAdminRequest(url)) {
      try {
        if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
          const adminRequest = Object.create(req);
          adminRequest.url = '/admin.html';
          return serveStatic(adminRequest, res, publicDir);
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/login') {
          const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}');
          if (!secureEqual(payload.password, ADMIN_PASSWORD)) {
            return sendJson(res, 401, { ok: false, code: 'ADMIN_UNAUTHORIZED', message: '管理密码不正确。' });
          }
          const sessionId = crypto.randomBytes(32).toString('base64url');
          state.adminSessions.set(sessionId, Date.now() + ADMIN_SESSION_TTL_MS);
          sendAdminSession(res, sessionId);
          return sendJson(res, 200, { ok: true });
        }
        if (!isAdminAuthorized(req, state)) {
          return sendJson(res, 401, { ok: false, code: 'ADMIN_UNAUTHORIZED', message: '请先登录管理后台。' });
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/logout') {
          state.adminSessions.delete(cookieValue(req, 'codexBridgeAdmin'));
          clearAdminSession(res);
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'GET' && url.pathname === '/admin/api/keys') {
          return sendJson(res, 200, { ok: true, keys: keyStore.list() });
        }
        if (req.method === 'POST' && url.pathname === '/admin/api/keys') {
          const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}');
          const created = keyStore.create(payload.note, payload.token);
          return sendJson(res, 201, { ok: true, ...created });
        }
        const keyMatch = url.pathname.match(/^\/admin\/api\/keys\/([^/]+)(?:\/(disable))?$/);
        if (keyMatch && req.method === 'POST' && keyMatch[2] === 'disable') {
          if (!keyStore.disable(keyMatch[1])) return sendJson(res, 404, { ok: false, code: 'KEY_NOT_FOUND', message: 'Key 不存在或已禁用。' });
          disconnectKey(state, keyStore, keyMatch[1]);
          return sendJson(res, 200, { ok: true });
        }
        if (keyMatch && req.method === 'DELETE' && !keyMatch[2]) {
          disconnectKey(state, keyStore, keyMatch[1]);
          if (!keyStore.remove(keyMatch[1])) return sendJson(res, 404, { ok: false, code: 'KEY_NOT_FOUND', message: 'Key 不存在。' });
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { ok: false, code: 'ADMIN_NOT_FOUND', message: '管理接口不存在。' });
      } catch (error) {
        return sendRelayError(res, error);
      }
    }
    if (isPublicAssetRequest(req)) return serveStatic(req, res, publicDir);
    const token = tokenFromRequest(req);
    const device = resolveDevice(keyStore, token);
    if (!device) {
      return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
    }
    const deviceId = device.id;
    try {
      if (req.method === 'GET' && req.url.startsWith('/codex/health')) {
        return sendJson(res, 200, {
          ok: true,
          service: 'codex-cloud-relay',
          online: isAgentOnline(state, deviceId),
          ...relayStateForToken(state, deviceId),
          updatedAt: state.cache.threads(deviceId).updatedAt,
        });
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/config')) {
        return sendJson(res, 200, { ok: true, service: 'codex-cloud-relay', localOnly: false });
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/threads')) {
        return sendJson(res, 200, Object.assign(state.cache.threads(deviceId), relayStateForToken(state, deviceId)));
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/thread-view')) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const threadId = url.searchParams.get('thread') || '';
        return sendJson(res, 200, Object.assign(
          state.cache.threadView(deviceId, threadId, url.searchParams.get('limit') || 5, url.searchParams.get('since') || ''),
          relayStateForToken(state, deviceId),
        ));
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/history')) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const threadId = url.searchParams.get('thread') || '';
        const before = url.searchParams.get('before') || '';
        if (before && state.cache.hasOpenThread(deviceId, threadId) && isAgentOnline(state, deviceId)) {
          const direct = await forwardToAgent(state, deviceId, 'history', {
            threadId,
            limit: url.searchParams.get('limit') || 120,
            before,
          }, requestTimeoutMs);
          return sendJson(res, 200, Object.assign({}, direct, { cached: false }, relayStateForToken(state, deviceId)));
        }
        return sendJson(res, 200, Object.assign(state.cache.history(deviceId, threadId, url.searchParams.get('limit') || 120, before), relayStateForToken(state, deviceId)));
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/status')) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const threadId = url.searchParams.get('thread') || '';
        return sendJson(res, 200, Object.assign(state.cache.status(deviceId, threadId, url.searchParams.get('since') || ''), relayStateForToken(state, deviceId)));
      }
      if (req.method === 'GET' && req.url.startsWith('/codex/control-result')) {
        const commandId = requireClientUserMessageId(url.searchParams.get('clientUserMessageId'));
        const command = controlCommandsFor(state, deviceId).get(commandId);
        if (!command) return sendJson(res, 404, { ok: false, code: 'CONTROL_COMMAND_NOT_FOUND', message: '发送记录不存在或已过期。' });
        return sendJson(res, 200, publicControlCommand(state, deviceId, command));
      }
      if (req.method === 'POST' && req.url.startsWith('/send')) {
        const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}');
        const threadId = requireOpenThread(state, deviceId, payload.threadId);
        const clientUserMessageId = requireClientUserMessageId(payload.clientUserMessageId);
        const accepted = acceptSendCommand(state, deviceId, {
          text: typeof payload.text === 'string' ? payload.text : '',
          threadId,
          clientUserMessageId,
        }, requestTimeoutMs);
        return sendJson(res, 202, accepted);
      }
      if (req.method === 'POST' && req.url.startsWith('/codex/stop')) {
        const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}');
        const threadId = requireOpenThread(state, deviceId, payload.threadId);
        const result = await forwardToAgent(state, deviceId, 'stop', {
          threadId,
        }, requestTimeoutMs);
        return sendJson(res, 200, Object.assign({}, result, { acceptedSyncVersion: syncHealthFor(state, deviceId).version }));
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
      const device = resolveDevice(keyStore, token);
      if (!device) {
        rejectAgent(ws, 1008, 'UNAUTHORIZED');
        return;
      }
      if (url.pathname === '/agent') attachAgent(state, ws, device.id, syncStaleMs);
      else attachMobileClient(state, ws, device.id);
    });
  });
  server.relayState = state;
  server.keyStore = keyStore;
  return server;
}

module.exports = {
  attachMobileClient,
  acceptSendCommand,
  applyAppServerEvent,
  applyEventStreamState,
  broadcastToMobileClients,
  createCloudRelayServer,
  disconnectKey,
  disconnectToken,
  forwardToAgent,
  markSessionSynced,
  requireClientUserMessageId,
  rejectPendingForToken,
  relayStateForToken,
  resolveDevice,
};
