const path = require('node:path');
const { createCloudRelayServer } = require('./src/cloud-relay');

const PORT = Number(process.env.PORT || process.env.CODEX_CLOUD_PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const tokens = String(process.env.CODEX_CLOUD_TOKENS || process.env.CODEX_CLOUD_TOKEN || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

if (!tokens.length) {
  console.error('CODEX_CLOUD_TOKENS is required.');
  process.exit(1);
}

const server = createCloudRelayServer({ tokens, publicDir: PUBLIC_DIR });
server.listen(PORT, HOST, () => {
  console.log('Codex Cloud Relay is running.');
  console.log(`  http://${HOST}:${PORT}/?token=<token>`);
});
