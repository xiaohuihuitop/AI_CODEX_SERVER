const { createDesktopAgentApi } = require('./src/desktop-agent-api');
const { createDesktopAgentClient } = require('./src/desktop-agent-client');
const { CodexSessionReader } = require('./src/codex-session-reader');
const { WindowsCodexController } = require('./src/windows-codex-controller');

const serverUrl = process.env.CODEX_CLOUD_URL || '';
const token = process.env.CODEX_DEVICE_TOKEN || '';

if (!serverUrl || !token) {
  console.error('CODEX_CLOUD_URL and CODEX_DEVICE_TOKEN are required.');
  process.exit(1);
}

const deviceName = process.env.CODEX_DEVICE_NAME || require('node:os').hostname();
const controller = new WindowsCodexController();
const reader = new CodexSessionReader();
const api = createDesktopAgentApi({ reader, controller });
const syncOffsets = new Map();
const discoveryIntervalMs = Math.max(5000, Number(process.env.CODEX_AGENT_DISCOVERY_INTERVAL_MS || 30000));
let knownThreadTargets = [];
let lastDiscoveryAt = 0;

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

async function syncProvider() {
  const busy = api.isBusy();
  const now = Date.now();
  if (!busy && now - lastDiscoveryAt >= discoveryIntervalMs) {
    lastDiscoveryAt = now;
    console.log('列表同步中：读取 Codex Desktop 已打开的对话');
    const openThreads = await controller.listOpenThreads();
    knownThreadTargets = reader.discoverOpenThreadSessions(openThreads)
      .sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0));
    console.log(`列表同步完成：发现 ${openThreads.length} 个对话，匹配 ${knownThreadTargets.length} 个本地记录`);
  }
  const snapshot = reader.readKnownThreadSync(knownThreadTargets, syncOffsets, {
    initialLineLimit: Number(process.env.CODEX_AGENT_INITIAL_SYNC_LINES || 1000),
    snapshotMessageLimit: Number(process.env.CODEX_AGENT_SNAPSHOT_MESSAGES || 50),
    syncByteLimit: Number(process.env.CODEX_AGENT_SYNC_BYTE_LIMIT || 512 * 1024),
  });
  if (snapshot.sessions.length) {
    const snapshotSessions = snapshot.sessions.filter(session => session.snapshot);
    const metadataCount = snapshot.sessions.filter(session => session.metadataOnly).length;
    for (const session of snapshotSessions) {
      const status = session.snapshot.status || {};
      console.log(`对话同步准备：${session.threadName || session.threadId}，${session.snapshot.messages.length} 条消息，状态 ${status.status || 'unknown'}`);
    }
    if (metadataCount) console.log(`对话同步排队：${metadataCount} 个对话等待下一个同步批次`);
  }
  return {
    deviceName,
    syncedAt: new Date().toISOString(),
    openThreadIds: snapshot.openThreadIds,
    sessions: snapshot.sessions,
  };
}

const ws = createDesktopAgentClient({
  serverUrl,
  token,
  api,
  syncProvider,
  syncIntervalMs: Number(process.env.CODEX_AGENT_SYNC_INTERVAL_MS || 1000),
  syncTimeoutMs: Number(process.env.CODEX_AGENT_SYNC_TIMEOUT_MS || 15000),
});

ws.on('open', () => {
  console.log(`Desktop agent connected: ${deviceName}`);
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
  console.log(`同步请求已发送：${sessions.length} 个对话，${snapshotCount} 个携带历史快照`);
});
ws.on('sync-ack', ack => {
  console.log(`服务器已确认同步：缓存 ${Number(ack.sessionCount) || 0} 个对话，${ack.updatedAt || ''}`);
});
