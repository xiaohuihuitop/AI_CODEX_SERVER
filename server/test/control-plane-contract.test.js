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

test('正式控制平面不保留 CDP 控制实现或旧本机桥接入口', () => {
  for (const relativePath of legacyControlFiles) {
    assert.equal(fs.existsSync(path.join(desktopDir, relativePath)), false, `不应保留旧控制文件：${relativePath}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node desktop-agent.js');
  assert.equal(Object.hasOwn(packageJson.scripts, 'start:manager:gui:legacy'), false);
  assert.equal(packageJson.build.files.includes('scripts/win-codex-control.ps1'), false);
  assert.equal(Object.hasOwn(packageJson.build, 'asarUnpack'), false);
});

test('正式入口只允许 App Server 控制线程，禁止重新引入 CDP 标识', () => {
  const forbiddenPatterns = [
    /WindowsCodexController/,
    /restartCodexDesktopWithDebug/,
    /CODEX_DEBUG_PORT/,
    /remote-debugging-port/,
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
  assert.match(agent, /createCodexAppServerClient/);
  assert.match(api, /await this\.appServer\.resumeThread\(threadId\)/);
  assert.match(api, /await this\.appServer\.startTurn\(threadId, text\)/);
  assert.match(api, /await this\.appServer\.interruptTurn\(threadId\)/);
});
