const path = require('node:path');
const { createCloudRelayServer } = require('./src/cloud-relay');
const { createKeyStore } = require('./src/key-store');

const PORT = Number(process.env.PORT || process.env.CODEX_CLOUD_PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const bootstrapTokens = String(process.env.CODEX_CLOUD_TOKENS || process.env.CODEX_CLOUD_TOKEN || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const keyStorePath = process.env.CODEX_CLOUD_KEY_STORE_PATH || '/data/keys.json';
const keyStore = createKeyStore(keyStorePath, bootstrapTokens);

const server = createCloudRelayServer({ keyStore, publicDir: PUBLIC_DIR });
server.listen(PORT, HOST, () => {
  console.log('Codex Cloud Relay is running.');
  console.log(`  http://${HOST}:${PORT}/admin`);
});
