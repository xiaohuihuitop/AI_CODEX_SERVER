const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  getAgentStatusPath,
  isAgentStatusFresh,
  readAgentStatus,
  writeAgentStatus,
} = require('../../desktop/src/desktop-agent-status');
const { resolveControlledCodexStatus } = require('../../desktop/src/controlled-codex-status');

test('Agent 状态文件按设备 Key 隔离且不暴露明文 Key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agent-status-'));
  try {
    const statusPath = getAgentStatusPath('device-key-1', { homeDir: dir });
    assert.equal(statusPath.includes('device-key-1'), false);

    writeAgentStatus(statusPath, {
      pid: 87420,
      state: 'ready',
      message: '本机 stdio 会话服务已就绪',
      codexVersion: '0.144.0-alpha.4',
      updatedAt: '2026-08-05T01:00:00.000Z',
    });

    assert.deepEqual(readAgentStatus(statusPath), {
      version: 1,
      pid: 87420,
      state: 'ready',
      message: '本机 stdio 会话服务已就绪',
      codexVersion: '0.144.0-alpha.4',
      updatedAt: '2026-08-05T01:00:00.000Z',
    });
    assert.equal(isAgentStatusFresh(readAgentStatus(statusPath), Date.parse('2026-08-05T01:00:20.000Z')), true);
    assert.equal(isAgentStatusFresh(readAgentStatus(statusPath), Date.parse('2026-08-05T01:01:01.000Z')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('管理器在接管已有 Agent 时从状态心跳判断受控 Codex 已连接', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-codex-status-'));
  const config = { token: 'device-key-1' };
  try {
    writeAgentStatus(getAgentStatusPath(config.token, { homeDir: dir }), {
      pid: 87420,
      state: 'ready',
      message: '受控 Codex Desktop 已连接：CDP 9230',
      codexVersion: '26.707.3748.0',
      updatedAt: '2026-08-05T01:00:00.000Z',
    });

    assert.deepEqual(resolveControlledCodexStatus({
      running: true,
      pid: 87420,
      lastOutput: [],
      lastError: [],
    }, config, {
      homeDir: dir,
      now: () => Date.parse('2026-08-05T01:00:10.000Z'),
    }), {
      ok: true,
      message: '受控 Codex Desktop 已连接：CDP 9230',
      codexVersion: '26.707.3748.0',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('管理器拒绝过期或属于其他 Agent 的受控 Codex 状态', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-codex-status-'));
  const config = { token: 'device-key-1' };
  const statusPath = getAgentStatusPath(config.token, { homeDir: dir });
  try {
    writeAgentStatus(statusPath, {
      pid: 100,
      state: 'ready',
      message: '本机 stdio 会话服务已就绪',
      codexVersion: '0.144.0-alpha.4',
      updatedAt: '2026-08-05T01:00:00.000Z',
    });
    const otherAgent = resolveControlledCodexStatus({ running: true, pid: 200 }, config, {
      homeDir: dir,
      now: () => Date.parse('2026-08-05T01:00:10.000Z'),
    });
    assert.equal(otherAgent.ok, false);
    assert.match(otherAgent.message, /其他 Agent/);

    writeAgentStatus(statusPath, {
      pid: 200,
      state: 'ready',
      message: '本机 stdio 会话服务已就绪',
      codexVersion: '0.144.0-alpha.4',
      updatedAt: '2026-08-05T01:00:00.000Z',
    });
    const stale = resolveControlledCodexStatus({ running: true, pid: 200 }, config, {
      homeDir: dir,
      now: () => Date.parse('2026-08-05T01:01:01.000Z'),
    });
    assert.equal(stale.ok, false);
    assert.match(stale.message, /状态心跳已过期/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
