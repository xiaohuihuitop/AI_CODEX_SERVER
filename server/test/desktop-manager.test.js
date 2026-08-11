const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildAgentEnv,
  buildMobileUrl,
  createDefaultManagerConfig,
  getAgentStatusPath,
  generateDeviceToken,
  normalizeManagerConfig,
} = require('../../desktop/src/desktop-manager');
const {
  DesktopAgentProcess,
  MAX_LOG_LINES,
  appendLog,
} = require('../../desktop/src/desktop-agent-process');

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
    CODEX_AGENT_STATUS_PATH: getAgentStatusPath('abc123'),
  });
});

test('桌面管理器默认配置使用固定随机 token', () => {
  const config = createDefaultManagerConfig();

  assert.equal(config.serverUrl, '');
  assert.match(config.token, /^codex_[a-z0-9_-]{24,}$/i);
  assert.equal(config.deviceName.length > 0, true);
  assert.equal(config.autoStart, false);
});

test('桌面管理器读取旧配置时忽略废弃 CDP 端口', () => {
  const config = normalizeManagerConfig({ debugPort: 'abc' });

  assert.equal(Object.hasOwn(config, 'debugPort'), false);
});

test('桌面管理器支持 HTTP 端口形式的群晖地址', () => {
  const config = normalizeManagerConfig({
    serverUrl: 'http://192.168.1.20:8008/',
    token: 'abc123',
    deviceName: 'synology-pc',
  });

  assert.equal(buildMobileUrl(config), 'http://192.168.1.20:8008/?token=abc123');
  assert.equal(buildAgentEnv(config).CODEX_CLOUD_URL, 'http://192.168.1.20:8008');
});

test('桌面管理器 token 生成不使用短 token', () => {
  const token = generateDeviceToken();

  assert.match(token, /^codex_[a-z0-9_-]{24,}$/i);
});

test('桌面 Agent 日志最多保留 500 条且支持清除', () => {
  const logs = [];
  appendLog(logs, Array.from({ length: MAX_LOG_LINES + 2 }, (_, index) => `日志 ${index + 1}`).join('\n'));
  assert.equal(MAX_LOG_LINES, 500);
  assert.equal(logs.length, 500);
  assert.equal(logs[0], '日志 3');

  const manager = new DesktopAgentProcess({ processFinder: () => null });
  manager.lastOutput = ['列表同步完成'];
  manager.lastError = ['同步异常'];
  manager.clearLogs();
  assert.deepEqual(manager.status().lastOutput, []);
  assert.deepEqual(manager.status().lastError, []);
});

test('桌面管理器提供日志清除操作', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../desktop/electron/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../../desktop/electron/preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../../desktop/electron/renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../../desktop/electron/renderer.html'), 'utf8');

  assert.match(main, /manager:clear-logs/);
  assert.match(preload, /clearLogs/);
  assert.match(renderer, /clearLogsButton/);
  assert.match(renderer, /window\.codexManager\.clearLogs\(\)/);
  assert.match(html, /id="clearLogsButton"/);
  const agent = fs.readFileSync(path.join(__dirname, '../../desktop/desktop-agent.js'), 'utf8');
  assert.match(agent, /对话同步准备：/);
  assert.match(agent, /同步请求已发送：/);
  assert.match(agent, /服务器已确认同步：/);
  assert.match(agent, /正在恢复目标对话：/);
  assert.match(agent, /手机回合已确认：/);
  assert.match(agent, /手机发送已落盘：/);
  assert.match(agent, /手机回合完整同步/);
  assert.match(agent, /手机控制同步完成/);
  assert.match(agent, /App Server 迟到响应已隔离/);
  assert.match(main, /resolveAppServerStatus/);
  assert.match(main, /App Server 未就绪：/);
  assert.doesNotMatch(main, /restartCodexDesktopWithDebug/);
  assert.doesNotMatch(renderer, /CODEX_DEBUG_PORT=/);
  assert.doesNotMatch(html, /id="debugPort"/);
});

test('桌面管理器统一使用固定目录、固定名称并展示版本', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../desktop/electron/main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../../desktop/electron/renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../../desktop/electron/renderer.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../desktop/package.json'), 'utf8'));

  assert.equal(pkg.build.directories.output, 'dist');
  assert.equal(pkg.productName, 'Codex Desktop 管理器');
  assert.equal(pkg.version, '0.2.5');
  assert.match(main, /const MANAGER_VERSION = app\.getVersion\(\)/);
  assert.match(main, /Codex Desktop 管理器 v\$\{MANAGER_VERSION\} 已启动/);
  assert.match(html, /id="managerVersion"/);
  assert.match(renderer, /管理器版本：v\$\{managerVersion\}/);
});

test('桌面管理器配置可以持久化到文件', () => {
  const { loadConfig, saveConfig } = require('../../desktop/src/desktop-manager-server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-'));
  const file = path.join(dir, 'manager-config.json');
  try {
    saveConfig(file, {
      serverUrl: 'http://example.com:8008/',
      token: 'token_replace_with_random_value',
      deviceName: 'home-pc',
      autoStart: true,
    });

    assert.deepEqual(loadConfig(file), {
      serverUrl: 'http://example.com:8008',
      token: 'token_replace_with_random_value',
      deviceName: 'home-pc',
      autoStart: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('桌面管理器配置兼容 UTF-8 BOM 文件', () => {
  const { loadConfig } = require('../../desktop/src/desktop-manager-server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-bom-'));
  const file = path.join(dir, 'manager-config.json');
  try {
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({
      serverUrl: 'http://example.com:8008/',
      token: 'token_replace_with_random_value',
      deviceName: 'home-pc',
      autoStart: false,
    })}`, 'utf8');

    assert.deepEqual(loadConfig(file), {
      serverUrl: 'http://example.com:8008',
      token: 'token_replace_with_random_value',
      deviceName: 'home-pc',
      autoStart: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('桌面管理器页面包含 Agent 控制和状态区域', () => {
  const { renderHtml } = require('../../desktop/src/desktop-manager-server');
  const html = renderHtml({
    serverUrl: 'http://example.com:8008',
    token: 'token_replace_with_random_value',
    deviceName: 'home-pc',
    autoStart: false,
  }, {
    running: false,
    pid: null,
    lastOutput: [],
    lastError: [],
  });

  assert.doesNotMatch(html, /启动 Agent/);
  assert.match(html, /Agent 上线\/重连/);
  assert.match(html, /停止 Agent/);
  assert.match(html, /会话服务/);
  assert.match(html, /http:\/\/example\.com:8008\/\?token=token_replace_with_random_value/);
});

test('桌面管理器 HTTP 接口支持保存配置和控制 Agent', async () => {
  const { createDesktopManagerServer } = require('../../desktop/src/desktop-manager-server');
  const calls = [];
  const agentController = {
    stop() {
      calls.push(['stop']);
      return { running: false, pid: 1234 };
    },
    restart(config) {
      calls.push(['restart', config]);
      return { running: true, pid: 5678, alreadyRunning: false };
    },
    status() {
      return { running: calls.some(call => call[0] === 'restart'), pid: 1234, lastOutput: [], lastError: [] };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-http-'));
  const server = createDesktopManagerServer({
    configPath: path.join(dir, 'manager-config.json'),
    agentController,
    probes: {
      cloud: async () => ({ configured: true, ok: true, online: true, status: 200, message: '' }),
      appServer: async () => ({ ok: true, message: '本机 stdio 会话服务已就绪', codexVersion: '0.144.0' }),
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const form = new URLSearchParams({
      serverUrl: 'http://example.com:8008',
      token: 'token_replace_with_random_value',
      deviceName: 'home-pc',
    });
    const saved = await fetch(`http://127.0.0.1:${port}/config`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(saved.status, 303);

    const restart = await fetch(`http://127.0.0.1:${port}/agent/restart`, { method: 'POST' });
    const restartBody = await restart.json();
    assert.equal(restart.status, 200);
    assert.equal(calls[0][0], 'restart');
    assert.equal(calls[0][1].token, 'token_replace_with_random_value');
    assert.equal(restartBody.agent.pid, 5678);

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    const statusBody = await status.json();
    assert.equal(statusBody.cloud.online, true);
    assert.equal(statusBody.appServer.ok, true);
    assert.equal(statusBody.agent.running, true);

    const stop = await fetch(`http://127.0.0.1:${port}/agent/stop`, { method: 'POST' });
    assert.equal(stop.status, 200);
    assert.equal(calls[1][0], 'stop');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧版本地管理页不再暴露 CDP 配置或探测', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../desktop/src/desktop-manager-server.js'), 'utf8');

  assert.match(source, /resolveAppServerStatus/);
  assert.doesNotMatch(source, /probeCodexDebug/);
  assert.doesNotMatch(source, /debugPort/);
});

test('Electron 停止功能会关闭自动启动并停止 Agent', () => {
  const electronMain = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'electron', 'main.js'), 'utf8');

  assert.match(electronMain, /manager:pause-feature/);
  assert.match(electronMain, /autoStart: false/);
  assert.match(electronMain, /saveConfig\(CONFIG_PATH, config\)/);
  assert.match(electronMain, /agentController\.stop\(\)/);
});

test('Electron 启动功能会恢复自动启动并重启 Agent', () => {
  const electronMain = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'electron', 'main.js'), 'utf8');

  assert.match(electronMain, /manager:restart-agent/);
  assert.match(electronMain, /autoStart: true/);
  assert.match(electronMain, /saveConfig\(CONFIG_PATH, config\)/);
  assert.match(electronMain, /agentController\.restart\(config\)/);
});

test('桌面 Agent 管理器可以识别并接管已有 Agent 进程', () => {
  const { DesktopAgentProcess } = require('../../desktop/src/desktop-agent-process');
  const killed = [];
  const manager = new DesktopAgentProcess({
    cwd: 'C:\\repo',
    platform: 'win32',
    processFinder: () => ({ pid: 4321, commandLine: 'node C:\\repo\\desktop-agent.js' }),
    killProcessTree: pid => killed.push(pid),
  });

  assert.deepEqual(manager.status(), {
    running: true,
    pid: 4321,
    exitCode: null,
    signalCode: null,
    lastOutput: [],
    lastError: [],
  });

  assert.deepEqual(manager.start({
    serverUrl: 'http://example.com:8008',
    token: 'token_replace_with_random_value',
    deviceName: 'home-pc',
  }), {
    running: true,
    pid: 4321,
    alreadyRunning: true,
  });

  assert.deepEqual(manager.stop(), { running: false, pid: 4321 });
  assert.deepEqual(killed, [4321]);
});

test('桌面 Agent 管理器重启时会结束旧 Agent 的 Windows 进程树', async () => {
  const EventEmitter = require('node:events');
  const { PassThrough } = require('node:stream');
  const { DesktopAgentProcess } = require('../../desktop/src/desktop-agent-process');
  const killed = [];
  const spawned = [];
  let existingPid = 4321;

  const manager = new DesktopAgentProcess({
    cwd: 'C:\\repo',
    platform: 'win32',
    nodePath: 'node.exe',
    processFinder: () => (existingPid ? { pid: existingPid, commandLine: 'node C:\\repo\\desktop-agent.js' } : null),
    killProcessTree: pid => {
      killed.push(pid);
      existingPid = null;
    },
    spawnImpl: (...args) => {
      spawned.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 9876;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
      };
      return child;
    },
    stopPollMs: 1,
    stopTimeoutMs: 50,
  });

  const result = await manager.restart({
    serverUrl: 'http://example.com:8008',
    token: 'token_replace_with_random_value',
    deviceName: 'home-pc',
  });

  assert.deepEqual(killed, [4321]);
  assert.equal(result.pid, 9876);
  assert.equal(result.running, true);
  assert.equal(result.alreadyRunning, false);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0][0], 'node.exe');
  assert.equal(spawned[0][2].env.CODEX_DEVICE_TOKEN, 'token_replace_with_random_value');
});

test('桌面 Agent 管理器按注入的平台隔离非 Windows 进程终止方式', () => {
  const { DesktopAgentProcess } = require('../../desktop/src/desktop-agent-process');
  const killed = [];
  const manager = new DesktopAgentProcess({
    platform: 'linux',
    processFinder: () => ({ pid: 4321, commandLine: 'node desktop-agent.js' }),
    killProcess: pid => killed.push(pid),
  });

  assert.deepEqual(manager.stop(), { running: false, pid: 4321 });
  assert.deepEqual(killed, [4321]);
});

test('桌面 Agent 管理器支持自定义子进程入口参数', () => {
  const { DesktopAgentProcess } = require('../../desktop/src/desktop-agent-process');
  const calls = [];
  const manager = new DesktopAgentProcess({
    cwd: 'C:\\repo',
    nodePath: 'manager.exe',
    childArgs: ['--codex-manager-agent-child'],
    childEnv: { CODEX_MANAGER_AGENT_CHILD: '1' },
    processFinder: () => null,
    spawnImpl: (...args) => calls.push(args),
  });

  assert.equal(manager.nodePath, 'manager.exe');
  assert.deepEqual(manager.childArgs, ['--codex-manager-agent-child']);
  assert.deepEqual(manager.childEnv, { CODEX_MANAGER_AGENT_CHILD: '1' });
});
