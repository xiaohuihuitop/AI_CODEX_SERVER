const crypto = require('node:crypto');
const os = require('node:os');

function generateDeviceToken() {
  return `codex_${crypto.randomBytes(24).toString('base64url')}`;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeManagerConfig(input = {}) {
  return {
    serverUrl: trimTrailingSlash(input.serverUrl),
    token: String(input.token || '').trim(),
    deviceName: String(input.deviceName || os.hostname()).trim(),
    autoStart: Boolean(input.autoStart),
  };
}

function createDefaultManagerConfig() {
  return {
    serverUrl: '',
    token: generateDeviceToken(),
    deviceName: os.hostname(),
    autoStart: false,
  };
}

function buildMobileUrl(config) {
  const normalized = normalizeManagerConfig(config);
  const url = new URL(normalized.serverUrl);
  url.searchParams.set('token', normalized.token);
  return url.toString();
}

function buildAgentEnv(config) {
  const normalized = normalizeManagerConfig(config);
  return {
    CODEX_CLOUD_URL: normalized.serverUrl,
    CODEX_DEVICE_TOKEN: normalized.token,
    CODEX_DEVICE_NAME: normalized.deviceName,
  };
}

module.exports = {
  buildAgentEnv,
  buildMobileUrl,
  createDefaultManagerConfig,
  generateDeviceToken,
  normalizeManagerConfig,
};
