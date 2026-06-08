const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAgentEnv,
  buildMobileUrl,
  createDefaultManagerConfig,
  generateDeviceToken,
  normalizeManagerConfig,
} = require('../src/desktop-manager');

test('桌面管理器生成可直接用于手机和 Agent 的固定 token 配置', () => {
  const config = normalizeManagerConfig({
    serverUrl: 'https://codex.example.com/',
    token: 'abc123',
    deviceName: 'home-pc',
    autoStart: true,
  });

  assert.deepEqual(config, {
    serverUrl: 'https://codex.example.com',
    token: 'abc123',
    deviceName: 'home-pc',
    autoStart: true,
  });
  assert.equal(buildMobileUrl(config), 'https://codex.example.com/?token=abc123');
  assert.deepEqual(buildAgentEnv(config), {
    CODEX_CLOUD_URL: 'https://codex.example.com',
    CODEX_DEVICE_TOKEN: 'abc123',
    CODEX_DEVICE_NAME: 'home-pc',
  });
});

test('桌面管理器默认配置使用固定随机 token', () => {
  const config = createDefaultManagerConfig();

  assert.equal(config.serverUrl, '');
  assert.match(config.token, /^codex_[a-z0-9_-]{24,}$/i);
  assert.equal(config.deviceName.length > 0, true);
  assert.equal(config.autoStart, false);
});

test('桌面管理器 token 生成不使用短 token', () => {
  const token = generateDeviceToken();

  assert.match(token, /^codex_[a-z0-9_-]{24,}$/i);
});
