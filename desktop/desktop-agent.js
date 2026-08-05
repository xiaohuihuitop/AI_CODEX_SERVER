const { createDesktopAgentApi } = require('./src/desktop-agent-api');
const { createDesktopAgentClient } = require('./src/desktop-agent-client');
const { createCodexAppServerClient } = require('./src/codex-app-server-client');
const { createCodexDesktopThreadCatalog } = require('./src/codex-desktop-thread-catalog');
const { CodexSessionReader } = require('./src/codex-session-reader');
const { AGENT_STATUS_HEARTBEAT_MS, writeAgentStatus } = require('./src/desktop-agent-status');
const { selectSyncBatch } = require('./src/desktop-sync-batch');

const serverUrl = process.env.CODEX_CLOUD_URL || '';
const token = process.env.CODEX_DEVICE_TOKEN || '';

if (!serverUrl || !token) {
  console.error('CODEX_CLOUD_URL and CODEX_DEVICE_TOKEN are required.');
  process.exit(1);
}

const deviceName = process.env.CODEX_DEVICE_NAME || require('node:os').hostname();
const appServerStatusPath = String(process.env.CODEX_AGENT_STATUS_PATH || '').trim();
const appServer = createCodexAppServerClient();
const reader = new CodexSessionReader();
const desktopCatalog = createCodexDesktopThreadCatalog();
const syncOffsets = new Map();
const discoveryIntervalMs = Math.max(5000, Number(process.env.CODEX_AGENT_DISCOVERY_INTERVAL_MS || 10000));
const syncBatchSize = Math.max(1, Number(process.env.CODEX_AGENT_SYNC_BATCH_SIZE || 1));
let knownThreadTargets = [];
let lastDiscoveryAt = 0;
let lastAppServerError = '';
let syncBatchCursor = 0;
let pendingCatalogMetadata = true;
let appServerState = 'starting';
let appServerStatusMessage = '正在初始化本机 stdio 会话服务';
let lastAppServerStatusAt = 0;
let pendingControlSyncThreadId = '';

/**
 * AI:将 app-server 生命周期写入管理器可跨进程读取的本机状态文件。
 *
 * @param {'starting'|'ready'|'unavailable'|'stopped'} state 当前服务状态。
 * @param {string} message 当前状态说明。
 * @param {boolean} force 是否跳过心跳间隔立即写入。
 * @returns {void}
 */
function reportAppServerStatus(state, message, force = false) {
  appServerState = state;
  appServerStatusMessage = String(message || '');
  if (!appServerStatusPath) return;
  const now = Date.now();
  if (!force && now - lastAppServerStatusAt < AGENT_STATUS_HEARTBEAT_MS) return;
  lastAppServerStatusAt = now;
  try {
    writeAgentStatus(appServerStatusPath, {
      pid: process.pid,
      state: appServerState,
      message: appServerStatusMessage,
      updatedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    console.error(`App Server 状态上报失败：${error.message}`);
  }
}

function discoverDesktopThreadTargets() {
  const threads = desktopCatalog.listThreads();
  const targets = reader.discoverDesktopThreadSessions(threads);
  applyAppServerRuntime(targets);
  return { threads, targets };
}

function createCatalogMetadata(targets) {
  return targets.map(target => ({
    threadId: target.threadId,
    threadName: target.threadName,
    projectName: target.projectName,
    cwd: target.cwd,
    updatedAt: target.updatedAt,
    sessionFile: target.sessionFile,
    mtimeMs: target.mtimeMs,
    metadataOnly: true,
  }));
}

function nextSyncBatch(targets) {
  const selection = selectSyncBatch(targets, syncBatchCursor, syncBatchSize, pendingControlSyncThreadId);
  if (!selection.prioritized) syncBatchCursor = selection.nextCursor;
  return selection.targets;
}

const api = createDesktopAgentApi({
  reader,
  appServer,
  onControlProgress: logControlProgress,
  listThreads: async () => {
    const listed = discoverDesktopThreadTargets();
    return {
      threads: listed.targets.map(target => ({
        id: target.threadId,
        name: target.threadName,
        projectName: target.projectName,
        updatedAt: target.updatedAt,
      })),
      nextCursor: null,
    };
  },
});

function describeSyncedThreads(sessions) {
  const names = {};
  for (const session of sessions) {
    const name = String(session.threadName || session.threadId || '').trim();
    if (name) names[name] = true;
  }
  const values = Object.keys(names);
  if (!values.length) return '未知对话';
  const preview = values.slice(0, 3).join('、');
  return values.length > 3 ? `${preview} 等 ${values.length} 个对话` : preview;
}

/**
 * AI:生成不包含正文的线程日志标签，优先显示已同步的线程名称。
 *
 * @param {string} threadId 线程标识。
 * @returns {string} 适合管理器日志显示的线程标签。
 */
function describeControlThread(threadId) {
  const id = String(threadId || '').trim();
  const target = knownThreadTargets.find(item => item.threadId === id);
  const shortId = id ? `${id.slice(0, 8)}…` : '未知线程';
  return target && target.threadName ? `${target.threadName}（${shortId}）` : shortId;
}

/**
 * AI:把 API 控制阶段映射为管理器可读日志，不记录手机消息正文。
 *
 * @param {{phase?: string, threadId?: string, textLength?: number, turnId?: string, error?: string}} event 控制进度事件。
 * @returns {void}
 */
function logControlProgress(event) {
  const thread = describeControlThread(event.threadId);
  if (event.phase === 'send.received') {
    console.log(`收到手机发送请求：${thread}，文本 ${Number(event.textLength) || 0} 字符`);
    return;
  }
  if (event.phase === 'send.resume.started') {
    console.log(`正在恢复目标对话：${thread}`);
    return;
  }
  if (event.phase === 'send.resume.completed') {
    console.log(`目标对话已恢复：${thread}`);
    return;
  }
  if (event.phase === 'send.turn.started') {
    console.log(`手机回合已启动：${thread}，回合 ${String(event.turnId || '').slice(0, 8)}…`);
    return;
  }
  if (event.phase === 'send.resume.failed' || event.phase === 'send.turn.failed') {
    console.error(`手机发送失败：${thread}，${event.error || '未知错误'}`);
    return;
  }
  if (event.phase === 'stop.received') {
    console.log(`收到手机停止请求：${thread}`);
    return;
  }
  if (event.phase === 'stop.completed') {
    console.log(`手机停止请求已完成：${thread}`);
    return;
  }
  if (event.phase === 'stop.failed') console.error(`手机停止失败：${thread}，${event.error || '未知错误'}`);
}

function applyAppServerRuntime(targets) {
  for (const target of targets) target.desktopRuntime = appServer.getThreadRuntime(target.threadId);
}

function recordAppServerError(error) {
  const message = String(error && error.message || '未知错误');
  if (message !== lastAppServerError) console.error(`App Server 不可用：${message}`);
  lastAppServerError = message;
  reportAppServerStatus('unavailable', message, true);
}

async function syncProvider() {
  reportAppServerStatus(appServerState, appServerStatusMessage);
  const busy = api.isBusy();
  const now = Date.now();
  let hasPendingControlTarget = Boolean(pendingControlSyncThreadId && knownThreadTargets.some(target => target.threadId === pendingControlSyncThreadId));
  if (!busy && !hasPendingControlTarget && now - lastDiscoveryAt >= discoveryIntervalMs) {
    lastDiscoveryAt = now;
    console.log('列表同步中：读取 Codex Desktop 侧栏对话');
    try {
      const listed = discoverDesktopThreadTargets();
      knownThreadTargets = listed.targets;
      syncBatchCursor = 0;
      pendingCatalogMetadata = true;
      console.log(`列表同步完成：Desktop 未归档 ${listed.threads.length} 个对话，匹配 ${knownThreadTargets.length} 个本地记录`);
    } catch (error) {
      console.error(`Desktop 线程目录不可用：${error.message}`);
      throw error;
    }
  }
  applyAppServerRuntime(knownThreadTargets);
  hasPendingControlTarget = Boolean(pendingControlSyncThreadId && knownThreadTargets.some(target => target.threadId === pendingControlSyncThreadId));
  if (hasPendingControlTarget) console.log(`手机控制状态同步：${describeControlThread(pendingControlSyncThreadId)}`);
  const catalogMetadata = pendingCatalogMetadata && !hasPendingControlTarget ? createCatalogMetadata(knownThreadTargets) : [];
  const batch = catalogMetadata.length ? [] : nextSyncBatch(knownThreadTargets);
  const synchronizedControlThreadId = pendingControlSyncThreadId;
  const snapshot = reader.readKnownThreadSync(batch, syncOffsets, {
    initialLineLimit: Number(process.env.CODEX_AGENT_INITIAL_SYNC_LINES || 1000),
    snapshotMessageLimit: Number(process.env.CODEX_AGENT_SNAPSHOT_MESSAGES || 50),
    syncByteLimit: Number(process.env.CODEX_AGENT_SYNC_BYTE_LIMIT || 512 * 1024),
  });
  if (synchronizedControlThreadId && batch.some(target => target.threadId === synchronizedControlThreadId)) {
    pendingControlSyncThreadId = '';
  }
  if (catalogMetadata.length) pendingCatalogMetadata = false;
  const sessions = catalogMetadata.length ? catalogMetadata : snapshot.sessions;
  if (sessions.length) {
    const snapshotSessions = sessions.filter(session => session.snapshot);
    const metadataCount = sessions.filter(session => session.metadataOnly).length;
    for (const session of snapshotSessions) {
      const status = session.snapshot.status || {};
      console.log(`对话同步准备：${session.threadName || session.threadId}，${session.snapshot.messages.length} 条消息，状态 ${status.status || 'unknown'}`);
    }
    if (catalogMetadata.length) console.log(`列表元数据已准备：${catalogMetadata.length} 个 Desktop 对话`);
    else if (metadataCount) console.log(`对话同步排队：${metadataCount} 个对话等待下一个同步批次`);
  }
  return {
    deviceName,
    syncedAt: new Date().toISOString(),
    openThreadIds: knownThreadTargets.map(target => target.threadId),
    sessions,
  };
}

reportAppServerStatus('starting', appServerStatusMessage, true);
appServer.on('ready', () => {
  lastAppServerError = '';
  reportAppServerStatus('ready', '本机 stdio 会话服务已就绪', true);
  console.log('App Server 已初始化：JSON-RPC stdio 连接就绪');
});
appServer.on('stderr', message => console.error(`App Server 输出：${String(message).slice(0, 300)}`));
appServer.on('runtime', ({ threadId, runtime }) => {
  console.log(`回合状态已更新：${threadId.slice(0, 8)}… 为 ${runtime.state}`);
});
appServer.on('exit', ({ message }) => {
  lastDiscoveryAt = 0;
  recordAppServerError(new Error(message));
});
appServer.on('protocol-error', error => recordAppServerError(error));
appServer.start().catch(recordAppServerError);

const ws = createDesktopAgentClient({
  serverUrl,
  token,
  api,
  syncProvider,
  syncIntervalMs: Number(process.env.CODEX_AGENT_SYNC_INTERVAL_MS || 1000),
  // AI:首次同步需要等待 app-server 冷启动和本地历史快照，15 秒会使在线 Agent 长期不上传会话。
  syncTimeoutMs: Number(process.env.CODEX_AGENT_SYNC_TIMEOUT_MS || 45000),
});

ws.on('open', () => {
  syncOffsets.clear();
  lastDiscoveryAt = 0;
  knownThreadTargets = [];
  syncBatchCursor = 0;
  pendingCatalogMetadata = true;
  console.log(`Desktop agent connected: ${deviceName}`);
  console.log('同步游标已重置：将重新上传本地对话列表和历史快照');
});

ws.on('control-complete', ({ action, payload }) => {
  pendingControlSyncThreadId = String(payload && payload.threadId || '').trim();
  console.log(`控制命令已确认：${action}，优先同步目标对话运行态`);
});
ws.on('control-failed', ({ action, payload, error }) => {
  console.error(`手机控制命令失败：${action}，${describeControlThread(payload && payload.threadId)}，${error.code || 'UNKNOWN'}：${error.message || '未知错误'}`);
});
ws.on('close', (code, reason) => {
  console.log(`Desktop agent disconnected: ${code} ${reason.toString()}`);
});
ws.on('error', error => {
  console.error(`Desktop agent error: ${error.message}`);
});
ws.on('sync-error', error => {
  console.error(`Desktop agent sync error: ${error.message}`);
});
ws.on('sync-sent', payload => {
  const sessions = Array.isArray(payload && payload.sessions) ? payload.sessions : [];
  const snapshotCount = sessions.filter(session => session.snapshot).length;
  console.log(`同步请求已发送：${sessions.length} 个对话，${snapshotCount} 个携带历史快照，${describeSyncedThreads(sessions)}`);
});
ws.on('sync-ack', ack => {
  console.log(`服务器已确认同步：缓存 ${Number(ack.sessionCount) || 0} 个对话，${ack.updatedAt || ''}`);
});

function shutdown() {
  reportAppServerStatus('stopped', 'Agent 正在停止', true);
  ws.close();
  appServer.stop();
}

process.once('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.once('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
