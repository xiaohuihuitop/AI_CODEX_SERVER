const { createDesktopAgentApi } = require('./src/desktop-agent-api');
const { createDesktopAgentClient } = require('./src/desktop-agent-client');
const { createCodexAppServerClient } = require('./src/codex-app-server-client');
const { createCodexDesktopThreadCatalog } = require('./src/codex-desktop-thread-catalog');
const { CodexSessionReader } = require('./src/codex-session-reader');

const serverUrl = process.env.CODEX_CLOUD_URL || '';
const token = process.env.CODEX_DEVICE_TOKEN || '';

if (!serverUrl || !token) {
  console.error('CODEX_CLOUD_URL and CODEX_DEVICE_TOKEN are required.');
  process.exit(1);
}

const deviceName = process.env.CODEX_DEVICE_NAME || require('node:os').hostname();
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
  if (!targets.length) return [];
  const start = syncBatchCursor % targets.length;
  const batch = [];
  for (let index = 0; index < Math.min(syncBatchSize, targets.length); index += 1) {
    batch.push(targets[(start + index) % targets.length]);
  }
  syncBatchCursor = (start + batch.length) % targets.length;
  return batch;
}

const api = createDesktopAgentApi({
  reader,
  appServer,
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

function applyAppServerRuntime(targets) {
  for (const target of targets) target.desktopRuntime = appServer.getThreadRuntime(target.threadId);
}

function recordAppServerError(error) {
  const message = String(error && error.message || '未知错误');
  if (message !== lastAppServerError) console.error(`App Server 不可用：${message}`);
  lastAppServerError = message;
}

async function syncProvider() {
  const busy = api.isBusy();
  const now = Date.now();
  if (!busy && now - lastDiscoveryAt >= discoveryIntervalMs) {
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
  const catalogMetadata = pendingCatalogMetadata ? createCatalogMetadata(knownThreadTargets) : [];
  const batch = catalogMetadata.length ? [] : nextSyncBatch(knownThreadTargets);
  const snapshot = reader.readKnownThreadSync(batch, syncOffsets, {
    initialLineLimit: Number(process.env.CODEX_AGENT_INITIAL_SYNC_LINES || 1000),
    snapshotMessageLimit: Number(process.env.CODEX_AGENT_SNAPSHOT_MESSAGES || 50),
    syncByteLimit: Number(process.env.CODEX_AGENT_SYNC_BYTE_LIMIT || 512 * 1024),
  });
  pendingCatalogMetadata = false;
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

appServer.on('ready', () => console.log('App Server 已初始化：JSON-RPC stdio 连接就绪'));
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

ws.on('control-complete', ({ action }) => {
  lastDiscoveryAt = 0;
  console.log(`控制命令已确认：${action}，立即重新读取 app-server 运行态`);
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
