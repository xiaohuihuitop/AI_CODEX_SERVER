const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildAgentEnv,
  buildMobileUrl,
  createDefaultManagerConfig,
  generateDeviceToken,
  normalizeManagerConfig,
} = require('../desktop-client/src/desktop-manager');

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

test('桌面管理器配置可以持久化到文件', () => {
  const { loadConfig, saveConfig } = require('../desktop-client/src/desktop-manager-server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-'));
  const file = path.join(dir, 'manager-config.json');
  try {
    saveConfig(file, {
      serverUrl: 'http://example.com:8008/',
      token: 'xiaohuihui',
      deviceName: 'home-pc',
      autoStart: true,
    });

    assert.deepEqual(loadConfig(file), {
      serverUrl: 'http://example.com:8008',
      token: 'xiaohuihui',
      deviceName: 'home-pc',
      autoStart: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('桌面管理器配置兼容 UTF-8 BOM 文件', () => {
  const { loadConfig } = require('../desktop-client/src/desktop-manager-server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-bom-'));
  const file = path.join(dir, 'manager-config.json');
  try {
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({
      serverUrl: 'http://example.com:8008/',
      token: 'xiaohuihui',
      deviceName: 'home-pc',
      autoStart: false,
    })}`, 'utf8');

    assert.deepEqual(loadConfig(file), {
      serverUrl: 'http://example.com:8008',
      token: 'xiaohuihui',
      deviceName: 'home-pc',
      autoStart: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('桌面管理器页面包含 Agent 控制和状态区域', () => {
  const { renderHtml } = require('../desktop-client/src/desktop-manager-server');
  const html = renderHtml({
    serverUrl: 'http://example.com:8008',
    token: 'xiaohuihui',
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
  assert.match(html, /Codex Desktop/);
  assert.match(html, /http:\/\/example\.com:8008\/\?token=xiaohuihui/);
});

test('桌面管理器 HTTP 接口支持保存配置和控制 Agent', async () => {
  const { createDesktopManagerServer } = require('../desktop-client/src/desktop-manager-server');
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
      codex: async () => ({ ok: true, targetCount: 1, message: '' }),
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const form = new URLSearchParams({
      serverUrl: 'http://example.com:8008',
      token: 'xiaohuihui',
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
    assert.equal(calls[0][1].token, 'xiaohuihui');
    assert.equal(restartBody.agent.pid, 5678);

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    const statusBody = await status.json();
    assert.equal(statusBody.cloud.online, true);
    assert.equal(statusBody.codex.ok, true);
    assert.equal(statusBody.agent.running, true);

    const stop = await fetch(`http://127.0.0.1:${port}/agent/stop`, { method: 'POST' });
    assert.equal(stop.status, 200);
    assert.equal(calls[1][0], 'stop');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('桌面管理器 Codex 控制只统计可控制 App 目标', async () => {
  const { probeCodexDebug } = require('../desktop-client/src/desktop-manager-server');
  const result = await probeCodexDebug({
    fetchWithTimeout: async () => ({
      json: async () => [
        { url: 'app://-/index.html' },
        { url: 'devtools://devtools/bundled/inspector.html' },
        { url: 'chrome-extension://example/background.html' },
        { url: 'about:blank' },
        { url: 'app://-/other.html' },
      ],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetCount, 5);
  assert.equal(result.appTargetCount, 1);
  assert.equal(result.port, 9229);
});

test('Electron 停止功能会关闭自动启动并停止 Agent', () => {
  const electronMain = fs.readFileSync(path.join(__dirname, '..', 'desktop-client', 'electron', 'main.js'), 'utf8');

  assert.match(electronMain, /manager:pause-feature/);
  assert.match(electronMain, /autoStart: false/);
  assert.match(electronMain, /saveConfig\(CONFIG_PATH, config\)/);
  assert.match(electronMain, /agentController\.stop\(\)/);
});

test('Electron 启动功能会恢复自动启动并重启 Agent', () => {
  const electronMain = fs.readFileSync(path.join(__dirname, '..', 'desktop-client', 'electron', 'main.js'), 'utf8');

  assert.match(electronMain, /manager:restart-agent/);
  assert.match(electronMain, /autoStart: true/);
  assert.match(electronMain, /saveConfig\(CONFIG_PATH, config\)/);
  assert.match(electronMain, /agentController\.restart\(config\)/);
});

test('桌面 Agent 管理器可以识别并接管已有 Agent 进程', () => {
  const { DesktopAgentProcess } = require('../desktop-client/src/desktop-agent-process');
  const killed = [];
  const manager = new DesktopAgentProcess({
    cwd: 'C:\\repo',
    processFinder: () => ({ pid: 4321, commandLine: 'node C:\\repo\\desktop-agent.js' }),
    killProcess: pid => killed.push(pid),
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
    token: 'xiaohuihui',
    deviceName: 'home-pc',
  }), {
    running: true,
    pid: 4321,
    alreadyRunning: true,
  });

  assert.deepEqual(manager.stop(), { running: false, pid: 4321 });
  assert.deepEqual(killed, [4321]);
});

test('桌面 Agent 管理器支持一键重启 Agent 让连接重新上线', async () => {
  const EventEmitter = require('node:events');
  const { PassThrough } = require('node:stream');
  const { DesktopAgentProcess } = require('../desktop-client/src/desktop-agent-process');
  const killed = [];
  const spawned = [];
  let existingPid = 4321;

  const manager = new DesktopAgentProcess({
    cwd: 'C:\\repo',
    nodePath: 'node.exe',
    processFinder: () => (existingPid ? { pid: existingPid, commandLine: 'node C:\\repo\\desktop-agent.js' } : null),
    killProcess: pid => {
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
    token: 'xiaohuihui',
    deviceName: 'home-pc',
  });

  assert.deepEqual(killed, [4321]);
  assert.equal(result.pid, 9876);
  assert.equal(result.running, true);
  assert.equal(result.alreadyRunning, false);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0][0], 'node.exe');
  assert.equal(spawned[0][2].env.CODEX_DEVICE_TOKEN, 'xiaohuihui');
});

test('桌面 Agent 管理器支持自定义子进程入口参数', () => {
  const { DesktopAgentProcess } = require('../desktop-client/src/desktop-agent-process');
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
