const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..');
const desktopDir = path.join(rootDir, 'desktop-client');
const serverDir = path.join(rootDir, 'server');
const mobileDir = path.join(rootDir, 'mobile-app');

test('云端和桌面端入口文件存在并使用固定 token 环境变量', () => {
  const cloud = fs.readFileSync(path.join(serverDir, 'cloud-server.js'), 'utf8');
  const agent = fs.readFileSync(path.join(desktopDir, 'desktop-agent.js'), 'utf8');

  assert.match(cloud, /createCloudRelayServer/);
  assert.match(cloud, /CODEX_CLOUD_TOKENS/);
  assert.match(agent, /createDesktopAgentClient/);
  assert.match(agent, /CODEX_CLOUD_URL/);
  assert.match(agent, /CODEX_DEVICE_TOKEN/);
  assert.match(agent, /function syncProvider\(\)/);
  assert.match(agent, /api\.isBusy\(\)/);
  assert.match(agent, /discoverOpenThreadSessions/);
  assert.match(agent, /readKnownThreadSync/);
  assert.match(agent, /CODEX_AGENT_SYNC_INTERVAL_MS/);
  assert.match(agent, /CODEX_AGENT_DISCOVERY_INTERVAL_MS/);
});

test('桌面管理小软件入口使用本地管理端口和配置模块', () => {
  const manager = fs.readFileSync(path.join(desktopDir, 'desktop-manager-server.js'), 'utf8');
  const gui = fs.readFileSync(path.join(desktopDir, 'scripts', 'codex-desktop-manager-gui.ps1'), 'utf8');
  const electronMain = fs.readFileSync(path.join(desktopDir, 'electron', 'main.js'), 'utf8');
  const electronPreload = fs.readFileSync(path.join(desktopDir, 'electron', 'preload.js'), 'utf8');
  const electronHtml = fs.readFileSync(path.join(desktopDir, 'electron', 'renderer.html'), 'utf8');
  const electronRenderer = fs.readFileSync(path.join(desktopDir, 'electron', 'renderer.js'), 'utf8');
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

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
  assert.doesNotMatch(electronMain, /manager:start-agent/);
  assert.match(electronMain, /manager:restart-agent/);
  assert.match(electronMain, /manager:restart-codex/);
  assert.match(electronMain, /createDesktopAgentProcess/);
  assert.match(electronPreload, /contextBridge/);
  assert.doesNotMatch(electronPreload, /\bstartAgent:\s*\(/);
  assert.match(electronPreload, /restartAgent/);
  assert.match(electronPreload, /restartCodex/);
  assert.match(electronHtml, /Codex Desktop 管理器/);
  assert.doesNotMatch(electronHtml, /启动 Agent/);
  assert.doesNotMatch(electronHtml, /startButton/);
  assert.match(electronHtml, /Agent 上线\/重连/);
  assert.match(electronHtml, /启动\/重启 Codex/);
  assert.match(electronRenderer, /async function refreshSilently\(\)/);
  assert.match(electronRenderer, /setInterval\(refreshSilently, 5000\)/);
  assert.match(electronRenderer, /refresh\(\{ interactive: false, renderConfig: false \}\)/);
  assert.match(electronRenderer, /if \(interactive\) setBusy\(true\)/);
  assert.match(electronRenderer, /if \(interactive\) setBusy\(false\)/);
  assert.match(electronRenderer, /if \(interactive\) elements\.saveState\.textContent = '状态已更新'/);
  assert.equal(desktopPkg.scripts['start:manager:gui'], 'electron electron/main.js');
  assert.equal(desktopPkg.scripts['start:manager:gui:legacy'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/codex-desktop-manager-gui.ps1');
  assert.deepEqual(desktopPkg.build.asarUnpack, ['scripts/*.ps1']);
  assert.equal(desktopPkg.devDependencies.electron, '42.3.3');
  assert.equal(rootPkg.scripts['start:manager:gui'], 'electron desktop-client/electron/main.js');
  assert.equal(rootPkg.scripts['build:manager:win'], 'electron-builder --win dir --projectDir desktop-client');
  assert.equal(Object.prototype.hasOwnProperty.call(rootPkg, 'build'), false);
});

test('电脑端、服务端、手机端目录物理隔离', () => {
  const expectedFiles = [
    path.join(desktopDir, 'desktop-agent.js'),
    path.join(desktopDir, 'desktop-manager-server.js'),
    path.join(desktopDir, 'electron', 'main.js'),
    path.join(desktopDir, 'public', 'index.html'),
    path.join(desktopDir, 'scripts', 'win-codex-control.ps1'),
    path.join(serverDir, 'cloud-server.js'),
    path.join(serverDir, 'Dockerfile'),
    path.join(serverDir, 'docker-compose.yml'),
    path.join(serverDir, 'public', 'index.html'),
    path.join(serverDir, 'src', 'cloud-relay.js'),
    path.join(serverDir, 'src', 'session-cache.js'),
    path.join(mobileDir, 'manifest.json'),
    path.join(mobileDir, 'pages', 'index', 'index.vue'),
  ];
  const removedRootFiles = [
    'cloud-server.js',
    'desktop-agent.js',
    'desktop-manager-server.js',
    'server.js',
    'Dockerfile',
    'docker-compose.yml',
    'Caddyfile',
  ];

  for (const file of expectedFiles) assert.equal(fs.existsSync(file), true, file);
  for (const file of removedRootFiles) assert.equal(fs.existsSync(path.join(rootDir, file)), false, file);
  assert.equal(fs.existsSync(path.join(rootDir, 'src', 'cloud-relay.js')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'public', 'index.html')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'electron', 'main.js')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'scripts', 'win-codex-control.ps1')), false);
});

test('服务端 Docker 构建只依赖 server 目录', () => {
  const dockerfile = fs.readFileSync(path.join(serverDir, 'Dockerfile'), 'utf8');
  const workflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'build-docker-image.yml'), 'utf8');

  assert.equal(fs.existsSync(path.join(serverDir, 'package-lock.json')), true);
  assert.match(dockerfile, /COPY package\*\.json \.\/\r?\nRUN npm ci --omit=dev/);
  assert.match(dockerfile, /COPY cloud-server\.js \.\//);
  assert.match(dockerfile, /COPY public \.\/public/);
  assert.match(dockerfile, /COPY src \.\/src/);
  assert.doesNotMatch(dockerfile, /desktop-client|mobile-app|\.\.\//);
  assert.match(workflow, /context:\s+\.\/server/);
});
