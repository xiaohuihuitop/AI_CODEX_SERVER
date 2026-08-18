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
  assert.match(agent, /let pendingControlSync = null/);
  assert.match(agent, /pendingControlSync\.threadId/);
  assert.match(agent, /if \(!busy && now - lastCatalogCheckAt >= catalogCheckIntervalMs\)/);
  assert.match(agent, /reconcileDesktopCatalog/);
  assert.match(agent, /selectSyncBatch/);
  assert.match(agent, /持续优先同步目标对话直到读取到新记录/);
  assert.match(agent, /inspectControlSyncEvidence/);
  assert.match(agent, /advanceControlSyncState/);
  assert.match(agent, /手机发送已落盘/);
  assert.match(agent, /手机回合完整同步/);
  assert.match(agent, /CODEX_AGENT_CONTROL_SYNC_TIMEOUT_MS \|\| 30000/);
  assert.doesNotMatch(agent, /if \(api\.isBusy\(\)\) \{\s*return null;\s*\}/);
  assert.match(agent, /new ControlledCodexRuntime\(\{ debugPort, reader \}\)/);
  assert.match(agent, /controlledStartupRetryTimer/);
  assert.doesNotMatch(agent, /setTimeout\(\(\) => process\.exit\(1\), 50\)/);
  assert.match(agent, /createCodexDesktopThreadCatalog/);
  assert.match(agent, /discoverDesktopThreadSessions/);
  assert.doesNotMatch(agent, /createCodexAppServerClient/);
  assert.doesNotMatch(agent, /WindowsCodexController/);
  assert.match(agent, /desktopController: controlledCodex/);
  assert.match(agent, /reportControlledStatus/);
  assert.match(agent, /受控 Codex Desktop 已连接/);
  assert.match(agent, /syncOffsets\.clear\(\)/);
  assert.match(agent, /readKnownThreadSync/);
  assert.match(agent, /CODEX_AGENT_SYNC_INTERVAL_MS/);
  assert.match(agent, /CODEX_AGENT_SYNC_TIMEOUT_MS \|\| 45000/);
  assert.match(agent, /CODEX_AGENT_DISCOVERY_INTERVAL_MS/);
  assert.match(agent, /CODEX_AGENT_DISCOVERY_INTERVAL_MS \|\| 10000/);
  assert.match(agent, /CODEX_AGENT_SYNC_BATCH_SIZE \|\| 1/);
  assert.match(agent, /openThreadIds: knownThreadTargets\.map\(target => target\.threadId\)/);
  assert.match(agent, /confirmedControlTurnIds/);
  assert.match(agent, /syncOffsets\.delete\(threadId\)/);
  assert.match(agent, /CODEX_AGENT_CATALOG_CHECK_INTERVAL_MS \|\| 1000/);
  assert.match(agent, /client\.on\('control-complete'/);
  assert.match(agent, /lastDiscoveryAt = 0/);
});

test('桌面管理小软件入口使用本地管理端口和配置模块', () => {
  const manager = fs.readFileSync(path.join(desktopDir, 'desktop-manager-server.js'), 'utf8');
  const electronMain = fs.readFileSync(path.join(desktopDir, 'electron', 'main.js'), 'utf8');
  const electronPreload = fs.readFileSync(path.join(desktopDir, 'electron', 'preload.js'), 'utf8');
  const electronHtml = fs.readFileSync(path.join(desktopDir, 'electron', 'renderer.html'), 'utf8');
  const electronRenderer = fs.readFileSync(path.join(desktopDir, 'electron', 'renderer.js'), 'utf8');
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

  assert.match(manager, /createDesktopManagerServer/);
  assert.match(manager, /CODEX_MANAGER_PORT/);
  assert.match(manager, /Codex Desktop Manager/);
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
  assert.match(electronMain, /createDesktopAgentProcess/);
  assert.match(electronMain, /async function startAgentIfEnabled\(\)/);
  assert.match(electronMain, /normalized\.autoStart/);
  assert.match(electronMain, /agentController\.restart\(normalized\)/);
  assert.match(electronMain, /autoStart: true/);
  assert.match(electronMain, /autoStart: false/);
  assert.match(electronMain, /function serverPortFromUrl\(serverUrl\)/);
  assert.match(electronMain, /resolveControlledCodexStatus/);
  assert.match(electronMain, /function controlledCodexStatus\(agent\)/);
  assert.match(electronMain, /官方 Codex Desktop 已受控连接/);
  assert.match(electronMain, /ports:\s*\{[\s\S]*cloud: serverPortFromUrl\(normalized\.serverUrl\),/);
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
  assert.match(electronHtml, /id="restartCodexButton"/);
  assert.match(electronHtml, /重启 Codex 启用 CDP/);
  assert.match(electronHtml, /id="portStatus"/);
  assert.match(electronHtml, /id="codexVersion"/);
  assert.match(electronHtml, /id="debugPort"/);
  assert.match(electronHtml, /功能状态/);
  assert.match(electronHtml, /云端连接/);
  assert.match(electronHtml, /官方客户端/);
  assert.match(electronRenderer, /const cloudPort = nextState\.ports\.cloud \|\| '未配置'/);
  assert.match(electronRenderer, /云端 \$\{cloudPort\} \/ CDP \$\{nextState\.config\.debugPort/);
  assert.match(electronRenderer, /nextState\.controlledCodex\.ok/);
  assert.match(electronRenderer, /nextState\.controlledCodex\.codexVersion/);
  assert.match(electronRenderer, /已连接/);
  assert.match(electronRenderer, /function isConfigured\(config\)/);
  assert.match(electronRenderer, /featureStarted/);
  assert.match(electronRenderer, /已启动/);
  assert.match(electronRenderer, /已停止/);
  assert.match(electronRenderer, /配置不完整/);
  assert.match(electronRenderer, /等待受控 Codex Desktop 初始化/);
  assert.doesNotMatch(electronMain, /restartCodexDesktopWithDebug/);
  assert.match(electronMain, /manager:restart-codex/);
  assert.match(electronMain, /controlledCodexProcess\.restart/);
  assert.match(electronMain, /重启官方 Codex Desktop/);
  assert.match(electronRenderer, /window\.codexManager\.restartCodex\(\)/);
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
  assert.equal(Object.hasOwn(desktopPkg.scripts, 'start:manager:gui:legacy'), false);
  assert.equal(Object.hasOwn(desktopPkg.build, 'asarUnpack'), false);
  assert.equal(desktopPkg.scripts.start, 'node desktop-agent.js');
  assert.match(desktopPkg.scripts['build:manager:win'], /verify-manager-artifact\.js/);
  assert.equal(desktopPkg.devDependencies.electron, '42.3.3');
});

test('根目录只保留三端业务目录、README 和 Git 基础设施', () => {
  const expectedFiles = [
    path.join(desktopDir, 'desktop-agent.js'),
    path.join(desktopDir, 'desktop-manager-server.js'),
    path.join(desktopDir, 'electron', 'main.js'),
    path.join(serverDir, 'cloud-server.js'),
    path.join(serverDir, 'Dockerfile'),
    path.join(serverDir, 'README.md'),
    path.join(serverDir, 'docker-compose.yml'),
    path.join(serverDir, 'public', 'index.html'),
    path.join(serverDir, 'src', 'cloud-relay.js'),
    path.join(serverDir, 'src', 'session-cache.js'),
    path.join(mobileDir, 'manifest.json'),
    path.join(mobileDir, 'README.md'),
    path.join(mobileDir, 'pages', 'index', 'index.vue'),
    path.join(mobileDir, 'docs', '使用说明.md'),
  ];
  const allowedRoot = new Set(['.agents', '.codex', '.git', '.gitattributes', '.github', '.gitignore', '.trellis', 'AGENTS.md', 'README.md', 'desktop', 'server', 'app', 'docs']);

  for (const file of expectedFiles) assert.equal(fs.existsSync(file), true, file);
  assert.equal(fs.existsSync(path.join(desktopDir, 'README.md')), true);
  const rootNames = fs.readdirSync(rootDir, { withFileTypes: true }).map(item => item.name);
  assert.deepEqual(rootNames.filter(name => !allowedRoot.has(name)).sort(), []);
  assert.equal(fs.existsSync(path.join(rootDir, 'desktop-client')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'mobile-app')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'docs', 'temp')), true);
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

test('服务端 Key 使用固定 Docker 数据卷跨发布目录持久化', () => {
  const compose = fs.readFileSync(path.join(serverDir, 'docker-compose.yml'), 'utf8');

  assert.match(compose, /- codex-relay-data:\/data/);
  assert.match(compose, /volumes:\s+[\s\S]*codex-relay-data:\s+[\s\S]*name: codex-relay-data/);
  assert.doesNotMatch(compose, /- \.\/data:\/data/);
});
