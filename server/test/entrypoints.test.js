const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const desktopDir = path.join(rootDir, 'desktop');
const serverDir = path.join(rootDir, 'server');
const mobileDir = path.join(rootDir, 'app');

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
  assert.match(agent, /const busy = api\.isBusy\(\)/);
  assert.match(agent, /if \(!busy && now - lastDiscoveryAt >= discoveryIntervalMs\)/);
  assert.doesNotMatch(agent, /if \(api\.isBusy\(\)\) \{\s*return null;\s*\}/);
  assert.match(agent, /discoverOpenThreadSessions/);
  assert.match(agent, /readKnownThreadSync/);
  assert.match(agent, /CODEX_AGENT_SYNC_INTERVAL_MS/);
  assert.match(agent, /CODEX_AGENT_DISCOVERY_INTERVAL_MS/);
  assert.match(agent, /CODEX_AGENT_DISCOVERY_INTERVAL_MS \|\| 30000/);
});

test('桌面管理小软件入口使用本地管理端口和配置模块', () => {
  const manager = fs.readFileSync(path.join(desktopDir, 'desktop-manager-server.js'), 'utf8');
  const gui = fs.readFileSync(path.join(desktopDir, 'scripts', 'codex-desktop-manager-gui.ps1'), 'utf8');
  const electronMain = fs.readFileSync(path.join(desktopDir, 'electron', 'main.js'), 'utf8');
  const electronPreload = fs.readFileSync(path.join(desktopDir, 'electron', 'preload.js'), 'utf8');
  const electronHtml = fs.readFileSync(path.join(desktopDir, 'electron', 'renderer.html'), 'utf8');
  const electronRenderer = fs.readFileSync(path.join(desktopDir, 'electron', 'renderer.js'), 'utf8');
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

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
  assert.match(electronMain, /Tray/);
  assert.match(electronMain, /nativeImage/);
  assert.match(electronMain, /TRAY_ICON_PNG_BASE64/);
  assert.match(electronMain, /nativeImage\.createFromBuffer/);
  assert.doesNotMatch(electronMain, /data:image\/svg\+xml/);
  assert.match(electronMain, /requestSingleInstanceLock/);
  assert.match(electronMain, /second-instance/);
  assert.match(electronMain, /function createTray\(\)/);
  assert.match(electronMain, /显示管理器/);
  assert.match(electronMain, /退出管理器/);
  assert.match(electronMain, /mainWindow\.on\('minimize'/);
  assert.match(electronMain, /mainWindow\.hide\(\)/);
  assert.match(electronMain, /app\.isQuitting/);
  assert.doesNotMatch(electronMain, /if \(process\.platform !== 'darwin'\) app\.quit\(\)/);
  assert.doesNotMatch(electronMain, /manager:start-agent/);
  assert.match(electronMain, /manager:restart-agent/);
  assert.match(electronMain, /manager:pause-feature/);
  assert.match(electronMain, /manager:restart-codex/);
  assert.match(electronMain, /createDesktopAgentProcess/);
  assert.match(electronMain, /async function startAgentIfEnabled\(\)/);
  assert.match(electronMain, /normalized\.autoStart/);
  assert.match(electronMain, /agentController\.restart\(normalized\)/);
  assert.match(electronMain, /autoStart: true/);
  assert.match(electronMain, /autoStart: false/);
  assert.match(electronMain, /function serverPortFromUrl\(serverUrl\)/);
  assert.match(electronMain, /ports:\s*\{[\s\S]*cloud: serverPortFromUrl\(normalized\.serverUrl\),[\s\S]*codexDebug: codex\.port \|\| CODEX_DEBUG_PORT,/);
  assert.match(electronPreload, /contextBridge/);
  assert.doesNotMatch(electronPreload, /\bstartAgent:\s*\(/);
  assert.match(electronPreload, /pauseFeature/);
  assert.match(electronPreload, /restartAgent/);
  assert.match(electronPreload, /restartCodex/);
  assert.match(electronHtml, /Codex Desktop 管理器/);
  assert.doesNotMatch(electronHtml, /启动 Agent/);
  assert.doesNotMatch(electronHtml, /停止 Agent/);
  assert.doesNotMatch(electronHtml, /Agent 上线\/重连/);
  assert.doesNotMatch(electronHtml, /启动\/重启 Codex/);
  assert.doesNotMatch(electronHtml, /startButton/);
  assert.match(electronHtml, /启动功能/);
  assert.match(electronHtml, /停止功能/);
  assert.match(electronHtml, /重启 Codex 生效 CDP/);
  assert.match(electronHtml, /id="portStatus"/);
  assert.match(electronHtml, /功能状态/);
  assert.match(electronHtml, /云端连接/);
  assert.match(electronHtml, /Codex 控制/);
  assert.match(electronRenderer, /const cloudPort = nextState\.ports\.cloud \|\| '未配置'/);
  assert.match(electronRenderer, /云端 \$\{cloudPort\} \/ CDP \$\{nextState\.ports\.codexDebug\}/);
  assert.match(electronRenderer, /CDP 端口 \$\{nextState\.ports\.codexDebug\}/);
  assert.doesNotMatch(electronRenderer, /Codex App 目标/);
  assert.doesNotMatch(electronRenderer, /可控制目标 \$\{nextState\.codex\.targetCount\}/);
  assert.match(electronRenderer, /function isConfigured\(config\)/);
  assert.match(electronRenderer, /featureStarted/);
  assert.match(electronRenderer, /已启动/);
  assert.match(electronRenderer, /已停止/);
  assert.match(electronRenderer, /配置不完整/);
  assert.match(electronRenderer, /需重启 Codex 生效 CDP/);
  assert.match(electronRenderer, /window\.codexManager\.pauseFeature\(\)/);
  assert.match(electronRenderer, /async function refreshSilently\(\)/);
  assert.match(electronRenderer, /const SILENT_REFRESH_MS = 15000/);
  assert.match(electronRenderer, /document\.visibilityState !== 'visible'/);
  assert.match(electronRenderer, /setInterval\(refreshSilently, SILENT_REFRESH_MS\)/);
  assert.match(electronRenderer, /refresh\(\{ interactive: false, renderConfig: false \}\)/);
  assert.match(electronRenderer, /if \(interactive\) setBusy\(true\)/);
  assert.match(electronRenderer, /if \(interactive\) setBusy\(false\)/);
  assert.match(electronRenderer, /if \(interactive\) elements\.saveState\.textContent = '状态已更新'/);
  assert.equal(desktopPkg.scripts['start:manager:gui'], 'electron electron/main.js');
  assert.equal(desktopPkg.scripts['start:manager:gui:legacy'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/codex-desktop-manager-gui.ps1');
  assert.deepEqual(desktopPkg.build.asarUnpack, ['scripts/*.ps1']);
  assert.equal(desktopPkg.devDependencies.electron, '42.3.3');
});

test('根目录只保留三端业务目录和 Git 基础设施', () => {
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
    path.join(mobileDir, 'docs', '使用说明.md'),
  ];
  const allowedRoot = new Set(['.git', '.github', '.gitignore', 'desktop', 'server', 'app']);

  for (const file of expectedFiles) assert.equal(fs.existsSync(file), true, file);
  const rootNames = fs.readdirSync(rootDir, { withFileTypes: true }).map(item => item.name);
  assert.deepEqual(rootNames.filter(name => !allowedRoot.has(name)).sort(), []);
  assert.equal(fs.existsSync(path.join(rootDir, 'desktop-client')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'mobile-app')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'docs')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'test')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'package-lock.json')), false);
});

test('服务端 Docker 构建只依赖 server 目录', () => {
  const dockerfile = fs.readFileSync(path.join(serverDir, 'Dockerfile'), 'utf8');
  const workflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'build-docker-image.yml'), 'utf8');

  assert.equal(fs.existsSync(path.join(serverDir, 'package-lock.json')), true);
  assert.match(dockerfile, /COPY package\*\.json \.\/\r?\nRUN npm ci --omit=dev/);
  assert.match(dockerfile, /COPY cloud-server\.js \.\//);
  assert.match(dockerfile, /COPY public \.\/public/);
  assert.match(dockerfile, /COPY src \.\/src/);
  assert.doesNotMatch(dockerfile, /desktop|COPY\s+app|COPY\s+\.\.\//);
  assert.match(workflow, /context:\s+\.\/server/);
});
