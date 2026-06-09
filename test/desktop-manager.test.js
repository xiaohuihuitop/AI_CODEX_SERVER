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
  const { loadConfig, saveConfig } = require('../src/desktop-manager-server');
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
  const { loadConfig } = require('../src/desktop-manager-server');
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
  const { renderHtml } = require('../src/desktop-manager-server');
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

  assert.match(html, /启动 Agent/);
  assert.match(html, /停止 Agent/);
  assert.match(html, /Codex Desktop/);
  assert.match(html, /http:\/\/example\.com:8008\/\?token=xiaohuihui/);
});

test('桌面管理器 HTTP 接口支持保存配置和控制 Agent', async () => {
  const { createDesktopManagerServer } = require('../src/desktop-manager-server');
  const calls = [];
  const agentController = {
    start(config) {
      calls.push(['start', config]);
      return { running: true, pid: 1234, alreadyRunning: false };
    },
    stop() {
      calls.push(['stop']);
      return { running: false, pid: 1234 };
    },
    status() {
      return { running: calls.some(call => call[0] === 'start'), pid: 1234, lastOutput: [], lastError: [] };
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

    const start = await fetch(`http://127.0.0.1:${port}/agent/start`, { method: 'POST' });
    assert.equal(start.status, 200);
    assert.equal(calls[0][0], 'start');
    assert.equal(calls[0][1].token, 'xiaohuihui');

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

test('桌面 Agent 管理器可以识别并接管已有 Agent 进程', () => {
  const { DesktopAgentProcess } = require('../src/desktop-agent-process');
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

test('桌面 Agent 管理器支持自定义子进程入口参数', () => {
  const { DesktopAgentProcess } = require('../src/desktop-agent-process');
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
