const { createDesktopAgentApi } = require('./src/desktop-agent-api');
const fs = require('node:fs');
const { createDesktopAgentClient } = require('./src/desktop-agent-client');
const { createAppServerEventStream } = require('./src/app-server-event-stream');
const { createCodexAppServerClient } = require('./src/codex-app-server-client');
const { createCodexDesktopThreadCatalog } = require('./src/codex-desktop-thread-catalog');
const { reconcileDesktopCatalog } = require('./src/desktop-catalog-reconcile');
const { CodexSessionReader } = require('./src/codex-session-reader');
const { AGENT_STATUS_HEARTBEAT_MS, writeAgentStatus } = require('./src/desktop-agent-status');
const { advanceControlSyncState, inspectControlSyncEvidence, selectSyncBatch } = require('./src/desktop-sync-batch');

const serverUrl = process.env.CODEX_CLOUD_URL || '';
const token = process.env.CODEX_DEVICE_TOKEN || '';

if (!serverUrl || !token) {
  console.error('CODEX_CLOUD_URL and CODEX_DEVICE_TOKEN are required.');
  process.exit(1);
}

const deviceName = process.env.CODEX_DEVICE_NAME || require('node:os').hostname();
const appServerStatusPath = String(process.env.CODEX_AGENT_STATUS_PATH || '').trim();
const appServer = createCodexAppServerClient();
const appServerEvents = createAppServerEventStream({ deviceId: deviceName });
const reader = new CodexSessionReader();
const desktopCatalog = createCodexDesktopThreadCatalog();
const syncOffsets = new Map();
const catalogCheckIntervalMs = Math.max(1000, Number(process.env.CODEX_AGENT_CATALOG_CHECK_INTERVAL_MS || 1000));
const discoveryIntervalMs = Math.max(5000, Number(process.env.CODEX_AGENT_DISCOVERY_INTERVAL_MS || 10000));
const syncBatchSize = Math.max(1, Number(process.env.CODEX_AGENT_SYNC_BATCH_SIZE || 1));
const controlSyncTimeoutMs = Math.max(5000, Number(process.env.CODEX_AGENT_CONTROL_SYNC_TIMEOUT_MS || 30000));
let knownThreadTargets = [];
let knownCatalogThreadIds = [];
let lastCatalogCheckAt = 0;
let lastDiscoveryAt = 0;
let syncBatchCursor = 0;
let pendingCatalogMetadata = true;
let pendingControlSync = null;
let lastAppServerError = '';
let appServerState = 'starting';
let appServerStatusMessage = '正在初始化本机 stdio 会话服务';
let appServerCodexVersion = '';
let lastAppServerStatusAt = 0;
let lastConfirmedSessionCount = null;

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
      codexVersion: appServerCodexVersion,
      updatedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    console.error(`App Server 状态上报失败：${error.message}`);
  }
}

function discoverDesktopThreadTargets(threads = desktopCatalog.listThreads()) {
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

/**
 * AI:用轻量文件大小校验找出尚未同步的 JSONL，避免大量线程按轮转长时间等待。
 *
 * @param {Array<object>} targets 当前 Desktop 可见线程目标。
 * @returns {Array<string>} JSONL 与已同步游标不一致的线程标识。
 */
function changedSyncTargetIds(targets) {
  const changed = [];
  for (const target of targets) {
    if (!target || !target.threadId || !target.file) continue;
    try {
      const size = fs.statSync(target.file).size;
      const offset = syncOffsets.get(target.threadId);
      if (!offset || Number(offset.size) !== size) changed.push(target.threadId);
    } catch (error) {
      console.error(`对话文件状态读取失败：${describeControlThread(target.threadId)}，${error.message}`);
    }
  }
  return changed;
}

function nextSyncBatch(targets) {
  const changedThreadIds = changedSyncTargetIds(targets);
  const selection = selectSyncBatch(
    targets,
    syncBatchCursor,
    syncBatchSize,
    pendingControlSync && pendingControlSync.threadId,
    changedThreadIds,
  );
  if (!selection.prioritized) syncBatchCursor = selection.nextCursor;
  if (selection.priorityReason === 'changed' && selection.targets[0]) {
    console.log(`变化对话优先同步：${describeControlThread(selection.targets[0].threadId)}`);
  }
  return selection.targets;
}

/**
 * AI:从当前 Desktop 侧栏目标中解析控制线程，目录可能在上次发现后刚发生变化。
 *
 * @param {string} threadId Codex 线程 ID。
 * @returns {object} 控制目标或不可用标记。
 */
const api = createDesktopAgentApi({
  reader,
  appServer,
  onControlProgress: logControlProgress,
  listThreads: async () => {
    const listed = discoverDesktopThreadTargets();
    knownThreadTargets = listed.targets;
    knownCatalogThreadIds = listed.threads.map(thread => thread.id);
    lastCatalogCheckAt = Date.now();
    lastDiscoveryAt = Date.now();
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
  const request = event.clientUserMessageId ? `，请求 ${event.clientUserMessageId}` : '';
  if (event.phase === 'send.received') {
    console.log(`收到手机发送请求：${thread}${request}，文本 ${Number(event.textLength) || 0} 字符`);
    return;
  }
  if (event.phase === 'send.deduplicated') {
    console.log(`重复发送已去重：${thread}${request}`);
    return;
  }
  if (event.phase === 'send.resume.started') {
    console.log(`正在恢复目标对话：${thread}${request}`);
    return;
  }
  if (event.phase === 'send.resume.completed') {
    console.log(`目标对话已恢复：${thread}`);
    return;
  }
  if (event.phase === 'send.turn.started') {
    console.log(`手机回合已启动：${thread}，等待 App Server 返回回合标识`);
    return;
  }
  if (event.phase === 'send.turn.completed') {
    console.log(`手机回合已确认：${thread}${request}，回合 ${String(event.turnId || '').slice(0, 8)}…`);
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
    console.log(`Codex Desktop 停止请求已完成：${thread}`);
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
  let hasPendingControlTarget = Boolean(pendingControlSync && knownThreadTargets.some(target => target.threadId === pendingControlSync.threadId));
  if (!busy && now - lastCatalogCheckAt >= catalogCheckIntervalMs) {
    lastCatalogCheckAt = now;
    try {
      const threads = desktopCatalog.listThreads();
      const forceDiscovery = now - lastDiscoveryAt >= discoveryIntervalMs;
      const reconciled = reconcileDesktopCatalog({
        previousCatalogThreadIds: knownCatalogThreadIds,
        previousTargets: knownThreadTargets,
        threads,
        discoverTargets: rows => reader.discoverDesktopThreadSessions(rows),
        forceDiscovery,
      });
      if (forceDiscovery) lastDiscoveryAt = now;
      if (reconciled.discovered) {
        console.log('列表同步中：读取 Codex Desktop 侧栏对话并映射本地记录');
      } else if (reconciled.removedCount) {
        console.log(`列表变更检测：归档或删除 ${reconciled.removedCount} 个对话，准备清理服务器缓存`);
      }
      for (const threadId of reconciled.removedThreadIds) syncOffsets.delete(threadId);
      if (reconciled.membershipChanged || reconciled.orderChanged || reconciled.discovered) {
        knownThreadTargets = reconciled.targets;
      }
      if (reconciled.membershipChanged || reconciled.discovered) {
        syncBatchCursor = 0;
        pendingCatalogMetadata = true;
      }
      knownCatalogThreadIds = reconciled.catalogThreadIds;
      if (reconciled.discovered) console.log(`列表同步完成：Desktop 未归档 ${threads.length} 个对话，匹配 ${knownThreadTargets.length} 个本地记录`);
    } catch (error) {
      console.error(`Desktop 线程目录不可用：${error.message}`);
      throw error;
    }
  }
  applyAppServerRuntime(knownThreadTargets);
  hasPendingControlTarget = Boolean(pendingControlSync && knownThreadTargets.some(target => target.threadId === pendingControlSync.threadId));
  if (hasPendingControlTarget) console.log(`手机控制状态同步：${describeControlThread(pendingControlSync.threadId)}`);
  const catalogMetadata = pendingCatalogMetadata && !hasPendingControlTarget ? createCatalogMetadata(knownThreadTargets) : [];
  const batch = catalogMetadata.length ? [] : nextSyncBatch(knownThreadTargets);
  const synchronizedControl = pendingControlSync;
  const snapshot = reader.readKnownThreadSync(batch, syncOffsets, {
    initialLineLimit: Number(process.env.CODEX_AGENT_INITIAL_SYNC_LINES || 1000),
    snapshotMessageLimit: Number(process.env.CODEX_AGENT_SNAPSHOT_MESSAGES || 50),
    syncByteLimit: Number(process.env.CODEX_AGENT_SYNC_BYTE_LIMIT || 512 * 1024),
  });
  let confirmedControlTurnIds = [];
  if (synchronizedControl) {
    const evidence = inspectControlSyncEvidence(snapshot.sessions, synchronizedControl.threadId, synchronizedControl.turnId);
    const transition = advanceControlSyncState(synchronizedControl, evidence, now);
    pendingControlSync = transition.state;
    confirmedControlTurnIds = transition.confirmedTurnIds;
    if (transition.acceptedNow && synchronizedControl.turnId) {
      console.log(`手机发送已落盘：${describeControlThread(synchronizedControl.threadId)}，继续同步同一回合的回复`);
    }
    if (transition.completedNow) {
      const message = synchronizedControl.turnId ? '手机回合完整同步' : '手机控制同步完成';
      console.log(`${message}：${describeControlThread(synchronizedControl.threadId)}`);
    } else if (transition.timedOut) {
      console.error(`手机控制同步未确认：${describeControlThread(synchronizedControl.threadId)}，等待 Desktop 写入超时`);
    }
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
    confirmedControlTurnIds,
  };
}

reportAppServerStatus('starting', appServerStatusMessage, true);
appServer.on('launch', ({ command, source }) => {
  appServerCodexVersion = '';
  const type = source === 'desktop' ? 'Codex Desktop 内置程序' : '系统 PATH 程序';
  console.log(`App Server 启动：${type}，${command}`);
});
appServer.on('version', ({ version }) => {
  appServerCodexVersion = String(version || '').trim();
  console.log(`Codex 运行时版本：v${appServerCodexVersion}`);
  reportAppServerStatus(appServerState, appServerStatusMessage, true);
});
appServer.on('version-error', ({ error }) => {
  console.error(`Codex 运行时版本读取失败：${error && error.message || '未知错误'}`);
});
appServer.on('ready', () => {
  lastAppServerError = '';
  reportAppServerStatus('ready', '本机 stdio 会话服务已就绪', true);
  ws.sendEventState();
  console.log('App Server 已初始化：JSON-RPC stdio 连接就绪');
});
appServer.on('stderr', message => console.error(`App Server 输出：${String(message).slice(0, 300)}`));
appServer.on('runtime', ({ threadId, runtime }) => {
  console.log(`回合状态已更新：${threadId.slice(0, 8)}… 为 ${runtime.state}`);
});
appServer.on('exit', ({ message }) => {
  lastDiscoveryAt = 0;
  recordAppServerError(new Error(message));
  ws.sendEventState();
});
appServer.on('protocol-error', error => {
  recordAppServerError(error);
  ws.sendEventState();
});
appServer.on('late-response', ({ id, method, timedOutAt, receivedAt }) => {
  const delayedMs = Math.max(0, Date.parse(receivedAt) - Date.parse(timedOutAt));
  console.log(`App Server 迟到响应已隔离：请求 ${id}，方法 ${method}，超时后 ${delayedMs}ms 返回`);
});

const ws = createDesktopAgentClient({
  serverUrl,
  token,
  api,
  syncProvider,
  eventStateProvider: () => ({
    ...appServerEvents.state(),
    appServerState,
    appServerMessage: appServerStatusMessage,
  }),
  syncIntervalMs: Number(process.env.CODEX_AGENT_SYNC_INTERVAL_MS || 1000),
  syncTimeoutMs: Number(process.env.CODEX_AGENT_SYNC_TIMEOUT_MS || 45000),
});

ws.on('open', () => {
  syncOffsets.clear();
  knownCatalogThreadIds = [];
  lastCatalogCheckAt = 0;
  lastDiscoveryAt = 0;
  knownThreadTargets = [];
  syncBatchCursor = 0;
  pendingCatalogMetadata = true;
  pendingControlSync = null;
  lastConfirmedSessionCount = null;
  console.log(`Desktop agent connected: ${deviceName}`);
  console.log('同步游标已重置：将重新上传本地对话列表和历史快照');
});

ws.on('control-complete', ({ action, payload, result }) => {
  pendingControlSync = {
    threadId: String(payload && payload.threadId || '').trim(),
    turnId: action === 'send' ? String(result && result.watch && result.watch.turnId || '').trim() : '',
    accepted: false,
    deadline: Date.now() + controlSyncTimeoutMs,
  };
  console.log(`控制命令已确认：${action}，持续优先同步目标对话直到读取到新记录`);
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
  const sessionCount = Number(ack.sessionCount) || 0;
  const appliedSessionCount = Number(ack.appliedSessionCount) || 0;
  const removedSessionCount = Number(ack.removedSessionCount) || 0;
  if (lastConfirmedSessionCount === null || sessionCount !== lastConfirmedSessionCount || appliedSessionCount || removedSessionCount) {
    const removed = removedSessionCount ? `，物理清理 ${removedSessionCount} 个对话缓存` : '';
    console.log(`服务器已确认同步：缓存 ${sessionCount} 个对话${removed}，${ack.updatedAt || ''}`);
  }
  lastConfirmedSessionCount = sessionCount;
});
ws.on('event-dropped', event => {
  console.error(`实时事件未发送：Agent WebSocket 未连接，事件 ${event.eventId || '未知'}，线程 ${String(event.threadId || '').slice(0, 8)}…`);
});
ws.on('event-state-error', error => {
  console.error(`事件流状态生成失败：${error.message}`);
});

appServer.on('notification', ({ method, params }) => {
  const event = appServerEvents.fromNotification(method, params);
  if (!event) return;
  const sent = ws.sendAppServerEvent(event);
  if (sent && (event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'thread.status.changed')) {
    console.log(`实时事件已发送：${event.type}，线程 ${event.threadId.slice(0, 8)}…，回合 ${String(event.turnId || '').slice(0, 8)}…，序号 ${event.seq}`);
  }
});
appServer.on('server-request', request => {
  console.error(`App Server 主动请求未获授权：${request.method}，请求 ${request.id}`);
});
appServer.start().catch(error => {
  recordAppServerError(error);
  ws.sendEventState();
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
