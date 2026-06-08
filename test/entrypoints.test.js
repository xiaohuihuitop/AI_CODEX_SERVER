const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('云端和桌面端入口文件存在并使用固定 token 环境变量', () => {
  const cloud = fs.readFileSync(path.join(__dirname, '..', 'cloud-server.js'), 'utf8');
  const agent = fs.readFileSync(path.join(__dirname, '..', 'desktop-agent.js'), 'utf8');

  assert.match(cloud, /createCloudRelayServer/);
  assert.match(cloud, /CODEX_CLOUD_TOKENS/);
  assert.match(agent, /createDesktopAgentClient/);
  assert.match(agent, /CODEX_CLOUD_URL/);
  assert.match(agent, /CODEX_DEVICE_TOKEN/);
});

test('桌面管理小软件入口使用本地管理端口和配置模块', () => {
  const manager = fs.readFileSync(path.join(__dirname, '..', 'desktop-manager-server.js'), 'utf8');

  assert.match(manager, /createDesktopManagerServer/);
  assert.match(manager, /CODEX_MANAGER_PORT/);
  assert.match(manager, /Codex Desktop Manager/);
});
