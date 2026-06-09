const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { buildAgentEnv, normalizeManagerConfig } = require('./desktop-manager');

const MAX_LOG_LINES = 30;

/**
 * AI:查找当前项目启动的 Agent 进程，避免管理器重启后重复启动。
 *
 * @param {string} agentScriptPath Agent 入口脚本绝对路径。
 * @returns {{pid: number, commandLine: string}|null} 已运行进程快照。
 */
function findExistingAgentSnapshot(agentScriptPath) {
  if (process.platform !== 'win32') return null;
  const target = String(agentScriptPath || '').replace(/'/g, "''");
  const script = [
    `$target = '${target}';`,
    'Get-CimInstance Win32_Process |',
    "Where-Object { $_.Name -match '^node(\\.exe)?$' -and $_.CommandLine -and $_.CommandLine.Contains($target) } |",
    'Sort-Object ProcessId |',
    'Select-Object -First 1 ProcessId,CommandLine |',
    'ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    }).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ProcessId) return null;
    return { pid: Number(parsed.ProcessId), commandLine: String(parsed.CommandLine || '') };
  } catch {
    return null;
  }
}

/**
 * 追加有限长度的日志行。
 *
 * @param {string[]} lines 日志缓存。
 * @param {Buffer|string} data 进程输出。
 * @returns {void}
 */
function appendLog(lines, data) {
  String(data || '').split(/\r?\n/).filter(Boolean).forEach(line => lines.push(line));
  if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
}

class DesktopAgentProcess {
  /**
   * 创建 Agent 子进程管理器。
   *
   * @param {{cwd?: string, nodePath?: string}} options 进程启动配置。
   */
  constructor(options = {}) {
    this.cwd = options.cwd || path.join(__dirname, '..');
    this.nodePath = options.nodePath || process.execPath;
    this.agentScriptPath = options.agentScriptPath || path.join(this.cwd, 'desktop-agent.js');
    this.processFinder = options.processFinder || findExistingAgentSnapshot;
    this.killProcess = options.killProcess || process.kill;
    this.child = null;
    this.lastOutput = [];
    this.lastError = [];
    this.exitCode = null;
    this.signalCode = null;
  }

  /**
   * 判断当前托管 Agent 是否仍在运行。
   *
   * @returns {boolean} 运行中返回 true。
   */
  isRunning() {
    return Boolean(this.getRunningSnapshot());
  }

  /**
   * AI:获取当前运行中的 Agent，优先使用托管子进程，其次识别已存在进程。
   *
   * @returns {{pid: number, external: boolean}|null} 运行快照。
   */
  getRunningSnapshot() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return { pid: this.child.pid, external: false };
    }
    const existing = this.processFinder(this.agentScriptPath);
    if (!existing) return null;
    return { pid: existing.pid, external: true };
  }

  /**
   * 启动 Windows Agent。
   *
   * @param {{serverUrl: string, token: string, deviceName: string}} input 管理器配置。
   * @returns {{running: boolean, pid: number|null, alreadyRunning: boolean}} 启动结果。
   */
  start(input) {
    const config = normalizeManagerConfig(input);
    if (!config.serverUrl) throw Object.assign(new Error('请先填写云端服务器地址。'), { status: 400, code: 'SERVER_URL_REQUIRED' });
    if (!config.token) throw Object.assign(new Error('请先填写固定 Token。'), { status: 400, code: 'TOKEN_REQUIRED' });
    const running = this.getRunningSnapshot();
    if (running) {
      return { running: true, pid: running.pid, alreadyRunning: true };
    }

    this.lastOutput = [];
    this.lastError = [];
    this.exitCode = null;
    this.signalCode = null;

    const child = spawn(this.nodePath, [this.agentScriptPath], {
      cwd: this.cwd,
      env: { ...process.env, ...buildAgentEnv(config) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', data => appendLog(this.lastOutput, data));
    child.stderr.on('data', data => appendLog(this.lastError, data));
    child.on('close', (code, signal) => {
      this.exitCode = code;
      this.signalCode = signal;
    });
    return { running: true, pid: child.pid, alreadyRunning: false };
  }

  /**
   * 停止当前托管 Agent。
   *
   * @returns {{running: boolean, pid: number|null}} 停止结果。
   */
  stop() {
    const running = this.getRunningSnapshot();
    if (!running) return { running: false, pid: null };
    if (this.child && this.child.pid === running.pid) this.child.kill();
    else this.killProcess(running.pid);
    return { running: false, pid: running.pid };
  }

  /**
   * 获取当前托管 Agent 状态。
   *
   * @returns {{running: boolean, pid: number|null, exitCode: number|null, signalCode: string|null, lastOutput: string[], lastError: string[]}} Agent 状态。
   */
  status() {
    const running = this.getRunningSnapshot();
    return {
      running: Boolean(running),
      pid: running?.pid || null,
      exitCode: this.exitCode,
      signalCode: this.signalCode,
      lastOutput: [...this.lastOutput],
      lastError: [...this.lastError],
    };
  }
}

/**
 * 创建 Agent 子进程管理器。
 *
 * @param {{cwd?: string, nodePath?: string}} options 进程启动配置。
 * @returns {DesktopAgentProcess} Agent 子进程管理器。
 */
function createDesktopAgentProcess(options = {}) {
  return new DesktopAgentProcess(options);
}

module.exports = {
  DesktopAgentProcess,
  createDesktopAgentProcess,
  findExistingAgentSnapshot,
};
