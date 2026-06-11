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
const discoveryIntervalMs = Math.max(5000, Number(process.env.CODEX_AGENT_DISCOVERY_INTERVAL_MS || 10000));
let knownThreadTargets = [];
let lastDiscoveryAt = 0;

async function syncProvider() {
  if (api.isBusy()) {
    return null;
  }
  const now = Date.now();
  if (now - lastDiscoveryAt >= discoveryIntervalMs) {
    const openThreads = await controller.listOpenThreads();
    knownThreadTargets = reader.discoverOpenThreadSessions(openThreads);
    lastDiscoveryAt = now;
  }
  const snapshot = reader.readKnownThreadSync(knownThreadTargets, syncOffsets, {
    initialLineLimit: Number(process.env.CODEX_AGENT_INITIAL_SYNC_LINES || 1000),
  });
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
  syncIntervalMs: Number(process.env.CODEX_AGENT_SYNC_INTERVAL_MS || 2000),
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
