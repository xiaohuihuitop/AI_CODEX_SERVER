const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const desktopDir = path.join(rootDir, 'desktop');

const legacyControlFiles = [
  'server.js',
  path.join('src', 'windows-codex-controller.js'),
  path.join('src', 'codex-desktop-process.js'),
  path.join('src', 'codex-app-server-client.js'),
  path.join('src', 'app-server-event-stream.js'),
  path.join('src', 'app-server-status.js'),
  path.join('scripts', 'win-codex-control.ps1'),
  path.join('scripts', 'codex-desktop-manager-gui.ps1'),
];

const productionSources = [
  'desktop-agent.js',
  'desktop-manager-server.js',
  path.join('electron', 'main.js'),
  path.join('electron', 'preload.js'),
  path.join('electron', 'renderer.js'),
  path.join('electron', 'renderer.html'),
  path.join('src', 'desktop-agent-api.js'),
  path.join('src', 'desktop-agent-process.js'),
  path.join('src', 'desktop-manager-server.js'),
  path.join('src', 'desktop-manager.js'),
];

test('正式控制平面不保留旧 CDP 脚本或独立 App Server 控制入口', () => {
  for (const relativePath of legacyControlFiles) {
    assert.equal(fs.existsSync(path.join(desktopDir, relativePath)), false, `不应保留旧控制文件：${relativePath}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node desktop-agent.js');
  assert.equal(Object.hasOwn(packageJson.scripts, 'start:manager:gui:legacy'), false);
  assert.equal(packageJson.build.files.includes('scripts/win-codex-control.ps1'), false);
  assert.equal(Object.hasOwn(packageJson.build, 'asarUnpack'), false);
});

test('正式入口只允许受控官方 Codex Desktop 作为会话控制面', () => {
  const forbiddenPatterns = [
    /WindowsCodexController/,
    /restartCodexDesktopWithDebug/,
    /createCodexAppServerClient/,
    /\.resumeThread\(/,
    /\.startTurn\(/,
    /\.interruptTurn\(/,
    /win-codex-control\.ps1/,
  ];

  for (const relativePath of productionSources) {
    const source = fs.readFileSync(path.join(desktopDir, relativePath), 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(source, pattern, `${relativePath} 不得包含 ${pattern}`);
    }
  }

  const agent = fs.readFileSync(path.join(desktopDir, 'desktop-agent.js'), 'utf8');
  const api = fs.readFileSync(path.join(desktopDir, 'src', 'desktop-agent-api.js'), 'utf8');
  assert.match(agent, /new ControlledCodexRuntime\(\{ debugPort, reader \}\)/);
  assert.match(agent, /desktopController: controlledCodex/);
  assert.match(agent, /CODEX_DEBUG_PORT/);
  assert.match(api, /await this\.desktopController\.sendMessage\(threadId, text\)/);
  assert.match(api, /await this\.desktopController\.stop\(threadId\)/);

  const processSource = fs.readFileSync(path.join(desktopDir, 'src', 'controlled-codex-process.js'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(desktopDir, 'src', 'codex-desktop-ui-controller.js'), 'utf8');
  assert.match(processSource, /remote-debugging-port/);
  assert.match(processSource, /ApplicationActivationManager/);
  assert.match(processSource, /buildProcessTreeSnapshot/);
  assert.match(processSource, /terminateProcessTree/);
  assert.match(processSource, /SIGKILL/);
  assert.doesNotMatch(processSource, /taskkill\.exe/);
  assert.match(processSource, /waitForPortRelease/);
  assert.doesNotMatch(processSource, /PackageDebugSettings|CloseMainWindow|Stop-Process/);
  assert.match(controllerSource, /data-app-action-sidebar-thread-id/);
  assert.match(controllerSource, /sessionConfirmer/);
});
