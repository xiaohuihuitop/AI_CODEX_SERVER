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
  const gui = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'codex-desktop-manager-gui.ps1'), 'utf8');
  const electronMain = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const electronPreload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const electronHtml = fs.readFileSync(path.join(__dirname, '..', 'electron', 'renderer.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  assert.match(manager, /createDesktopManagerServer/);
  assert.match(manager, /CODEX_MANAGER_PORT/);
  assert.match(manager, /Codex Desktop Manager/);
  assert.match(gui, /System\.Windows\.Forms/);
  assert.match(gui, /function U/);
  assert.match(gui, /\\u7ba1\\u7406\\u5668/);
  assert.doesNotMatch(gui, /[^\x00-\x7F]/);
  assert.match(gui, /Start-Agent/);
  assert.match(gui, /Stop-Agent/);
  assert.match(gui, /function Get-AgentProcess/);
  assert.match(gui, /\$AgentScriptPath/);
  assert.match(electronMain, /BrowserWindow/);
  assert.match(electronMain, /manager:start-agent/);
  assert.match(electronMain, /manager:restart-codex/);
  assert.match(electronMain, /createDesktopAgentProcess/);
  assert.match(electronPreload, /contextBridge/);
  assert.match(electronPreload, /restartCodex/);
  assert.match(electronHtml, /Codex Desktop 管理器/);
  assert.match(electronHtml, /启动 Agent/);
  assert.match(electronHtml, /启动\/重启 Codex/);
  assert.equal(pkg.scripts['start:manager:gui'], 'electron electron/main.js');
  assert.equal(pkg.scripts['start:manager:gui:legacy'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/codex-desktop-manager-gui.ps1');
  assert.deepEqual(pkg.build.asarUnpack, ['scripts/*.ps1']);
});
