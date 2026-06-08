const { createDesktopAgentApi } = require('./src/desktop-agent-api');
const { createDesktopAgentClient } = require('./src/desktop-agent-client');

const serverUrl = process.env.CODEX_CLOUD_URL || '';
const token = process.env.CODEX_DEVICE_TOKEN || '';

if (!serverUrl || !token) {
  console.error('CODEX_CLOUD_URL and CODEX_DEVICE_TOKEN are required.');
  process.exit(1);
}

const deviceName = process.env.CODEX_DEVICE_NAME || require('node:os').hostname();
const api = createDesktopAgentApi();
const ws = createDesktopAgentClient({ serverUrl, token, api });

ws.on('open', () => {
  console.log(`Desktop agent connected: ${deviceName}`);
});
ws.on('close', (code, reason) => {
  console.log(`Desktop agent disconnected: ${code} ${reason.toString()}`);
});
ws.on('error', error => {
  console.error(`Desktop agent error: ${error.message}`);
});
